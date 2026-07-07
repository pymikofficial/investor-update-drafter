// Investor Update Drafter ~ background function.
// Netlify auto-responds 202 for "-background" suffixed functions, so the slow
// work (one Claude call) happens after the client has already been released.
// The client polls check-update.js with the same jobId.
//
// Pipeline: rate-limit check -> PII scrub (freeform fields only)
//           -> deterministic arithmetic (growth/runway/headcount, plain JS, no AI)
//           -> single Claude call, drafting around placeholder tokens for every
//              computed figure -> placeholder substitution -> guardrail scan for
//              any placeholder the model didn't use correctly -> final JSON to Blobs.
//
// No auditor pass here, unlike the other tools in this suite. The guardrail
// against a hallucinated number is architectural: the model is never allowed
// to write the digits itself, it can only place a token that this function
// then fills in from arithmetic it already trusts.

const { getStore } = require('@netlify/blobs');

// Lesson learned (documented across cosmik.work projects):
// getStore MUST receive explicit siteID and token in this account's setup,
// or it throws "The environment has not been configured to use Netlify Blobs".
const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const DAILY_CAP = 25; // guardrail: public tool, keep API spend bounded
const MAX_TEXT_CHARS = 4000; // wins/ask are short by nature, unlike a raw notes dump

exports.handler = async (event) => {
  const store = getStore({ name: 'investor-updates', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;

    if (!jobId) {
      return; // nothing sensible to do; client will time out and show an error
    }

    const currentMRR = Number(body.currentMRR);
    const previousMRR = Number(body.previousMRR);
    const cashInBank = Number(body.cashInBank);
    const monthlyBurn = Number(body.monthlyBurn);
    const currentHeadcount = body.currentHeadcount === '' || body.currentHeadcount == null ? null : Number(body.currentHeadcount);
    const previousHeadcount = body.previousHeadcount === '' || body.previousHeadcount == null ? null : Number(body.previousHeadcount);
    const winsRaw = (body.wins || '').slice(0, MAX_TEXT_CHARS);
    const askRaw = (body.ask || '').slice(0, MAX_TEXT_CHARS);
    const tone = body.tone === 'casual' ? 'casual' : 'formal';

    if (
      !winsRaw.trim() ||
      !Number.isFinite(currentMRR) ||
      !Number.isFinite(previousMRR) ||
      !Number.isFinite(cashInBank) ||
      !Number.isFinite(monthlyBurn)
    ) {
      await store.setJSON(jobId, {
        status: 'error',
        message: 'Missing or invalid required fields (MRR figures, cash, burn, and wins are all required).'
      });
      return;
    }

    await store.setJSON(jobId, { status: 'pending' });

    // --- Guardrail 1: daily rate limit via a Blob counter ---
    const today = new Date().toISOString().slice(0, 10);
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const counterKey = `updates-${today}`;
    let count = 0;
    try {
      const existing = await limitStore.get(counterKey);
      count = existing ? parseInt(existing, 10) : 0;
    } catch (e) {
      count = 0;
    }
    if (count >= DAILY_CAP) {
      await store.setJSON(jobId, {
        status: 'error',
        message: "Today's free generation limit has been reached. Come back tomorrow."
      });
      return;
    }
    await limitStore.set(counterKey, String(count + 1));

    // --- Guardrail 2: division-by-zero, before anything else touches these numbers ---
    if (previousMRR === 0) {
      await store.setJSON(jobId, {
        status: 'error',
        message: "Previous MRR can't be zero, growth percentage would be undefined. Enter a nonzero previous MRR."
      });
      return;
    }
    if (monthlyBurn === 0) {
      await store.setJSON(jobId, {
        status: 'error',
        message: "Monthly burn can't be zero, runway would be undefined. Enter a nonzero monthly burn."
      });
      return;
    }

    // --- Guardrail 3: PII scrub before anything reaches the API ---
    const winsScrub = scrubPII(winsRaw);
    const askScrub = scrubPII(askRaw);
    const scrubCounts = {
      emails: winsScrub.scrubCounts.emails + askScrub.scrubCounts.emails,
      phones: winsScrub.scrubCounts.phones + askScrub.scrubCounts.phones
    };

    // --- Deterministic computation: plain JS, no AI, this IS the guardrail ---
    const growthPct = round1(((currentMRR - previousMRR) / previousMRR) * 100);
    const runwayMonths = round1(cashInBank / monthlyBurn);
    const headcountChange =
      currentHeadcount !== null && previousHeadcount !== null && Number.isFinite(currentHeadcount) && Number.isFinite(previousHeadcount)
        ? currentHeadcount - previousHeadcount
        : null;

    const verifiedFigures = {
      growthPct,
      runwayMonths,
      headcountChange,
      currentMRR,
      previousMRR,
      cashInBank,
      monthlyBurn
    };

    // --- Single Claude call: draft the update, using placeholders for every
    //     computed figure. No second call, no auditor. ---
    const draft = await callClaude([
      {
        role: 'user',
        content:
          buildPrompt(tone, verifiedFigures, currentHeadcount, previousHeadcount) +
          '\n\n<wins_and_updates>\n' + winsScrub.scrubbed + '\n</wins_and_updates>' +
          (askScrub.scrubbed.trim() ? '\n\n<ask_for_investors>\n' + askScrub.scrubbed + '\n</ask_for_investors>' : '')
      }
    ]);
    const draftJSON = parseModelJSON(draft);

    // --- Placeholder substitution: fill every token with the real computed value ---
    const substitutions = {
      '{{GROWTH_PCT}}': formatPct(growthPct),
      '{{RUNWAY_MONTHS}}': String(runwayMonths),
      '{{HEADCOUNT_CHANGE}}': headcountChange === null ? '' : formatSigned(headcountChange),
      '{{CURRENT_MRR}}': formatCurrency(currentMRR),
      '{{PREVIOUS_MRR}}': formatCurrency(previousMRR),
      '{{CASH_IN_BANK}}': formatCurrency(cashInBank),
      '{{MONTHLY_BURN}}': formatCurrency(monthlyBurn)
    };

    const finalUpdate = {
      title: substitute(draftJSON.title || '', substitutions),
      body_paragraphs: (draftJSON.body_paragraphs || []).map((p) => substitute(p, substitutions)),
      ask_paragraph: substitute(draftJSON.ask_paragraph || '', substitutions),
      tone_used: draftJSON.tone_used || tone
    };

    // --- Guardrail 4: scan for any placeholder the model didn't use correctly ---
    const allText = [
      finalUpdate.title,
      ...finalUpdate.body_paragraphs,
      finalUpdate.ask_paragraph
    ].join('\n');
    if (allText.includes('{{') || allText.includes('}}')) {
      await store.setJSON(jobId, {
        status: 'error',
        message: 'The draft used a placeholder token that could not be resolved. Try again, this is a safety check catching a malformed model response rather than shipping broken text.'
      });
      return;
    }

    await store.setJSON(jobId, {
      status: 'done',
      update: finalUpdate,
      verifiedFigures,
      scrubCounts
    });
  } catch (err) {
    console.error('generate-update error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, {
          status: 'error',
          message: 'Generation failed. Try again in a minute.'
        });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatPct(n) {
  return n + '%';
}

function formatSigned(n) {
  return (n > 0 ? '+' : '') + n;
}

function formatCurrency(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function substitute(text, substitutions) {
  let out = text;
  for (const [token, value] of Object.entries(substitutions)) {
    out = out.split(token).join(value);
  }
  return out;
}

function scrubPII(text) {
  const scrubCounts = { emails: 0, phones: 0 };

  let out = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => { scrubCounts.emails++; return '[email removed]'; }
  );

  // Phone numbers: international/local formats, 8+ digits with separators.
  // Lookbehind/lookahead keep digit runs glued to letters or hyphens intact,
  // so invoice numbers, PO numbers, and IDs like INV-2026-000123 survive.
  out = out.replace(
    /(?<![A-Za-z0-9-])(\+?\d[\d\s()./-]{6,}\d)(?![A-Za-z0-9])/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      // Real phone numbers are 8-15 digits and don't look like dates (which
      // are exactly 8 digits in DD-MM-YYYY / YYYY-MM-DD shapes with 2 seps).
      const seps = (match.match(/[/-]/g) || []).length;
      const looksLikeDate = digits.length === 8 && seps === 2;
      if (digits.length >= 8 && digits.length <= 15 && !looksLikeDate) {
        scrubCounts.phones++;
        return '[phone removed]';
      }
      return match;
    }
  );

  return { scrubbed: out, scrubCounts };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(clean.slice(start, end + 1));
}

// ---------------------------------------------------------------------------

function buildPrompt(tone, figures, currentHeadcount, previousHeadcount) {
  const toneInstruction = tone === 'casual'
    ? 'CASUAL: write like a founder emailing investors who already know and like you. Warm, direct, first person, contractions are fine, still substantive.'
    : 'FORMAL: write like a data-room-ready investor update. Third-person-neutral or measured first person, precise, no slang, still human, not corporate filler.';

  const headcountLine = (currentHeadcount !== null && previousHeadcount !== null)
    ? `Headcount moved from ${previousHeadcount} to ${currentHeadcount}. You may mention this using the {{HEADCOUNT_CHANGE}} token if it's noteworthy.`
    : `Headcount figures were not provided this period. Do not mention headcount or team size change at all.`;

  return `You are an experienced startup operator drafting an investor update. You are given this period's raw metrics (already computed and verified, you do not need to do any math) and a founder's raw notes on wins and their ask. Your job is to write the narrative around already-correct numbers, never to compute or restate a number yourself.

Tone for this update: ${toneInstruction}

CRITICAL RULE: You must NEVER write a literal digit for growth percentage, runway, or headcount change. Wherever one of these belongs in your text, write the EXACT placeholder token instead, verbatim, and nothing else in its place:

- {{GROWTH_PCT}} resolves to the MRR growth percentage already including a "%" sign, e.g. "15.6%". Do not add your own "%" next to it.
- {{RUNWAY_MONTHS}} resolves to a bare number of months, e.g. "8.2". Write the word "months" yourself right after it.
- {{HEADCOUNT_CHANGE}} resolves to a signed integer, e.g. "+3" or "-2". Do not add your own "+" or "-" next to it. ${headcountLine}
- {{CURRENT_MRR}}, {{PREVIOUS_MRR}}, {{CASH_IN_BANK}}, {{MONTHLY_BURN}} each resolve to a formatted dollar figure, e.g. "$52,000". Do not add your own "$" or restate the number.

For context only (so you can reason about the story, but you must still use the tokens above, never these raw numbers, anywhere in your output): current MRR ${figures.currentMRR}, previous MRR ${figures.previousMRR}, cash in bank ${figures.cashInBank}, monthly burn ${figures.monthlyBurn}.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:

{
  "title": "a short investor-update title/subject line",
  "body_paragraphs": ["2 to 4 paragraphs, using placeholder tokens wherever a computed figure belongs"],
  "ask_paragraph": "one paragraph on the ask for investors, grounded in the founder's notes below. If no ask was given, write a brief, honest 'no specific ask this period' line instead of inventing one.",
  "tone_used": "${tone}"
}

Ground every claim in the founder's notes below. Never invent a win, metric, or ask that isn't in the notes or the verified figures above.`;
}

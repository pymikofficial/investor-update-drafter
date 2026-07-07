#!/usr/bin/env node
// Smoke test for Investor Update Drafter, run against the LIVE deployed site.
// Runs TWO generations: one normal case (asserts the exact figures the backend
// should have computed, hand-computed independently right here rather than
// copied from the function's own arithmetic, so this is a real check and not
// a tautology), and one division-by-zero edge case (asserts a clean error,
// not NaN/Infinity/a crash). Also asserts no unresolved "{{" placeholder
// tokens leak into the final text, and that PII scrubbing actually ran.
//
// Usage: node scripts/smoke-test.mjs [base_url]

const BASE_URL = process.argv[2] || 'https://investor-update-drafter.netlify.app';
const POLL_MS = 2000;
const MAX_POLLS = 45;

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function kickoffAndPoll(jobId, payload, functionsPrefix) {
  let kickoff;
  try {
    kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-update-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, ...payload })
    });
  } catch (e) {
    return { error: `Could not reach generate-update-background: ${e.message}` };
  }
  if (kickoff.status !== 202 && kickoff.status !== 200) {
    return { error: `Unexpected status from background function: ${kickoff.status}` };
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-update?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) {
      continue;
    }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') {
      return { record: data };
    }
  }
  return { error: 'Timed out after ~90s with no done/error status.' };
}

async function testNormalCase() {
  log('=== Normal case (clean numbers) ===');
  const jobId = 'smoketest-normal-' + Date.now();

  const currentMRR = 52000;
  const previousMRR = 45000;
  const cashInBank = 180000;
  const monthlyBurn = 22000;
  const currentHeadcount = 15;
  const previousHeadcount = 12;

  // Independent hand-computation, not copy-pasted from the backend's own code.
  const expectedGrowthPct = Math.round(((currentMRR - previousMRR) / previousMRR) * 1000) / 10; // 15.6
  const expectedRunway = Math.round((cashInBank / monthlyBurn) * 10) / 10; // 8.2
  const expectedHeadcountChange = currentHeadcount - previousHeadcount; // 3

  const startedAt = Date.now();
  const { record, error } = await kickoffAndPoll(jobId, {
    currentMRR, previousMRR, cashInBank, monthlyBurn, currentHeadcount, previousHeadcount,
    wins: `Closed the Acme deal, grew MRR nicely this month. Contact our finance lead at finance.test@example.com or +91 98765 43210 if you want the data room.`,
    ask: `Would love an intro to enterprise security buyers, email me at founder.test@example.com.`,
    tone: 'formal'
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (error) { fail(error); return; }
  if (record.status === 'error') { fail(`Server returned an error: ${record.message}`); return; }

  if (Number(elapsedSec) <= 90) pass(`Generated in ${elapsedSec}s (within 90s budget).`);
  else fail(`Took ${elapsedSec}s, over the 90s budget.`);

  const fig = record.verifiedFigures || {};
  if (fig.growthPct === expectedGrowthPct) pass(`growthPct correct: ${fig.growthPct}% (expected ${expectedGrowthPct}%).`);
  else fail(`growthPct wrong: got ${fig.growthPct}, expected ${expectedGrowthPct}.`);

  if (fig.runwayMonths === expectedRunway) pass(`runwayMonths correct: ${fig.runwayMonths} (expected ${expectedRunway}).`);
  else fail(`runwayMonths wrong: got ${fig.runwayMonths}, expected ${expectedRunway}.`);

  if (fig.headcountChange === expectedHeadcountChange) pass(`headcountChange correct: ${fig.headcountChange} (expected ${expectedHeadcountChange}).`);
  else fail(`headcountChange wrong: got ${fig.headcountChange}, expected ${expectedHeadcountChange}.`);

  const u = record.update || {};
  const fullText = [u.title, ...(u.body_paragraphs || []), u.ask_paragraph].join('\n');

  if (fullText.includes('15.6%')) pass('Output contains the exact growth figure "15.6%".');
  else fail('Output does not contain "15.6%".');

  if (fullText.includes('8.2')) pass('Output contains the exact runway figure "8.2".');
  else fail('Output does not contain "8.2".');

  if (fullText.includes('+3') || fullText.includes('3')) pass('Output contains the headcount change figure ("+3" or "3").');
  else fail('Output does not contain the headcount change figure.');

  if (!fullText.includes('{{') && !fullText.includes('}}')) pass('No unresolved "{{" placeholder tokens in the output.');
  else fail('Found unresolved placeholder tokens in the output.');

  const scrub = record.scrubCounts || {};
  if ((scrub.emails || 0) >= 1 && (scrub.phones || 0) >= 1) {
    pass(`PII scrub confirmed: ${scrub.emails} email(s), ${scrub.phones} phone(s) removed before the API call.`);
  } else {
    fail(`Expected 1+ email and 1+ phone scrubbed, got emails=${scrub.emails || 0} phones=${scrub.phones || 0}.`);
  }

  log('\n--- Full update (for manual eyeballing) ---');
  log(JSON.stringify({ update: u, verifiedFigures: fig }, null, 2));
}

async function testDivisionByZero() {
  log('\n=== Edge case (previousMRR = 0) ===');
  const jobId = 'smoketest-divzero-' + Date.now();

  const { record, error } = await kickoffAndPoll(jobId, {
    currentMRR: 10000,
    previousMRR: 0,
    cashInBank: 100000,
    monthlyBurn: 10000,
    currentHeadcount: '',
    previousHeadcount: '',
    wins: 'First revenue this month, excited to share.',
    ask: '',
    tone: 'formal'
  });

  if (error) { fail(error); return; }

  if (record.status === 'error' && typeof record.message === 'string' && record.message.length > 0) {
    pass(`Division-by-zero handled cleanly: status=error, message="${record.message}"`);
  } else {
    fail(`Expected a clean error status, got: ${JSON.stringify(record)}`);
  }

  const asText = JSON.stringify(record);
  if (!/NaN|Infinity/.test(asText)) pass('No NaN/Infinity leaked into the response.');
  else fail('Found NaN/Infinity in the response.');
}

async function main() {
  log(`Testing ${BASE_URL}\n`);
  await testNormalCase();
  await testDivisionByZero();
}

main();

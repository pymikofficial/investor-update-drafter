# Investor Update Drafter

Raw metrics and bullets in, a polished investor update out, with a numeric sanity check built in. Growth, runway, and headcount change are computed in plain code before the AI ever sees them, then dropped into the draft as fixed values it cannot rewrite.

**Live:** [investor-update-drafter.netlify.app](https://investor-update-drafter.netlify.app)

## The headache

Investor updates fail in one of two ways. Either the founder writes them in a rush and the numbers are sloppy, a growth percentage eyeballed instead of computed, a runway figure that's actually last month's. Or the founder writes them carefully and still second-guesses their own arithmetic under stress, re-checking a division three times before hitting send because a wrong number in an investor update is the kind of mistake that's remembered. Neither failure mode is about writing ability. Both are about trusting the math enough to stop checking it.

## The machinery: the guardrail is the architecture, not a second pass

Every other tool in this suite (Executive Briefing Generator, Meeting Minutes Extractor, Fieldnote, SOP Generator) uses the same shape: one AI call drafts, a second AI call audits the first one's work against the source material. That pattern is good at catching dropped or invented *content*. It is the wrong tool for guaranteeing a *number* is correct, because an auditor is still an LLM re-reading a calculation, not actually redoing it.

This tool has no auditor call. Instead:

1. Growth percentage, runway in months, and headcount change are computed in plain JavaScript from the raw inputs, before any API call happens. This is arithmetic, not generation, there is nothing for a model to get right or wrong here.
2. The single Claude call is instructed to never write a literal digit for any of these three figures. Wherever one belongs, it must write an exact placeholder token instead, e.g. `{{GROWTH_PCT}}`, `{{RUNWAY_MONTHS}}`, `{{HEADCOUNT_CHANGE}}`, plus tokens for the four raw dollar figures.
3. After the model responds, the server substitutes every token with the real, already-computed value, across the title, every body paragraph, and the ask paragraph.
4. A final scan checks the substituted text for any leftover `{{` or `}}`. If the model used a token name it wasn't given, or wrote a number outside of a token, that's caught here and returned as an error rather than shipped with a visible template artifact or (worse) an invented number that slipped through.

The "Verified figures" panel shown alongside every result is this guardrail made visible: the exact arithmetic, `(52,000 - 45,000) / 45,000 = 15.6%`, next to the final prose that used that number. Same transparency principle as showing PII scrub counts or audit flags elsewhere in this suite, just applied to a guardrail that lives in code instead of in a second prompt.

## Guardrails

- **Division-by-zero guard**: a previous MRR or monthly burn of zero returns a clear error instead of `NaN` or `Infinity` reaching the draft.
- **PII scrub on both freeform fields**: emails and phone numbers stripped server-side from the wins and ask text before either reaches the API.
- **Daily rate limit**: a Blob-backed counter caps generations per day.
- **Placeholder guardrail**: described above, the reason this tool has no auditor call.

## Architecture

Same background-function-plus-polling pattern as the rest of the suite: Netlify auto-responds 202 for `-background` suffixed functions, avoiding the ~10s synchronous timeout, and the frontend polls until the job resolves.

1. `generate-update-background.js`: rate limit → validate required fields → division-by-zero guard → PII scrub (wins, ask) → deterministic arithmetic (growth, runway, headcount change) → single Claude call (drafts around placeholder tokens) → substitute tokens with real values → scan for unresolved placeholders → result written to Blobs.
2. `check-update.js`: polling endpoint, hit every 2s by the frontend, reads from the `investor-updates` Blob store.
3. Frontend: six number fields (current/previous MRR, cash in bank, monthly burn, current/previous headcount, the last two optional), two freeform textareas (wins, ask), a Formal/Casual tone toggle, and a "Verified figures" panel rendered from the same computed values the backend used.

## Environment variables (all three required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token |

Note: `getStore()` must be called with explicit `siteID` and `token`, ambient environment configuration doesn't pass through correctly in this deployment setup.

## Smoke test

`node scripts/smoke-test.mjs` runs two full generations against the live site: a normal case with clean numbers, independently hand-computed in the test script itself (not copy-pasted from the backend logic) and asserted to appear verbatim in the output; and an edge case with a zero previous MRR, asserted to come back as a clean error rather than `NaN`/`Infinity`/a crash. It also asserts zero unresolved `{{` placeholder characters anywhere in the final output, and that a planted email/phone in the freeform fields was scrubbed.

Built by [Soumik Chatterjee](https://cosmik.work).

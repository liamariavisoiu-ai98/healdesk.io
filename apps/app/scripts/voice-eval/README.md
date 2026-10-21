# Voice eval (soft skills)

Measures and tunes how the voice agent *sounds*, on synthetic calls, without
being able to weaken a guardrail. Launch-readiness handover, package H2.

- **Voice only, in text.** Each call is the transcribed text Retell would send,
  driven through the real turn pipeline (`src/lib/assistant/turn.ts`
  `answerTurn`: card cut, urgent screen, language screen, guard) and the real
  production request (`responder.ts` `modelRequest`: the voice model, its
  token limit, low effort, the cache breakpoint).
- **Inbound only.** The caller always starts the call. Nothing here contacts
  anyone.
- **Synthetic only.** Every caller is generated (made-up first names, numbers
  in the 555-01xx fiction range); the practices are made up. Never real
  transcripts: we keep none.

## Pieces

| File | What it is |
|---|---|
| `rubric.ts` | Seven skills, each a checkable claim scored 0-3 or n/a: feeling first, spoken brevity, one question at a time, confirms details back, honest "I don't know, let me get the team", no over-apologising, natural close. Plus a note per specialty (med-spa, plastic-surgery, fertility, dental, hair-restoration, veterinary, massage-chiro). |
| `scenarios.ts`, `scenarios/*.json` | 30 callers per specialty (210): anxious, rushed, rambling, price-shopping, angry, hard of hearing, wrong number, cut-off-and-redial, interrupting, across five intents. The JSON is what runs; `npm run voice-eval:scenarios -w @healdesk/app` regenerates it deterministically, and a test fails if file and generator differ. |
| `clinics.ts` | One synthetic practice per specialty, as `assistantFacts` would read it, with questions its facts deliberately leave unanswered. |
| `caller.ts` | Caller simulator, Claude Haiku 5.5 (`claude-haiku-5-5`). Told never to describe emergencies or symptoms, never give card details, English only. |
| `conversation.ts` | One call (two for a cut-off) through `answerTurn`. |
| `judge.ts` | Judge, Claude Opus 5.5 (`claude-opus-5-5`), structured output. Grades only the lines the model wrote; fixed lines (AI opening, urgent, guard, failure) are labelled and not graded. |
| `report.ts` | Per-skill, per-specialty, per-caller-type, per-scenario and per-split scores with 95% intervals, the guard's replacement rate, spend; `history.jsonl` and `trend.md` across runs. |
| `hillclimb.ts` | Train/validation loop that may change only the tone sentence (`prompt.ts` `TONE.warm`). |
| `tone.ts` | The tone swap and the off-limits screen. |
| `safety-gate.ts` | Runs the deterministic safety suites plus `tests/voice-eval-tone-gate.test.ts` on each candidate. |
| `cost.ts`, `client.ts` | Cost estimator, spend gate, mock and live clients. |

## Running it

```bash
# Dry run: scripted fake model replies, no network, no key, no spend.
npm run voice-eval -w @healdesk/app -- run --dry-run --specialty dental --limit 5
npm run voice-eval -w @healdesk/app -- hillclimb --dry-run --rounds 2 --limit 6

# What a paid run would cost, and the id that approves exactly that plan.
npm run voice-eval -w @healdesk/app -- estimate                          # full run
npm run voice-eval -w @healdesk/app -- estimate --plan hillclimb --rounds 3
```

Flags: `--specialty a,b`, `--limit N` (scenarios per specialty), `--reps N`,
`--rounds N`, `--assumed-turns N` (dry run and estimate), `--concurrency N`,
`--label NAME`. Output goes to `apps/app/.voice-eval/` (gitignored), or
`VOICE_EVAL_OUT_DIR`. A dry-run's scores test the plumbing, not the assistant;
every dry-run report says so.

### The paid path (the owner approves the first spend)

`run` and `hillclimb` without `--dry-run` refuse to make any API call unless
**both**:

1. `VOICE_EVAL_CONFIRM_SPEND` equals the estimate id printed for the same
   flags (the id binds the plan, its size to the cent, and the price table:
   change any and you need a new approval), and
2. `VOICE_EVAL_ANTHROPIC_API_KEY` is set: a developer's own key, deliberately
   **not** `ANTHROPIC_API_KEY`, the patient-data organisation's key.

The SDK is not even imported before that check passes. A running run stops
itself once measured spend passes 1.5 x the estimate + $1, and fails any
response served by a different model than requested. Per-case results carry
the real `usage`, so the first paid run replaces the estimate's assumptions
with measurements.

### Measured estimate (dry run, 21 October 2026)

| Plan | Agent (Sonnet 5.5) | Caller (Haiku 5.5) | Judge (Opus 5.5) | Proposer | Total | No-cache bound |
|---|---|---|---|---|---|---|
| Full run, 210 calls, 6 caller turns | $3.25 | $0.07 | $7.94 | - | **$11.25** | $13.30 |
| Same at 4 / 8 caller turns | | | | | $10.50 / $11.69 | |
| Hill-climb, 3 rounds (4 passes of 210) | $13.00 | $0.29 | $31.75 | $0.22 | **$45.25** | $53.45 |
| First pass, `--limit 10` (70 calls) | | | | | **$3.80** | $4.52 |

Assumptions (printed with every estimate): input tokens = characters / 4 of
the real requests the dry run built (about +-20% against the real tokenizer);
output per call, thinking included, agent 150, caller 60, judge 1,500,
proposer 3,000 tokens; the agent's stable prompt cached per conversation;
first-party list prices from the claude-api skill (cached 2026-10-06), cache
writes 1.25x and reads 0.1x input. The judge's output is the largest and
least certain term (about 70% of the total).

## How tuning cannot weaken safety

- The proposer may replace one sentence, `TONE.warm`, and nothing else.
  `applyTone` throws unless swapping the candidate back gives the production
  prompt byte for byte.
- `validateToneCandidate` rejects any candidate that mentions a guardrail's
  subject (prices, clinical matters, payment, bookings made, call-backs,
  emergencies, being human, languages, compliance, the rules or prompt) or
  carries structure (newlines, braces, brackets) or digits.
- Before a candidate runs, the safety gate must pass with no failure and at
  least as many passing tests as for the production tone:
  `tests/safety-suite.test.ts`, `tests/safety-suite-voice.test.ts` (runs when
  `TEST_APP_URL` points at a test database, skips otherwise) and
  `tests/voice-eval-tone-gate.test.ts` (prompt invariants and identical
  urgent/guard/injection outcomes under the candidate).
- A candidate is kept only if the **validation** mean (scenarios the proposer
  never read) rises by more than 2 points **and** the guard does not replace
  a larger share of answers (within 1 point): a friendlier tone that makes the
  model say more things the guard must catch is not an improvement.
- Nothing is written into `prompt.ts`. The winner is `best-tone.json`; adopting
  it is a reviewed code change, gated by the safety suites in CI.

## Not covered (later)

Content-free production signals (booked, handed off, hung up early, turns per
call, response time); audio (latency, barge-in, TTS prosody); the clinical
tone setting; Spanish callers; the live-model safety probes (`qa:meta` is the
Meta channel's equivalent).

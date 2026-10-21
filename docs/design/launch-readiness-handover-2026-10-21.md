# Launch-readiness handover (written 2026-10-21, end of a long multi-agent session)

For a NEW Claude Code session (Opus 5.5 recommended) to finish what is left
before launch. Self-contained. `AGENTS.md` points here. Nothing in this file is
production-verified; every status says what was and was not run.

## Startup prompt (paste into the new session, repo root `healdesk.io`)

> Read `docs/claude-session-start.md`, `AGENTS.md`, `CLAUDE.md`, and
> `docs/design/launch-readiness-handover-2026-10-21.md`, issue the reading
> receipt, then work through the packages in that handover in order, starting
> with H0 (review each branch diff against a fresh database). Use
> `docs/design/builder-rules-2026-10-21.md` for every parallel builder (at most
> four at once; the machine load is very high). Do not push to `main`, deploy or
> flip any owner switch without the owner's explicit instruction.

## 1. Where everything is (GitHub, `liamariavisoiu-ai98/healdesk.io`)

`main` carried the DPA 1.0.0 release (migration 0104) and the Wave 0 audit
(`docs/wave0-audit-2026-10-21.md`). All other work of the session is on GitHub
as BRANCHES. Merge order and migration numbers matter.

| Branch | HEAD | What | Verified how | Migration |
| --- | --- | --- | --- | --- |
| `integ/wave0-fixes` (= `check/wave0-integration`) | c6820b04 | The merge of the eight branches below plus `origin/main` 2221a669, no conflicts | Each part was tested alone by its builder; the merged branch was NOT verified (the verifier died). CI on `check/wave0-integration` is the first merged-code run | 0105 |
| `pkg/alert-noaudio` | cfa58259 | ALERT-01: "I've told the team" only when an alert would really go out (`lib/notices/urgent-readiness.ts`); NOAUDIO-01: Retell agent writer, recording alerts, admin delete | its own targeted tests, own DB | 0105 `recording_alerts` |
| `pkg/safety-suite` | 186d9955 | SAFETY-01: deterministic injection/regression suite for web chat and voice (tests only) | own DB | none |
| `pkg/book-deposit` | 90af34a0 | BOOK-01/DEPOSIT-01: booking tools for voice + web chat, deposit link in web chat | own DB | none |
| `fix/screen-turn` | 459a1865 | urgent-symptom screen misses, cut-off JSON never sent raw, urgent alert in fr/de/it/pt, model deadline (voice 7 s, web chat 40 s), Settings card truthful | own DB; voice suite flaked under load | none |
| `fix/guard` | 551eeb89 | 23 output-guard defects (dosage, plans, guarantees, booking claims, card asks, outbound promises, "told the team", off-list prices, other patients, spelled-out never-say) | own DB; 3 load flakes | none |
| `fix/deposit-gap` | 6314219c | `collect` booking stored as `pending_link` in its own transaction + a sweep that flags unlinked deposits for staff after 10 min | own DB | none |
| `fix/retell-transcript` | d8ba9bff | Retell keeps the transcript until our copy is committed, then we delete the call (`everything`, retention 1 day); alert only if a delete still fails after 30 min; `/admin/recordings` kept as backstop | mocked fetch, own DB | none |
| `fix/legal-retell` | 05d99304 | minimal agreement edit: Retell holds a call's transcript/recording only until we have our copy (BAA 1.5.1, 1.6.0, DPA 1.0.0; hashes regenerated; counsel NOT reviewed) | catalog 1749/1750 (one 30 s timeout), app 348 passed | none |
| `pkg/voice-provisioning` | a5897cd6 | **WIP, unfinished, untested**: automated Retell number + agent per clinic, engine field default `custom`, spend guard, drift check | not run | 0106 `voice_agents` |
| `pkg/ended-early-redial` | 3a4baa16 | **WIP, unfinished, untested**: "ended early" flag + banner + short-lived redial record | not run | 0107 |
| `locations/foundation` | a33e8f18 | extra-locations L1 (per-location table, ack table), 2 stale tests fixed; **incomplete** | targeted | its own is now clashing: renumber to 0108 |
| `locations/copy-terms` | f0cf8480 | acknowledgement copy + "one central AYA" Terms, LEGAL_VERSION 2026-10-21.1 | complete, app/web/catalog tests | none |
| `copy/vet-dpa-wording` | fd08bef2 | veterinary/DPA wording across portal, email, checkout, demo | complete by its builder's test | none |

Migration plan (current highest on `main`: 0104): 0105 recording alerts (already
in `integ/wave0-fixes`), 0106 voice agents, 0107 ended-early, 0108 locations.
Renumber at merge time if the order changes; prove each with a fresh-DB migrate
from zero and `npx drizzle-kit generate` reporting no change.

## 2. Owner decisions that bind this work (21 October 2026)

- **Voice stays on the custom-LLM WebSocket endpoint.** Retell's native LLM is NOT pursued; the assessment is in `docs/design/voice-native-llm-migration-2026-10-21.md` (kept for a second track). The custom build is never deleted.
- **A window-gated reply to a patient's open request is allowed** (already in `CLAUDE.md`). **No call-backs and no outbound calls.** A call that ends early is flagged to the clinic; a redial is recognised.
- **`urgent-alert` stays `on`** in `launch.ts`. The owner adds `RESEND_API_KEY` in AWS Parameter Store (`infra/aws/scripts/put-external-secrets.sh RESEND_API_KEY` in CloudShell), rolls the web tier, and switches `billing-notices` on in `/admin/ops` (needs the operator password + authenticator; Claude cannot).
- **Retell keeps a call's transcript (and, unavoidably, its recording) only until our copy is sealed, then we delete the call; retention backstop 1 day.** The agreement text was minimally amended for that on `fix/legal-retell`, authorised by the owner, who confirmed no real practice has signed any version.
- Direct-booking switch, `voice_real_calls`, `HEALDESK_VOICE_PROVISION_ENABLED`, the addendum approval and the gateway connection are the OWNER's. Never set them.

## 3. Work packages, in order

### H0 (first): review every diff against a fresh test database
The owner asked for this explicitly. Branch by branch, **starting with
`pkg/alert-noaudio`** (it fixes the "I've told the team" problem). For each
branch: create your own worktree and a real `npm ci` install; start a FRESH
Postgres per the recipe in `builder-rules-2026-10-21.md`; migrate from zero;
read the whole diff (`git diff origin/main...<branch>`), not the summary; run
the targeted tests listed for it in section 1 against that database; list
what you could not run; fix only clear defects in a separate commit. Order:
`pkg/alert-noaudio`, `pkg/book-deposit`, `fix/screen-turn`, `fix/guard`,
`pkg/safety-suite`, `fix/deposit-gap`, `fix/retell-transcript`,
`fix/legal-retell`, then `integ/wave0-fixes` as a whole. For
`pkg/alert-noaudio` specifically confirm: `URGENT_ALERT_DELIVERED` is gone
(only comments mention it); `urgentAlertReadiness` is false when the
`billing-notices` job is off, or the email transport/key is missing, or no
recipient exists, and each case produces the honest wording on voice, web chat
and Meta; the alert is still queued as before; the setup and Settings screens
say "Urgent alerts are not switched on yet" when false; recording-alert tests
use mocked fetch only and unsigned `/api/ops` calls get 401. Also run
`tests/ops.test.ts` and `tests/patient-requests.test.ts` (they could not load in
the builders' worktrees because of the module-resolution trap), `rls-drift`,
`tenant-isolation`, `tsc` in all three workspaces and eslint on changed files.
Check the GitHub CI result for `check/wave0-integration` once; do not poll.

### H1: finish the two stopped builders (specs below)
Resume from `pkg/voice-provisioning` and `pkg/ended-early-redial` (WIP commits;
read what exists before adding).
- **PROVISION-VOICE.** Tenant-scoped table `voice_agents` (engine `custom|native` default `custom`, Retell agent id, LLM id, number E.164, status, config hash, last synced, last error, attempts). Pg-boss job, idempotent and crash-safe (adopt an existing number, never buy twice): for a clinic with a PAID first invoice and a voice plan, create or buy the Retell number, create the agent through `lib/voice/retell-agent.ts`, attach it, set the fallback number to the direct line, set the webhook, record it. **Spend guard:** no Retell call that costs money unless `HEALDESK_VOICE_PROVISION_ENABLED=1` (default off) and under `HEALDESK_VOICE_PROVISION_DAILY_CAP` (default 20). Sync on change by config hash (knowledge, prices, hours, never-say live in our DB and cause NO Retell call under the custom engine). Nightly drift check + ops projection `voiceAgentStatus` (ids/status/times only). Deprovision on offboarding. `verifyVoiceAgent` never places a call. Engine `native` returns a typed `not_implemented`.
- **ENDED-EARLY-REDIAL.** Classify technical or abrupt endings (`disconnection_reason` technical set from Retell's docs, verify with Context7, plus our own signals: live socket died, backstop recorded the call). Flag: fixed banner "This call ended unexpectedly. The caller may want a call back." in the transcript email, marker in Conversations, count pointer on Home, alert with the same truthfulness gating as ALERT-01. **Redial:** only for ended-early calls, keep the last at most 6 turns, sealed with KMS, keyed by an HMAC of the caller number (never the plain number), retention 2 hours, deleted on first use or by a sweep, audit row on use, tenant RLS; a new call from the same number within the window adds a fixed "you were cut off" block to the prompt; the AI + transcription line still comes first. No outbound contact anywhere.
Acceptance for both: tests listed in each branch's WIP commit message and
the original brief themes (mocked fetch, DB-backed, RLS and tenant isolation,
`/admin/map` true). Do not touch `launch.ts` statuses.

### H2: voice eval package (soft skills)
Goal: improve tone and conversation quality of the voice agent without
weakening safety. Build under `apps/app/scripts/voice-eval/` (+ tests) and a
README: (1) a rubric (acknowledges feeling before facts; short spoken
sentences, no lists; one question at a time; confirms names/dates/numbers back;
says "I don't know, let me get the clinic" instead of bluffing; no
over-apologising; natural close), with a variant per specialty (med-spa,
plastic-surgery, fertility, dental, hair-restoration, veterinary,
massage-chiro: see `packages/catalog/src/specialties.ts`); (2) a scenario
library of 20 to 50 synthetic callers per specialty (anxious, rushed, rambling,
price-shopping, angry, hard of hearing, wrong number, cut-off-and-redial,
interrupting); (3) a caller simulator (Haiku 5.5, `claude-haiku-5-5`) that
drives the REAL turn pipeline (`lib/assistant/turn.ts` with the real guard and
urgent screen) in text; (4) an LLM judge (Opus 5.5, `claude-opus-5-5`) scoring
each transcript against the rubric, with per-skill, per-specialty and
per-scenario scores and a trend report; (5) a hill-climb loop with a
train/validation split so a prompt change is kept only if validation rises (use
the `claude-api` skill's `build-eval` and `hillclimb` guides); (6) the
deterministic safety suite stays separate and runs alongside, so tuning tone can
never weaken a guardrail. Expected cost per full run: roughly $5 to $10 (an
estimate; measure and report it, and get the owner's approval before the first
run that spends money). It must use only synthetic data and never real
transcripts (we delete them). Content-free production signals (booked, handed
off, hung up early, turns per call, response time) are a later add.

### H3: patch the customer-facing "no call audio is kept" statements
Now false in the sense that Retell briefly holds call data. Suggested truthful
wording: "healdesk keeps no call audio. Our voice provider holds a call's
transcript and recording only until we have the transcript, and for no more than
a day." Places found (verify each, line numbers drift):
`apps/web/src/app/terms/page.tsx` (~296, ~878), `apps/web/src/app/privacy/page.tsx` (~450),
`apps/web/src/lib/subprocessors.ts` (~141-156), `apps/app/src/lib/support/help-text.ts` (~92),
`apps/app/src/lib/compliance/disclosure.ts` (~66 and ~158; pinned by
`tests/compliance.test.ts` and `tests/retell-voice.test.ts`; quoted in
`how-aya-is-built-to-behave.ts`, `ai-call-transcription-consent-by-state.ts`,
`state-ai-disclosure-and-consent-tracker.ts`), `apps/web/src/lib/content/pieces/how-aya-is-built-to-behave.ts` (~238, says
"recording storage off": plainly wrong), `does-an-ai-receptionist-have-to-say-it-is-an-ai.ts` (~430),
`packages/catalog/src/operator-notices.ts` (~208), `apps/web/src/lib/admin/seo/launch.ts`
(~108, text only, status stays `building`), `apps/web/src/app/admin/recordings/page.tsx`,
`README.md` (~68), `CLAUDE.md` (~100, ~357), `docs/hipaa-compliance.md` (~53),
`docs/hipaa-risk-analysis.md` (~47), `docs/counsel/state-disclosure.md` (~104). The
spec export (`docs/v1-product-spec.md` ~724) is the OWNER's to change through its
source doc; list the exact sentence. **Collision:** Terms/Privacy changes are a
legal-version flow (`LEGAL_VERSION`, pinned hashes). `locations/copy-terms` already moves
the Terms to 2026-10-21.1; do this patch AFTER or WITH that branch and regenerate
the pins once. The BAA/DPA texts were already amended on `fix/legal-retell`; do not
touch them again. Use the "copy first, then the switch" rule: phrase as design
("is designed to"), and keep `no-audio` `building` in the register.

### H4: Spanish in the urgent screen
Today the urgent screen reads English plus French, German, Italian and Portuguese
(`packages/catalog/src/urgent-content.ts`; `fix/screen-turn`): such a message gets the
fixed 911 response with a bilingual language line AND a clinic alert. Add Spanish:
urgent and complication phrasings (post-filler: blanched/white lip or skin,
vision loss or blur, trouble breathing, swelling of face/tongue/throat, chest pain,
fainting, severe pain, infection, bleeding that will not stop, severe allergic
reaction; and pet-emergency phrasings for veterinary clinics), with accents
and without ("dolor", "hinchazon"), common misspellings and informal
forms (Latin American and Peninsular), plus the fixed Spanish emergency line
("llame al 911" in the US) in the language line. It applies to chat, voice
and Meta. Tests: table of Spanish cases flipped from miss to urgent in the
safety cases (`apps/app/tests/setup/safety-cases.ts`) for both channels, ordinary
Spanish booking questions that must NOT trigger (the owner's rule: a
pre-treatment question is a deliberate decision, see the existing swelling
test), and the alert path. AYA still does not converse in Spanish unless the
spec says otherwise: ask the owner. **Two open owner questions from the
builder:** (1) should every message in a language the assistant does not answer in
raise a clinic alert? (2) should the practice runner count other-language urgent
hits as urgent? Default until answered: no to (1), yes to (2), documented.

### H5: land the locations and copy branches
Order: `locations/copy-terms` -> `copy/vet-dpa-wording` -> `locations/foundation`
(renumber its migration to the next free number, expected 0108; fix every
comment/doc naming 0105 for it; fresh-DB proof). The builder reported ten
overlapping files between foundation and vet-wording, so expect conflicts.
Foundation is incomplete: finish L1 then rewire `addLocation` (see memory note
"Extra locations: step 8"). `LOCATION_CLINICS_READY` stays false until the owner
decides the rollout.

### H6: security hygiene and dependency upgrade
`docs/design/security-hygiene-brief-2026-10-21.md` (SEC-01: boundary guard
tests, CI naming the security suites, gitleaks, dependabot/npm audit, CodeQL).
Another session holds `pkg/security-hygiene` and the memory note "SEC-02
dependency upgrade approved, not started: wait for the owner's go": do not start
SEC-02 without the owner's "go" and check that branch first.

### H7: test debt and register hygiene
Find the cause of the `setup-wizard.test.ts` "one on day 5" failure (it fails on
unmodified `main`; a hard-coded 20 October date is the suspect). Raise the hard 5 s/30 s
timeouts on `go-live`, `practice-questions-db`, `stripe-connect-webhook` and the
catalog "names other clauses" test, or fake time. Tune the guard's
over-blocking against honest sentences (any non-dollar currency, any undenied
"guarantee", "twice a day", "another patient/clinic" wording). Add accessibility and
mobile tests for the web chat widget; a test for `lib/admin/seo/health.ts`. Register
and map: `baa-chain` omits AWS though `vendor-coverage.ts` requires it; `/admin/map` does not
mention the DPA; `plans.ts` L88-94 says nothing reports usage to Stripe but
`usage-report.ts`/`annual-overage.ts` run in `scheduler/tick.ts`. Stored
alert wording in the portal: during the 10-minute grace a crashed deposit booking
can show "payment link sent".

### H8: live checks that need the owner's accounts (prepare, do not run alone)
On the demo clinic only: the exact Retell custom-LLM `response_engine` field names
(`{type:"custom-llm", llm_websocket_url}`, unconfirmed); delete-call behaviour and
what it deletes; `data_storage_retention_days` behaviour; whether webhooks carry
the transcript; a real call reaching `src/voice/server.ts`; `npm run qa:meta`
with a live Anthropic key; a real-model run of the new booking prompts (the
action field never ran against a real model). Retell's written answers on LLM
subprocessors are no longer on the critical path (custom engine) but the
retention questions in `docs/design/retell-written-terms-request-2026-10-21.md`
still are.

## 4. Owner-only actions (Claude must not do these)

1. Add `RESEND_API_KEY` in AWS (above), roll the web tier (`deploy-app.yml` restart), switch `billing-notices` (and `daily-summary`, `weekly-recap`) on in `/admin/ops`; set the alert recipients.
2. Run `deploy-app.yml` so migrations 0104 and 0105 (and later 0106+) reach the host. **Hazard:** once `main` carries the amended agreement text, `apps/web` (Vercel auto-deploys `main`) renders the new text while the old `apps/app` image still re-renders the old one; the import re-render-hash check then rejects a signed agreement and the provision dead-letters (replayable). Deploy the app image promptly after the web deploy, or pause checkout in between.
3. Record the vendor attestations on `/admin/compliance` (Retell, Anthropic, database host, AWS) with evidence; `enable_voice` + secret + demo call, then `voice_real_calls`; set `HEALDESK_VOICE_PROVISION_ENABLED` only when ready to spend.
4. Direct-booking switch, addendum approval, clinics' Stripe Connect, Google scopes and verification (unverified apps are user-capped), Meta business verification and review, live `stripe:setup`, restore drill, WAF/multi-AZ/second web task (+about $27 a month), branch protection and GitHub security settings, SEO owner steps, final launch attestation. BAA 1.6.0 release or counsel review (`baa-1-6-0-retention`).
5. Source-doc edits: the spec's voice sentences about recording/transcript retention.

## 5. Traps

- Module-resolution trap (symlinked `node_modules`): see `builder-rules-2026-10-21.md`.
- Machine load is extreme; fresh Docker Postgres per builder, unique names/ports; remove stale containers.
- Do not stage in a shared index; use your own worktree. `apps/app/Dockerfile` may show as modified in the main checkout from another session; leave it.
- The audit's own corrections: product mail goes through Resend (transcripts through SES); `turbo.json` has `//` comments (fine); the Meta window-gated reply is allowed.
- Session-restart note: three builders (verification, provisioning, ended-early) died with the previous session; this handover replaces them.

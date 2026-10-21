# Live checks checklist (H8), prepared 21 October 2026

For the OWNER to run later, on the demo clinic only, with the owner's own
accounts. Written by reading the code; **nothing in this file has been run**.
Writing it made no network call, no vendor API call and set no environment
variable or switch.

- Source: `integ/wave0-reviewed` at `85c4128b` (branch `pkg/live-checks`). The
  voice files named below (`retell-agent.ts`, `recording-alerts.ts`) exist on
  that branch and **not on `main`**. Line numbers refer to that commit.
- Anything marked **UNCONFIRMED** is an assumption about Retell's or
  Anthropic's behaviour that the code makes and no source here proves. Confirm
  it against the vendor's current documentation (Context7 or their site) and
  the owner's account, then record the answer in the results table.
- **NOT FOUND IN CODE** means exactly that. Nothing has been guessed.

---

## 0. Ground rules

- **Demo clinic only.** The BAA-workspace demo clinic is the one where
  `app_clinic_is_demo()` is true (`apps/app/src/lib/booking/terms.ts:197`,
  `isDemoClinic`; created by `apps/app/scripts/demo-clinic.ts`). The marketing
  demo agent on `apps/web` is a different Retell workspace with its own key
  (see section 4, item 6). Do not run these checks against it.
- **Synthetic caller content only.** Any words said on a test call, or typed
  into a test, use invented people and invented numbers in the 555-01xx range,
  for example "This is a test caller, can I book a consultation on Tuesday?".
  Never a real person's name, number, symptom or treatment.
- **Owner switches Claude must not set, and this checklist does not need Claude
  to set:** `HEALDESK_VOICE_REAL_CALLS` (`lib/voice/test-calls.ts:40-42`),
  `enable_voice` and `voice_real_calls` (Terraform), `HEALDESK_VOICE_PROVISION_ENABLED`
  (not on this branch), `HEALDESK_DIRECT_BOOKING_ENABLED` (owner's kill switch),
  the addendum approval, the gateway connection, `billing-notices` in `/admin/ops`.
- **Keys, by name only:**
  - `HEALDESK_RETELL_API_KEY`: the BAA workspace's Retell key, read by
    `apps/app` (`lib/voice/retell-api.ts:47-51`). Never the marketing site's
    `RETELL_API_KEY`, which is another workspace.
  - `HEALDESK_RETELL_LLM_SECRET`: the path secret in the agent's socket URL.
    Between 16 and 200 characters, no `/` and no whitespace
    (`server.ts:46`, `retell-agent.ts:59`).
  - `ANTHROPIC_API_KEY`: healdesk's patient-data organisation key
    (`lib/assistant/responder.ts`, header).
  - `HEALDESK_VOICE_MODEL`, `HEALDESK_CHAT_MODEL`: optional overrides; each must
    name a member of `PATIENT_MODEL_IDS` or it is ignored with a warning
    (`responder.ts`, header).
  - `BETTER_AUTH_URL`: the public https origin the agent's URLs are built from
    (`retell-agent.ts:87-98`).
  - `DATABASE_URL`: only for the local test runs in step 1 and the voice task.
- **Paste-back rule.** Paste field names, status codes, counts, PASS or FAIL,
  and seconds. Never paste: an API key; the agent's socket URL (it contains the
  secret); a webhook signature header; a transcript or any words a caller said;
  a phone number; a recording URL; a clinic's or person's name. Save raw
  responses to a local file outside the repo, read them, delete them.
- Read Retell keys from the environment (exported from the password manager),
  not typed inline, so they stay out of shell history.

---

## 1. Run sheet (ordered: cheapest and safest first)

| Step | Check | Needs a call? | Spends money? | Owner time |
| --- | --- | --- | --- | --- |
| 1 | Local targeted tests (mocked fetch) | no | no | minutes |
| 2 | A. Read back the demo agent (`GET /get-agent`) | no | Retell API (rate NOT FOUND IN CODE) | minutes |
| 3 | B. `npm run qa:meta` with a live Anthropic key | no | Anthropic tokens | minutes |
| 4 | C. Real-model run of the booking `action` field | no | Anthropic tokens | hours to build a harness |
| 5 | D. One real call reaching `src/voice/server.ts` | yes | Retell minutes, Sonnet tokens, the voice task | half an hour |
| 6 | E. Webhook and transcript under each `data_storage_setting` | yes (three) | Retell minutes | an hour |
| 7 | F. `delete-call`: what it removes, and the 404 meaning | yes (use the calls from E) | Retell minutes already spent | half an hour |
| 8 | G. `data_storage_retention_days` = 1 | yes (one, left undeleted) | none beyond that call | wait more than 24 hours |

Stop the run at the first FAIL in steps 2, 5 or 7 and fix it before going on.
Steps 2, 6 and 7 touch the demo agent's storage settings and calls; do not run
them on any agent that serves a real clinic.

### Step 1: local targeted tests (no network)

These use mocked fetch and do not change anything at Retell. Some suites need
the database (the `test:db` recipe in `apps/app/package.json`); the ones named
here are mocked.

Run from `apps/app`, for example
`npx vitest run tests/recording-alerts.test.ts tests/retell-voice.test.ts tests/voice-test-calls.test.ts tests/voice.test.ts`.
Files exist at `apps/app/tests/recording-alerts.test.ts`,
`apps/app/tests/retell-voice.test.ts`, `apps/app/tests/voice-test-calls.test.ts`,
`apps/app/tests/voice.test.ts`.

Expected: all pass. Paste back the pass and fail counts. A pass proves only that
the code agrees with itself; it proves nothing about Retell. That is why the
live checks exist.

---

## 2. The checks

### A. Retell agent read-back (response engine and storage field names)

**1. What it proves.** Retell keeps, and returns under the names the code uses,
the four fields the code writes for every clinic's agent: `response_engine`,
`data_storage_setting`, `data_storage_retention_days`, `webhook_url`. Retell
answers 200 for a field it renames or ignores, so a passing write proves nothing
on its own. The read-back is the only check the code has
(`retell-agent.ts:216-221`, `mustHold`, and the comment there).

**2. Prerequisites.**
- `HEALDESK_RETELL_API_KEY` (BAA workspace), exported in the shell.
- The demo agent's Retell `agent_id`. **Nothing in this branch creates the
  agent in production:** `createRetellAgent` (`retell-agent.ts:229`) is called
  only from tests (`apps/app/tests/recording-alerts.test.ts`). The owner
  creates the demo agent in Retell's dashboard, or by a one-off script that does
  not exist in the repo (NOT FOUND IN CODE).
- The demo clinic's UUID (for the expected `webhook_url`) and `BETTER_AUTH_URL`.

**3. Steps.**
1. `curl -sS -H "authorization: Bearer $HEALDESK_RETELL_API_KEY" https://api.retellai.com/get-agent/<agent_id> -o <private file outside the repo>`
   (save to a private file outside the repo). The code's own read is `verifyRetellAgent`
   (`retell-agent.ts:280-287`) on `/get-agent/<id>`, with the origin
   `RETELL_API_ORIGIN = "https://api.retellai.com"` (`retell-api.ts:26`).
   **UNCONFIRMED:** that this path and origin are Retell's current GET path.
2. Read the top-level keys `response_engine` (with `type` and
   `llm_websocket_url`), `data_storage_setting`, `data_storage_retention_days`,
   `webhook_url`. Compare with what `retellAgentSettings` writes
   (`retell-agent.ts:138-143`).
3. Redact `llm_websocket_url` before pasting anything.
4. Delete the saved file.

**4. Expected.**
- `response_engine.type` = `custom-llm` (`retell-agent.ts:117-122`).
- `data_storage_setting` = `everything` (`retell-agent.ts:47`).
- `data_storage_retention_days` = `1` (`retell-agent.ts:50`).
- `webhook_url` = `https://<BETTER_AUTH_URL host>/api/webhooks/retell/<clinic uuid>`
  (`retell-agent.ts:140`).
- **UNCONFIRMED:** that `response_engine` and `llm_websocket_url` are Retell's
  field names. The code uses them as fact; `retell-agent.ts:28-31` does not mark
  them unconfirmed; CLAUDE.md:322-323 says "never tested against
  Retell itself".

Record: each field present (yes or no); `type` value; `data_storage_setting`
value; retention value; `webhook_url` matches yes or no. Never the URL or secret.

**5. What a FAIL means.**
- A field missing or renamed: Retell's API differs from the code. Change the
  field names in `retell-agent.ts` (`retellAgentSettings`, `checkRetellAgent`,
  `sameEngine`) and the tests that pin them. Do not set `engineIsOurs` true by
  hand.
- `data_storage_setting` reads `basic_attributes_only`, or the setting is
  missing: Retell keeps no transcript for this agent. The crash backstop
  (`lib/voice/backstop.ts`, `fetchRetellCall`) would find no words, so the
  clinic gets no transcript email. Fix with `updateRetellAgent`
  (`retell-agent.ts:258`) or in Retell's dashboard, then rerun A.
- Retention missing or not 1: Retell keeps the call's data indefinitely by
  default (`retell-agent.ts:191-192`). Do not let a real call through.
- `webhook_url` differs: the agent is not wired to our route; check
  `BETTER_AUTH_URL` (CLAUDE.md, "Deployment").

**6. Cost and who pays.** A Retell API read. Retell's pricing for it is NOT
FOUND IN CODE. The owner's Retell account pays.

---

### B. `npm run qa:meta` with a live Anthropic key

**1. What it proves.** That the **Meta front door** prompt still refuses to act
as a hallway, that its replies pass the same deterministic guard the webhook
applies, and that the first reply holds no second greeting or AI
self-introduction (`scripts/meta-qa-gate.ts:1-44`).
**Scope limit:** it does not test the voice agent, the web chat, or the booking
tools. The front door has no tools and no search (`lib/meta/front-door.ts:1331`),
so it can never exercise the `action` field. The owner should not read a pass
here as evidence for H8's booking check.

**2. Prerequisites.**
- `ANTHROPIC_API_KEY` in `apps/app/.env.local` (the script loads it with
  `--env-file-if-exists=.env.local`, `apps/app/package.json:29`).
- `npm ci` in the owner's checkout (not run by Claude).
- Model: `claude-opus-5-5` for channel `meta`, with no environment override
  (`responder.ts`, `MODEL_CONFIG.meta`, `modelEnv: null`).

**3. Steps.** From the repo root:
`npm run qa:meta -w @healdesk/app`. The probe list is `FRONT_DOOR_PROBES`
(`lib/meta/front-door.ts:1681`); count it at run time (14 entries appear in the
first 20 lines of that block, so the total is larger).

**4. Expected.** One `PASS` or `FAIL` line per probe and a final `N/N passed`
line, exit code 0 (`scripts/meta-qa-gate.ts:93-94`). Paste back: the final line,
and each probe's id with `PASS` or `FAIL`. The script prints the first 160
characters of each reply; do not paste those, because a reply may quote the
probe. The clinic facts in the script are invented (Radiance Med Spa, a 555
number), so the replies contain no real data, but still paste only ids and
verdicts.

**5. What a FAIL means.** A probe that fails is a quality regression, not a
leak: production replaces a failing reply with the fixed hand-off line
(`meta-qa-gate.ts:25-31`). A model refusal counts as a failure
(`meta-qa-gate.ts:72-76`). Fix in the prompt (`buildFrontDoorPrompt`,
`lib/meta/front-door.ts`) or, if the guard is over-blocking an honest reply, in
`lib/assistant/guard.ts` with a test. Do not loosen the guard to make a probe
pass. Exit 1 means the gate failed.

**6. Cost and who pays.** One Opus call per probe, on healdesk's own Anthropic
key (billed to healdesk, so the owner pays). The rate is NOT FOUND IN CODE. The
script's own header says it "costs real tokens" (`meta-qa-gate.ts:27`).

---

### C. Real-model run of the booking `action` field

**1. What it proves.** That the model, given the booking-tools prompt, returns
the `action` object the tool layer acts on, and that the code reads it. Today
the field has only ever been exercised by mocked responders. The handover says
it never ran against a real model.

**2. Prerequisites.**
- `ANTHROPIC_API_KEY`.
- Voice model: `HEALDESK_VOICE_MODEL` unset (default `claude-sonnet-5-5`,
  `responder.ts:106`) or a `PATIENT_MODEL_IDS` member. Web chat:
  `claude-opus-5-5` (`responder.ts:97`).
- The demo clinic must have a booking path the tool layer can answer
  (`lib/assistant/booking-tools.ts`). Whether the demo clinic has a Google
  Calendar connected is NOT FOUND IN CODE; use the demo calendar only, never a
  real practice's.
- **No committed harness exists on this branch.** The intended harness is in
  `pkg/voice-eval` (H2), which is not merged, and it is not in
  `integ/wave0-reviewed` (NOT FOUND IN CODE). The owner either builds a small
  harness on that branch, which calls the real turn pipeline `answerTurn`
  (`lib/assistant/turn.ts`, around line 481 where `tools.run` is called) in
  text, or runs it through the demo clinic's web chat with synthetic messages.

**3. Steps.**
1. Message 1 (synthetic): "I'd like a consultation next Tuesday morning."
   Expect the model to ask for times with `"action"` of type `find_times`,
   with `service` and `day` (`lib/assistant/prompt.ts:118-119`, the `ACTION`
   constant; the booking text is at `prompt.ts:116`, `BOOKING_TOOLS`).
2. Message 2 (synthetic): "The 10 o'clock one, please." Expect `"action"` of
   type `choose_time` whose `at` equals the exact value the tool layer gave
   for that time.
3. Check that the model's raw JSON parses (`lib/assistant/turn.ts:324`,
   `parseToolAction`), and that a parse failure is not counted as a pass:
   `malformed: true` is set when the object does not parse (`turn.ts:330`).
4. Check that no reply says "booked", "held", "reserved" or "confirmed"
   (`prompt.ts:116` forbids it; the tool layer says that itself).

**4. Expected.** Per turn, the action type or `null`, parse succeeded (yes or
no), the `at` value matches an offered time (yes or no), and the forbidden-word
check (yes or no). **UNCONFIRMED:** that the real model follows the schema every
time; that is what this check measures.

**5. What a FAIL means.**
- `action` is `null` when a time was asked for: the prompt wording
  (`prompt.ts:116-120`) or the model is at fault. Adjust wording and add a test
  on the prompt's text.
- `malformed` is true: the model's JSON is wrong or was cut off at the token
  limit (`responder.ts`: voice 400 tokens). Raise the limit only with the owner's
  approval for its cost, or shorten the prompt.
- The model invents a time or says "booked": the tool layer must still refuse
  (`booking-tools.ts`). Add a fixture test; do not rely on the prompt alone.
- Never set `HEALDESK_DIRECT_BOOKING_ENABLED` to make this run pass.

**6. Cost and who pays.** Anthropic tokens on healdesk's key (rates NOT FOUND IN
CODE). A dozen turns is small. Any calendar read or write touches the demo
calendar, which the owner controls.

---

### D. One real call reaching `src/voice/server.ts`

**1. What it proves.** That Retell opens a WebSocket to the voice endpoint with
the agent's URL, that the process accepts it, runs the custom-LLM protocol
(`config`, `ping_pong`, `response_required` answered with `response`), and that
the greeting carries the AI and transcription line. It also proves the test-mode
gate: a call for any clinic that is not the demo clinic is refused or passed to
its direct line, with nothing recorded (`lib/voice/test-calls.ts:51-61`).

**2. Prerequisites (owner-only where marked).**
- **Owner:** the voice task is deployed with `enable_voice` (Terraform, off by
  default), or the owner runs `npm run voice -w @healdesk/app`
  (`apps/app/package.json:20`) and exposes it on a public `wss` address by a
  method NOT FOUND IN CODE.
- **Owner:** `HEALDESK_RETELL_LLM_SECRET` set in the voice process and in the
  agent's URL (16 to 200 characters, no `/`).
- **Owner:** `HEALDESK_VOICE_REAL_CALLS` **unset** (test mode). Claude must never
  set it.
- The demo agent from check A with `response_engine` pointing at the endpoint.
- The voice process needs `DATABASE_URL` (test-mode screen reads
  `isDemoClinic`, `test-calls.ts:53`).

**3. Steps.**
1. `GET /health` on the endpoint: expect 200 and `{"ok":true,"calls":0}`
   (`server.ts:81-84`).
2. From the owner's phone, call the demo clinic's Retell number and say the
   synthetic opening above.
3. Watch the process log for the lines `voice endpoint ready` and the per-call
   status (the code logs ids and outcomes, never the caller's words; server.ts
   header, and `retell.ts` comments).
4. Hang up. Check `GET /health` again: `calls` should be 0.

**The path the code expects:** `/llm-websocket/<secret>/<clinic uuid>/<call id>`
(`server.ts:46`, regex `PATH`). The agent is written with
`wss://<host>/llm-websocket/<secret>/<clinic uuid>` (`retell-agent.ts:122`), and
the code assumes Retell appends the call id. **UNCONFIRMED.** If Retell does not
append it, every upgrade gets 404 (`server.ts:102`).

**4. Expected.** The call is answered by the AI line within seconds. The first
words say it is an AI assistant and that the call is transcribed
(CLAUDE.md, product rules: "On calls the same line says the call is
transcribed"). The log shows the upgrade accepted. The call ends and `calls`
returns to 0. Paste back: health result; upgrade accepted (yes or no); seconds to
first words; disclosure spoken (yes or no); Retell's call status and
disconnection reason, without call ids.

**5. What a FAIL means.**
- 404 on the upgrade: path, secret or call-id mismatch. Compare the agent's
  `llm_websocket_url` (redacted) with `retell-agent.ts:122` and `server.ts:46`.
- 503: the secret is unset, or the process is draining (`server.ts:101`).
- The demo clinic answered but a real clinic's call was not: that is test mode
  working, and expected.
- The disclosure is missing or late: stop. It is a launch blocker and the
  greeting and `lib/compliance/disclosure.ts` need fixing before any real call.
- Retell ends the call with `error_llm_websocket_open`: the code's comment says
  Retell retries the socket three times and then ends the call
  (`lib/voice/retell-api.ts:6-9`). **UNCONFIRMED.**

**6. Cost and who pays.** Retell per-minute charges on the owner's Retell
account (rate NOT FOUND IN CODE); Sonnet tokens per turn on healdesk's key
(`responder.ts:106`); the voice task's running cost, which is NOT FOUND IN
CODE for this branch (the infra README gives only the lean profile's total).

---

### E. Webhook and transcript under each `data_storage_setting`

**1. What it proves.** Two things. (i) Whether Retell's `call_ended` and
`call_analyzed` webhook bodies carry a transcript under each storage setting.
(ii) Whether the backstop can read the transcript from Retell's call record,
which is what the code actually depends on.

**What the code depends on.** The webhook route reads only `event` and
`call.call_id` from the body (`apps/app/src/app/api/webhooks/retell/[clinicId]/route.ts:59-61`).
It queues the backstop for `call_ended` and `call_analyzed` only (`route.ts:65`,
`backstop.ts:110`). The backstop then reads the call with
`GET /v2/get-call/<id>` (`backstop.ts:175`) and turns `transcript_object` into
turns (`backstop.ts:196`, used at `:292`). So the webhook body's transcript is
**not** needed by the code. The `transcript` field in `retell.ts:110` belongs to
the custom-LLM socket, not to the webhook.

**2. Prerequisites.**
- Check A passed. The demo agent must be able to take each setting. The code
  writes only `everything` (`retell-agent.ts:47`); to test the others the owner
  changes the demo agent in Retell's dashboard, or sends a PATCH by hand.
  **UNCONFIRMED:** that `data_storage_setting` accepts `everything_except_pii`
  and `basic_attributes_only` on update (the code lists all three as Retell's
  values, `retell-agent.ts:53`).
- The webhook route on the public host with `HEALDESK_RETELL_API_KEY` set on the
  web tier (`route.ts:42-46`: 503 when unset).

**3. Steps.** For each setting in turn (`everything`, `everything_except_pii`,
`basic_attributes_only`):
1. Place one synthetic call and let it end.
2. `curl` `GET https://api.retellai.com/v2/get-call/<call id>` with the key from
   the environment. Note: whether `transcript_object` is present and non-empty,
   how many turns (a number only), and whether a recording field is present
   (the field name is UNCONFIRMED; the code never reads it).
3. Retell's webhook delivery log, if it has one, for the webhook body: does it
   carry a transcript? **UNCONFIRMED** that the dashboard shows this.
4. Our route's answer: the code returns 204 for a handled event (`route.ts:74`)
   and 401 for a bad signature (`route.ts:53`). A signature cannot be forged by
   hand (`retell-signature.ts`), so observe the answer through Retell's log, not
   by `curl`.

**4. Expected.**
- `everything`: `transcript_object` present and non-empty. The code's
  backstop and the clinic's transcript email depend on this.
- `basic_attributes_only`: no transcript. That is the code's own claim
  (`backstop.ts:80`, `retell-agent.ts:14-19`).
- `everything_except_pii`: transcript present with PII scrubbed. The code's
  comment says this would strip the name and number from the clinic's email
  (`retell-agent.ts:17-19`).
- Webhook body transcript: record present or absent per setting. **UNCONFIRMED**
  either way.

Paste back, per setting: transcript present (yes or no); turn count; recording
field present (yes or no); webhook body transcript (yes, no, or not visible).

**5. What a FAIL means.**
- `everything` has no transcript: the backstop turns an empty transcript into
  nothing (`backstop.ts:196-205`) and the clinic gets no transcript email. Fix
  the agent's setting, then rerun. Do not ship the transcript email on the
  strength of this check.
- `basic_attributes_only` has a transcript: the setting is not honoured as
  written, and the statement "keeps no transcript" in `retell-agent.ts:14-19`
  and the customer copy is wrong. Tell the owner before any real call.
- Route answers 401: the signature key differs from the one Retell signs with
  (`retell-signature.ts` header: `HEALDESK_RETELL_API_KEY` must carry the
  webhook badge).

**6. Cost and who pays.** Retell per-minute on three calls (rate NOT FOUND IN
CODE). Owner pays.

---

### F. `delete-call`: what it removes, and what 404 means

**1. What it proves.** That `DELETE /v2/delete-call/<id>` answers 204 on a call
that exists, that the call is then gone from `get-call`, and what a second
delete answers. The code treats **both 204 and 404 as "gone"**
(`recording-alerts.ts:217`). That is a deliberate choice, and it has a trap: a
mistyped route also answers 404, so the 404 branch can hide a path error.

**2. Prerequisites.**
- A demo call from E, which the owner is sure is a demo call.
- `HEALDESK_RETELL_API_KEY` in the environment.
- For the code's own call path, `deleteAtRetell(callId, deps)`
  (`recording-alerts.ts:203`) runs only after a conversation exists for the call
  (`deleteRetellCallAfterIngest`, `recording-alerts.ts:238-248`). Use raw `curl`
  for this check so nothing is written to the clinic's audit log.

**3. Steps.**
1. `GET .../v2/get-call/<id>`: expect 200 (path per `backstop.ts:175`).
2. `DELETE https://api.retellai.com/v2/delete-call/<id>`: expect 204
   (`recording-alerts.ts:208`, `:217`). **UNCONFIRMED:** the path.
3. `GET .../v2/get-call/<id>` again: expect 404. **UNCONFIRMED.**
4. `DELETE` the same id again: expect 404.
5. `DELETE https://api.retellai.com/v2/delete-call-x/<id>` (a deliberately wrong
   route): if this also returns 404, the code's 404 branch cannot tell
   "already gone" from "wrong route". Record it and rely on step 3 for proof.
6. In Retell's dashboard, check whether the call's recording and transcript are
   still shown. **UNCONFIRMED** that the dashboard shows them.

**4. Expected.** 204, then 404 on `get-call`, then 404 on the second delete. The
wrong-route test answers something other than 204 (record the code). Paste back
each status code, the wrong-route status, and dashboard visibility (yes or no).

What delete removes: the code says "its recording, its transcript and its logs"
(`recording-alerts.ts:29-31`, `retell-agent.ts:14-21`). **No Retell source is
cited in code for that sentence.** Record what the dashboard shows as the
answer, and mark it UNCONFIRMED until the vendor's documentation confirms it.

**5. What a FAIL means.**
- 204 but `get-call` still 200: deletion is not what the code assumes. The
  alert window (`RETELL_DELETION_WINDOW_MS`, `recording-alerts.ts:58`) and the
  comments about deletion (`recording-alerts.ts:19-42`) rest on it. Stop and tell
  the owner. Do not mark H8 as passed.
- 404 on the first delete: either the call was already gone, or the path is
  wrong. Compare with step 1: if `get-call` was 200 before, the path is wrong
  (`recording-alerts.ts:208`).
- 401: the key is wrong or not the BAA workspace's.
- Wrong-route 404 and right-route 404 are the same: the 404 branch is unsafe
  without step 3. Report it; the fix is in `recording-alerts.ts:217` (check the
  body or re-read `get-call` after a 404).

**6. Cost and who pays.** No charge expected for a delete (UNCONFIRMED). The
minutes were spent in E. Owner pays.

---

### G. `data_storage_retention_days` = 1

**1. What it proves.** That Retell itself removes a call's data about one day
after it ended, when nothing else did. That is the backstop for any call the
code fails to delete (`recording-alerts.ts:32-34`, `retell-agent.ts:22-23`).
Retention accepts 1 to 730 days, and the code writes the minimum
(`retell-agent.ts:22`, from the comment "the least Retell takes").

**2. Prerequisites.** A demo call from E, deliberately **not** deleted; check A
showing retention 1; patience.

**3. Steps.** Note the call id and the end time. More than 26 hours later,
`curl` `GET .../v2/get-call/<id>`, and check the dashboard. Record the hours
elapsed, the status code, whether a transcript is present, whether the dashboard
still shows the call.

**4. Expected.** After about a day the call's data is gone or the call returns
404. **UNCONFIRMED** what Retell's answer looks like. Retention is a daily sweep
on Retell's side, so "about a day" is a window, not a moment.

**5. What a FAIL means.** Data still present after 26 hours: Retell's retention
does not do what the code and the agreement text say (`fix/legal-retell`; the handover
describes its text as saying Retell holds a call only until our copy is sealed,
with a one-day backstop. Read the amended BAA 1.5.1 and 1.6.0 and DPA 1.0.0 text
to confirm; this file did not read it). Stop and tell the owner before any real call.
The only remaining control would be the alert path (`recording-alerts.ts`).

**6. Cost and who pays.** None beyond the call in E. Owner's Retell account.

---

## 3. Retell's questions still open (from `docs/design/retell-written-terms-request-2026-10-21.md`)

The request draft is written for Retell's native LLM and still asks about
`basic_attributes_only`. The owner decided on 21 October 2026 to keep Retell's
default `everything` with one-day retention (handover section 2;
`retell-agent.ts:14-23`). Items 1 to 3 (LLM scope, subprocessors,
provider retention) concern the native LLM, which the handover takes off the
critical path. The open retention questions are these:

- **4a.** With `basic_attributes_only`, do `call_ended` and `call_analyzed`
  webhooks still carry the transcript? Check E answers the API half (the
  `get-call` record); the webhook body is still OPEN.
- **4b.** Which setting delivers a transcript in the webhook while keeping no
  recording? The code's reading is that `everything_except_pii` keeps the
  transcript but scrubs PII from it (`retell-agent.ts:14-19`), so it does not
  serve the clinic's email. OPEN with Retell.
- **4c.** What exactly does delete-call remove? Check F gives the status codes.
  The content of the removal is OPEN (the code's claim is UNCONFIRMED).
- **4d.** How long do backups of deleted data live? NOT FOUND IN CODE; OPEN.
- **Item 6 (failure behaviour) and item 7 (live control)** matter to the custom
  engine too: the code answers a failed or unreachable endpoint with the
  direct-line fallback (`retell-api.ts:6-18`) and can transfer a live call
  (`retell.ts:102`, `TRANSFER_LINE`). Whether Retell confirms that behaviour is
  OPEN; that is not a retention question.
- **Item 8 (breach-notification contacts and timelines)** is OPEN and not
  technical.

---

## 4. Results table (template)

Copy this table into the PR or the handover. Fill every row. Use NOT RUN where a
step was skipped, and say why.

| Step | Check | Date (UTC) | Run by | Environment (local or demo host) | Result (PASS, FAIL, NOT RUN) | What was observed (no patient data, no secrets) | Follow-up (file, owner decision) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Local targeted tests | | | local | | pass / fail counts | |
| 2 | A. Agent read-back | | | Retell API | | field present: response_engine ___ ; data_storage_setting ___ ; retention ___ ; webhook_url matches ___ | |
| 3 | B. qa:meta | | | local, Anthropic | | N/N passed; failing ids: ___ | |
| 4 | C. Booking action field | | | harness (to build) | | action types ___ ; parse ok ___ ; `at` matches ___ ; forbidden words ___ | |
| 5 | D. Real call to voice server | | | voice task | | upgrade accepted ___ ; seconds to first words ___ ; disclosure spoken ___ | |
| 6 | E. Transcript per setting | | | Retell API | | per setting: transcript ___ ; turns ___ ; recording field ___ ; webhook transcript ___ | |
| 7 | F. delete-call | | | Retell API | | 204 ___ ; get-call after 404 ___ ; second delete ___ ; wrong-route ___ | |
| 8 | G. Retention 1 day | | | Retell API | | hours elapsed ___ ; status ___ ; transcript present ___ | |

Status after the run: `local` / `committed` / `pushed` / `deployed` /
`live-verified`, stated for each step. A PASS on a mocked test is not a live
verification.

---

## 5. Where the code and the handover disagree

1. **The voice files are not on `main`.** `retell-agent.ts` and
   `recording-alerts.ts` exist only on `integ/wave0-reviewed` and the branches
   the handover lists. H8 does not name a branch. Run these checks against the
   integrated branch that is merged.
2. **`qa:meta` covers only the Meta front door.** `scripts/meta-qa-gate.ts`
   calls `anthropicResponder` (`lib/meta/front-door.ts:1334`), which has no tools.
   The handover's H8 wording could be read as testing the booking prompts. It
   does not. Check C is the only booking test.
3. **The Retell paths and field names are stated as fact in code.** The
   `response_engine` shape (`retell-agent.ts:117-122`), `/get-agent`
   (`retell-agent.ts:285`), `/v2/delete-call/` (`recording-alerts.ts:208`),
   `/v2/get-call/` and `transcript_object` (`backstop.ts:170`, `:175`) are not
   marked UNCONFIRMED. The handover marks only the `response_engine` names as
   unconfirmed; the others need the same mark.
4. **The deletion's content is asserted in code.** `recording-alerts.ts:29-31`
   says delete-call "removes the call record as a whole: its recording, its
   transcript and its logs". No Retell source is cited.
5. **The webhook does not carry the transcript into the code.** The handover
   asks whether webhooks carry it. The code never reads it from the webhook body
   (`route.ts:59-61`). The backstop reads the transcript from `get-call`
   (`backstop.ts:175`). The question that matters is the `get-call` one.
6. **The marketing demo agent contradicts the owner's storage decision.**
   `apps/web/src/lib/demo/sloane-voice.ts:62-63` writes
   `data_storage_setting: "basic_attributes_only"` with
   `data_storage_retention_days: 30`. That is a different workspace (the
   marketing site's key), not the BAA demo clinic, and the handover does not
   mention it. The owner should decide whether it changes, because the public
   demo is "a clinic's own demo" to visitors.
7. **The written-terms draft is out of date.** `docs/design/retell-written-terms-request-2026-10-21.md`
   item 4 asks about `basic_attributes_only` as the working setting. The code
   and the owner's 21 October decision use `everything` with one day.
8. **Retell's failure behaviour is stated as fact in a comment.**
   `lib/voice/retell-api.ts:6-9` says Retell tries the socket three times and
   then ends the call with `error_llm_websocket_open`. UNCONFIRMED.
9. **The 404 branch of delete is unsafe as written.** `recording-alerts.ts:217`
   treats 404 as "gone". A wrong route gives the same answer (check F, step 5).
   This is a code gap, not only a vendor question.

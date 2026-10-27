# No-audio deletion check: the owner's run sheet (27 October 2026, lane NOAUDIO-2)

For the OWNER to run, on the **demo clinic only**, from his own accounts. Written by
reading the code on `lane/noaudio-2`; nothing here has been run by Claude, and writing it
made no call to Retell or AWS and set no switch.

It proves the promise `no-audio` (`apps/web/src/lib/admin/seo/launch.ts`): healdesk keeps
no call audio, and the voice provider holds a call's transcript and recording only until
healdesk has the transcript, and for no more than a day. It reuses steps D to G of
`docs/design/live-checks-checklist-2026-10-21.md`, cut down to what the deletion needs.
The 22 October results file named in `AGENTS.md`
(`docs/design/live-checks-results-2026-10-22.md` on `pkg/live-checks`) is not in this
checkout, so nothing below assumes its answers beyond what `AGENTS.md` records: the
storage field names and values were read live, and the delete route answers a JSON 404
for a missing call and an HTML 404 for a wrong route.

Passing it does not move `no-audio` to `on`. That is the owner's word, in the commit that
records it.

## Ground rules

- **Demo clinic only**: the clinic where `app_clinic_is_demo()` is true
  (`apps/app/src/lib/booking/terms.ts`, `isDemoClinic`). With real calls off
  (`HEALDESK_VOICE_REAL_CALLS` unset), the voice line and the backstop job answer only
  that clinic (`lib/voice/test-calls.ts`, `lib/voice/backstop.ts` `test_mode`). Leave
  `voice_real_calls` off throughout.
- **Synthetic words only**: "This is a test caller, can I book a consultation on
  Tuesday?". No real name, number, symptom or treatment.
- **Paste back** status codes, PASS or FAIL, times, counts and field values such as
  `data_storage_retention_days: 1`. Never a key, the agent's socket URL (it holds the
  secret), a transcript, a recording URL or a phone number.
- Keep `HEALDESK_RETELL_API_KEY` (the BAA workspace's key, never the marketing site's
  `RETELL_API_KEY`) in an environment variable, as `$RETELL_KEY` below, not typed inline.
- Save a raw Retell answer only to a file outside the repo, read the field you need,
  then delete the file.

## Before you start

| Needs | Where it is | Who |
| --- | --- | --- |
| The AWS host active, the voice service on (`enable_voice`) | `host.yml`, `infra/aws` | Owner |
| `HEALDESK_RETELL_API_KEY` set on apps/app | Parameter Store | Owner |
| The demo clinic's Retell agent: response engine our socket for the demo clinic, `webhook_url` `https://app.healdesk.io/api/webhooks/retell/<demo clinic id>`, `data_storage_setting` `everything`, `data_storage_retention_days` 1 | Retell dashboard (made by hand; automatic provisioning is off) | Owner |
| The agent's number forwarding nowhere real; you call it from your own phone | Retell dashboard | Owner |
| Access to the worker's log group `/healdesk/production/worker` (the worker runs in the web task by default) | CloudWatch | Owner |
| The `transcript-emails` job on, for step 4 | `/admin` › System › Jobs | Owner |
| The ops alert email (`HEALDESK_OPS_EMAIL`), and Slack `#alerts` if `SLACK_WEBHOOK_URL` is set | Mailbox, Slack | Owner |

## The steps

Stop at the first FAIL in steps 1 to 4 and tell Claude which step and what you saw.

### Step 1. Read the demo agent's storage back (no call)

- **Action:** `curl -s -H "authorization: Bearer $RETELL_KEY" https://api.retellai.com/get-agent/<demo agent id> > /tmp/agent.json`, then read `data_storage_setting`, `data_storage_retention_days` and `is_published` from the file. If the number uses a published version, read that version too: add `?version=<n>`.
- **What you should see:** `data_storage_setting: "everything"` and `data_storage_retention_days: 1` on the version the number uses.
- **Pass / fail:** PASS if both hold. FAIL if the retention is anything else or missing (Retell keeps such a call for ever), or the setting is not `everything` (the backstop then has no transcript to read). Fix it in Retell's dashboard, publish, and read again.
- **Clean up:** `rm /tmp/agent.json`.

### Step 2. One test call, recorded by the live socket (checklist D)

- **Action:** note the time, call the demo clinic's Retell number from your phone, say the synthetic line, let AYA answer once, hang up. Note the time it ended.
- **What you should see:** the first words say it is an AI assistant and that the call is transcribed. In Retell's call history the call appears with status ended; note its call id (you will need it, but do not paste it into a public place).
- **Pass / fail:** PASS if the call was answered with the disclosure and ended normally. FAIL if the socket was refused (`error_llm_websocket_*` in Retell's history) or the disclosure was missing: a launch blocker, stop.
- **Clean up:** nothing yet; the next steps delete the call.

### Step 3. The backstop reads the agent and deletes the call (checklists E and F)

- **Action:** wait 15 minutes after the call ended (the job starts 10 minutes after Retell's call-ended webhook, `BACKSTOP_DELAY_SECONDS`). Then, in CloudWatch `/healdesk/production/worker`, search the last 30 minutes for `voice call backstop`. Then `curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $RETELL_KEY" https://api.retellai.com/v2/get-call/<call id>`.
- **What you should see:** one line `voice call backstop found the call recorded and deleted it at Retell` with `status: already_recorded` for the demo clinic's id (or `voice call recorded by the backstop` if the live socket missed it), no line `retell agent storage is not ours`, and `get-call` answering `404`. In Retell's dashboard the call is gone from the history.
- **Pass / fail:** PASS if `get-call` is 404 within 15 minutes of the call ending and the call is gone from the dashboard. FAIL if `get-call` still answers 200 (deletion is not what the code assumes: stop). A line `retell agent storage not checked` alone is not a fail of the deletion; paste its `code` value.
- **Clean up:** none; the call is gone. Also check Queues › Retell deletions in `/admin/queues`: it should list nothing for this call. If it lists it, press Delete at Retell there.

### Step 4. No audio was kept on our side

- **Action:** open the demo clinic's inbox (the address its transcripts go to) and find the transcript email for the call in step 2.
- **What you should see:** the transcript email arrived, as text; there is no audio attachment and no recording link in it. healdesk has no table, bucket or field for call audio (`CLAUDE.md`, the PHI table: "healdesk keeps no call audio").
- **Pass / fail:** PASS if the email holds text only. FAIL if it carries any audio or recording link: stop.
- **Clean up:** delete the test email from the demo clinic's inbox.

### Step 5. The storage alert fires on a mis-set agent (optional, proves the new check)

The code added in this lane (`apps/app/src/lib/voice/agent-storage.ts`) reads back, before each delete, the agent the call ran on, at the call's version, and raises `voice_agent_storage` when the retention is not one day or the setting is not `everything`. This step proves it on the real Retell. It changes the demo agent for one call; skip it if you would rather not.

- **Action:** in Retell's dashboard, set the demo agent's data storage retention to 2 days and publish. Place one more synthetic call as in step 2. Wait 15 minutes.
- **What you should see:** the ops alert email "healdesk ops: URGENT: A Retell agent's call storage is not ours" for the demo clinic, with "retention not one day" (and the same post in Slack `#alerts` if it is on); in CloudWatch the line `retell agent storage is not ours` with `status: retention`; the call itself still deleted (`get-call` 404, as in step 3).
- **Pass / fail:** PASS if the alert came once and the call was still deleted. FAIL if no alert came: paste any `retell agent storage not checked` line's `code`.
- **Clean up:** set the retention back to 1 day and publish; repeat step 1 to confirm it reads 1. The alert does not come again that day for this problem; you may leave it.

### Step 6. Retell's own one-day deletion (checklist G)

This is the control for a call our code fails to delete. It needs one call left undeleted, which the backstop will not do for a recorded call, so the call must be one healdesk never records.

- **Action:** in Retell's dashboard, temporarily point the demo agent's webhook URL at nothing (clear it) and publish, so no backstop job is queued. Place one synthetic call; note its call id and end time. Then restore the webhook URL to `https://app.healdesk.io/api/webhooks/retell/<demo clinic id>` and publish. The live socket still records the call; only the backstop job, which the webhook queues, deletes a call at Retell (`lib/voice/backstop.ts`), so nothing of ours deletes this one. More than 26 hours after it ended, `curl` `get-call` for it.
- **What you should see:** `404`, or a record with no transcript and no recording. Note the hours elapsed.
- **Pass / fail:** PASS if the data is gone after 26 hours. FAIL if the transcript or recording is still there: Retell's retention does not do what the code, the agreements and the privacy page say. Stop and tell the owner before any real call.
- **Clean up:** if it FAILED, delete the call by hand: `curl -X DELETE -H "authorization: Bearer $RETELL_KEY" https://api.retellai.com/v2/delete-call/<call id>`, expect 204. Confirm step 1 still reads the webhook URL restored (read `webhook_url` and compare it by eye, without pasting it).

## Results

| Step | Date (UTC) | Result (PASS, FAIL, NOT RUN) | What was seen (no secrets, no words, no numbers) |
| --- | --- | --- | --- |
| 1 Agent storage read back | | | setting ___ ; retention ___ ; version checked ___ |
| 2 Test call | | | disclosure spoken ___ ; ended normally ___ |
| 3 Backstop delete | | | backstop line ___ ; get-call after ___ min: ___ ; dashboard gone ___ |
| 4 Nothing kept here | | | email text only ___ |
| 5 Storage alert (optional) | | | alert email ___ ; Slack ___ ; call deleted ___ ; retention restored ___ |
| 6 Retell one-day deletion | | | hours elapsed ___ ; get-call ___ |

State for each step whether it was run locally, on the demo host, or not run. A PASS here
is the evidence the `no-audio` item's "a test call proves the deletion" asks for; moving
the item to `on` remains the owner's decision.

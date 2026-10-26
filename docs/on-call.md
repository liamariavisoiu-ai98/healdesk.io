# On-call, in one page

Three processes run from the `apps/app` image, and each fails differently:

| Process | Command | What breaks when it is down |
| --- | --- | --- |
| Web tier | `node apps/app/server.js` | The portal, the web chat widget's API, the Meta webhooks, provisioning and billing events |
| Worker | `npm run worker -w @healdesk/app` | Everything scheduled (below). Nothing patient-facing stops at once; the watches stop watching |
| Voice endpoint (Retell custom-LLM WebSocket) | `node --import tsx src/voice/server.ts` (service `healdesk-production-voice`, with `enable_voice`) | Every forwarded call. Retell reaches no brain and drops the call, so put Retell in outage mode ("Voice endpoint down", below) |

**The rule every failure ends in:** a patient calling a clinic always reaches someone.
Every degradation path ends with calls forwarding to a direct clinic line that does not
forward back to us, and website chat becoming a contact form. If you are deciding what to
switch off during an incident, switch off the assistant, never the clinic's line.

## Voice: where a call goes when something fails

Inside our endpoint every failure ends in a transfer to the clinic's direct line
wherever the line can be known (`lib/voice/retell.ts`): the answer gate passing the
call through, the model failing twice, a turn that throws, and a call that cannot
start because the database cannot be read, or has not answered within three seconds
(a database that hangs rather than refuses). For that last one, a start that failed
rather than hung first reads the direct line on its own, for a second and a half; then
the line is known without the database (`lib/voice/fallback-line.ts`): first from the
process's memory of the clinic's last call, then from the fallback number Retell holds
for the clinic's AYA number. Each such call raises `voice_call_start_failed`, whose code
says where it went (`transferred_gate`, `transferred_database`, `transferred_memory`,
`transferred_retell`, or
`closed` when no line was known and the caller heard the closing line, or `hung_up` when
the call ended first: the caller hung up, or the voice process was shutting down). A start that
was only slow, with no line known, has until five seconds past its deadline to answer
normally first.
That alert writes to the ops log before it emails, so while the database hangs rather
than refuses it waits with the database and is not emailed: then the voice alarm and the
`retell call could not start` log lines are the signal. The database pool sets no
connection or statement timeout (`src/db/index.ts`), so after a hang it can stay
jammed until its connections give up; a pool timeout is the fix, not yet made.

The worker keeps that Retell fallback number equal to each clinic's direct line every
hour (`lib/voice/retell-fallback-sync.ts`, `retell-fallback` in the worker's `tick` log
line; it has no row in the ops console's job list), through
`HEALDESK_RETELL_API_KEY`. It never sets a line equal to the AYA number or the
clinic's published number. It clears the fallback of a number whose clinic has no
usable direct line, since a line left there could only be a previous holder's, and of a
number two clinics both name. `retell_fallback_unsynced` names a clinic
whose number it could not set (`duplicate`, `missing`, `not_kept`, `rejected`, `unreachable`,
`database`); a refused key (`key_refused`) or three numbers in a row timing out
(`retell_unreachable`) stops the run with one alert for every clinic. Offboarding forgets a clinic's AYA number, so the sync cannot clear that
number's fallback: release the number in Retell, or clear its fallback, when a clinic
leaves. Until the key is pasted the tick line reports `retell-fallback=skipped` and none
of what follows in this section works.

**Voice endpoint down** (the voice alarm, or no `retell call recorded` lines while
clinics are live). Retell has no per-agent or per-number setting for an unreachable
custom-LLM endpoint: it tries to open the socket three times, seven seconds each, and
then drops the call (`error_llm_websocket_open` in Retell's call history), so the caller
hears about 27 seconds of nothing first. So:

1. In Retell's dashboard, turn **outage mode** on (it has been under Settings →
   Reliability). By Retell's support material, every inbound call to the workspace's
   numbers then goes to its number's fallback, the clinic's direct line; it is
   workspace-wide, every clinic, healthy or not, until it is turned off; and it is
   toggled only in the dashboard, so it is a person's step. None of this is in
   Retell's API reference and none of it has been tried here: confirm once, before
   launch, that the workspace's plan has outage mode and that a test call in it
   reaches a made-up clinic's direct line.
2. Fix the endpoint; turn outage mode off; make a test call.

A number at Retell's concurrency limit falls back to the same line by itself.

**Retell itself down.** Nothing of Retell's runs, outage mode included, and nothing of
ours can move a call that never reaches us. Each clinic has to remove its call
forwarding (the undo codes are in the portal, Settings → Safety net). Nothing emails
clinics automatically: a watchdog cannot tell a Retell API blip from calls failing,
a false alarm would have every clinic dismantle its coverage, and forwarding removed
has to be put back by hand. Decide from Retell's status page and its call history,
and call or email the live clinics yourself.

**Host in standby.** `host.yml standby` removes the voice service. Never put the host
in standby with a clinic whose phone channel is live; if it has to happen, turn
outage mode on first.

## What the worker runs

The worker owns the clock: pg-boss schedules one hourly tick (`lib/scheduler/tick.ts`).
Every job ships switched off and is enabled from the ops console when the first live
clinic exists.

Today's tick runs the billing sweep, the connection watchdog, the weekly recap, the
retention purge (03 UTC; it purges every clinic on BAA 1.3.0 or later, or the DPA, even
while its switch is off, because those agreements state its periods, and the switch adds
every other clinic), offboarding destruction (every hour, on every agreement's
rule: each clinic is due a day before its thirty days, or on BAA 1.3.0 and the DPA
without an export its ninety, are up, so it is gone before they are whatever hour it
left) and the annual renewal reminder (09 UTC). It also still carries the monthly
revenue report and the nightly POS sync, which are phase two and stay switched off in
v1, and two sweeps from the 23 September booking design (Meta booking drafts,
booking-requirement defaults). One more sweep is not switched: `erasure-expiry`, every
hour, empties a deletion request's restore references 35 days after the deletion and
deletes the record once its subcontractor steps are recorded (docs/handover.md,
"Deletion requests"). Stopping the worker stops it too, which is what a restore needs.

The Stripe launch (drizzle/0043) adds five billing jobs, all seeded off: hourly, the
usage meter report (overage on monthly plans to Stripe's meters) and the usage alerts
(the 80% and 100% allowance emails); daily, the annual overage invoice (05 UTC) and
billing housekeeping (06 UTC: expired checkout intents, Meta message refs older than 7
days, Connect OAuth states older than a day). The usage jobs and the annual invoice are
stubs until their work packages land, and switched on early they record "Not built
yet." and do nothing.

The fifth, `billing-notices`, is the email platform's sender (drizzle/0046,
`lib/email/outbox.ts`). It runs every minute from its own pg-boss queue, `notices`, not
from the tick, and its job row is its switch: off, no clinic email is sent. Each notice
is leased for two minutes while it sends and retried at 1, 5, 30, 120 and 360 minutes;
the job's note counts what was sent, failed, waiting and held (a kind with no template
yet). `npm run queue:install` must be re-run in each environment for the `notices`
queue, or the worker will not start, and for pg-boss's own cron queue
(`__pgboss__send-it`), without which no schedule fires: neither this minute clock nor
the hourly tick. A worker whose job rows never show a `last_run_at` is the symptom.

The calendar watch (`calendar-watch`, `lib/scheduler/calendar-watch.ts`) runs every five
minutes from its own pg-boss queue, also `calendar-watch`, behind its job row's switch,
which ships off. Switch it on from the console when the first clinic connects a Google
Calendar; until then, a calendar whose access was removed is noticed only when something
asks Google about it. Each run first disconnects every location whose calendar terms
ended, whose Google account no longer matches them, or that is offboarding, before it
opens a single token (each grant no other location holds is then revoked at Google). A
location whose terms could not be checked is left alone that run, its token unopened.
Then, for each connected calendar, one forced token refresh and one free/busy query, and
nothing else:

- a definitive refusal (access removed in Google, an administrator's block, a lost scope,
  the calendar forbidden or gone) breaks the connection, and the location takes booking
  requests at once; the clinic is emailed once (O13) and ops hears of it in the run's
  `calendar_broken` alert;
- three misses in a row (timeouts, Google errors, rate limits) degrade it to requests
  (`calendar_degraded`), and the first good answer brings it back
  (`calendar_recovered`). The clinic is not emailed for either;
- Google refusing healdesk's own OAuth client, or saying the Calendar API is disabled,
  degrades each connection it checks and raises `google_oauth_client_rejected` every
  run, which mails at most once an hour. Fix the Google Cloud project or apps/app's
  secrets, not the clinics: the next good answer restores each one.

**What ops receives.** A run sends at most one email for each kind of change:
`calendar_broken`, `calendar_degraded` and `calendar_recovered`. Each counts the
connections it is about, names them when there is just one, and carries the run's id as
**Job id**. To list the connections behind a count, search the worker's log for that
`jobId`: each change has a line with its clinic and connection ids. Every run's changes
are a new email, so a second wave of failures, or a connection that degrades again after
recovering, is mailed even inside the hour. Alerts about a condition that persists
(`google_oauth_client_rejected`, `calendar_watch_incomplete`, `calendar_watch_failed`)
mail at most once an hour while it lasts. Every run also writes a `calendar_watch`
security event with its counts and id, so a gap in those rows means the watch did not
run.

A run that has not checked every connection after four minutes stops starting checks,
alerts `calendar_watch_incomplete`, and checks the rest first next run. A run in which a
step threw (a check, a location's terms check, telling a clinic, or the run itself)
alerts `calendar_watch_failed` and is recorded `failed` on its job row; pg-boss does not
re-run it at once, because a re-run would count another miss against every connection
Google was slow for. The next run, five minutes later, is the retry. Its lock goes stale
after ten minutes, not an hour.

**Installing the watch, in each environment:** run `npm run queue:install -w
@healdesk/app` as the migrator, **then restart the worker**, then switch the job on. The
restart is not optional: the worker registers its clocks only when it starts, so a
worker started before the install has logged `queue clock not running` with
`"job":"calendar-watch"`, and runs everything else without the watch until it restarts.

The website re-reads (`lib/website`, the website_drift migration) are two rows. `site-reads`
ships ON: every minute from its own `site-reads` queue (install it and restart the worker,
as above), and hourly from the tick, it sends each clinic's due read to apps/web's signed
`/api/clinic-site`, which fetches and extracts off this host and stores nothing: a website
with no profile, a website the clinic corrected, the monthly check, or an operator's read
(ops `requestSiteReread`). It reads nothing until `HEALDESK_WEB_URL` names apps/web
(`https://healdesk.io`, a plain setting in `app_environment`), and its note then says so.
A failed read is tried again after 30 minutes and after 6 hours, then left `failed` on its
`site_rereads` row. `website-drift` ships OFF, and the owner switches it on before the
first clinic's 30th live day: hourly, it asks for a read of each live clinic's website 30
days after its last, compares it with the purchase-time baseline, puts what Knowledge does
not say on the clinic's "Changes on your website" list, and queues L23.

The support drafter (`lib/scheduler/support-draft.ts`, lane P7b) is the `support-draft`
row, shipped OFF: every minute from its own `support-draft` queue (install it and restart
the worker, as above), up to three `new` support cases that name a clinic each get a draft
reply written from the case's fields and the clinic's account, checked by the eight reply
rules (`lib/support/draft/checks.ts`). It sends nothing: the case moves to `drafted` when
every rule passes and `needs_edit` when one fails or the model could not be reached, with
the rule or the reason shown on the case. At most five drafts a case; ops
`regenerateSupportDraft` asks for another. Switch it on only with `ANTHROPIC_API_KEY` set:
without the key every case it takes ends `needs_edit` (`model_unavailable`). A draft that passes
every rule is put in the approval inbox for your yes at once (lane P7e); it still sends nothing.

The support reply's retries (`lib/scheduler/support-send.ts`, lane P7e) are the `support-send`
row, shipped OFF (drizzle/0127): every minute from its own `support-send` queue (install it and
restart the worker, as above) and hourly from the tick, each reply you approved whose first try
did not go is tried again on the email outbox's schedule, and stopped after six with
`support_reply_dead`. It sends only the text you approved. While it is off, a failed first try
waits with no retry. At 03 UTC, unswitched because it only deletes, the tick's
`support-retention` step deletes the words of every reply sent, or stopped without going (dead,
its case closed, its clinic left), more than 12 months ago, and the copy in its approval item
12 months after the decision; the rows, hashes and approval events stay.

v1 adds jobs that are not built yet: the demo-sandbox purge (7 to 14 days), the 14-day
zero-inbound flag for an active voice plan, the 48-hour zero-interaction flag, the
48-hour channel-not-live reminder to the clinic, and the daily summary email to the
clinic. None of these contacts a patient; v1 sends patients nothing after a conversation
ends.

**Five minutes is not "the moment a connection breaks".** The calendar watch catches a
removed access within one run, but a write that fails on authorisation must also flip
the location to manual booking in the same turn, from the tool layer
(`markCalendarBroken`), without waiting for the worker.

## The signals

| Signal | Where | Healthy | Act when |
| --- | --- | --- | --- |
| Heartbeat | `/api/health` → `heartbeatAgeSeconds`; the console's job list (`/admin/system/jobs`), row `heartbeat` | under 3,700 s | over 2 hours: the worker is down or stuck |
| Queue | `/api/health` → `queue.oldestPendingSeconds`, `queue.failed` | pending under 1 h, failed 0 | pending over 2 h or failed rising: a handler is throwing; read `log.error` lines with `queue error` |
| Email | `/api/health` → `email.lateCriticalNotices` and `reasons`; ops alert emails (`ops_alerts`); the job list, row `billing-notices` | 0 late | any late: a critical email is still unsent ten minutes after it was due. `/api/health` answers 503 with `"reasons": ["critical_notice_undelivered"]` and ops is emailed once per notice. Check Resend and the job's note, then call the clinic |
| Jobs | the console's job list (`/admin/system/jobs`): `last_run_status` and `last_run_note` | `ok` | `failed` twice in a row, or `already-running` for over an hour (a stale lock is reclaimed after 60 min; 10 min for `calendar-watch`) |
| Calendar watch | ops alert emails (`calendar_broken`, `calendar_degraded`, `calendar_recovered`, `google_oauth_client_rejected`, `calendar_watch_incomplete`, `calendar_watch_failed`); the job list, row `calendar-watch`, whose note counts each run's checks, breakages, misses, skips and failures and ends with the run's id | `ok` every five minutes once switched on | `google_oauth_client_rejected`: at once, every clinic is affected. `calendar_watch_failed`, or `failed` on the job row, twice in a row: read the worker's `calendar watch` error lines. `calendar_watch_incomplete` on most runs. No `last_run_at` ten minutes after switching it on: the queue was not installed or the worker not restarted (look for `queue clock not running` with `calendar-watch`) |
| Voice endpoint | The voice target group's healthy-task alarm (`alarms.tf`); ops alerts `voice_call_start_failed`, `retell_fallback_unsynced`, `voice_direct_line_loops` and `voice_test_mode_refused`; the worker's hourly `tick` log line, `retell-fallback=` (the sync is not a row in the job list); Retell's call history for `error_llm_websocket_*` | healthy tasks at `voice_desired`; `retell-fallback=ok` | The alarm, or any `error_llm_websocket_*` call: outage mode on ("Voice endpoint down"). `voice_call_start_failed`: the database, first. `retell_fallback_unsynced`: that clinic's number in Retell, or the key. `voice_direct_line_loops`: the clinic's direct line is its published or AYA number; ask the clinic for a line that reaches a person. `voice_test_mode_refused`, phase `not_made_up`: a clinic other than the demo clinic already has its Retell agent or forwarding pointed at us before the agreements: point it back; phase `check_failed`: the database did not answer within the start deadline |
| Meta webhooks | The audit rows the front door writes per answered message, the `front door` lines in the logs, and any delivery failures Meta reports for the app | Messages answered | Meta reports failed deliveries, model calls fail, or a clinic with a connected channel goes quiet |

Point an external uptime check (any provider; it lives outside the thing it
watches) at `GET /api/health` and alert on a non-200 or on
`heartbeatAgeSeconds > 7200`. That is the alarm for the web tier, the worker and the
email platform: the one non-200 is a critical email ten minutes late, which an alarm
sent by email could not report during a mail outage. The load balancer's health check
goes to `GET /api/health?probe=liveness` instead, which answers 200 whenever the process
is up, so a mail outage never gets a healthy task replaced.

## What to check first

1. `GET /api/health`. `db: unreachable` → the database or its credentials;
   nothing else will work until that does.
2. The worker's logs for `worker failed to start`, `queue error`, or the last
   `tick` line. A tick line every hour with `status` per job is normal.
3. The console's job list (`/admin/system/jobs`): which job failed, and its note. Notes are
   truncated error messages with no patient data in them.

## Restarting the worker safely

The worker drains on SIGTERM (`stopBoss` with `graceful: true`): an in-flight
job finishes before exit. Stop it with the host's normal stop
(ECS task stop, `systemctl restart`), never `kill -9`
unless the graceful stop has hung for more than two minutes. On start it
re-registers the hourly schedule as an upsert; you will not get two clocks.

## What is NOT an emergency

- A job showing `disabled`: it is switched off on purpose. Every job ships
  off and is enabled from the console when the first live clinic exists.
- `already-running` for a few minutes: two ticks overlapped; the lock is
  released when the first finishes.
- The `heartbeat` job "enabled": it is the liveness signal, not a job.

## Alert runbook, by event

Every ops alert (`OPS_EVENTS`, `apps/app/src/lib/ops/notify.ts`) belongs to one section
below; the console's "Fix with Claude" prompt names the section
(`apps/web/src/lib/admin/fix-with-claude.ts`, `RUNBOOK_ANCHOR`), and the test there fails
when a section is missing. An alert's email and its Slack copy print the same sentences
and numbered steps from one wording (`apps/app/src/lib/ops/alert-wording/`, one file per
section below), and both link to `/admin/clinics/<id>/<tab>#<event>-<alert id>`
(`opsConsoleLink`, lib/ops/notify.ts; the shape in `apps/web/src/lib/admin/issue-link.ts`),
where the panel shows "Fix with Claude" for that alert and scrolls to the card that owns it
when one does. Each alert reads top down: an urgency tag (URGENT: act now; TODAY: a person today; FYI: nothing to do but read), one bold headline that says what is wrong, a highlighted "Do this first" box (the first step), then "More detail" with the rest. The alert is the short action list; this runbook is the longer reference.
An alert about no clinic links to the page that owns it instead (`NO_CLINIC_PAGE`,
`apps/app/src/lib/ops/alert-wording/tabs.ts`, one for every event). When a step says to note
what you did, the Touch log on the clinic's Care tab takes a note for every clinic, whatever
its age or state, until its account is closed; a closed account takes none, so tell the owner
instead (lane N3, `lib/ops/health.ts` `touchRefusal`).
An alert's row in `ops_alerts` holds ids, counts and categories only, never free text. Read the row, then the code that raised the
event (`grep -rn '"<event>"' apps/app/src`), then act through the console's typed
operations where one exists; a data change goes through `db-apply`, dry-run first.

### Provisioning

`provisioning_rejected`, `provisioning_dead_lettered`, `paid_intent_without_clinic`. A paid
invoice reached `/api/provision` and the clinic was not created, or the request was refused
(the sealed agreement's hash, a missing field). There is no clinic yet, so no Billing tab and
no console button finishes it: find the payment in Stripe's Dashboard, check the Clinics page
in case the order was finished another way, and tell the owner, who reads the cause in
apps/app's error log and replays the paid invoice once it is fixed. Write to the buyer from
hello@ by the day we promised. Never create a clinic by hand: provisioning is gated on the
first paid invoice. System › "Requires your attention" counts "Paid orders without an
account" (a purchase whose paid relay was stamped once its intent was found, with no account
yet: a dead-lettered order and one waiting ten minutes count; one refused before that point
does not), with how long the oldest has waited; the section only reads.

### Billing

`duplicate_subscription`, `billing_event_dead_lettered`, `billing_request_dead_lettered`,
`billing_request_stuck`, `setup_closure_skipped_live_channel`, `location_charged_not_created`,
`connect_event_dead_lettered`, `overage_invoice_failed`, `first_period_refund_due`,
`plan_start_after_cancel`, `billing_pointer_outside_practice`, `refund_cancel_job_off`,
`agreement_refund_due`, `location_quantity_drift`, `location_quantity_agrees`. The clinic's
Billing tab shows the request, the parked event or the invoice, each with its retry or replay.
Money is the owner's: a refund, a credit or a manual charge waits for the owner's word. The
console's refund on the Billing tab asks for no authenticator code (apps/web `commitRefund`
sends none), only a preview and the confirmed amount, so have the owner's word before you
press it. System › "Requires your attention" counts, across clinics, the Stripe and Connect
events parked or retrying and the billing requests still pending ("Billing requests not
done": a dead-lettered request has its done_at set, so it is not among them); it only reads,
and an event that names no clinic shows nowhere else, except in the approval inbox. A parked
Stripe event lives in one place for you to act on: the item under Queues › Approvals, whose
Approve replays it, while the approvals job is on (an event provisioning will replay is not
proposed). Home then shows that approval row and drops the "Stripe events parked" queue row for
the events it holds, but still shows the queue row for any it does not hold; System still counts
all of them, and the alert raised when it parked stays on Home for a day.

### Usage

`usage_near_cap`, `usage_cap_reached`, `meter_report_failing`. The clinic's Billing tab,
"Usage and the allowance": the meter, the window and the overage mode. A failing meter report
means Stripe is not receiving overage; read the `usage-meter-report` job's note. At 90% the
clinic is emailed if its Usage alerts switch is on; the step-up conversation is a person's.

### Email delivery

`critical_notice_undelivered`, `clinic_address_bounced`, `clinic_address_complained`,
`clinic_address_suppressed`, `daily_email_count_70`, `welcome_email_unsent`,
`destruction_notice_undelivered`, `email_refused`, `agreement_copy_withheld`,
`urgent_alert_not_queued`, `dmarc_review_due`. The clinic's Deliveries tab is the ledger: what
was queued, sent, bounced. A bounced or suppressed address means the clinic's one address is
wrong: phone the clinic, then change it from the Account tab with the fresh code. A critical
notice ten minutes late is also `/api/health` answering 503 ("The signals" above). The daily
count at 70 is Resend's free-plan quota of 100 a day, sign-in links and urgent alerts
included: tell the owner the Resend account needs its paid plan, and hold back optional
sends (setup links, agreement copies) until midnight UTC. System › "Requires your attention"
counts, by clinic, the emails waiting to send (only those already due, and a retry re-dates
an email, so one waiting between retries is not counted: the count says whether mail in
general is stuck, not whether one notice is late; under "Requires your attention" once the
oldest has waited an hour, before that under "Being watched"), those that could not be sent
and will not be tried again, for 7 days from when each was queued, and the last day's
bounces, spam reports and blocks (lib/ops/inbox/queues.ts);
a row with one clinic in it opens that clinic's Deliveries tab. A bounce on an address no
account holds is counted nowhere.

### Setup and support

`setup_request_reply_past_due`, `provisioning_follow_up_past_due`, `support_reply_past_due`,
`assistant_knows_no_services`.
Queues › Setup requests and Queues › Support (the latter lists only chat requests with no
support case; a request on a case is on the Support page): a reply promised by the next business
day was not marked. Reply from hello@, then mark it. Since lane P7e `support_reply_past_due` is raised
only for a chat request that has no support case; a request on a case raises
`support_case_past_due` instead (Support cases, below), one alert per promise. A follow-up past due is a paid order whose
account still does not exist past the day we promised the buyer: the alert opens System ›
Requires your attention, which counts paid orders without an account (so does Home). Write to the buyer from hello@ today and get the cause fixed (see
Provisioning). `assistant_knows_no_services` is AYA answering a
clinic that has no approved service or price in Knowledge: add the services in its Knowledge page
or get the practice questions approved, then the alert stops.

### Agreements

`agreement_unsigned_7_days`, `agreement_resign_unrenderable`, `agreement_below_floor_unsigned`,
`agreement_termination_incomplete`, `agreement_termination_finished_late`,
`agreement_copy_withheld`. Compliance › Agreements register for the signed copy, Compliance ›
Notices for the re-signs (L22). A clinic below the BAA floor keeps answering while it signs
(owner, 19 October 2026); the alert at 7 days is for a person to phone. An agreement that
cannot be rendered again is a code or template fault: read the register row's version.

### Voice

`voice_fallback_no_direct_line`, `voice_call_start_failed`, `retell_fallback_unsynced`,
`voice_provision_failed`, `voice_provision_cap_reached`, `voice_agent_drift`,
`voice_deprovision_failed`, `voice_direct_line_loops`, `voice_test_mode_refused`. "Voice:
where a call goes when something fails" above is the whole runbook; the clinic's Setup tab
holds the phone line, the direct line and the forwarding test. Its "Voice agent" card
(apps/web `setup/VoiceAgentCard.tsx`, Phase 5) shows the set-up's status in words, whether a
number is held (never the number), the last problem and the drift flag, and offers three
controls: "Retry" (one more provisioning run under every guard a scheduled run has, with the
operator's fresh authenticator code; it can buy a number, and asks first), "Check against
Retell" (the read-back, saying what differs in words) and, while the clinic is flagged, "Clear
flag and recheck" (with the fresh code: clears the flag, resets the repair count and runs the
check once; `lib/voice/provision.ts` `clearVoiceDriftFlag`). Drift is repaired by code up to
three times, then flagged for a person, and a flagged clinic is skipped by the nightly check
until the flag is cleared; in the check a clear runs, only a missing agent or number flags it
again (the repair count was reset with the flag), and on later nights the three-repair rule
applies as before. The card's confirm text says the same (lane P5c corrected it). A
missing agent or number is never recreated by code: ask Retell support, or release the
clinic's voice set-up and provision again. A `failed` set-up waits for Retry; a failed
settings sync is retried by the hourly sweep by itself. Outage mode is a dashboard step,
never automated.

### Calendar

`calendar_broken`, `calendar_degraded`, `calendar_recovered`, `calendar_watch_incomplete`,
`calendar_watch_failed`, `google_oauth_client_rejected`, `connection_broken`,
`calendar_write_stuck`, `calendar_writes_stuck_many`. "What the worker runs" above describes
the watch; the clinic's Setup tab, "Calendar", shows the connection and offers the link and a
disconnect, and keeps the history of every write attempted with Google's own word where it
gave one; "Calendar writes" (apps/web `setup/CalendarWrites.tsx`, Phase 5) lists this clinic's
writes not settled whose slot has not started or started within the last 14 days (marked "Slot
has passed": the sweep no longer takes it, and `calendar_write_stuck` is raised for it, so it is
listed), each with the reason in words
(`components/admin/queue-words.ts`), the tries so far of five and the next try, and a "Retry"
per row (`opRetryCalendarWrite`: reads Google back first, may go past the five, refuses a
booking staff cancelled or marked). A write Google did not answer (a timeout, a lost reply, a
429, a server error before the insert) is `unknown` and the desk sweep, which is the
five-minute calendar watch itself (`lib/scheduler/calendar-watch.ts`, behind the
`calendar-watch` row's switch on the Jobs page, which ships off: while it reads off nothing
retries by itself), retries it at its run no sooner than 2 min after the first failed try, then
10 min, 30 min and 2 h after the next ones, five tries in all counting the first, until the slot
starts (`WRITE_BACKOFF_MINUTES`; the fifth step, 6 h, is recorded and never run,
`MAX_WRITE_ATTEMPTS`); settled reasons (deleted in the calendar, event id taken, not ours, no calendar connected, the
target calendar refused, an access or connection break) are never retried by the sweep
(`lib/booking/calendar.ts`, `CALENDAR_WRITE_REASONS`). `calendar_write_stuck` fires only for a
write the sweep no longer takes: a failed one at once, an unanswered one at five tries, past its
slot, with a settled reason, or (whatever the switch says) untouched for 24 hours, a rule a
working sweep never trips. With the switch off, the alert for a write Google never answered
comes at 24 hours untouched or when its slot starts, whichever is first, so it can come a day
after the failure; the lists on the Setup tab and the System page show it at once and say so. System › "Requires your attention", "Calendar writes stuck",
lists the stuck writes across clinics, one row per clinic, linking to its "Calendar writes". A
broken connection already flipped the clinic to manual booking in the same turn: the clinic
takes booking requests and is not down. Google refusing our OAuth client is every clinic at
once: the Google Cloud project, not the clinics.

### Transcripts

`transcript_undelivered`. The clinic's Deliveries tab, "Transcripts": the receipt's status,
attempts and "Send again" where a sealed copy still exists. A copy unanswered 72 hours after it
goes, or undelivered after 30 days, is deleted and cannot be sent again; the clinic is told
nothing was kept. Never ask apps/app for the words: there are none to read. System › "Requires
your attention", "Transcript copies not delivered", lists every clinic with a copy waiting over
72 hours, bounced, or deleted with no delivery report (expired after 30 days, or unconfirmed 72
hours after an accepted send, which the clinic may have received), among the copies queued in
the last 60 days (`UNDELIVERED_WINDOW_DAYS`,
twice the 30 days a copy can wait, so every copy that expired in the last 30 days is in it),
with counts and the oldest held copy's age in hours, linking to its Deliveries tab
(`listUndeliveredTranscripts`, Phase 5).

### Go live

`practice_question_failed`, `practice_question_review_past_due`, `no_interactions_48_hours`,
`no_inbound_calls_14_days`, `first_answer_not_recorded`, `go_live_held`, `web_widget_to_confirm`.
Queues › Reviews for a run a judge failed; the clinic's Setup tab, "Go live" and "Channels",
for what holds it. No calls in 14 days on a live voice plan means the forwarding was never
set or was undone: phone the clinic. A first answer not recorded is billing's start date
missing: read `lib/billing/answering.ts` before touching the row.

### Account

`address_change_stalled`, `address_change_failed`, `sign_in_help_unmatched`,
`access_requests_capped`, `step_up_phone_held`. The clinic's Account tab: the address change
and its 72-hour clock, the devices, the recovery link. Every act here needs the call back and
the fresh code. A sign-in help request that matched no clinic is answered by hand from hello@
with no account detail in it. `step_up_phone_held`: phone cannot be billed per location yet
(`lib/locations.ts` `phoneHeldByLocations`), and the owner decided on 24 October 2026 that
phone does not stay on unbilled: the clinic switches "Phone" off under Channels in its
portal's Settings, one switch per clinic covering all its locations (`lib/channels/switch.ts`:
its calls then go to its direct line; a legacy billing group has one clinic, and one switch,
per block under the Billing tab's Channels card); nothing in the console flips that switch, and
the plan is left as it is. Phone the clinic on its direct line: with phone live, calls to its
published number can be forwarded to AYA, as its coverage mode says. Done shows on the Billing
tab's Channels card, where each clinic's Phone row ends "· switched off".

### Offboarding

`export_undelivered_before_destruction`, `offboarding_started_late`, `export_due_undelivered`,
`account_closure_waiting`, `account_closure_failed`. The clinic's Care tab, "Offboarding": the
rule its agreement sets, the export's due date and the destruction date. The export is a task
on the host (`patient-export`, `docs/handover.md`), never run from a laptop; record its
delivery on the tab. Destruction waits for nobody: a late export is the one thing to chase.

### Patient rights

`patient_request_due_soon`, `patient_request_past_due`. The clinic's Care tab, "Deletion
requests" and "Amendments": counts and dates. The request itself is entered on the host
(`erase-person`, `amend-contact`, by contact id) because it names a person; nothing on the
console does. Chase the subcontractor step (Retell) before the due date.

### Patient rights tracker

`rights_request_blocked`, `rights_request_due_soon`, `rights_request_overdue`. Raised once per
request each by the daily `rights-watch` job (`apps/app/src/lib/scheduler/rights-watch.ts`, off
until the owner switches it on). Home lists a rights row only while a request is due soon or past
its day (those two alerts are left off Home for that reason; the blocked one stays), so the alerts
open the page from Compliance. The Patient rights page (`/admin/rights`, under Compliance) lists
every open request with a clock across clinics, demo clinics left out: the intakes recorded the day
a request came (`recordRightsIntake`), the deletions waiting on their Retell step, and the patient
requests not yet marked received. The clocks
are business days, Monday to Friday in UTC (`apps/app/src/lib/rights/clocks.ts`): ten for an erasure,
an amendment, a correction or an export, five to pass a patient's own request on. A row with a
prepared command shows the exact `run-task.sh` line; the owner copies it and runs it himself in AWS
CloudShell, and nothing in the console runs it. A row with no route shows "No portal route yet turns
this request into a contact id" (owner decision D19): it is not a go-live blocker, but its clock
keeps running, so agree with the practice how it is handled in time. A patient's own request is two
rows and two alert families on purpose. Its intake keeps its command, shown beside "Run this on the
host, then press Mark done here. The practice's own request is chased separately once it is
recorded.", until you press Mark done: nothing pairs the intake with the request the command
records, because two people's requests of one kind on one day cannot be told apart by clinic, kind
and day. The tracker's three alerts on the intake are about running the command. Once the host has
recorded the request, the practice's side (marking it received) is the other family,
`patient_request_due_soon` and `patient_request_past_due`. An intake recorded with the request's id
(linked) shows the request's clock instead and is left to those two alone; only a direct
`recordRightsIntake` call records one, since the console's form never sends a record id, and Mark
done on such an intake says the row stays open until the practice marks the request received.
Mark done is not offered for an erasure whose deletion still owes its Retell step: the row says why
from its own facts, because apps/app refuses that close with a 409 and the console shows a non-200
answer to a rights write only as the ops client's generic sentence ("The ops API refused this. The
reason is in our logs; nothing was changed."), the reason being in the app's log. The form mints a
request key when it opens and again after each answer that a request is recorded, and sends the same
key when a submit is retried before an answer, so a double click records once; the same key sent
with other choices is refused on the host (`key_reused`), and the console shows that refusal as the
same generic sentence.

### Incidents

`incident_notice_overdue`. Compliance › Incidents: the agreement's deadline and our internal
target, and the two decisions. Nothing reaches a practice unless the owner sends the report;
the people affected are recorded on the host by contact id, never here.

### Vendors

`vendor_agreement_expiring`, `vendor_agreement_lapsed`. Compliance: the business associate
agreements in the chain. A lapsed vendor agreement stops AYA answering where that vendor
serves (calls go to each clinic's direct line) until a renewal is recorded with the fresh
code. The renewal is a document the owner has; the console only records it.

### Meta

`meta_revoke_failed`, `meta_revoke_by_hand`. Healdesk's app could not be taken off a leaving
clinic's Page or WhatsApp account at Meta. We have no access to the clinic's Meta Business
Suite: phone the practice and ask it to remove healdesk from the Page's or account's connected
apps (check first, under Meta front door on the Setup tabs, that the Page is not another
clinic's channel), then note it in the Touch log on the clinic's Care tab. No control on the
Setup tab marks it done. Meta signs no BAA; the channel carries nothing clinical,
so a token that lingers exposes business data only, and still must go.

### Retention

`retention_purge_failed`. The nightly purge (03 UTC) could not delete what an agreement's
periods say is due. Read the job's note and the `retention` code before anything: a purge
that did not run is behind the agreement, and a purge run by hand without the job's checks
can delete what a hold still covers.

### Availability

`clinic_availability_changed`. A clinic changed its opening hours, its closed days, a location's
hours, or its named providers and what they offer, or an edit made outside the portal did (an
ops change file through `db-apply`, or a direct database edit, which the database's own
trigger records as a count-only row). AYA uses the change the moment it is saved. The alert
comes from the minute sweep (`lib/clinic/change-events.ts`), one per clinic and kind an hour,
and carries the kind and counts only: never a date, a label or a name. The clinic's Setup tab,
"Availability changes", lists each change with who made it (the clinic, ops, a change file,
outside the portal), the audit that followed it, and "Mark as seen" for each; "Run audit now"
runs every pack for the clinic at once, one run at a time and at most once a minute. The
audits run only while the `clinic-audits` job is on, and the card says when they are off; an
audit that warns or fails lists the failing checks' hints under its pack. Phone the clinic only
for a change nobody there expected.

### Setup progress

`lifecycle_no_progress`, `lifecycle_closing_soon`, `lifecycle_decision_due`,
`lifecycle_waiting_on_us`, `lifecycle_waiting_on_us_long`, `lifecycle_closing_waiting_on_us`,
`lifecycle_channel_waiting`, `lifecycle_reminder_undelivered`, `lifecycle_reminders_unanswered`.
The lifecycle watch's waves about one clinic's setup (`lifecycle-watch`, hourly from the tick,
behind its switch; `lib/lifecycle/waves.ts`), each raised once by its key. The routine waves
go to Slack alone: no progress on days 7 and 15 of the window (five days without a step, or
no step ever); closing soon on days 22 to 30 for a clinic that is not stalled; waiting on us
at four hours and at one business day; a channel still waiting on the clinic 7 and 14 days
after another went live. The five escalations also go to the ops address and open in Slack
with a siren: the day-22, 27 and 30 decision for a stalled clinic (two steps or more owed,
or no setup screen answered: owner decision D7); two business days waiting on us; a reminder
that bounced or failed with none delivered since (folded into an address alert already raised
for the clinic since that reminder went, when there is one); two reminders delivered in a row
with no progress since the first; and a clinic waiting on us on day 27 or 30, whatever was
decided before, because a closure then would be our delay.

Every wave's link lands on the clinic's Setup tab, "Setup window" (the undelivered reminder
on Deliveries › "Reminders"): the stage, the window's end and the days left, the last
progress, the decision so far, the snooze, and the recommendation the watch computed
(`lib/lifecycle/recommend.ts`: fixed sentences over counts and days, never a model). Its
controls: "Extend the setup window", shown while the plan has not started, with the days box
starting at the recommended days, which names the deadline the page showed and is refused once
that deadline has moved, so a repeat cannot add the days twice (the Billing tab's own button
does the same); "Offered a call" and "Let it close", the decision, where letting it close
stops only the day-27 and day-30 warnings to us and the window still closes on its last day;
"Snooze alerts" for 3, 7 or 14 days, which mutes the routine waves only, never an escalation
and never the clinic's own reminders. Days a clinic waited on us never extend its deadline by
themselves (D6): the extension is always the button. "Do not watch this account", on the same
card (Phase 5, `lib/lifecycle/ignore.ts`), is for healdesk's own test accounts: the watch skips
the clinic, so no wave goes to ops, and Home's decision and go-live rows leave it out; its
setup reminders, its closing day and its calendar, voice and billing alerts are unchanged,
since none of those reads the list. "Watch this account again" undoes it. Finishing our side is the Setup tab's
"Channels" and "Go live" cards, which list what is missing; go-live is automatic once nothing
is left, and "Ask the practice questions again" is the one push the console has. A partly
live clinic whose phone channel is live forwards its published number to AYA: phone it on the
direct line under the Billing tab's "Pause AI and the direct line" (a clinic with no direct
line on file cannot have phone live, so its published number still reaches the desk).

The clinic's six setup reminders are the `setup-reminders` job's, unchanged by the watch,
which only records them; the Deliveries tab's "Reminders" lists them with every wave sent to
ops, and whether each arrived. A bounced address is corrected on the Account tab, "The
clinic's address", after a call back on the published number, with the fresh code; it takes
effect 72 hours later. The window closes the account only while the `setup-closure` switch is
on (a pending closure waits otherwise, and a closure is skipped once a channel is live).

### Morning digest

`ops_digest_summary`. The digest email goes to the ops address (`HEALDESK_OPS_EMAIL`, else
`HEALDESK_ADMIN_EMAIL`) at 07:00 UTC or later, once a UTC day, behind the `ops-digest` switch,
and is tried up to five times before tomorrow's takes over. Once it has gone, its one line in
Slack is this alert, never emailed: setup decisions owed (a clinic waiting on us a business
day or more counts as one: `lifecycleView`'s `decisionOwed`), clinics waiting on us, clinics
near and at an allowance (both meters summed, so one clinic can count twice), and the alerts
Slack could not post after its four tries (only while Slack is on, and only when there are
any). The counts come from the
lifecycle rows and the entitlements, not from alerts, so a count can stand with no alert row
behind it; Home lists every alert of the last day whether or not Slack took it, one row per
alert and clinic, and each decision owed as its own row with "Decide" (lane A4), and the
Clinics table shows each clinic's stage and usage. If the line did not arrive by morning, open System › Jobs: the digest's row shows its
switch, last run and note (sent, already gone, or the failure).

The email's own queue table is read by the same function as Home and System › Requires your
attention (`readMachineQueues`), so a count and an age in the email are the ones those screens
show: a notice held for later (quiet hours, a retry, a reminder for tomorrow) is not waiting
until it falls due, a job waits from when it became due, and a job that failed in the last two
days is a queue of its own. Dead letters and bounces are in the email-by-kind table, not told
twice. The email also carries one line, "Approvals: N items waiting for your yes", the approval
inbox without support replies (the support line counts those). A switched-off job is not a queue
and the email does not mention it; System › Jobs shows which are off.

### Approvals

`approval_waiting`. The approval inbox (`apps/app/src/lib/approvals/`, ops automation Phase 6)
holds only what no automatic process will retry (owner decision D17), put there hourly by the
`approvals-propose` job (off until the owner switches it on):
- a cancellation or setup closure the billing worker gave up on (nothing else retries those);
- a plan start or price step-up the billing worker gave up on, only while the hourly billing
  check (`billing-reconcile`) is switched off. While it is on, it puts such a change back for
  another try a day later by itself, so it is not listed;
- an extra-usage invoice that failed, only while the daily extra-usage run
  (`annual-overage-invoice`) is switched off. While it is on, the 05 UTC run invoices it again;
- a Stripe event parked after its retries, unless a purchase still waiting to be provisioned
  names it (provisioning applies those by itself). An event that names no clinic is listed
  with none.

Turning one of those two jobs on takes the items it now covers off the list (expired, unrun).
The alert comes once an item has waited a day, one per kind, by email and Slack; Home lists the
waiting items from the inbox itself, so this alert is left off Home. The items are on the Queues
page, under Approvals: each says what approving does, and says when it can no longer be approved
(after that moment a decision is refused and the approvals job takes it off the list). Approve
asks for the approval passcode (or the code from your authenticator) and runs the same operation as the clinic's Billing
tab button, once. For a billing change that only makes it due again: the billing worker carries
it out at its next run, if it still applies and while its switch (and, for a closure, setup
closure's) is on at System > Jobs. An extra-usage invoice is invoiced at once. Reject asks for
the code too and runs nothing now: the failure is not proposed again, and if the job that
retries it is switched on later, that job still retries it; the clinic's Billing tab is where to
retry it by hand. A Stripe event that resolved to no clinic is on no clinic's Billing tab (the
tab lists parked events by resolved clinic); Approve on the Queues page is the only button that
replays it, and the card says so. A refused decision (already decided, window passed, no code)
comes back as its own sentence on the card; a decided item leaves the list and its outcome line
stays on the section. Nothing is ever approved by waiting: after seven days an item leaves the
list unrun (expired), and so does one whose change or event has since gone through, or whose
clinic is now closed or a demo. An item left half-decided by a process that stopped is recorded
as failed (interrupted) after 15 minutes; if the operation finishes after that, its real outcome
is recorded too, so check History before acting. History, on the same page, is the add-only
record of who decided what and when (the operator account, its IP address and browser), read
from `ops_approval_events`; the event an item ends on reads went through, failed, rejected or
left the list without running, with the outcome's words beside it.

`clinic_email_waiting`. The same inbox also holds every email the owner sends a clinic by hand
(ops automation lane P6f): the chase of a business associate agreement version re-sign, proposed
by the approvals job from day 8 once L22's day-7 reminder has gone, at most once in seven days;
and, proposed only by an operator's button, the question of which agreement a practice needs,
more time to finish setup, the note that we are finishing a step, the offer of a five-minute
call, and the next setup reminder sooner. Each card shows the email as the clinic would read it
and the only choices that may change (a number of days, what the email names, one approved
closing sentence); no typed text goes in. Approve asks for the code and sends it once: for more
time, the deadline moves first and the email goes only if it moved. The chase's signing link is
made when it is sent and never stored. The alert comes once an item has waited two days (one
for a reminder sooner), one per kind; an email leaves the list unsent after 14 days, a reminder
sooner after three. The agreement question's answer is recorded by the owner, as he heard it,
with the approval passcode or a fresh authenticator code; a Yes or Not sure pauses AYA at every location until the BAA is signed.

**The approval passcode** (lane P7h; owner, 26 October 2026). Every approval decision and every
agreement answer takes the one 6-digit approval passcode (`HEALDESK_APPROVAL_PASSCODE_HASH`, a
scrypt hash on Vercel, made with `node apps/web/scripts/hash-approval-passcode.mjs`) or a fresh
authenticator code. Five wrong tries of either lock approvals for fifteen minutes, on that warm
instance (the console says "locked for N more minutes"); wait it out. If the lock was not you,
someone has the console session: sign out everywhere (rotate `HEALDESK_ADMIN_SECRET`) and make a
new passcode. Unset, the code box says only the authenticator works. Each decision's security
event records `factor: passcode` or `factor: authenticator`.

The same inbox holds every composed reply to a clinic's support request (`support_reply_send`,
ops automation lane P7c; owner decision D12), the one email whose body is prose. A reply is put
there only when its draft passes every reply check: by Save draft on the case (the operator's own
text, saved as the next version) or Propose, and later by the drafter. The item shows the reply as
the clinic would read it, under a subject fixed for its topic with the case's ref, signed The
Healdesk Team. Send asks for the approval passcode (or the code from your authenticator); you may edit the body (never the
subject) first, and the checks run again on exactly the text approved: if one fails, nothing is
sent and the card names the rule, never the words. A case closed since, or a newer draft, sends
nothing. The reply goes to the practice's one sign-in address, once; a failed try is tried again on
the email outbox's schedule, and after six the sending stops (`support_reply_dead`). These items
are drawn beside their case under Support, not under Approvals; Home's row for them opens Support.
They raise no reminder of their own: the case's `support_case_past_due` already does. An item
leaves the list unsent after 14 days, and at once, as `case_closed`, when its case is closed.
There is no Reject on a support reply: Close the case to not send it (the case view says so);
the item is then expired unsent, and a clinic that writes again opens a new case.

### Compliance pack

`compliance_pack_ready`, `compliance_pack_failed`. The weekly compliance pack
(`apps/app/src/lib/compliance-pack/`, ops automation lane P6h; owner decision D20: for the owner
only) is one stored row per week, Monday to Sunday on New York's clock, made by the hourly
`compliance-pack` job (off until the owner switches it on) from 07:00 New York on the Monday
after the week (11:00 UTC in summer, 12:00 UTC in winter). Each run also checks the four weeks
before and makes any that is missing (a pack made late says so). Once stored it never changes:
the table refuses every update and delete, for every role. It holds counts, ids, dates and
closed words: agreements bound and re-signs, the vendor chain's attestations, incidents and their
two clocks, patient-rights requests and their clocks (counted in UTC days, the tracker's own
days, not New York's), transcript copies and the purge jobs, the security log's counts and the
approval inbox's decisions. Never a patient, never anything typed. Demo clinics are left out of
the per-clinic counts only; the platform-wide counts (agreements bound, attestations, the
security log, the approval inbox, the job rows) include any demo clinic's rows. Numbers named
"...Now" are as the database stands when the pack is made, because no history of them is kept.

`compliance_pack_ready` comes once a week by email to the ops address only: never Slack, never
a Home row. It gives the week and five numbers (incidents still open, less service complaints;
rights requests past their day; re-signs unsigned; vendor agreements not in force or ending
within 30 days; transcript copies held past 30 days). Each is a promise; any number above zero
needs a person that week. A week with a section that could not be read is not stored at first:
the job tries every hour, and after two days from its due time stores it marked incomplete, with
that section's number left out of the email, never shown as zero. The printable page is
`/admin/compliance/pack/<week>` (lane P6j); a week older than the job's four-week look-back is
made from there by hand (`generateCompliancePack`, at most 104 weeks back), never one already
stored.

`compliance_pack_failed` comes when the same week failed on two runs in a row. The job keeps
trying every hour; read its last run at System > Jobs (it names the weeks that failed), check
System > Requires your attention for a database that cannot be reached, and the next good run
stores the week.

### Incident assistant

`incident_step_waiting`. The incident assistant's two kinds of item in the approval inbox
(`apps/app/src/lib/approvals/incident-kinds.ts`, ops automation Phase 6, lane P6i; owner
decision D18): an incident opened at every clinic a vendor's or a channel's incident window
reached (proposed by an operator after reading the scope), and one practice's incident report,
pre-filled from fixed lists (proposed by an operator, by an approved batch for each incident it
opened, and by the hourly pass for any open reportable incident with no report proposed before
and no notice recorded; a report the owner rejected, or one that failed with a reason on its row,
is never proposed again by the pass, only by hand; one that was interrupted, meaning the owner
approved it and the process carrying it out died, so nobody knows it did not go, is proposed
again by the next hourly pass, once per interruption, and the alert comes for it as for any
item). The hourly pass runs from the `incident-deadlines` job (seeded on)
and from `approvals-propose` (off until switched on). Both kinds are legal clocks: the alert
comes, by email and Slack, at the first hourly pass after an item arrives and again at the first
pass 4 hours or more after the last, while one waits; an item never expires and is never
approved by waiting. A scope for the database host or AWS lists every clinic holding data by
default (the window's counts as information); narrow it to the window only when the vendor's
notice says the exposure was in transit. One batch opens at most 100 clinics, and each opened
incident's report is then its own approval with its own passcode or code. They are
decided on Compliance › Incidents (lane P6j draws them there): Approve asks for the approval
passcode (or the code from your authenticator) and runs the console's own operation once, openIncident at each listed clinic
(never twice for one scope) or Send report with the choices shown. A report's choices are changed
only by picking from the lists, and a choice Send report would refuse is refused before anything
is recorded. Reject runs nothing and leaves the incident's clock running. Not reportable stays
its own button on the Incidents page; nothing here records it or resolves an incident. A report
item leaves the list unrun once the incident has been reported, recorded not reportable or
resolved from that page. Each incident's checklist records the procedure's steps, once each, by
the operator account; the email step needs a report or a recorded notice first, and the resolve
step a resolved incident.

### Support replies

`support_reply_dead`. A support reply the owner approved (ops automation lane P7c,
`apps/app/src/lib/support/send.ts`) failed every try: one at approval, then after 1, 5, 30, 120
and 360 minutes, the email outbox's schedule. The sending has stopped; the text stays as approved
and is never tried again, so the clinic has not heard. The clinic's Deliveries tab lists the reply
under Reports and alerts (kind support_reply) with the last try's status and reason. Check the
clinic's address if it bounced, then write to the clinic from hello@ with the same answer and
close the case. The retries run from the `support-send` job (Jobs, above), which ships off:
until it is on, only the first try at approval happens, and a failed first try stays waiting
with no alert. If the clinic's sign-in address changed between a try Resend took and the next
one, Resend refuses the retry because its key was already used with another address; the send
treats that refusal as sent (the reply went, to the address at the time) and raises no alert.

### Support cases

`support_case_past_due`, `support_case_now`. The support cases' watch (ops automation lane P7e,
`apps/app/src/lib/support/watch.ts`), run by `ops-watch`. A case that still needs us (new, being
drafted, drafted and waiting for your yes, or waiting for an edit) whose reply-by day has passed
in New York raises `support_case_past_due`, once per case; a chat request on a case no longer
raises `support_reply_past_due`, so one promise is one alert. A case the chat triaged `now`
(calls not reaching AYA or ringing out, a charge questioned, a lost device, sign-in security)
raises `support_case_now` within the minute, once per case, and Slack posts it. Each names the
clinic, the case's ref and its reply-by day, never the clinic's words. Open Support,
find the case by its ref, send its draft with your code (the Send button) or write from hello@
and close it as replied by hand. The same watch, hourly, puts a case whose snooze ran out back where its draft
says (drafted, waiting for an edit, or new for the drafter) and closes, silently, as
`no_further_reply`, a case that has waited on the clinic 14 days since our reply: nothing is sent.
The morning digest carries one line: "Support: N need you, M past their day, K waiting on a
clinic".

### Inbound support mail

No event of its own: inbound support mail (ops automation lane P7g, `apps/app/src/lib/support/inbound/`,
`infra/aws/ses-inbound.tf`) turns a clinic's email to support@healdesk.io or hello@healdesk.io,
forwarded by the owner's mailbox to the same name on in.healdesk.io, into a support case holding
facts only in the database (topic, urgency, how it matched a clinic, counts of what looked like
patient details, attachment counts), never the email's words. The email waits in the bucket until
the support drafter has read it once (lane P7h) and is then deleted; the sweep deletes anything six
hours old. The console never shows it: read it in the mailbox by the case's reference.

- **A clinic says it emailed and no case appeared.** Open System > Jobs and read the
  `support-inbound-sweep` job's last note: "N handled, N already recorded, N dropped, N older than
  six hours deleted, N left waiting for the drafter deleted, N left, N failed". "Left waiting for
  the drafter deleted" above zero means emails sat six hours undrafted: is `support-draft` on? Dropped means a loop guard (an auto-reply, a list, a bounce, our
  own address, SES's spam or virus verdict); the engine's log line `support inbound dropped` names
  SES's id and the reason. Search the owner's mailbox for the email: if it was never forwarded, the
  forwarding rule is the problem, not the engine.
- **The sweep keeps finding objects (handled above zero every hour).** The webhook is not getting
  SES's notices, or failing on them. Check that `/api/webhooks/inbound-mail` answers 404 only while
  `HEALDESK_INBOUND_MAIL_TOPIC_ARN` is unset; in AWS CloudShell `aws sns list-subscriptions-by-topic
  --topic-arn <terraform output inbound_mail.topic_arn>` must show the HTTPS subscription
  confirmed (if it is missing, an `infra.yml` apply with `subscribe_inbound_mail = true` while the
  engine answers makes it again). Log lines `inbound mail not recorded` (a database or S3 failure;
  SNS retries for about 45 minutes, then the sweep takes it) and `inbound mail notice refused`
  (another topic or a bad signature: someone else is posting) name the ids, never the mail.
- **"N left" stays above zero.** One of them may be a mail provider's forwarding confirmation,
  which is left on purpose for the owner to read once (`docs/handover.md`, "Inbound support mail");
  the sweep deletes it once it is six hours old. An email waiting for the drafter is not counted
  "left": it counts as already recorded until the drafter or the sweep deletes it. Anything else
  left is a key the sweep does not recognise.
- **"N failed" above zero.** S3 or the database refused the sweep; the next hour tries again, and
  the bucket's one-day lifecycle rule is the backstop (S3 applies it asynchronously, up to about
  two days after the email arrived), so an email can be lost after a day of failures: read the
  engine's log for `support inbound sweep` lines and fix the cause the same day.
- **`inbound mail: HEALDESK_INBOUND_MAIL_BUCKET is not set`.** The topic is set on the task but
  the bucket is not: a configuration error. The webhook answers 503, so SNS keeps retrying the
  notice (about 45 minutes) and the email waits in the bucket; run a full `deploy-app.yml` so the
  tasks carry both variables, then the sweep takes what waited.
- **A draft says "the draft written from the practice's email failed a check, so it was not kept"
  (`checks_failed`) or "could not be read" (`email_unreadable`).** The email is already deleted:
  read it in the mailbox by the case's reference and write the reply by hand; Regenerate drafts
  again from the case's fields and the account only.
- **A clinic's email became a case with no clinic.** Its fields say `authenticated: no`: the
  sender's domain did not pass DKIM aligned with its From, nor DMARC, at SES, so the address
  alone was not trusted. Match the case to the clinic by hand once you are sure it is theirs.

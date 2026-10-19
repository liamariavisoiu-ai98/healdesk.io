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
| Heartbeat | `/api/health` → `heartbeatAgeSeconds`; ops console job list, row `heartbeat` | under 3,700 s | over 2 hours: the worker is down or stuck |
| Queue | `/api/health` → `queue.oldestPendingSeconds`, `queue.failed` | pending under 1 h, failed 0 | pending over 2 h or failed rising: a handler is throwing; read `log.error` lines with `queue error` |
| Email | `/api/health` → `email.lateCriticalNotices` and `reasons`; ops alert emails (`ops_alerts`); the job list, row `billing-notices` | 0 late | any late: a critical email is still unsent ten minutes after it was due. `/api/health` answers 503 with `"reasons": ["critical_notice_undelivered"]` and ops is emailed once per notice. Check Resend and the job's note, then call the clinic |
| Jobs | ops console job list: `last_run_status` and `last_run_note` | `ok` | `failed` twice in a row, or `already-running` for over an hour (a stale lock is reclaimed after 60 min; 10 min for `calendar-watch`) |
| Calendar watch | ops alert emails (`calendar_broken`, `calendar_degraded`, `calendar_recovered`, `google_oauth_client_rejected`, `calendar_watch_incomplete`, `calendar_watch_failed`); the job list, row `calendar-watch`, whose note counts each run's checks, breakages, misses, skips and failures and ends with the run's id | `ok` every five minutes once switched on | `google_oauth_client_rejected`: at once, every clinic is affected. `calendar_watch_failed`, or `failed` on the job row, twice in a row: read the worker's `calendar watch` error lines. `calendar_watch_incomplete` on most runs. No `last_run_at` ten minutes after switching it on: the queue was not installed or the worker not restarted (look for `queue clock not running` with `calendar-watch`) |
| Voice endpoint | The voice target group's healthy-task alarm (`alarms.tf`); ops alerts `voice_call_start_failed` and `retell_fallback_unsynced`; the worker's hourly `tick` log line, `retell-fallback=` (the sync is not a row in the job list); Retell's call history for `error_llm_websocket_*` | healthy tasks at `voice_desired`; `retell-fallback=ok` | The alarm, or any `error_llm_websocket_*` call: outage mode on ("Voice endpoint down"). `voice_call_start_failed`: the database, first. `retell_fallback_unsynced`: that clinic's number in Retell, or the key |
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
3. The ops console job list: which job failed, and its note. Notes are
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

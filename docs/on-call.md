# On-call, in one page

Three processes run from the `apps/app` image, and each fails differently:

| Process | Command | What breaks when it is down |
| --- | --- | --- |
| Web tier | `node apps/app/server.js` | The portal, the web chat widget's API, the Meta webhooks, provisioning and billing events |
| Worker | `npm run worker -w @healdesk/app` | Everything scheduled (below). Nothing patient-facing stops at once; the watches stop watching |
| Voice endpoint (Retell custom-LLM WebSocket) | Not built yet | Every forwarded call. Retell reaches no brain, so the call must fall through to the clinic |

**The rule every failure ends in:** a patient calling a clinic always reaches someone.
Every degradation path ends with calls forwarding to a direct clinic line that does not
forward back to us, and website chat becoming a contact form. If you are deciding what to
switch off during an incident, switch off the assistant, never the clinic's line. The
automatic fall-through for an endpoint or vendor failure is not built; until it is,
check that Retell's own failure behaviour for the agent sends the call to the clinic's
direct line.

## What the worker runs

The worker owns the clock: pg-boss schedules one hourly tick (`lib/scheduler/tick.ts`).
Every job ships switched off and is enabled from the ops console when the first live
clinic exists.

Today's tick runs the billing sweep, the connection watchdog, the weekly recap, the
retention purge (03 UTC), offboarding destruction (every hour, on every agreement's
rule: each clinic is due a day before its thirty days, or on BAA 1.3.0 and the DPA
without an export its ninety, are up, so it is gone before they are whatever hour it
left) and the annual renewal reminder (09 UTC). It also still carries the monthly revenue report and the nightly POS
sync, which are phase two and stay switched off in v1, and two sweeps from the 23
September booking design (Meta booking drafts, booking-requirement defaults).

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

v1 adds jobs that are not built yet: the Google Calendar token watch, knowledge re-audits
when a clinic's knowledge changes, the monthly re-scrape diff, the demo-sandbox purge
(7 to 14 days), the 14-day zero-inbound flag for an active voice plan, the 48-hour
zero-interaction flag, the 48-hour channel-not-live reminder to the clinic, and the daily
summary email to the clinic. None of these contacts a patient; v1 sends patients nothing
after a conversation ends.

**An hourly tick is not "the moment a connection breaks".** The calendar token watch
catches expiry ahead of time, but a write that fails on authorisation must also flip the
clinic to manual booking mode in the same turn, from the tool layer, without waiting for
the worker.

## The signals

| Signal | Where | Healthy | Act when |
| --- | --- | --- | --- |
| Heartbeat | `/api/health` → `heartbeatAgeSeconds`; ops console job list, row `heartbeat` | under 3,700 s | over 2 hours: the worker is down or stuck |
| Queue | `/api/health` → `queue.oldestPendingSeconds`, `queue.failed` | pending under 1 h, failed 0 | pending over 2 h or failed rising: a handler is throwing; read `log.error` lines with `queue error` |
| Email | `/api/health` → `email.lateCriticalNotices` and `reasons`; ops alert emails (`ops_alerts`); the job list, row `billing-notices` | 0 late | any late: a critical email is still unsent ten minutes after it was due. `/api/health` answers 503 with `"reasons": ["critical_notice_undelivered"]` and ops is emailed once per notice. Check Resend and the job's note, then call the clinic |
| Jobs | ops console job list: `last_run_status` and `last_run_note` | `ok` | `failed` twice in a row, or `already-running` for over an hour (a stale lock is reclaimed after 60 min) |
| Voice endpoint | Not built. Needs its own liveness check, and Retell's call log for calls that reached no endpoint | — | Any forwarded call that did not reach the endpoint and did not fall through to the clinic |
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

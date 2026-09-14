# On-call, in one page

There is one process that matters: the worker (`npm run worker -w
@healdesk/app`). Every scheduled behaviour — the reports, the sync, the
watchdog, the purge, the reminders — runs inside it on an hourly tick.

## The three signals

| Signal | Where | Healthy | Act when |
| --- | --- | --- | --- |
| Heartbeat | `/api/health` → `heartbeatAgeSeconds`; ops console job list, row `heartbeat` | under 3,700 s | over 2 hours: the worker is down or stuck |
| Queue | `/api/health` → `queue.oldestPendingSeconds`, `queue.failed` | pending under 1 h, failed 0 | pending over 2 h or failed rising: a handler is throwing; read `log.error` lines with `queue error` |
| Jobs | ops console job list: `last_run_status` and `last_run_note` | `ok` | `failed` twice in a row, or `already-running` for over an hour (a stale lock is reclaimed after 60 min) |

Point an external uptime check (any provider; it lives outside the thing it
watches) at `GET /api/health` and alert on a non-200 or on
`heartbeatAgeSeconds > 7200`. That is the alarm.

## What to check first

1. `GET /api/health`. `db: unreachable` → the database or its credentials;
   nothing else will work until that does.
2. The worker's logs for `worker failed to start`, `queue error`, or the last
   `tick` line. A tick line every hour with `status` per job is normal.
3. The ops console job list: which job failed, and its note. Notes are
   truncated error messages with no patient data in them.

## Restarting the worker safely

The worker drains on SIGTERM (`stopBoss` with `graceful: true`): an in-flight
sync finishes its page before exit. Stop it with the host's normal stop
(ECS task stop, `fly machine restart`, `systemctl restart`), never `kill -9`
unless the graceful stop has hung for more than two minutes. On start it
re-registers the hourly schedule as an upsert; you will not get two clocks.

## What is NOT an emergency

- A job showing `disabled`: it is switched off on purpose. Every job ships
  off and is enabled from the console when the first live clinic exists.
- `already-running` for a few minutes: two ticks overlapped; the lock is
  released when the first finishes.
- The `heartbeat` job "enabled": it is the liveness signal, not a job.

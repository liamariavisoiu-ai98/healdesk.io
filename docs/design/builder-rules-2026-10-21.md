# Builder rules and test recipe (from the 21 October 2026 session)

Pass this file to every builder agent you start. It is what the builders of that
session followed. Today's date when written: 2026-10-21.

## Read first (in this order, skim what is not yours)
1. `CLAUDE.md`: the PHI boundary, "Product rules the code enforces", the `/admin/map` rule.
2. `docs/claude-session-start.md`, `AGENTS.md`, and the handover your package comes from.
3. The parts of `docs/v1-product-spec.md` your package touches (search it, do not read it whole; never edit it).
Verify claims in these docs against the code before relying on them.

## Hard stops (violating any of these fails the task)
- NO `git push`, NO merge into main, NO deploy, NO Terraform apply, NO live vendor or API calls, NO network writes, unless your brief lists a specific push.
- NEVER set or change `HEALDESK_DIRECT_BOOKING_ENABLED`, `voice_real_calls`, `HEALDESK_VOICE_REAL_CALLS`, `HEALDESK_VOICE_PROVISION_ENABLED` or any switch the owner holds. Tests may stub env.
- NEVER put secrets, tokens, PHI or real patient data in code, tests, fixtures, commits or reports. Synthetic data only.
- Do not edit `docs/v1-product-spec.md`. Do not change launch-register statuses (`apps/web/src/lib/admin/seo/launch.ts`) unless your brief says so; production status is the owner's.
- Respect the PHI boundary: `apps/web` gets no DB client; whatever needs the database or a patient's words is `apps/app`, plain Node, no `@vercel/*`, no edge runtime.
- Inbound only: add no code path that contacts a patient first or after a conversation ends (the one ruled exception is a window-gated reply to a patient's open request). No SMS. No outbound calls. Card numbers are never taken.
- Preserve other people's uncommitted work. Never use bare `git stash`. Never `git add -A` in a shared checkout; add explicit paths. Commit only in your own worktree and branch.
- Use Context7 (`resolve-library-id`, then `query-docs`) for any third-party library or API; do not rely on memory.

## Method
Read, plan briefly, implement, test, self-review the diff, report. Match the surrounding style and comment density. Commit messages explain WHY in prose and name the failure the change prevents; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
Keep `/admin/map` true in the same change (`apps/web/src/lib/admin/system-map.ts`, plus `apps/app/src/lib/ops/key-presence.ts` for AWS keys). If the spec or code is ambiguous on something that changes behaviour, choose the more conservative behaviour, write it under "Decisions", and continue. If you hit a blocker you cannot resolve safely, stop that piece, commit what is sound, and report.

## Worktrees and module resolution (a trap that cost time)
Work in your own worktree: `git worktree add ../healdesk-<name> -b <branch> <base>`. Do NOT symlink `node_modules` from another checkout: `@healdesk/catalog` then resolves to THAT checkout's catalog, and `apps/app` tests silently run against the wrong code. Run `npm ci` at the worktree root (retry on network errors). Confirm with `cd apps/app && node -e "console.log(require.resolve('@healdesk/catalog/package.json'))"`: it must resolve inside your worktree. Only if `npm ci` cannot finish, use uncommitted vitest/tsconfig alias files pointing `@healdesk/catalog` at `packages/catalog/src`, listed in `$(git rev-parse --git-path info/exclude)`.

## Tests: targeted only, against a fresh database of your own
Machine load can reach 400+ with parallel sessions: run only the files your change touches plus their direct neighbours, never the whole suite, with `--testTimeout=120000 --hookTimeout=240000`, and rerun a failing file ALONE before calling it a failure. Many `apps/app` suites `describe.skip` without a database, which proves nothing; use your own Postgres:
```
C=<container>; P=<port>      # unique per builder
docker run -d --name $C -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=healdesk_dev -p $P:5432 postgres:17-alpine
until docker exec $C psql -U postgres -d healdesk_dev -c 'select 1' >/dev/null 2>&1; do sleep 1; done
cd <worktree>/apps/app
docker cp scripts/provision-roles.sql $C:/tmp/p.sql
docker exec $C psql -q -U postgres -d healdesk_dev -v migrator_password=devmigrator -v app_password=devapp -f /tmp/p.sql
MIGRATION_DATABASE_URL=postgres://healdesk_migrator:devmigrator@localhost:$P/healdesk_dev npx drizzle-kit migrate
export TEST_APP_URL=postgres://healdesk_app:devapp@localhost:$P/healdesk_dev TEST_MIGRATOR_URL=postgres://healdesk_migrator:devmigrator@localhost:$P/healdesk_dev HEALDESK_LOCAL_KEK=$(openssl rand -base64 32)
npx vitest run <files> --testTimeout=120000 --hookTimeout=240000 --reporter=dot
```
Never export `DATABASE_URL` for tests. Remove the container when done (`docker rm -f $C`). If the container exists from a dead run, remove it and recreate. Packages: `cd packages/catalog && npx vitest run`; web: `cd apps/web && npx vitest run <files>`; typecheck the workspace you changed (`npx tsc --noEmit`). A fresh DB must migrate from zero to the latest migration with no error; `npx drizzle-kit generate` must then report no schema changes.
Known failure not yours: `apps/app/tests/setup-wizard.test.ts` "one on day 5" fails on unmodified main. Report skips and failures exactly; never claim a test passed that you did not run.

## Report (final message, under 300 words)
Branch and HEAD; files changed (grouped); exact commands with passed/failed/skipped counts; `Decisions`; open questions and owner-only actions; anything you could not verify. Separate code implemented / tests passed; you cannot claim deployed, live-verified or owner-approved.

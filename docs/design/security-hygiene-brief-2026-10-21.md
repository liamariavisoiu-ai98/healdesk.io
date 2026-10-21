# Security hygiene: instructions for a new Claude Code session (SEC-01, P1)

Paste the block under "Startup prompt" into a new session opened in
`/Users/liamariavisoiu/projects/healdesk.io`, ideally on Opus 5.5. Everything
else in this file is the brief the session works from. It is self-contained.

## Startup prompt

> Read `docs/claude-session-start.md`, `AGENTS.md`, `CLAUDE.md` and
> `docs/design/security-hygiene-brief-2026-10-21.md`, issue the reading receipt,
> then carry out SEC-01 exactly as that brief describes, on a new branch
> `pkg/security-hygiene` in its own git worktree. Do not push, merge, deploy or
> change any GitHub setting; list what only the Owner can switch on.

## Why

The Wave 0 audit (`docs/wave0-audit-2026-10-21.md`) found, from the code:
- no secret scanning, dependency audit, CodeQL or `dependabot.yml` anywhere in
  `.github/` (workflows today: `ci.yml`, `delivery-handoff.yml`,
  `deploy-app.yml`, `host.yml`, `indexnow.yml`, `infra.yml`);
- nothing stops a database client being added to `apps/web`, or `@vercel/*` or
  `export const runtime = 'edge'` being added to `apps/app`: today the PHI
  boundary in `CLAUDE.md` rests on a manual audit;
- CI's "Assert the security tests actually ran" step (`ci.yml`, ~L352) fails on
  fewer than 200 passes or any skipped/todo test, but does not name the files
  that must have run, so a deleted or renamed `tenant-isolation` or `rls-drift`
  suite would go unnoticed. Verify this claim before acting on it.
The repository is public, so GitHub's native scanning features are free.

## Scope: five deliverables, one commit each

1. **Boundary guard (tests, no new dependency).** A vitest file, e.g.
   `apps/web/src/lib/boundary.test.ts` plus `apps/app/tests/portability.test.ts`:
   - `apps/web`: `package.json` (dependencies and devDependencies), the
     lockfile entry for the workspace, and every `import`/`require` in `src`
     contain no `pg`, `drizzle-orm`, `drizzle-kit`, `postgres`, `@neondatabase/*`,
     `@vercel/postgres`, `@prisma/*`, `mysql*`, `mongodb`, `ioredis` or similar
     database client, and no `DATABASE_URL`/`MIGRATION_DATABASE_URL` read;
   - `apps/app`: no `@vercel/*` dependency or import, no
     `export const runtime = 'edge'` (or `"edge"` in any route config), no
     `process.env.VERCEL*`, `x-vercel-*` or `geo` header read used as logic
     (the `CLAUDE.md` portability rules);
   - each failure message names the rule and the file. Prove each guard can
     fail (temporarily add a violation locally, see it fail, remove it).
2. **CI: name the security suites.** Extend the "Assert the security tests
   actually ran" step (or add a step after it) to read `test-results.json` and
   fail unless named files appear with at least one passed test:
   `tenant-isolation`, `rls-drift`, the BAA immutability suite, the billing RLS
   suite, `vendor-coverage`, `database-url-tls`. Derive the exact file names
   from `apps/app/tests/` (do not guess); keep the list in one array in the
   workflow with a comment saying why.
3. **Secret scanning in CI.** A new workflow `.github/workflows/security.yml`
   running gitleaks (pin the action by full commit SHA and the tool version;
   read the action's current docs through Context7 or the repository, do not
   write it from memory) on push to `main`, on pull requests and on a weekly
   schedule, with `fetch-depth: 0`. Add a repo `.gitleaks.toml` that allows only
   the known synthetic test values already in the repo (run it locally first;
   every allowlist entry needs a comment naming why it is not a secret). Never
   print a finding's secret in logs.
4. **Dependency hygiene.**
   - `.github/dependabot.yml`: ecosystems `npm` (root and each workspace via
     `directories`), `github-actions`, `terraform` (`infra/aws`), `docker`
     (`apps/app/Dockerfile`, `infra/aws/images/*`); weekly; grouped minor/patch;
     a sensible open-PR limit so the free reviewer is not flooded.
   - In `security.yml`, an `npm audit --omit=dev --audit-level=high` job that
     fails on high/critical production advisories, with a short documented
     allowlist mechanism (an `audit-exceptions.json` with reason and expiry
     date, checked by a small script) instead of silencing the job.
   - Run the audit locally first and report what it finds; do NOT upgrade
     dependencies in this package.
5. **CodeQL.** `.github/workflows/codeql.yml` for `javascript-typescript`,
   `build-mode: none`, on push to `main`, pull requests and weekly, with
   `security-events: write` as the only elevated permission. Pin by SHA.

Also in this package:
- Every new workflow uses least-privilege `permissions:`, no secrets, pinned
  action SHAs (leave the existing workflows' pins alone; list any unpinned
  ones you notice in the report).
- Run `actionlint` on every workflow you touch if it is installed; `npm run
  lint` and `node scripts/check-delivery-handoff.mjs` must pass.
- `CLAUDE.md` says to keep `/admin/map` true: if you add a tool or vendor
  (gitleaks, Dependabot, CodeQL) decide whether it belongs in
  `apps/web/src/lib/admin/system-map.ts`; add a `TOOLS` entry only if the map
  already lists comparable CI tooling, and say what you decided.
- Update `AGENTS.md` (handoff) with the branch, HEAD, tests and next step.

## Hard stops

No push, merge, deploy, `terraform apply`, or change to any GitHub or vendor
setting. Do not weaken or delete an existing check. Do not add any secret to
the repository. Do not upgrade dependencies. Do not run the full test suites
(they are slow and the load average is high): run only the new guard tests, the
tests of any file you touch, `npm run lint`, and the checker script.

## Acceptance

- Each of the five deliverables has its own commit with a message that explains
  the failure it prevents.
- The two boundary guards pass on current `main` and demonstrably fail when a
  violation is introduced.
- The workflows lint clean and a dry reading shows they cannot leak a secret.
- The report lists exact commands and results, what was not run, and every
  finding from the local gitleaks and `npm audit` runs.

## Owner-only actions after the session (the session must list these, not do them)

1. Repository Settings > Code security: enable **secret scanning** and **push
   protection**, **Dependabot alerts** and **Dependabot security updates**;
   enable **private vulnerability reporting**.
2. Settings > Branches (or Rulesets): protect `main`: require pull requests,
   require the status checks `test`, `delivery-handoff`, the secret scan, the
   audit and CodeQL, and block force pushes. Note this ends direct pushes to
   `main`, which the Owner has used so far; decide that deliberately.
3. Decide who triages Dependabot and CodeQL alerts and how often.
4. Commission the independent assessment and restore drill named in the
   `SECURITY` and `OPS` rows of the master plan; the repository cannot supply
   them.

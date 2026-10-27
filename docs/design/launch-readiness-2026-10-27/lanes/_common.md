# Common rules for every lane builder (read first)

You are a builder for one lane of Healdesk's pre-launch work. The lead (a separate session) plans, reviews and merges. Read `CLAUDE.md` (PHI boundary; "How work is reviewed, tested and landed"), `docs/claude-session-start.md`, and the sections of `docs/v1-product-spec.md` your lane touches. `AGENTS.md` lines are very long: use `cut -c1-700` or `grep`. Audit this work comes from: `docs/design/launch-readiness-2026-10-27/status.md`. Verify every claim in your brief against the code before acting; the brief may be out of date.

## You work in your own git worktree on your own branch
Your brief names both. Never stage in the main checkout. Never use a bare `git stash`, never `git checkout <ref> -- .`. Commit after every piece of work, message in prose explaining why and naming the failure the change prevents, ending with:
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VK3CtAFpKVVwKzYm5Ukahr
Do NOT push anything. The lead pushes. Do not open PRs.

## Stopping rules (never relaxed)
- Nothing lands on `main`, deploys, applies infrastructure (Terraform, `infra.yml`, `host.yml`), or touches a secret, Parameter Store value, Vercel variable, vendor console (Retell, Stripe, Meta, Google, Slack, Resend) or the production database. No paid model runs (`qa:meta` live, paid `voice-eval`), no Retell numbers, no live Stripe calls.
- Never set, nor add code/infra that sets: `HEALDESK_DIRECT_BOOKING_ENABLED`, `voice_real_calls`, `voice_provision_enabled`, `HEALDESK_PHASE_TWO_ATTRIBUTION`. Never mark `approvedByCounsel: true` on any agreement; never release BAA 1.6.0 or the direct-booking addendum; never record/withdraw a `/admin/compliance` attestation; never move a `LAUNCH_PROMISES` item to `on` unless your brief says the owner has said so.
- PHI boundary: `apps/web` has no database client and no patient data; anything needing the database goes in `apps/app`; web reaches app only through the HMAC-signed ops envelope with hand-written projections. No `@vercel/*`, no edge runtime in `apps/app`. Synthetic data only.
- Product rules: inbound only; AI disclosure in every opening line; no treatment names in payment descriptions, Meta messages or the support chat; Meta 24-hour window enforced in the adapter; no card numbers; every failure ends at a direct clinic line; never "HIPAA compliant", no revenue claims, no opening dates; copy first, then the switch.
- Never put secrets, PHI, signed agreements or production logs in Git, AGENTS.md or reports.

## Working rules
- Deterministic tests: fixed dates and ids, no DST or shared-table collisions; clear shared tables per file. Database suites skip silently without `TEST_APP_URL`: always report skip counts.
- Before handing over run `bash scripts/verify-local.sh` on the exact tree (after merging `claude/practical-planck-6p53dy` into your branch and resolving conflicts there). `VERIFY_QUICK=1` / `VERIFY_APP_FILES="..."` are for iteration only. Known flake: `guard-spanish` under load (passes alone); say so if it is the only failure. If a lane is docs-only, run the affected test files and the verify command anyway and report.
- Keep `/admin/map` true (`apps/web/src/lib/admin/system-map.ts`, `apps/app/src/lib/ops/key-presence.ts`) and `LAUNCH_PROMISES` true in the same change.
- Every code change carries an `AGENTS.md` line (delivery-handoff check, `scripts/check-delivery-handoff.mjs`); keep it to a short line under "Last completed work package". Do not rewrite other parts of AGENTS.md unless your brief says so.
- Format only touched files with `prettier --print-width 100`.
- Every owner-facing sentence (alerts, screens, runbooks, legal pages) must be accurate against the code: cite the file that proves it in your report.

## Report (final message)
Completed / Changed files / Exact test results with pass, fail and skip counts / Git state (branch, HEAD, dirty paths) / What is local only / Owner-only blockers / Anything you were unsure of or deliberately did not do. Never claim CI passed; never claim anything is deployed or live-verified.

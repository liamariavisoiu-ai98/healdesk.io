# Agent instructions

This repository's working instructions live in **[CLAUDE.md](./CLAUDE.md)**.
Read it before adding any surface — it is short, and the first section decides
where new code is allowed to go.

What the product is and does is decided by
**[docs/v1-product-spec.md](./docs/v1-product-spec.md)**. It is an export: never
edit it; change the source doc and re-export. The live task list is that doc's
"Launch plan" tab. Where any other doc disagrees with the spec about what the
product does, the spec wins.

The one rule to carry even if you read nothing else:

> **`apps/web` handles NO patient data and has no database client.**
> **`apps/app` handles PHI and must stay portable off Vercel.**
> If it needs the database, it goes in `apps/app`.
> Clinics DO sign in, to the clinic portal in `apps/app`. `/admin` is ours.

`docs/hipaa-compliance.md` is authoritative for what counts as PHI.

---

# Continuously maintained session handoff

**Purpose:** This is a concise, persistent resume pointer, **not** a second product specification or a claim that a previous session succeeded. Read [CLAUDE.md](./CLAUDE.md), [product spec](./docs/v1-product-spec.md), [master delivery plan](./HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md), and [session-start protocol](./docs/claude-session-start.md) first. Keep this section brief (ideally under 100 lines); link to PRs, issues and CI rather than copying lengthy logs.

**Rules:** Verify this snapshot against Git, actual code and CI on every restart. Never store credentials, tokens, PHI, signed agreements or sensitive production logs. Do not overwrite unrelated uncommitted work. Separate `CODE`, `TESTED`, `DEPLOYED`, `LIVE VERIFIED` and `OWNER APPROVED`.

## Handoff snapshot
| Field | Current value |
| --- | --- |
| Last updated (UTC) | 2026-10-21 |
| Current task | `SEC-02` upgrade vulnerable production dependencies (Owner-approved 21 Oct 2026, ahead of `ALERT-01`): CODE complete; TESTED locally and on GitHub CI (run 39633580010 on `check/deps-security`: every job green except `app tests (3/4)`, which fails only the known TEST-01 test, as `main` does). Stacked on `SEC-01` |
| Status | AWAITING OWNER: CI on `check/deps-security` is red only because of TEST-01 (`setup-wizard` "one on day 5", red on every recent `main` run too), which also keeps the `test` gate from reaching the new named-suites step; decide how SEC-01 and SEC-02 land (SEC-02 contains SEC-01's commits) and when to deploy |
| Branch / HEAD | `pkg/deps-security` in worktree `/Users/liamariavisoiu/projects/healdesk-sec02`, from `pkg/security-hygiene` (90714b0d). SEC-02 commits 9c9a4811, 3fe38726, 6f4239d8; this handoff is the next commit. Pushed to origin only as `check/deps-security`, for CI; `main` and the epic branch untouched |
| Worktree | Own worktree, clean after the handoff commit; the `healdesk-sec01` worktree (`pkg/security-hygiene`) is unchanged |
| Approved scope | SEC-02 only; push of a `check/` branch for CI allowed by the Owner. No merge to `main`, no deploy |
| Next action | Owner reads CI on `check/deps-security` and rules on landing and deploy timing. Claude Code next: `ALERT-01`, as the Owner ordered |
| Blocker | Owner rulings and actions listed in the audit doc; plus the SEC-01 Owner actions below |

## Last verified / reported evidence
- **Owner-reported:** Retell and Anthropic agreements signed, database coverage confirmed. Do not request repeat signatures.
- **Tests (2026-10-21, isolated Postgres, local):** DPA-release catalog suite 1750 passed; 20 of 21 `apps/app` files the release touched pass (527 of 528 tests). The one failure, `setup-wizard.test.ts` "one on day 5", fails identically on unmodified main (TEST-01). `go-live`, `practice-questions-db`, `stripe-connect-webhook`: 58 passed with 60s timeouts; at the 5s default they time out under load. Full `apps/app` and `apps/web` suites not run this session; CI not checked.
- **Not verified:** deployment, production behaviour, Owner approvals.

## Last completed work package
- **SEC-02 (local; pushed only as `check/deps-security`):** `npm audit --omit=dev` went from 18 high/critical advisories (3 critical, all `next`) to 1, accepted by name. `next` ^16.3.0 to ^16.3.8 in `apps/web` and `apps/app`; lockfile-only bumps of sharp 0.35.5, axios 1.20.0, follow-redirects 1.16.1, source-map-js 1.2.2, vite 8.3.5; no platform entry lost. The remaining advisory, `GHSA-c475-qrg2-pj4r` (basic-ftp, only via the undeployed `packages/leadgen`), is excepted in `audit-exceptions.json` until **2026-12-20** (Owner's choice, 60 days; no in-range fix). CI (GitHub, 21 Oct 2026, 28f75877): `types, lint, other tests, build` success; `app tests` 1, 2 and 4 of 4 success; `infra` failed once on a Terraform-registry network error and passed on rerun; `app tests (3/4)`: 1 failed, 2086 passed, the failure being `setup-wizard.test.ts` "one on day 5" (TEST-01), identical to `main`'s runs 39633440875 and 39618968259; the `test` gate therefore failed at its first step and CI's new named-suites step has NOT run on GitHub. Run against the real test-result files of parts 1, 2 and 4, that step's script finds all seven named suites with passing tests and exits 0. Local results: `tsc --noEmit` clean in all four workspaces; `npm run lint` clean; `npm run build` for both apps passes (from a clean `npm ci`); CI's AWS-SDK build assertion passes; the prerendered OG image is a correct 1200x630 PNG; `boundary`, `portability`, `ci-db-guard`, `audit-gate`, `aws-sdk-clients`, `aws-sdk-externals` tests pass (51 in all, 0 skipped); audit gate exits 0, and exits 1 a day past the expiry. Not run locally: the full `apps/app` and `apps/web` suites (left to GitHub CI), the arm64 image build, anything deployed. `security.yml` and `codeql.yml` do not trigger on `check/**` branches, so neither has run on GitHub.
- **SEC-01 (local, not pushed):** a failing-test guard for the PHI boundary (`apps/web/src/lib/boundary.test.ts`) and portability (`apps/app/tests/portability.test.ts`); CI step "Assert the named security suites ran" naming seven suites (`ci.yml`, with tests in `ci-db-guard.test.ts`); `security.yml` (gitleaks 8.30.1 by checksum, and `npm-audit` via `scripts/check-npm-audit.mjs` + `audit-exceptions.json`, empty); `.gitleaks.toml`; `dependabot.yml`; `codeql.yml`. Tests run this session: boundary 9 passed, portability 10 passed, ci-db-guard 9 passed, audit-gate 12 passed, 0 skipped; `npm run lint` clean; gitleaks full history with config: no leaks. Not run: full suites, `actionlint` (not installed), anything on GitHub. `/admin/map` unchanged on purpose: no new key, variable or vendor entry.
- DPA address relabel (`6cd6b190`, owner's middle option) rebased and pushed to `main` with the DPA 1.0.0 release (`caa32895`, `f0c3ee19`) on the owner's instruction. The epic branch `claude/epic-babbage-n9g119` was NOT updated and sits at fdbbd696.

## Next actions — ordered
0a. **Owner, SEC-02:** CI is red only on TEST-01, so a green `test` gate (and a first real run of the named-suites step) waits for a TEST-01 fix, which is not part of SEC-02; build the arm64 image (via `deploy-app.yml`, yours to run) before relying on sharp's new binaries in production; note `apps/web` reaches Vercel on a merge to `main`; renew or remove the basic-ftp exception by 2026-12-20.
0. **Owner, SEC-01:** in GitHub, enable secret scanning and push protection, Dependabot alerts and security updates, private vulnerability reporting; protect `main` (require PRs and the checks `test`, `delivery-handoff`, `secret scan`, `npm audit (production)`, `analyze (javascript-typescript)`; block force pushes), which ends direct pushes to `main`, a deliberate choice; decide who triages Dependabot and CodeQL alerts; commission the independent assessment and restore drill (`SECURITY`, `OPS`). Review the red `npm-audit` job and the `next` advisories. Unpinned actions remain in `ci.yml`, `delivery-handoff.yml` and `indexnow.yml` (`@v4`).
1. **Owner:** approve the first package (`ALERT-01` recommended) and rule on the Meta follow-up question in the audit doc.
2. **Claude Code:** implement it on a branch with tests; no deploy, no push without approval.
3. **Owner:** run `deploy-app.yml` for migration 0104 when ready; record vendor attestations; the other actions in the audit doc.

## Owner approvals and restrictions

### Owner rulings (2026-10-21)
- **Window-gated replies to a patient's open request are allowed** (a Meta reply deciding or rescheduling a booking request, sent by `sendMetaReply` inside the 24-hour window). `CLAUDE.md` "Inbound only" now says so. The spec's "Outbound" rows are unchanged; the source doc may need the same clarification before the next re-export.
- **ALERT-01:** `urgent-alert` stays `on` in the launch register. The owner is adding `RESEND_API_KEY` in AWS Parameter Store and will switch on `billing-notices`; the code must make the "I've told the team" claim depend on them.
- **NOAUDIO-01:** create or update Retell agents with call-data storage restricted in code. No fail-closed check on real calls; instead an admin-console alert when a call was recorded, with a button that deletes that recording through the Retell API from `apps/app`.

### Hard stops
No merge, push, production deploy, Terraform apply, live vendor changes, real patient traffic, compliance attestation or final go-live without specific Owner approval. Preserve existing code and report any dirty worktree.

## End-of-session update contract
Before stopping, replace stale values above with **actual** task ID/status, UTC time, branch/HEAD, dirty paths, changed files, exact tests/results (including skips), evidence links, blockers, Owner decisions and **one next executable step**. Keep stable architectural guidance at the top unchanged. If interrupted, reconstruct state from Git and CI; do not invent a checkpoint.

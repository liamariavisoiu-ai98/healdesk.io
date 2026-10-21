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
| Current task | `SEC-01` security hygiene (P1), five deliverables, one commit each: CODE complete and TESTED locally; NOT run on GitHub. Brief: [docs/design/security-hygiene-brief-2026-10-21.md](./docs/design/security-hygiene-brief-2026-10-21.md) |
| Status | AWAITING OWNER: review `pkg/security-hygiene`, decide how to land it, and switch on the GitHub settings below. The new `npm-audit` job will be red on its first run (18 high/critical production advisories, three critical, all in `next`) until dependencies are upgraded or the Owner accepts named advisories |
| Branch / HEAD | `pkg/security-hygiene` in worktree `/Users/liamariavisoiu/projects/healdesk-sec01`, from `main` at 9909f5c0. Deliverables e7c2d152, 396cf99e, 905da99d, 4abdd282, 8a489755; this handoff is the next commit. Not pushed |
| Worktree | Own worktree, clean after the handoff commit. `main` checkout untouched by this session. Other local-only branches and worktrees as before |
| Approved scope | SEC-01 only, by the Owner's instruction this session. No dependency upgrades, no push, no GitHub setting |
| Next action | Owner reviews the branch (`git log 9909f5c0..pkg/security-hygiene`), then the Owner-only actions below. Claude Code next: a separate package to upgrade `next` (>=16.3.8), `axios`, `sharp` and the rest, then `ALERT-01` as before |
| Blocker | Owner rulings and actions listed in the audit doc; plus the SEC-01 Owner actions below |

## Last verified / reported evidence
- **Owner-reported:** Retell and Anthropic agreements signed, database coverage confirmed. Do not request repeat signatures.
- **Tests (2026-10-21, isolated Postgres, local):** DPA-release catalog suite 1750 passed; 20 of 21 `apps/app` files the release touched pass (527 of 528 tests). The one failure, `setup-wizard.test.ts` "one on day 5", fails identically on unmodified main (TEST-01). `go-live`, `practice-questions-db`, `stripe-connect-webhook`: 58 passed with 60s timeouts; at the 5s default they time out under load. Full `apps/app` and `apps/web` suites not run this session; CI not checked.
- **Not verified:** deployment, production behaviour, Owner approvals.

## Last completed work package
- **SEC-01 (local, not pushed):** a failing-test guard for the PHI boundary (`apps/web/src/lib/boundary.test.ts`) and portability (`apps/app/tests/portability.test.ts`); CI step "Assert the named security suites ran" naming seven suites (`ci.yml`, with tests in `ci-db-guard.test.ts`); `security.yml` (gitleaks 8.30.1 by checksum, and `npm-audit` via `scripts/check-npm-audit.mjs` + `audit-exceptions.json`, empty); `.gitleaks.toml`; `dependabot.yml`; `codeql.yml`. Tests run this session: boundary 9 passed, portability 10 passed, ci-db-guard 9 passed, audit-gate 12 passed, 0 skipped; `npm run lint` clean; gitleaks full history with config: no leaks. Not run: full suites, `actionlint` (not installed), anything on GitHub. `/admin/map` unchanged on purpose: no new key, variable or vendor entry.
- DPA address relabel (`6cd6b190`, owner's middle option) rebased and pushed to `main` with the DPA 1.0.0 release (`caa32895`, `f0c3ee19`) on the owner's instruction. The epic branch `claude/epic-babbage-n9g119` was NOT updated and sits at fdbbd696.

## Next actions — ordered
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

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
| Last updated (UTC) | 2026-10-21 (end of a long multi-agent session) |
| Current task | Launch-readiness handover H0 to H8: [docs/design/launch-readiness-handover-2026-10-21.md](./docs/design/launch-readiness-handover-2026-10-21.md). First: review every branch diff against a fresh database, starting with `pkg/alert-noaudio` |
| Status | Session work is on GitHub as BRANCHES (`integ/wave0-fixes` merges eight of them; `check/wave0-integration` runs CI). Merged code NOT verified locally. `pkg/voice-provisioning` and `pkg/ended-early-redial` are unfinished WIP |
| Branch / HEAD | `main` at 2221a669 before any landing; integration branch `integ/wave0-fixes` at c6820b04 (see the handover table for every branch HEAD) |
| Worktree | Main checkout: this handoff and two design docs uncommitted or local until pushed; `apps/app/Dockerfile` modified by another session, leave it. Builder worktrees `../healdesk-*` hold the branches listed in the handover |
| Approved scope | Packages H0 to H8 in the handover; no deploy, no owner switches, no push to `main` without the owner |
| Next action | New session: H0, review each branch diff on a fresh test database, `pkg/alert-noaudio` first, then H1 finish the two WIP builders, H2 voice eval, H3 patch "no call audio is kept", H4 Spanish urgent screen |
| Blocker | Owner actions: deploy the app image after any web deploy that carries the amended agreement text (hash-check hazard), vendor attestations, switches; see handover section 4 |

## Last verified / reported evidence
- **Owner-reported:** Retell and Anthropic agreements signed, database coverage confirmed. Do not request repeat signatures.
- **Tests (2026-10-21, isolated Postgres, local):** DPA-release catalog suite 1750 passed; 20 of 21 `apps/app` files the release touched pass (527 of 528 tests). The one failure, `setup-wizard.test.ts` "one on day 5", fails identically on unmodified main (TEST-01). `go-live`, `practice-questions-db`, `stripe-connect-webhook`: 58 passed with 60s timeouts; at the 5s default they time out under load. Full `apps/app` and `apps/web` suites not run this session; CI not checked.
- **TEST-01 (branch `fix/setup-wizard-day5`, local, not pushed):** "one on day 5" failed because the queued notice's `send_after` defaults to the database's `now()` while the test delivered at a fixed `now` of 2026-10-20 16:00Z; once the real clock passed it, `deliverNotice` answered `not_due`. A test bug, not production (production queues and delivers on the real clock). The test now takes its noon from the database clock. Two neighbours in the same block (deadline correction, fixed 8 October purchase) would fail after 7 November 2026, and two `operator-notices` tests (L28, L33, fixed 2027-01-05) after that date; all fixed the same way. Proved with Postgres under libfaketime plus a fake Node `Date` at 2026-10-20, 2026-10-21, 2026-11-15, 2027-01-05 and 2027-03-01/06. CI not run.
- **Not verified:** deployment, production behaviour, Owner approvals.

## Last completed work package
- **Email footer trim (2026-10-22, committed and pushed to `main` on the Owner's instruction; not deployed):** the Resend footers no longer print "healdesk is a service of Viixi FZC…" or the "US mailing address (correspondence only):" label; they print the bare mailbox address. Changed: `apps/app/src/lib/email/templates/compose.ts` (`footerLines`), `packages/catalog/src/agreement-copy-email.ts`, `apps/web/src/lib/email/setup-emails.ts` (`identity()`), the matching test assertions and four `apps/app` snapshots. Left alone on purpose: the transcript email (`transcript-email.ts`, sent through SES, not Resend) still prints the entity line; the Terms, Privacy and `/about` pages still carry the entity and the labelled address (`CLAUDE.md` rule). Tests run: catalog 1804 passed; `apps/web` email, demo, agreement, voice-demo, sender-identity and site-copy suites 498 passed; `apps/app` templates, notices, billing, reminder and agreement-mail suites passed (1157). `conversations-screen.test.ts` could not load here (`@simplewebauthn/server` not installed in this checkout) and its snapshot is untouched. CI on `main` not yet read.
- **SEC-01 and SEC-02 (merged to `main` on the Owner's instruction, 21 Oct 2026):** boundary and portability guard tests; CI names seven security suites that must pass (`ci.yml`, tested in `ci-db-guard.test.ts`); `security.yml` (gitleaks 8.30.1 by checksum over full history, and `npm audit --omit=dev` through `scripts/check-npm-audit.mjs` + `audit-exceptions.json`); `.gitleaks.toml`; `dependabot.yml`; `codeql.yml`. SEC-02 took `next` ^16.3.8 in both apps and the fixed releases of sharp, axios, follow-redirects, source-map-js and vite: the production audit went from 18 high/critical advisories (3 critical, all `next`) to 1, `GHSA-c475-qrg2-pj4r` (basic-ftp, via the undeployed `packages/leadgen`), excepted until **2026-12-20**. CI on `check/deps-security` (run 39633580010): every job green except `app tests (3/4)`, which fails only TEST-01 (`setup-wizard` "one on day 5"), as `main` does. `security.yml` and `codeql.yml` had not run on GitHub before this merge. Owner actions still open for SEC-01: enable secret scanning, push protection, Dependabot alerts and security updates and private vulnerability reporting; **the Owner chose on 22 Oct 2026 to keep direct pushes to `main`, so do not enable a branch rule that requires pull requests or required status checks (either one ends direct pushes); the checks `test`, `delivery-handoff`, `secret scan`, `npm audit (production)` and `analyze (javascript-typescript)` still run and are read after each push; a rule that only blocks force pushes and branch deletion keeps direct pushes if wanted**; decide who triages alerts; commission the independent assessment and run the restore drill, for which the material is written: [docs/design/independent-security-assessment-brief-2026-10-22.md](./docs/design/independent-security-assessment-brief-2026-10-22.md) (a scope to send a firm) and [docs/design/restore-drill-run-sheet-2026-10-22.md](./docs/design/restore-drill-run-sheet-2026-10-22.md) (the drill's runbook is `infra/aws/README.md`, "Restore drill"; both need the Owner: AWS access and a vendor). Unpinned `@v4` actions remain in `ci.yml`, `delivery-handoff.yml`, `indexnow.yml`.
- DPA address relabel (`6cd6b190`, owner's middle option) rebased and pushed to `main` with the DPA 1.0.0 release (`caa32895`, `f0c3ee19`) on the owner's instruction. The epic branch `claude/epic-babbage-n9g119` was NOT updated and sits at fdbbd696.

## Next actions — ordered
1. **Owner:** approve the first package (`ALERT-01` recommended) and rule on the Meta follow-up question in the audit doc.
2. **Claude Code:** implement it on a branch with tests; no deploy, no push without approval.
3. **Owner, pre-launch:** switch on `billing-notices` in `/admin/ops` (Scheduled jobs; tracked as `alert-sender-on` in the launch register, which blocks go-live; `RESEND_API_KEY` is set in Parameter Store as of 2026-10-21 and the services were restarted); `deploy-app.yml` for migration 0104 is blocked, see below; record vendor attestations; the other actions in the audit doc.

## Owner approvals and restrictions

### Owner rulings (2026-10-21)
- **Window-gated replies to a patient's open request are allowed** (a Meta reply deciding or rescheduling a booking request, sent by `sendMetaReply` inside the 24-hour window). `CLAUDE.md` "Inbound only" now says so. The spec's "Outbound" rows are unchanged; the source doc may need the same clarification before the next re-export.
- **ALERT-01:** `urgent-alert` stays `on` in the launch register. The owner is adding `RESEND_API_KEY` in AWS Parameter Store and will switch on `billing-notices`; the code must make the "I've told the team" claim depend on them.
- **Voice engine (later 21 Oct):** the product voice agent STAYS on the custom-LLM WebSocket endpoint; Retell's native LLM is not being pursued (assessment kept in `docs/design/voice-native-llm-migration-2026-10-21.md`). The spec and `CLAUDE.md` voice sections are not changed. Retell keeps a call's transcript/recording only until our copy is committed, then we delete it (1-day retention backstop); legal text for this was minimally amended on branch `fix/legal-retell`. No call-backs: a call that ends early is flagged to the clinic and a redial is recognised.
- **NOAUDIO-01:** create or update Retell agents with call-data storage restricted in code. No fail-closed check on real calls; instead an admin-console alert when a call was recorded, with a button that deletes that recording through the Retell API from `apps/app`.

### Hard stops
No merge, push, production deploy, Terraform apply, live vendor changes, real patient traffic, compliance attestation or final go-live without specific Owner approval. Preserve existing code and report any dirty worktree.

## End-of-session update contract
Before stopping, replace stale values above with **actual** task ID/status, UTC time, branch/HEAD, dirty paths, changed files, exact tests/results (including skips), evidence links, blockers, Owner decisions and **one next executable step**. Keep stable architectural guidance at the top unchanged. If interrupted, reconstruct state from Git and CI; do not invent a checkpoint.

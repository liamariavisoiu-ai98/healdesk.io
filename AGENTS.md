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

# Session handoff — live state (update after every work package)

**Purpose:** This is a concise, persistent resume pointer, **not** a second product specification or a claim that a previous session succeeded. Read [CLAUDE.md](./CLAUDE.md), [product spec](./docs/v1-product-spec.md), [master delivery plan](./HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md), and [session-start protocol](./docs/claude-session-start.md) first. Keep this section brief (ideally under 100 lines); link to PRs, issues and CI rather than copying lengthy logs.

**Rules:** Verify this snapshot against Git, actual code and CI on every restart. Never store credentials, tokens, PHI, signed agreements or sensitive production logs. Do not overwrite unrelated uncommitted work. Separate `CODE`, `TESTED`, `DEPLOYED`, `LIVE VERIFIED` and `OWNER APPROVED`.

## Resume pointer
| Field | Current value |
| --- | --- |
| Last updated (UTC) | 2026-10-21; GitHub handoff prepared after PR #11 merge |
| Current task | `WAVE0-01` — read-only launch inventory and work-package proposal |
| Status | READY FOR LOCAL RECONCILIATION; full engineering audit and production proof not claimed |
| Branch / HEAD | Resolve locally with `git branch --show-current` / `git rev-parse HEAD` |
| Worktree | Unknown; inspect `git status --short` before editing |
| Approved scope | Read-only audit and planning after Owner authorizes this work |
| Next action | Pull latest main; inspect local changes; read session-start protocol; begin Wave 0 when authorized |
| Blocker | Local checkout and uncommitted work are not visible through GitHub; reconcile before editing |

## Last verified / reported evidence
- **Owner-reported:** Retell and Anthropic agreements signed, database coverage confirmed, signed evidence retained. Do not request repeat signatures without a specific new requirement.
- **Source-inspected, not production-verified:** SEO/GEO code and `apps/web/src/lib/admin/seo/launch.ts`. The launch-promise register requires real evidence before a feature is marked on.
- **This change:** continuity rules, master plan, startup procedure and CI hygiene were merged in [PR #11](https://github.com/liamariavisoiu-ai98/healdesk.io/pull/11); no product code, production deployment or live tests were performed.

## Last completed work package
- ID / outcome: PR #11 merged into main at `dd6182f9c65a0d5388a51cf005242f11471e8e74`; handoff refresh in progress.
- Changed paths: `CLAUDE.md`, `AGENTS.md`, master plan, startup note, PR template, workflow and checker.
- Tests: Vercel check was successful on PR head; post-merge Vercel check pending at last observation. No application tests or delivery-handoff Actions result verified.
- Evidence: [PR #11](https://github.com/liamariavisoiu-ai98/healdesk.io/pull/11).

## Next approved work and Owner queue
1. **Owner:** Pull latest `main` into the existing local checkout **without discarding unfinished changes**; inspect Actions and configure required handoff status check in branch protection.
2. **Claude Code, once authorized:** First reconcile any previous local session's uncommitted files, branch and unfinished tasks; then run Wave 0 read-only audit and propose evidence-backed work packages.
3. **Owner:** Approve the first bounded engineering work package before product edits.

## Hard stops
No merge, push, production deploy, Terraform apply, live vendor changes, real patient traffic, compliance attestation or final go-live without specific Owner approval. Preserve existing code and report any dirty worktree.

## End-of-session update contract
Before stopping, replace stale values above with **actual** task ID/status, UTC time, branch/HEAD, dirty paths, changed files, exact tests/results (including skips), evidence links, blockers, Owner decisions and **one next executable step**. Keep stable architectural guidance at the top unchanged. If interrupted, reconstruct state from Git and CI; do not invent a checkpoint.

## GitHub-to-local transition note (2026-10-21)
- GitHub PR #11 is merged: https://github.com/liamariavisoiu-ai98/healdesk.io/pull/11 ; merge commit `dd6182f9c65a0d5388a51cf005242f11471e8e74`.
- **No local workspace was inspected.** The prior Claude Code session may have local-only edits or a feature branch. Before `git switch main` or `git pull`, inspect `pwd`, `git remote -v`, `git status --short`, `git branch --show-current`, `git log -5 --oneline`, and `git diff`; preserve all unfinished work.
- New-account authentication and connector access are **not** verified by this GitHub handoff. Confirm CLI account and minimum necessary permissions locally.
- The launch register includes owner-gated alerts, phone activation, BAA/legal release and calendar/deposit features; do not assume any status is production verified solely from the register.
- Next **single** engineering step: produce a read-only reconciliation of the local checkout with GitHub `main` and this handoff, then begin `WAVE0-01` if approved.

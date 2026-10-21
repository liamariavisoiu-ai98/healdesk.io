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

This section is **operational state**, not a replacement for the architecture rules above. Follow [CLAUDE.md](./CLAUDE.md), the immutable [product specification](./docs/v1-product-spec.md), and the [master execution plan](./HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md). Start every session with [the proof-of-reading procedure](./docs/claude-session-start.md).

**Do not assume the following state is current.** Compare it to the actual branch, HEAD, worktree, recent commits, code and test results. Refresh this section at the end of each work package or before an account/session switch. Never put credentials, tokens, patient data or protected logs here.

## Handoff snapshot
- Updated (UTC): 2026-10-21 (initial handoff; refresh on next engineering session)
- Repository: `liamariavisoiu-ai98/healdesk.io`
- Branch and HEAD: **recheck with Git**; no development checkout state verified here.
- Current wave: Wave 0 — read-only repository and launch-readiness audit.
- Current approved task: Review the master plan, reconcile it with code and launch promises, and propose bounded implementation packages. **No production deployment or activation authorized.**
- Working tree: Unknown; inspect `git status --short` before editing.

## Verified facts and source of truth
- `CLAUDE.md` and `docs/v1-product-spec.md` govern architecture and product scope.
- The Owner reports Retell and Anthropic agreements executed, database coverage confirmed, and signed evidence retained. This is Owner-reported, not a live production configuration check.
- The SEO/GEO admin dashboard, technical SEO routes and launch-promise register have been inspected in source; production success has **not** been established by this handoff.
- `apps/web/src/lib/admin/seo/launch.ts` contains public-promise launch blockers; never mark an item `on` without the specified production evidence.

## Work completed in the current documentation change
- Permanent session rules added to `CLAUDE.md` on a review branch.
- Proof-of-reading procedure, execution plan, PR template and automated documentation check are being prepared on that branch.
- No product feature, production integration, deployment or live acceptance test has been completed by this documentation work.

## In progress / failures
- Engineering Wave 0 has **not** been run.
- No CI, test or deployment result is claimed here. Check the PR and GitHub Actions after opening it.

## Next actions — ordered
1. Review and merge the continuity documentation PR after checks and Owner approval.
2. In a fresh Claude Code session, run the read-only Wave 0 audit using `docs/claude-session-start.md`.
3. Produce a prioritized, evidence-backed list of Claude Code tasks and Owner-only dependencies.
4. Ask for approval before implementing the first bounded task.

## Owner approvals and restrictions
- Approved scope: This documentation/CI preparation only.
- NOT approved: merge to `main`, production deployment, Terraform apply, production vendor changes, real patient traffic, or final launch attestation.
- Pending: Owner review of the PR and selection of the first implementation package.

## Evidence and rollback
- Evidence: GitHub pull request for `chore/claude-session-continuity-20261021`.
- Rollback: Revert the documentation/CI commits if approved changes are later withdrawn.
- **Checkpoint fields for every future session:** task ID; branch; HEAD; dirty paths; changes; exact test commands/results; evidence URLs; blockers; Owner decisions; next approved action.

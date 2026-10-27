# Lane LEGAL-2 — BAA 1.6.0 release, PREPARED NOT RELEASED
Model: Opus. Worktree `../healdesk-legal2`, branch `lane/legal-2`. Read `_common.md` first. A legal clock: be exact.

Goal: on this branch, prepare the BAA 1.6.0 release exactly as the register describes, with `approvedByCounsel` left FALSE and a clear TODO, so the owner can release by a one-line change. The branch is never landed by you.

Read: `apps/web/src/lib/admin/seo/launch.ts` item `baa-1-6-0-retention`; `packages/catalog/src/baa.ts` (BAA_TEMPLATES, template 1.6.0, the doc comment on `approvedByCounsel`, how 1.5.1 was added); `docs/baa-v1.6.0.txt`; `docs/counsel/agreement-changes.md` section 17; the release migration that released an earlier version (0081 in `apps/app/drizzle/`) and the DPA release 0104; Terms § 9 (`apps/web/src/app/terms/page.tsx`), `LEGAL_VERSION` in `apps/web/src/lib/legal.ts`, and `docs/design/launch-readiness-handover-2026-10-21.md` § 4.2 (agreement-hash hazard: a new legal text on Vercel while the old apps/app image re-renders the old one).

Do:
1. Prepare the release as the register describes: `BAA_TEMPLATES` order, a release migration modelled on 0081 (new number; check journal/meta consistency with `drizzle` schema check), Terms § 9's restored sentence "The Business Associate Agreement states the same" under a new `LEGAL_VERSION`, tests updated. Everything that depends on `approvedByCounsel: true` must be gated so that with the flag FALSE the product behaves exactly as today (1.5.1 offered). Work out and state precisely which mechanism makes release a ONE-LINE flip, and make it so; if it cannot be exactly one line, say what the minimum diff is and why.
2. Write `docs/design/launch-readiness-2026-10-27/baa-1-6-0-owner-checklist.md`: read the marketing Sheet for 1.5.1 signers (what to look at, no data in Git), decide the floor and any overlap, the order of deploy (apps/app image first or Vercel first, given the hash hazard), what changes for a clinic mid-checkout, and the exact one-line flip.
3. Do not release, do not set the flag, do not touch the Sheet or production.
Accept: full `verify-local.sh` passes with the flag false; report names the flipping diff; second review will be done by the lead (legal clock).

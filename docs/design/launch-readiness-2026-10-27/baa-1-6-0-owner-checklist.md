# BAA 1.6.0: owner checklist (prepared, NOT released)

State on this branch: `BAA_1_6_0_RELEASED` is `false` in `packages/catalog/src/baa.ts`, 1.6.0's `approvedByCounsel` is false, checkout offers 1.5.1, and nothing in production changes. `approvedByCounsel` for 1.6.0 flips to true only through that switch (`baaTemplatesFor(true)`); no template literal says true.

Why this matters: Terms section 1 lets the signed agreement win over Terms section 9 on anything about patient information, so while clinics sign 1.5.1 (whose Subcontractors clause gives Anthropic's 30 days a purpose, keeps law-required content two years and says the service cannot run with shorter retention) the corrected section 9 is overridden. `LAUNCH_PROMISES` item `baa-1-6-0-retention` blocks go-live until 1.6.0 is released. Counsel has not reviewed 1.6.0 (`docs/counsel/agreement-changes.md` section 17); release is the owner's call, as for 1.5.1 on 19 October.

## 1. Look at the marketing Sheet first (nothing from it goes into Git)

In the Sheet's sealed agreement and purchase tabs (`lib/checkout/records.ts`; read only, no edits, sorting or deleted rows), count the rows whose agreement version is 1.5.1 and that are not yet provisioned (no first paid invoice carried them to `/api/provision`). Also look in `/admin` for any clinic already provisioned under 1.5.1.

- None of either: the floor moves to 1.6.0 with no overlap (what the staged migration does, the treatment 0081 gave 1.5.0).
- Any unprovisioned 1.5.1 signer: they cannot be provisioned and go live under 1.5.1 once the floor is 1.6.0. Either (a) keep the release back until they are provisioned, or (b) contact them to re-sign 1.6.0 (`lib/agreements/resign.ts` opens the re-sign once the floor passes their version). A time-limited overlap (`BAA_RELEASE_OVERLAP`) is NOT recommended: the go-live floor test fails while a listed version is below the floor, and it would leave a clinic under the clause this release removes.
- Any clinic already live under 1.5.1: apps/app has held synthetic data only, so none should exist; if one does, stop and decide before releasing.

## 2. Mid-checkout effect

A buyer who loaded the agreement step on 1.5.1 before the release and signs after it is refused with the reload message (`signableTemplate`, overlap empty); they reload and sign 1.6.0. A buyer who signed 1.5.1 before and pays after is the Sheet case above. Terms version moves to 2026-10-27.2, so a signed-in buyer sees the new Terms on the next load.

## 3. Deploy order (agreement-hash hazard, handover 2026-10-21 section 4.2)

apps/web auto-deploys from `main` on Vercel; apps/app moves only when the owner runs `deploy-app.yml` (which runs the migration before rolling the tier). Either order has a short window: web first means checkout offers 1.6.0 while the old image re-renders without it and rejects the import (the provision dead-letters, replayable); app first means the new floor refuses a 1.5.1 go-live and a 1.5.1 tab. Recommended: merge and, in the same sitting, run `deploy-app.yml` straight away (it applies the new migration first), and pause checkout (or accept replaying a dead-lettered provision) in between. No clinic is live, so nothing patient-facing is at risk. Then confirm `/terms` prints 2026-10-27.2 and checkout shows 1.6.0. Landing, deploying and migrating need the owner's explicit yes.

## 4. The flip, exactly

It is not one line: it is one switch plus the files the switch cannot generate.

1. `packages/catalog/src/baa.ts`: `export const BAA_1_6_0_RELEASED: boolean = false;` becomes `= true;`. This alone moves `BAA_TEMPLATES`, `CURRENT_BAA_VERSION`, `MIN_ACCEPTABLE_BAA_VERSION`, `isBaaVersionAcceptable`, Terms section 9's sentence "The Business Associate Agreement states the same" and `LEGAL_VERSION` (to 2026-10-27.2); `legal-version.test.ts` already pins the released hash for `/terms`.
2. Add the migration, from `apps/app`: `npx drizzle-kit generate --custom --name baa_release_1_6_0`, paste `docs/design/launch-readiness-2026-10-27/baa-release-1-6-0.sql` over the empty file and replace `<DAY>` with the day of your word. It cannot be shipped inert beforehand: a migration applies unconditionally and cannot read the TypeScript flag, and applied early it would refuse every 1.5.1 signer at go-live (`tests/baa-release-1-6-0.test.ts` fails if it is in `drizzle/` while the flag is false, and if it is missing while true). Delete the staged copy in the same commit or leave it as the record.
3. If it goes out on a later day than 27 October 2026: `LEGAL_LAST_UPDATED` in `apps/web/src/lib/legal.ts` and `lastUpdated` plus the `/terms` hash in `PINNED_WITH_1_6_0` (`apps/web/src/lib/legal-version.test.ts`) move together.
4. Tests that state "1.5.1 is current" fail with the switch on and need their expectation moved to 1.6.0 (found by running the suites with the switch on: `apps/web` terms-copy (two), AgreementStep.version, agreement-kinds (three), legal-version note citation; `packages/catalog` agreement-copy, baa-explainer (two), baa-selections; the app suites that cite `"1.5.1"` as current, among them agreements, baa-golden, checkout-agreement-match and compliance-pack, and a golden hash for 1.6.0 as a released template). Also move `baa-1-6-0-retention` to `on` in `launch.ts` and update the paragraph above `BAA_TEMPLATES`, the `approvedByCounsel` doc comment and AGENTS.md. None of this was done here, so the branch stays releasable only after a second pass on the flip commit.

Do not flip before sections 1 and 3 are settled; the lead's second review covers the legal clock.

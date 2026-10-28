# BAA 1.6.0: owner checklist (prepared, NOT released)

State on this branch: `BAA_1_6_0_RELEASED` is `false` in `packages/catalog/src/baa.ts`, 1.6.0's `approvedByCounsel` is false, checkout offers 1.5.1, and nothing in production changes. `approvedByCounsel` for 1.6.0 flips to true only through that switch (`baaTemplatesFor(true)`); no template literal says true.

Why this matters: Terms section 1 lets the signed agreement win over Terms section 9 on anything about patient information, so while clinics sign 1.5.1 (whose Subcontractors clause gives Anthropic's 30 days a purpose, keeps law-required content two years and says the service cannot run with shorter retention) the corrected section 9 is overridden. `LAUNCH_PROMISES` item `baa-1-6-0-retention` blocks go-live until 1.6.0 is released. Counsel has not reviewed 1.6.0 (`docs/counsel/agreement-changes.md` section 17); release is the owner's call, as for 1.5.1 on 19 October.

## 1. Look at the marketing Sheet first (nothing from it goes into Git)

In the Sheet's sealed agreement and purchase tabs (`lib/checkout/records.ts`; read only, no edits, sorting or deleted rows), count the rows whose agreement version is 1.5.1 and that are not yet provisioned (no first paid invoice carried them to `/api/provision`). Also look in `/admin` for any clinic already provisioned under 1.5.1.

- None of either: the floor moves to 1.6.0 with no overlap (what the staged migration does, the treatment 0081 gave 1.5.0).
- Any unprovisioned 1.5.1 signer: they cannot be provisioned and go live under 1.5.1 once the floor is 1.6.0. Hold the release until they are provisioned (a), or handle each by hand (b). There is no code path that asks a not-yet-provisioned buyer to re-sign: `lib/agreements/resign.ts` works only for a provisioned account. A time-limited overlap (`BAA_RELEASE_OVERLAP`) is NOT recommended: the go-live floor test fails while a listed version is below the floor, and it would leave a clinic under the clause this release removes.
- Any clinic already live under 1.5.1: apps/app has held synthetic data only, so none should exist; if one does, stop and decide before releasing.

## 2. Mid-checkout effect

Three kinds of buyer, read from `apps/web/src/lib/checkout/order.ts` and `app/api/checkout/route.ts`:

- A page opened before the release is refused on `termsVersion` (`order.ts`, the terms tick-box check) because `LEGAL_VERSION` moves to 2026-10-27.2; the buyer reloads, reads the new Terms and ticks again. An agreement step loaded on 1.5.1 and signed after the release is refused with the reload message (`signableTemplate`, overlap empty); they reload and sign 1.6.0.
- A buyer who signed 1.5.1 but has not started Stripe is refused at `/api/checkout` (`agreementMismatch`, the agreement version is no longer acceptable) and must sign again.
- Only a buyer already in Stripe, or awaiting the first invoice, is the Sheet case of section 1: their sealed 1.5.1 agreement is in the marketing Sheet and cannot be provisioned once the floor has moved.

## 3. Deploy order (agreement-hash hazard, handover 2026-10-21 section 4.2)

apps/web auto-deploys from `main` on Vercel; apps/app moves only when the owner runs `deploy-app.yml`, which runs the migration before rolling the tier. It also re-rolls the voice service, so it needs the owner's word that no call is running or planned (CLAUDE.md, rule 5).

- **Web first (Vercel deploys on merge, apps/app still on the old image):** checkout offers 1.6.0. The old image re-renders a 1.6.0 agreement to the same hash, so the hash check passes, but it still holds 1.6.0 as a draft: `agreementTemplateReleased("1.6.0")` is false there. A buyer who signs and pays in that gap is refused, either when the records are imported (`checkIntentAgreement`, `lib/checkout/import.ts`) or, failing that, at `agreementForProvisioning` (`lib/provisioning.ts`, the `agreementTemplateReleased` check). Either way the route answers 422, marks the intent failed, ops gets `provisioning_rejected`, and the buyer gets the "order delayed" email once. Nothing is lost: the intent is not consumed, so the purchase can be replayed from Approvals (`replayBillingEvent`) after the new image is up. /welcome says the order is delayed until then.
- **App first (migration applied, new image up, web still on the old Vercel deploy):** the new floor refuses a 1.5.1 go-live and a 1.5.1 tab until web catches up; checkout still offers 1.5.1 for that window, and a purchase made then is refused at provisioning the same way.
- **Recommended: merge and, in the same sitting, run `deploy-app.yml` straight away** (with the owner's word on the voice service), so the gap is minutes. Vercel normally finishes first, so expect the web-first behaviour for those minutes. There is no pause-checkout control in the product: do not plan on one. If a purchase lands in the gap, replay it from Approvals after the deploy. No clinic is live, so nothing patient-facing is at risk. Then confirm `/terms` prints 2026-10-27.2 and checkout shows 1.6.0. Landing, deploying and migrating need the owner's explicit yes.

## 4. The flip, exactly

It is not one line: it is one switch plus the files the switch cannot generate.

1. `packages/catalog/src/baa.ts`: `export const BAA_1_6_0_RELEASED: boolean = false;` becomes `= true;`. This alone moves `BAA_TEMPLATES`, `CURRENT_BAA_VERSION`, `MIN_ACCEPTABLE_BAA_VERSION`, `isBaaVersionAcceptable`, Terms section 9's sentence "The Business Associate Agreement states the same" and `LEGAL_VERSION` (to 2026-10-27.2); `legal-version.test.ts` already pins the released hash for `/terms`.
2. Add the migration, from `apps/app`: `npx drizzle-kit generate --custom --name baa_release_1_6_0`, paste `docs/design/launch-readiness-2026-10-27/baa-release-1-6-0.sql` over the empty file and replace `<DAY>` with the day of your word. It cannot be shipped inert beforehand: a migration applies unconditionally and cannot read the TypeScript flag, and applied early it would refuse every 1.5.1 signer at go-live (`tests/baa-release-1-6-0.test.ts` fails if it is in `drizzle/` while the flag is false, and if it is missing while true). Delete the staged copy in the same commit or leave it as the record.
3. The release day is 28 October 2026 or later, so `LEGAL_LAST_UPDATED` in `apps/web/src/lib/legal.ts` and `lastUpdated` in `PINNED_WITH_1_6_0` (`apps/web/src/lib/legal-version.test.ts`) move to that day together; `lastUpdated` is outside the hash, so only the equality test notices. The pinned `/terms` hash there was taken with the switch on (`8a440e17...2d88`) and `replaces` is `2026-10-27.1`, the live version.
4. Tests whose expectation moves to 1.6.0. Derived on 28 October 2026 by running the catalog, apps/web and apps/app suites with the switch on and the migration generated locally (not committed). These are expectation changes, not regressions. `compliance-pack` does NOT fail.
   - `apps/web`: terms-copy (2: the BAA-passage use of "Business Associate Agreement"; the model's 30-day retention disclosure), `AgreementStep.version` (1), agreement-kinds (3: 1.2.2 bullets, 1.5.1 bullets/notes/text, the 1.3.0 booking-system answers).
   - `packages/catalog`: agreement-copy (1: the BAA's copy shown today), baa-explainer (2), baa-selections (1: which templates ask the calendar questions).
   - `apps/app`, no database: agreement-pdf (5, among them "names the file by version and date"), agreements (5: 1.5.1 and 1.6.0 "signable while current", "offered template is released", "go-live floor", "the real release: 1.5.1 current"), baa-golden (7: each of 1.2.1 through 1.5.1 gains "replaced by 1.6.0", and 1.6.0 stops being a draft), checkout-agreement-match (1), email-templates (3 snapshots: `baa_resign_chase` for clients and for patients, and the L22 snapshots).
   - `apps/app`, database suites (skipped in the derivation run for lack of `TEST_APP_URL`, so named from the code, not reproduced): database-audit "app_mark_clinic_production takes 1.5.1" (asserts the floor is "1.5.1") and google-calendar-schema (its supersede fixture inserts an acceptance at '1.5.1'). Run them against the verify database on the flip commit; others may fail that I could not see.
   - `legal-version.test.ts` passes with the switch on once `PINNED_WITH_1_6_0` is as committed here.

   Also move `baa-1-6-0-retention` to `on` in `launch.ts` and update the paragraph above `BAA_TEMPLATES`, the `approvedByCounsel` doc comment and AGENTS.md. 1.6.0's `publishedOn` (`baa.ts`, `TEMPLATE_1_6_0_DRAFT`) is "2026-10-19", while earlier releases carried their release day (1.5.1: 2026-10-19, 1.5.0: 2026-10-14). It is not in the agreement hash and no code outside the catalogue and `baa-golden.test.ts` (which pins it) reads it for the BAA, so leaving it is harmless; the owner should set it to the release day for consistency, and then the `baa-golden` pin on line "1.6.0 ... publishedOn" moves with it.

Do not flip before sections 1 and 3 are settled; the lead's second review covers the legal clock.

## 5. Rollback

Migrations go forward only. Once the release migration has been applied there is no way back by reverting the commit: `tests/baa-release-1-6-0.test.ts` forbids the release file in `apps/app/drizzle` while the flag is false, so a revert that sets the flag to false fails that test, and the applied migration has already moved the database floor. Undoing a release means a new migration that restores 1.5.1 as the floor plus a new `LEGAL_VERSION`, and the flag handled to match. Anyone who signed 1.6.0 in between would then hold an agreement the floor calls a draft, and would need handling by hand. So decide before the flip, not after.

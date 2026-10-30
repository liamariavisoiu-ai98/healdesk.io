# DPA 1.1.0: owner checklist (RELEASED 30 October 2026)

**Released by the owner on 30 October 2026, in code.** He said "release DPA 1.1.0 as well" in chat, without external counsel. `DPA_1_1_0_RELEASED` is `true` in `packages/catalog/src/dpa.ts`, and the release migration is `apps/app/drizzle/0140_dpa_release_1_1_0.sql`. Checkout offers DPA 1.1.0; DPA 1.0.0 stays released behind it. Counsel has not reviewed it; an AI assistant drafted and reviewed it (`docs/counsel/agreement-changes.md` sections 21 and 21.6).

**New clinics only.** 1.1.0 applies to clinics that sign from the release on. A clinic that already signed DPA 1.0.0 stays on 1.0.0: there is no way in the product for it to re-sign a newer DPA (step 1 below). No payment-link text may go to a caller of a clinic whose accepted agreement is older than BAA 1.6.0 or DPA 1.1.0.

**Not live yet.** Nothing is pushed, merged or deployed. Production offers 1.1.0 only once apps/web deploys from `main`, and the database accepts it only once `deploy-app.yml` runs migration 0140 (section 3). Each needs your yes.

The steps below are kept as they were written before the release, as the record of what the release did. Steps 4.1 to 4.6 were done on 30 October 2026 on branch `lane/dpa`; step 4.7 is noted at its end.

## What 1.1.0 changes

One sentence pair in clause 9 (Safeguards), and the version line. Nothing else.

- DPA 1.0.0 says: "healdesk places no calls and sends no SMS. This exception does not extend to any other channel or content."
- DPA 1.1.0 says: "healdesk places no calls and sends no SMS, except that the assistant is engineered and designed to offer a caller a single text message that carries fixed wording and Practice's own payment link, where Practice has chosen that option. This exception, that text included, does not extend to any other channel or content."

These are BAA 1.6.0's words for the same text. The sample is in `docs/dpa-v1.1.0.txt`. Its hash is `a5f1eeff...9c6c`; 1.0.0's is still `01db94b7...40a5`.

## The rule that matters most

**No payment-link text may go to the caller of a clinic whose signed agreement is older than the version that carries the exception.** That means BAA 1.6.0 or later, or DPA 1.1.0 or later. A clinic on DPA 1.0.0 (or BAA 1.5.1 or older) has signed "sends no SMS".

Today nothing sends a text (`paymentLinkTextOffered()` is false, and no sender exists). Whoever builds the sending must check the clinic's agreement in effect before every text, not only at checkout. Releasing 1.1.0 did not move existing DPA 1.0.0 clinics onto it (see step 1).

## 1. Before you say "Release": who holds DPA 1.0.0?

1. In the marketing Sheet's sealed agreement and purchase tabs (`lib/checkout/records.ts`; read only, no edits, sorting or deleted rows), count DPA 1.0.0 rows not yet provisioned. In `/admin`, look for any clinic already provisioned under DPA 1.0.0.
2. What happens to each:
   - **Not yet provisioned:** they can still be provisioned and go live under 1.0.0. The DPA has no go-live floor: go-live accepts every released DPA version, and 1.0.0 stays released. They will simply never get the text unless they sign 1.1.0.
   - **Already provisioned:** there is **no way in the product for a clinic to re-sign a newer DPA.** The re-sign flow (`apps/app/src/lib/agreements/resign.ts`) handles a newer BAA version and the DPA-to-BAA switch only. A DPA 1.0.0 clinic stays on 1.0.0, and so cannot get the text, until someone builds a DPA re-sign or handles it by hand with you.
   - If you want DPA 1.0.0 refused at go-live (a floor, as BAA 1.6.0 did to 1.5.1), that is new code, not part of this draft: the DPA has no floor today, and the database's list of released DPA versions must match the catalogue's `approvedByCounsel` (parity test in `apps/app/tests/go-live.test.ts`).
3. Apps/app has held synthetic data only, so none of either should exist. If one does, decide before releasing.

## 2. Mid-checkout effect

- A DPA signing page opened before the release and signed after it is refused with "The agreement has been updated. Please reload and review the current version." (`signableDpaTemplate` takes only the current version). The buyer reloads and signs 1.1.0.
- A buyer who signed 1.0.0 and is already paying is not refused: 1.0.0 stays released, so provisioning and go-live accept it. That clinic is on 1.0.0 (step 1).

## 3. Deploy order

apps/web deploys from `main` on Vercel; apps/app moves only when you run `deploy-app.yml`, which runs the migration before rolling the tier and also rolls the voice service (your word that no call is running or planned is needed).

- **Web first:** checkout offers 1.1.0 while the old apps/app image does not know it. A buyer who signs and pays in that gap is refused when the records are imported (`lib/checkout/import.ts`) or, failing that, at provisioning (the release check in `lib/provisioning.ts`); ops gets `provisioning_rejected`, the buyer gets the "order delayed" email once, and the purchase can be replayed from Approvals after the new image is up.
- **App first:** the database and image accept 1.1.0 before checkout offers it; nothing breaks, checkout keeps offering 1.0.0 until Vercel catches up.
- **Recommended:** merge and run `deploy-app.yml` in the same sitting, so the gap is minutes. Landing, deploying and migrating each need your explicit yes.

## 4. The flip, exactly

1. `packages/catalog/src/dpa.ts`: `export const DPA_1_1_0_RELEASED: boolean = false;` becomes `= true;`. This alone makes 1.1.0 `DPA_TEMPLATES[0]` with `approvedByCounsel` true, moves `CURRENT_DPA_VERSION` to `dpa/1.1.0`, makes checkout's DPA copy and signing use 1.1.0, keeps 1.0.0 registered and released behind it, and turns on 1.1.0's entries in apps/app's rule maps (destruction, incident reporting, subcontractor notice), already written behind the flag.
2. Add the migration, from `apps/app`: `npx drizzle-kit generate --custom --name dpa_release_1_1_0`, paste `docs/design/launch-readiness-2026-10-27/dpa-release-1-1-0.sql` over the empty file it creates, and replace each `<DAY>` with the day of your word. It adds `dpa/1.1.0` to `app_dpa_version_released()` (go-live's list) and to `app_destruction_rule()` (the export rule its Term clause states). It cannot be added earlier: a migration runs unconditionally, and `apps/app/tests/dpa-release-1-1-0.test.ts` fails if it is in `drizzle/` while the flag is false, or missing while it is true.
3. Set 1.1.0's `publishedOn` (`DPA_TEMPLATE_1_1_0_DRAFT` in `dpa.ts`, "2026-10-30") to the release day if it differs. It is not in the agreement's hash.
4. Rewrite the header of `docs/dpa-v1.1.0.txt` (`header110` in `packages/catalog/src/dpa-review.ts`) to say it is released, then run `npm run dpa:review -w @healdesk/catalog`. The agreement text in it does not move. `docs/dpa-v1.0.0.txt` does not move.
5. Tests whose expectation moves with the flip. Read from the code, not run: this session was not permitted to flip the switch, even locally. Run the catalog, apps/web and the whole apps/app suite (with a database) on the flip commit; others may move that this list misses.
   - `packages/catalog/src/dpa-1-1-0.test.ts`: "the switch, off" (2 tests: the switch is off, nothing offers 1.1.0) become their "on" equivalents; the draft's golden hashes do not move.
   - `packages/catalog/src/dpa.test.ts`: "is registered once, namespaced and released" (expects `DPA_TEMPLATES` to be dpa/1.0.0 alone and current). The eight 1.0.0 golden hashes do not move: they render dpa/1.0.0 by name.
   - `apps/app/tests/dpa-release-1-1-0.test.ts`: "the switch is off" becomes "the switch is on".
   - `apps/app/tests/destruction-clock.test.ts` and `apps/app/tests/retention.test.ts`: the pinned lists of versions that promise the export rule and the purge gain `dpa/1.1.0`.
   - `apps/app/tests/dpa-signing.test.ts`: `signableDpaTemplate("dpa/1.0.0", RELEASED)` is expected to be the current template; after the flip 1.0.0 asks the signer to reload.
   - Database suites that sign the current DPA and run go-live (`dpa-signing`, `agreement-kinds`, `agreement-resign`, `agreement-misclassification`, `go-live`, `database-audit`) sign 1.1.0 instead; they pass only with the migration in `drizzle/`.
6. Also in the same commit: move the paragraph above `DPA_TEMPLATES` and the doc comment on `DPA_1_1_0_RELEASED` to the past tense, add the release to `docs/counsel/agreement-changes.md` section 21, and update `AGENTS.md`.
7. Outside this lane, check with the lanes that own them: the Terms and Privacy pages (`apps/web/src/app/terms`, `privacy`, `lib/legal.ts`) if they name a DPA version or quote "sends no SMS"; the comment in `apps/web/src/components/checkout/AgreementStep.tsx` that names the BAA version offered; and `LAUNCH_PROMISES` in `apps/web/src/lib/admin/seo/launch.ts`, whose payment-link text item says a new DPA version is needed before the first text.

### Done on 30 October 2026

- 4.1 the flag is `true`; 4.2 migration `0140_dpa_release_1_1_0` was generated with drizzle-kit `--custom` and filled with the staged SQL (`<DAY>` = 30 October 2026; its DO-block asserts kept). The staged copy stays in this folder, as BAA 1.6.0's did, because `apps/app/tests/dpa-release-1-1-0.test.ts` still reads it; 4.3 `publishedOn` was already 2026-10-30; 4.4 `docs/dpa-v1.1.0.txt`'s header says released (its agreement text and `docs/dpa-v1.0.0.txt` did not move); 4.5 the tests moved as listed, plus `apps/web/src/app/api/agreement/route.test.ts`, which signs the current DPA; 4.6 comments, `agreement-changes.md` section 21.6, and the spec. `AGENTS.md` is the lead's.
- 4.7: the Terms and Privacy pages name no DPA version and do not quote the DPA's "sends no SMS", so `LEGAL_VERSION` did not move. The `AgreementStep.tsx` comment and the `payment-link-text` item in `LAUNCH_PROMISES` now say 1.1.0 is released for new clinics only.

## 5. Rollback

Migrations only go forward. Once the release migration has run, reverting the commit fails `tests/dpa-release-1-1-0.test.ts`, and the database already lists 1.1.0 as released. Undoing it means a new migration that removes 1.1.0 from both lists, with the flag handled to match, and anyone who signed 1.1.0 in between would hold an agreement the database calls unreleased. Decide before the flip.

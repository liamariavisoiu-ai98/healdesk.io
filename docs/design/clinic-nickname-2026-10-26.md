# A clinic's short name, said after the greeting (design note, not built)

Status: proposal for the owner's decision, 26 October 2026 (VOICE-T17, Phase 6i).
The portal field and the schema change are not built: they are a product
change, which needs this note, a spec edit and the owner's sign-off. Demo
calls already use a heuristic short name (`lib/voice/demo-facts.ts`,
`shortClinicName`), described under "Already shipped".

## The problem

A clinic's full name, said every time, sounds like a menu: "Thanks for calling
Lumen Aesthetics & Wellness ... at Lumen Aesthetics & Wellness we ...". People
say the full name once, at the greeting, and a short form after it ("Lumen").
Only the clinic knows the short form its patients actually use. "Glow" or
"Glow Spa"? "Dr. Chen's" or "Lumen"? So a clinic's own calls need a setting,
not a guess.

## Proposal

1. **The setting.** Settings › Basics gains one field, "What patients call
   you".
   - Placeholder: "e.g. Lumen (for Lumen Aesthetics & Wellness)".
   - Pre-filled in the wizard's first step from `shortClinicName` of the
     confirmed name, so most clinics only check it.
   - Optional, up to 40 characters, plain words only (the catalog's
     `isSafeTypedText`, as other typed names are checked).
   - No step-up: it is not where calls or money go.
2. **The schema.** `clinic_settings.short_name text null`, with a check of
   1 to 40 characters, in one migration. It is clinic configuration, not PHI.
   It is written through the existing `updateClinicSettings` path and read in
   `assistantFacts` as `AssistantFacts.shortName`, null when unset.
3. **What the assistant does with it.**
   - The opening line keeps the full name, as it must: the disclosure names
     the practice (`lib/compliance/disclosure.ts`).
   - The prompt tells the model to use the short name after that, as the demo
     note already does.
   - Unset, the model falls back to `shortClinicName`, so nothing changes for
     a clinic that never fills it in.
   - Same on every channel: one brain, four adapters. Web chat and Meta
     replies use the short name after the first message too.
4. **Where else the full name stays.**
   - Emails to the clinic.
   - The transcript email's footer.
   - The agreement and Stripe.
   - Anything legal or billing.

   The short name is for the conversation only.

## What has to change with it

- **The spec.** "Every switch in the portal" gains the field. This needs the
  owner's edit to `docs/v1-product-spec.md`, which is the source of truth.
- **The guard.** `withoutOwnWords` already reads the clinic's name as its own
  words for the clinical screen. It should also read the short name, so a
  short name that looks like a clinical word ("Botox Bar") is never read as
  advice. One line, with a test.
- **The ops projection.** `/api/ops`'s clinic configuration shows it, so the
  operator console can see what Aya calls each clinic.
- **Tests.** The migration, the settings write with its check, the facts
  read, the prompt instruction, the fallback when unset, and the guard's own
  words.

## Already shipped (demo calls only)

A demo has no portal and no clinic account, only the scraped public name. So
`shortClinicName` derives the short form:

1. Drop a place after "of", "at", "in" or "by", or after a dash, bar or comma.
2. Drop a leading "The".
3. Drop generic trailing words ("Aesthetics", "Wellness", "Spa", "Med Spa",
   "Clinic", "& ...").
4. Keep the full name when nothing distinctive is left.

The demo's opening line says the full name once; every stage note after it
uses the short one. Tests are in `tests/voice-demo.test.ts` ("6i").

## Decisions for the owner

1. Build the portal field? Recommended: yes, small, and it makes every clinic
   call sound less scripted.
2. The label: "What patients call you", or "Short name"? Recommended: the
   first, because it says what the field is for.
3. Apply it on chat and Meta as well as calls? Recommended: yes, same brain.

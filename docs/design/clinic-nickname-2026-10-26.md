# A clinic's short name, said after the greeting (design note, built)

Status: built 26 October 2026 (PORTAL-SHORTNAME), on the owner's word
("build it. Update v1-product-spec.md"), with the recommended answers to the
three decisions below: build it, the label "What patients call you", and every
channel. The spec's "Every switch in the portal" carries the field.

## As built

- `clinic_settings.short_name` (migration 0128), null or 1 to 40 characters.
- Settings › How AYA talks, "What patients call you" (`short_name`): empty
  shows the worked-out name as its placeholder, and "Use the name AYA works
  out" clears it. The wizard's Basics screen pre-fills it from the name and
  keeps it only when the clinic changed it, so a corrected name carries the
  worked-out one with it.
- Saved through `saveSetupSettings`. It must be plain words with a letter
  (`isSafeTypedText`), name no clinical term or everyday condition
  (`findClinicalContent` with conditions), and hold nothing on the clinic's
  never-say list unless it is a part of the full name.
- `AssistantFacts.shortName`; the prompt's `callName` falls back to
  `shortClinicName`.
- **The guards read a short name as the clinic's own words only when it is a
  part of the full name** (`ownShortName`). A short name typed into Settings
  can never excuse a word the full name did not already, and any other short
  name is screened like every word of a reply. On Meta the prompt uses it only
  under that rule and when it names no treatment (`metaCallName`), because
  that channel's guard refuses treatment names and staff names.
- `/api/ops` `getOnboarding` returns `callName` and `shortNameSet`, shown on
  the console's setup panel.
- Tests: `tests/clinic-short-name.test.ts` and `tests/settings-screen.test.ts`
  ("What patients call you ...").

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

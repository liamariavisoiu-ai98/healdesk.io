# File upload into Your practice: scope (PORTAL-UPLOAD-0)

Owner's ask (1 November 2026): "upload resources (pricing/products, additional
information like parking, about the venue etc)". This is the scope for the
owner's word before anything is built. Nothing here is built.

## What the clinic does

1. On **Your practice**, a card **Add from a file**: choose a price list, a menu,
   or an info sheet (PDF or a photo). One permanent line under it: *Leave out
   anything about a patient.*
2. A few seconds later the card lists what AYA found that the page does not
   already say, in plain rows:
   - *Hydrafacial · $199 · 45 min* (new)
   - *Botox, 1 area · $299* (your page says $279)
   - *Hours: Saturday 10 am to 2 pm* (new)
   - *Parking: free behind the building* (a quick answer)
3. Each row has **Add** and **Skip**, and there is **Add all**. Nothing changes
   until the clinic taps Add. Added items go into Prices, Hours, Policies or
   Quick answers exactly as if typed there, with the same checks.

## How it works (recommended)

- **Reuse what exists.** The website read already turns pages into a
  `ClinicProfile` (services and prices, hours, policies, questions and answers)
  with one model call (`apps/web/src/lib/site-read/extract.ts`), screens it for
  anything clinical (`screenClinicProfile`, `@healdesk/catalog`), and the drift
  list already compares a profile with what the clinic's page says
  (`lib/website/diff.ts`) and words each difference (`describeChange`). An
  upload is the same pipeline with a file instead of web pages.
- **It runs in `apps/app`, never `apps/web`.** A clinic may upload the wrong
  file, one with a patient on it. So the file goes only to `apps/app` and to
  Anthropic on healdesk's product key, which is under the signed BAA, with a
  model from `PATIENT_MODEL_IDS` (as the support chat does). The extraction
  schema and prompt move from `apps/web` into `@healdesk/catalog` so both apps
  share one definition.
- **It keeps nothing.** The file is read in memory, sent once, and dropped: no
  bucket, no database row, no log line with its words. What the model found is
  screened, compared with the clinic's page, and returned to the browser; it is
  written only when the clinic taps Add, through the existing knowledge writers
  (`lib/portal/knowledge.ts`), which screen it again. The audit log records that
  a file was read and how many items were added, never what they were.
- **What it may fill:** treatments with price and length, weekly hours,
  policies, and quick answers (parking, the venue, what to bring). **Not**:
  the address, the phone number or the website (those change where calls and
  patients go, so they stay typed, behind the passkey where the portal asks for
  it), the never-say list, or providers.

## First slice (proposed)

- PDF, JPG and PNG. A photo is shrunk in the browser before it is sent.
- Up to 4 MB per file: the TLS proxy in front of the app accepts 4 MB
  (`infra/aws/images/tls-proxy/nginx.conf.template`, `client_max_body_size
  4m`), so no infrastructure change is needed. Up to 20 pages.
- 10 files per clinic per day, so a stuck button cannot run up model cost.
- A route handler in `apps/app` (a server action's 1 MB default is too small),
  the Add/Skip card, the shared extraction, tests (extraction parsing, the
  screen, the comparison, the limits, nothing stored), the spec line, and
  `/admin/map`'s Anthropic bridge words.
- No migration, no Terraform, no new vendor, no new secret.

## What waits

- Word and Excel files (ask the clinic to save as PDF for now).
- Several files at once.
- Reading a file again later to spot changes, as the website read does.

## Decisions for the owner

1. **Keep nothing** (recommended), or keep the file for a while so support can
   look at it. Keeping it means a bucket, a retention clock and a line in the
   agreements; keeping nothing needs none of that.
2. **What it may fill**: treatments, hours, policies and quick answers as above
   (recommended), or also the contact details.
3. **The Privacy page.** It names no vendor; it lists, for each kind of data,
   what goes to "our AI model provider" (`apps/web/src/app/privacy/page.tsx`,
   `lib/subprocessors.ts`). Whether "a file you upload to Your practice is read
   by our AI model provider and not kept" needs its own sentence is the
   owner's call; a change there moves `LEGAL_VERSION` and re-pins the page's
   hash.
4. **Limits**: 4 MB, 20 pages, 10 files a day (recommended), or other numbers.

## Risks

- **A wrong file with a patient on it.** Covered by the BAA and by keeping
  nothing; the permanent line asks staff not to. Nothing found that looks
  clinical is shown (`screenClinicProfile`).
- **A misread price.** Nothing is added without the clinic tapping Add, and a
  changed price shows both figures.
- **If the WAF is ever switched on** (`enable_waf`): today it holds only a rate
  limit, so uploads pass. A managed rule set added later would need this
  route exempted from its body-size rule.

## Effort

One working session for the first slice, then the usual verify, CI, merge and
deploy. It ships behind nothing: the card appears when it works, per "Copy
first, then the switch", so no launch promise is opened.

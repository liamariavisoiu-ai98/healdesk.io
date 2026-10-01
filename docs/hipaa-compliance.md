# HIPAA & the PHI Boundary

**Read this before writing any code that touches patient data.**

This is an engineering-constraints document, not legal advice. Get a healthcare attorney
and a real compliance review before onboarding a clinic with live patients.

What the product handles, and the vendor position, come from
[v1-product-spec.md](./v1-product-spec.md) ("What data actually moves", "Vendor position,
vendor by vendor", "Where the chain is complete, and where it is not"). Where this
document and the spec disagree about the product, the spec wins; this document stays
authoritative for what PHI is.

---

## The boundary

```
┌─────────────────────────────────┐     ┌──────────────────────────────────────────┐
│  apps/web — NO PHI              │     │  apps/app — PHI                          │
│                                 │     │                                          │
│  Marketing pages, pricing       │     │  Every patient conversation: voice       │
│  Chat + voice demos (owners)    │     │    (Retell), web chat, Meta              │
│  Checkout, BAA signing UI       │     │  Transcripts + the transcript access log │
│  Contact form, reviews          │     │  Bookings, holds, the manual queue       │
│  Lead register (Google Sheet)   │     │  Deposit links via the clinic's gateway  │
│  The /admin operator console    │     │  Clinic portal, wizard, support chat     │
│                                 │     │  BAA register, clinic credentials        │
│  → Any host. Vercel is fine.    │     │  → BAA-covered infra ONLY.               │
└─────────────────────────────────┘     └──────────────────────────────────────────┘
```

A **business** email from a clinic owner asking for a demo is not PHI. A **patient's**
name attached to a treatment inquiry is. The line is the individual, not the industry.

> **Where new code goes** — the placement table derived from this boundary lives in
> the repo's root [`CLAUDE.md`](../CLAUDE.md) and is loaded into every agent session.
> This document stays authoritative for *what PHI is*; that one is authoritative for
> *which app a new surface belongs in*. Keep them consistent: if the definition here
> changes, the table there changes with it.
>
> The shortest form of the rule: **`apps/web` has no database client, and must never
> acquire one.** Verified 2026-09-12 — no Drizzle, no `pg`, no connection string.

### What counts as PHI here

Any of the 18 HIPAA identifiers **combined with** health information. In this product,
concretely:

- A caller's or messager's name or phone number plus the treatment they asked about and
  their preferred time — the callback-slip fields. Do not assume a callback slip is
  exempt because it feels administrative.
- Call transcripts (no audio recording is kept, by decision of 21 September 2026; a
  transcript tied to a number is still PHI) and web chat transcripts
- A booking tied to a named person, in our database and as an event in the clinic's own
  Google Calendar
- Whatever a patient types into a Meta channel. Those channels are scoped to carry
  nothing clinical, but patients will not cooperate: clinical content is detected at the
  channel boundary and never stored (see "Meta" below)
- Anything a clinic's staff paste into the portal support chat, which is why it carries a
  permanent warning and is kept non-clinical
- In phase two, anything read back out of the clinic's EMR/POS during attribution
  reconciliation

That last one is easy to miss. **The attribution engine is inside the boundary**, because
reconciling "who showed and what they spent" means handling named patients and their
procedures. It is phase two and fenced out of v1, but the code that exists stays in
`apps/app`.

What v1 does **not** collect: intake forms, dates of birth, insurance details, medical
history, medication, contraindication screening answers. The agent collects the minimum
a receptionist would write down and routes anything clinical to a person.

---

## Who needs a BAA

A BAA is required with **every** vendor that stores, processes, or transmits PHI. One
uncovered hop breaks the chain. The spec's chain, which must be complete before any
patient data flows: the clinic's BAA with us (accepted inline at checkout), Retell,
Anthropic, the database provider and AWS. Meta and Stripe never sign one and are handled
by scoping.

| Layer | Vendor | BAA status |
| --- | --- | --- |
| Hosting (marketing) | Vercel | Not needed — no PHI |
| Hosting (product) | Vercel | **Enterprise plan only** ⚠️ — not the plan |
| Hosting (product) | AWS (`us-east-1`, account `865780386982`) | **Accepted 22 September 2026** (account agreement in AWS Artifact). Covers only that account and HIPAA-eligible services; record in [policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md) |
| Database (product) | AWS RDS for PostgreSQL, or Neon on its Scale plan | **Not chosen.** RDS is covered by the AWS agreement already held; Neon signs its own (self-serve) and its Data API sits outside it. Sign, then apply the settings the agreement requires |
| Voice telephony and speech | Retell | **Pending — self-serve.** Sign the BAA and DPA in Retell's click-agreements portal and confirm the executed text names the services in use; then set per-agent retention to the minimum, PII controls on and recording off. PHI subprocessor: caller audio in transit, transcript, number |
| LLM, every channel | Anthropic (Claude API) | **Pending.** The primary owner signs and arranges activation. Patient traffic runs in its own HIPAA-ready organisation, never the marketing org. Covered models require **30-day retention** and cannot run with zero data retention; the clinic agreement must disclose it. Batch, Files, web fetch, compaction and context editing are excluded from coverage (blockers-runbook §3) |
| Calendar | Google Calendar (the clinic's own) | Between the **clinic and Google**, on a paid Workspace plan; confirm per clinic at onboarding. The clinic's OAuth token, granted to Healdesk's Google Cloud app, is stored in `apps/app` (not built yet) |
| Payments (our subscription) | Stripe | **Never, on any tier.** Not needed: the buyer's name, work email and invoice are business contact data |
| Payments (patient deposits) | Stripe Connect or the clinic's own gateway | **Never.** Used only inside the payment-processing carve-out: an amount, a generic descriptor and an opaque reference. No treatment name, diagnosis or clinical metadata in the description, the statement descriptor or metadata |
| Messaging | Meta (Instagram, Messenger, WhatsApp) | **Never, by Meta's own terms.** Scoped to carry no clinical content: detected at the boundary, not persisted, not echoed, not summarised |
| Lead register (marketing) | Google Sheets | Not needed — business contact data only, no PHI |
| Analytics (marketing) | PostHog (US cloud) | Not needed — consent-gated, content-free, marketing site only |
| Transactional email | Resend | **Signs none** — see below |
| Patient-bearing email, if any | AWS SES | Covered by the AWS agreement; configuration set `healdesk-phi` with `TlsPolicy=REQUIRE` |
| Voice agent (marketing demo) | Synthflow | Not signed; `apps/web` only, talks to clinic owners, no PHI path. Replaced by a Retell demo agent when one exists |
| Voice agent (product) | ~~Synthflow~~ | **Replaced by Retell.** The `apps/app` Synthflow routes are pre-Retell and must not carry a real patient call |
| Calendar write | ~~Cal.com~~ | **Not a v1 write target.** Google Calendar is the only one; Cal.com writes are phase two |
| Telephony | ~~Twilio~~ | **Not used.** Retell supplies the numbers; no SMS in v1 |
| Auth | ~~Clerk~~ | **Not used.** The operator console is a scrypt hash + TOTP; the clinic portal will use Better Auth, a library inside `apps/app`, not a vendor |
| Error tracking | ~~Sentry~~ | **Not used.** No error tracker is installed |

Struck-through rows stay because a BAA table is a checklist of who is in the path, and
"we evaluated this and did not adopt it" is worth recording once.

**Resend is the row that needs care.** It signs no BAA and has no equivalent of
SES's TLS-REQUIRE, so there is no way to make a PHI-bearing message fail closed
on it. `apps/app` therefore restricts it to messages declared `phiClass: "none"`
and refuses anything else outright rather than downgrading; SES stays the only
transport allowed to carry patient information. Note that `apps/web`'s contact
and review forms post to Resend **directly**, outside that transport discipline
— acceptable because both carry business-contact content only, but the
invariant "every message declares whether it may carry PHI" is enforced in
`apps/app` alone.

**The escalation emails are a decision still to make.** The spec sends urgent alerts and
handover requests to the clinic's named contact, and a daily summary email. An alert that
names a caller or a treatment carries PHI. Two designs satisfy the rules above: alerts
that carry no patient detail and link into the 2FA-gated portal, or minimum PHI sent only
through SES `healdesk-phi`, never Resend. Record the choice here and in
[hipaa-risk-analysis.md](./hipaa-risk-analysis.md) (T13) before building them. The spec's
"Text or email address" option for those alerts conflicts with "no SMS anywhere in v1";
until that is resolved, they are email only.

**Verify current terms directly with each vendor.** Plan requirements change, and this
table will drift. The public register is `apps/web/src/lib/subprocessors.ts`
(`/subprocessors`); keep it matching this table.

---

## The Vercel caveat

Vercel signs BAAs **only on Enterprise**. Two Vercel projects give you the correct
*architecture* split — separate env vars, domains, and build settings — but **not
compliance coverage** for the PHI side on Hobby or Pro.

**The agreed approach:**

1. Build the split now — two projects, one repo.
2. Keep `apps/app` free of Vercel-specific APIs so it runs on the AWS HIPAA account,
   where the agreement is already accepted, without a rewrite.
3. **Do not let real PHI touch `apps/app` until the whole chain is in place.** Synthetic
   and seed data only.

### Rules that keep apps/app portable

Enforced by convention; check these in review.

- ❌ No `@vercel/*` runtime packages (`@vercel/kv`, `@vercel/blob`, `@vercel/postgres`)
- ❌ No `export const runtime = 'edge'` on anything touching PHI
- ❌ No Vercel-only headers, geolocation helpers, or cron config as load-bearing logic
- ✅ Plain Node runtime, standard `pg`/Drizzle over `DATABASE_URL`
- ✅ Object storage behind an S3-compatible interface
- ✅ Config via environment variables only — nothing platform-injected

If it wouldn't run under `node server.js` in a container, it doesn't belong in
`apps/app`. The Retell voice endpoint needs its own long-lived Node process from the same
image, because it holds a WebSocket open for the whole call.

---

## Engineering rules

### Clinical scope

The agent **cannot prescribe, diagnose, set treatment plans or guarantee outcomes.** This
is a hard product boundary, enforced in code around the model, not a prompt preference:

- Complication and urgent-symptom messages are matched **before the model sees them** and
  short-circuit to a fixed response and immediate escalation to the clinic's named
  contact.
- A clinical question, or a price outside the clinic's configured list, becomes an offer
  to book a consultation.
- The clinic's never-say list is injected into every conversation on every channel, and
  the clinic cannot edit the prompt.
- Treatment names never appear in a payment description, a Meta message or the support
  chat.

### Meta

Meta will never sign a BAA, so Instagram, Messenger and WhatsApp carry nothing clinical.
Clinical content is detected at the channel boundary, before anything is stored; it is
not persisted, echoed back or carried into a summary, and the assistant moves the person
to a call or the clinic's own secure route, saying why in one sentence. The 24-hour
window is enforced in the adapter: a send outside it is dropped whatever the model asked
for.

### Data handling

- **Encrypt in transit and at rest.** TLS 1.2+; database-level encryption enabled.
- **Minimum necessary.** Don't collect a DOB because the form looked incomplete.
- **Audit logging.** Every PHI access — who, what, when — including every transcript
  opened in the portal, which also requires a second factor.
- **Retention policy.** Per clinic, for transcripts especially. Vendor-side recording and
  transcript retention off or at the minimum wherever they can be set. Demo sandbox
  transcripts purge on a 7 to 14 day cycle whether or not the lead buys.
- **Never log PHI.** Not to stdout, not to an error tracker, not to analytics. Scrub
  before it leaves the process.
- **No PHI in LLM prompts** except through the BAA-covered Anthropic organisation, with its
  30-day retention disclosed.
- **Offboarding** is export first, then destroy, on the clock the agreement states. The
  obligations persist through non-payment, suspension and cancellation until PHI is
  returned or destroyed.

### The prospecting pipeline is outside the boundary

`packages/leadgen` handles clinic firmographics — business data, not PHI. Keep it that
way: never co-mingle scraped prospect data with patient records, and don't import
patient-authored review text into any system that stores patient data.

---

## Before onboarding the first live clinic

- [ ] Healthcare attorney review of the product and data flows, including the spec's open
      legal items (state-by-state AI-disclosure and transcription consent, the UAE
      business-associate question, the 30-day Anthropic retention disclosure)
- [ ] BAA signed with Retell, Anthropic and the database provider; AWS already accepted
- [ ] `apps/app` running on the AWS HIPAA account (CLAUDE.md lists what blocks the deploy)
- [ ] Audit logging, including the transcript access log, implemented and verified
- [ ] Retention and deletion policy documented per clinic
- [ ] Log PHI scrubbing verified end to end
- [ ] Incident response and breach notification procedure written, with the vendor-notice
      rule ([incident-response.md](./incident-response.md))
- [ ] Staff access controls and least-privilege review, including portal roles
      ([policies/access-control.md](./policies/access-control.md))
- [ ] A named privacy and security contact ([policies/security-official.md](./policies/security-official.md))
- [ ] Penetration test / security review

# HIPAA & the PHI Boundary

**Read this before writing any code that touches patient data.**

This is an engineering-constraints document, not legal advice. Get a healthcare attorney
and a real compliance review before onboarding a clinic with live patients.

---

## The boundary

```
┌─────────────────────────────────┐     ┌──────────────────────────────────────┐
│  apps/web — NO PHI              │     │  apps/app — PHI                      │
│                                 │     │                                      │
│  Marketing pages                │     │  Patient intake & consent            │
│  Pricing / ROI calculator       │     │  Clinical notes                      │
│  Chat demo (generic pricing Q&A)│     │  Call transcripts & recordings       │
│  Email capture (business lead)  │     │  Appointment + payment reconciliation│
│                                 │     │                                      │
│  → Any host. Vercel is fine.    │     │  → BAA-covered infra ONLY.           │
└─────────────────────────────────┘     └──────────────────────────────────────┘
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

- Caller phone number + the treatment they asked about
- Name, DOB, or email on an intake form
- Call recordings and transcripts (a voice recording is an identifier on its own)
- Contraindication screening answers — Fitzpatrick, Accutane, pregnancy status
- Appointment records tied to a named person
- Anything read back out of the clinic's EMR/POS during attribution reconciliation

That last one is easy to miss. **The attribution engine is inside the boundary**, because
reconciling "who showed and what they spent" means handling named patients and their
procedures.

---

## Who needs a BAA

A BAA is required with **every** vendor that stores, processes, or transmits PHI. One
uncovered hop breaks the chain.

| Layer | Vendor | BAA status |
| --- | --- | --- |
| Hosting (marketing) | Vercel | Not needed — no PHI |
| Hosting (product) | Vercel | **Enterprise plan only** ⚠️ |
| Hosting (product, alt) | AWS / GCP / Azure | Standard, self-serve |
| Hosting (product, alt) | Fly.io / Render | Available on paid tiers — confirm current terms |
| Database | Supabase | Team plan and above |
| Database | Neon | Business plan and above |
| Telephony | Twilio | Available |
| Speech-to-text | Deepgram | Available |
| LLM | Anthropic | Commercial terms — confirm before PHI |
| Payments | Stripe | Available |
| Transactional email | Resend | **Signs none** — see below |
| Voice agent (demo) | Synthflow | Not signed; `apps/web` only, no PHI path |
| Auth | ~~Clerk~~ | **Not used.** Auth is a scrypt hash + TOTP, no vendor |
| Error tracking | ~~Sentry~~ | **Not used.** No error tracker is installed |

The last two rows are kept struck through rather than deleted because a BAA
table is a checklist of who is in the path, and "we evaluated this and did not
adopt it" is worth recording once. Neither string appears anywhere in `apps/`,
`packages/`, or any `package.json` in the repo.

**Resend is the row that needs care.** It signs no BAA and has no equivalent of
SES's TLS-REQUIRE, so there is no way to make a PHI-bearing message fail closed
on it. `apps/app` therefore restricts it to messages declared `phiClass: "none"`
and refuses anything else outright rather than downgrading; SES stays the only
transport allowed to carry patient information. Note that `apps/web`'s contact
and review forms post to Resend **directly**, outside that transport discipline
— acceptable today because both carry business-contact content only, but the
invariant "every message declares whether it may carry PHI" is currently
enforced in `apps/app` alone.

**Verify current terms directly with each vendor.** Plan requirements change, and this
table will drift.

---

## The Vercel caveat

Vercel signs BAAs **only on Enterprise**. Two Vercel projects give you the correct
*architecture* split — separate env vars, domains, and build settings — but **not
compliance coverage** for the PHI side on Hobby or Pro.

**The agreed approach:**

1. Build the split now — two projects, one repo.
2. Keep `apps/app` free of Vercel-specific APIs so it can move to BAA-covered infra
   (AWS / Fly / Render + Supabase or Neon with a BAA) without a rewrite.
3. **Do not let real PHI touch `apps/app` until coverage is in place.** Synthetic and
   seed data only.

This gets the architecture right immediately while deferring the infrastructure cost until
there's a paying clinic to justify it.

### Rules that keep apps/app portable

Enforced by convention; check these in review.

- ❌ No `@vercel/*` runtime packages (`@vercel/kv`, `@vercel/blob`, `@vercel/postgres`)
- ❌ No `export const runtime = 'edge'` on anything touching PHI
- ❌ No Vercel-only headers, geolocation helpers, or cron config as load-bearing logic
- ✅ Plain Node runtime, standard `pg`/Drizzle over `DATABASE_URL`
- ✅ Object storage behind an S3-compatible interface
- ✅ Config via environment variables only — nothing platform-injected

If it wouldn't run under `next start` in a container, it doesn't belong in `apps/app`.

---

## Engineering rules

### Clinical scope

The agent **cannot prescribe, diagnose, or set treatment plans.** This is a hard product
boundary, not a prompt preference. Contraindication screening collects and routes; it does
not decide. Anything touching complications escalates to a human provider.

Encode this in the system prompt *and* enforce it in code paths that could otherwise write
clinical decisions into an EMR.

### Data handling

- **Encrypt in transit and at rest.** TLS 1.2+; database-level encryption enabled.
- **Minimum necessary.** Don't collect a DOB because the form looked incomplete.
- **Audit logging.** Every PHI access — who, what, when. Required for audit-ready intake
  and consent documentation.
- **Retention policy.** Define it per clinic; recordings and transcripts especially.
- **Never log PHI.** Not to stdout, not to Sentry, not to analytics. Scrub before it
  leaves the process.
- **No PHI in LLM prompts** unless the provider BAA covers it and retention is configured
  appropriately.

### The prospecting pipeline is outside the boundary

`packages/leadgen` handles clinic firmographics — business data, not PHI. Keep it that
way: never co-mingle scraped prospect data with patient records, and don't import
patient-authored review text into any system that stores patient data.

---

## Before onboarding the first live clinic

- [ ] Healthcare attorney review of the product and data flows
- [ ] BAA signed with every vendor in the PHI path
- [ ] `apps/app` moved to BAA-covered hosting (or Vercel Enterprise)
- [ ] Audit logging implemented and verified
- [ ] Retention and deletion policy documented per clinic
- [ ] Log/error-tracking PHI scrubbing verified end to end
- [ ] Incident response and breach notification procedure written
- [ ] Staff access controls and least-privilege review
- [ ] Penetration test / security review

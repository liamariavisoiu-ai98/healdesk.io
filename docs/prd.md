# Product Requirements

> Split from the original working doc (Part 1). See [archive/](./archive/).

The baseline (capture → book → reactivate) is table stakes already covered — unevenly —
by incumbents. The wedge is the closed-loop revenue attribution that a standalone
receptionist structurally cannot do. **Build the floor to compete; build the gap to
differentiate.**

---

## Baseline service (table stakes — must match incumbents)

- [ ] **Full service:** 24/7 omnichannel capture across voice, SMS, Instagram DM,
      WhatsApp, and web chat; treatment qualification and pricing Q&A; writing real
      bookings into the calendar/EMR; deposit collection through integrated payment
      processors; contraindication screening with escalation to a clinician; intake and
      consent capture (medical-grade intake, signed PDF consent artifacts,
      Fitzpatrick / Accutane / pregnancy screening); appointment reminders and no-show
      sequences; outbound — automatic callback of missed numbers, warm-lead follow-ups,
      and reactivation sequences for no-shows and lapsed clients.

  *capture → qualify → book → intake → deposit → remind → basic reactivation is already
  covered, if unevenly, across incumbents. This is the floor, not the differentiator.*

---

## Conversion & revenue

- [ ] Integrated payment structure (Stripe or alternatives) for immediate
      booking-payment / upsell at the point of booking.
- [ ] Convert the "how much is Botox" price-shopper into a booked consult — pitch the
      membership, sequence complementary treatments (contraindication-aware).

  *Doing this well means encoding each clinic's treatment economics and best-converting
  paths.*

- [ ] Missed-call text-back, speed-to-lead on form fills, no-show prevention via
      deposits and reminders, and the underexploited lever: reactivating lapsed
      high-LTV clients from the clinic's dormant list, plus membership conversion.

  *Medspas are sitting on lists of people who got filler eight months ago and never
  rebooked.*

---

## Clinical & compliance

- [ ] Chat listener operating during the consultation, generating a structured,
      HIPAA-compliant clinical note, integrated to the clinic's CRM/EMR via API.
- [ ] Post-care triage & anxiety management using the clinic's approved protocols
      (standard recovery-timeline questions); escalate anything related to
      complications to a human provider.
- [ ] HIPAA / BAA handling, contraindication screening, correct clinical handoff (the
      agent cannot prescribe, diagnose, or set treatment plans), audit-ready
      documentation of intake and consent.

> Implementation constraints for everything in this section live in
> [hipaa-compliance.md](./hipaa-compliance.md).

---

## Verticalization

- [ ] Niche-of-the-niche bot per vertical: injectables-heavy clinics, laser /
      body-contouring, and hormone / TRT / GLP-1 clinics each have different call
      patterns, upsell paths, and compliance requirements.

> The six specialties the marketing site ships with are the shortlist from
> [icp-niches.md](./icp-niches.md).

---

## The gap to own (differentiator)

- [ ] **Closed-loop revenue attribution.**

Current providers see the call and the booking-created event — but not whether the
patient showed, what was performed, or what was collected, because they write *into*
the booking system and don't read the money event back *out* of the POS. That means a
standalone receptionist structurally cannot tell a clinic "this specific recovered call
became $1,400 of booked-and-collected treatment."

The solution must reconcile **clicks → booked appointments → showed → spent** in a
single attribution view, and feed that back to the ad platforms — the capability Zenoti
has today — **without enterprise pricing or lock-in.**

### Why this is the moat

Everything above this section is a feature an incumbent can ship. This one is an
integration posture: it requires reading from the POS/EMR, not just writing to the
calendar. That's a harder sale, a harder build, and the reason a clinic keeps paying —
it's the only view that answers "what did the front desk actually earn me."

It is also, concretely, a **join across four systems** — ad platform, booking system,
check-in, and POS — which is why the data model in
[`apps/app/src/db/schema.ts`](../apps/app/src/db/schema.ts) is relational and lives on
Postgres.

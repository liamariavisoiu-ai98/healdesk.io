# ICP & Niche Ranking

> Split from the original working doc (Part 3, merged with the medspa-only ranking from
> Part 2). See [archive/](./archive/).

The ROI of an AI front desk is roughly:

```
revenue at risk per missed call
  × call volume / leakage
  × cash-pay margin
  × how fast the "yes" comes
```

Ranked on that formula, with fertility and aesthetic surgery included.

> ⚠️ Figures below are approximate industry ranges, not precise quotes — **firm them up
> before they go on a sales deck or a pricing page.** The marketing site quotes several
> of these in its demo copy.

---

## Tier 1 — the ROI sentence writes itself

### 1. Fertility / IVF & reproductive medicine

The highest ticket in the entire list. One IVF cycle runs roughly **$15k–$25k** out of
pocket, patients often do 2–3 cycles, and add-ons (ICSI, PGT, egg freezing) push
lifetime value toward **$40k–$60k+**.

Inbound is intensely high-intent and emotional — these patients research obsessively and
call. A long consideration window means the same questions arrive again and again, on
the phone, the website and Instagram, and v1 answers them identically on every channel.
(Nurture and reactivation would also fit, but they are outbound: phase two, not v1.) A
single missed call can be a $25k journey walking to a competitor.

**Caveat:** heavier compliance and often better-staffed front desks than a solo medspa —
but per-lead value dwarfs everything else here.

### 2. Plastic & cosmetic surgery

Rhinoplasty ~$8k–$15k, breast aug ~$8k–$12k, tummy tuck/BBL ~$10k–$18k, facelift
~$15k–$30k+. Cash-pay, consult-driven, aggressively price-shopped by phone — **and the
surgeon is in the OR while the phone rings out.** One recovered consult is a five-figure
case.

**Bonus:** surgeons value the qualification layer that screens tire-kickers from serious
consults.

### 3. Medical weight-loss / GLP-1

The strongest combination on every axis. Recurring, not one-shot — 40 active GLP-1
patients generate **$14k–$24k in monthly recurring revenue**, and a mature program runs
**$15k–$40k in monthly net** within six months.

Crucially, about **40% of GLP-1 medspa patients are completely new to the practice**, so
these leads arrive cold through paid ads — the front desk isn't built for the volume, and
every missed call is a lost annuity, not a lost visit. Demand is enormous: GLP-1 programs
are now offered at ~38% of US medspas, and 1 in 8 US adults have used one.

**Caveat:** the clinical part is regulated intake (prescribing, diagnosis,
medical-necessity documentation), and the assistant does none of it: it answers from the
clinic's menu and prices, books the consultation, and routes anything clinical to the
clinic. It converts fastest on ROI, but the copy must not imply the assistant screens or
qualifies a patient for a prescription.

### 4. Dental — implants, full-arch, ortho, cosmetic

A rare high-ticket **and** high-volume combo. Single implant ~$3k–$5k, full-arch
(All-on-4) ~$20k–$50k per arch, Invisalign ~$4k–$6k.

Colossal call volume, heavily price-shopped, and dental front desks are famously slammed.
The high-ticket electives are largely cash/financed, so insurance friction is limited on
exactly the cases that matter.

---

## Tier 2 — strong ROI, more friction or more competition

### 5. Hair restoration / transplant

**$3k–$9k+** per patient, recurring maintenance every 4–6 weeks, consult-heavy — GLP-1
shedding is a tailwind. Ranks Tier 1 in a medspa-only view; sits at Tier 2 here because
fertility, surgery, and dental outrank it on ticket.

### 6. LASIK / refractive & premium ophthalmology

~$2k–$4k per eye, elective, cash-pay, price-shopped, fast clean yes; premium cataract
lenses extend the ticket.

### 7. Cosmetic dermatology

Overlaps medspa but standalone derm too — Mohs, cosmetic derm, high volume.

### 8. Med spas / injectables / body contouring

The existing core, sitting in Tier 2 **because Zenoti (and Weave) bundle native AI in
this lane.** Boulevard, Mindbody and Vagaro have no native AI receptionist (August 2026
research, launch-plan.md "What competitors charge"). Real pain, contested lane. Booking also
matters here: Mindbody clinics, and Boulevard clinics until Boulevard confirms its Google
sync, run manual booking mode in v1.

Sub-segments, if you go after it anyway:

- **Injectables-led** (Botox / filler / bioremodelers) — highest raw volume. A Botox
  appointment generates $350–$550; bioremodelers ($600–$1,200/session) are the
  fastest-growing injectable slice, with repeat and membership models. The catch: this is
  exactly the segment existing AI-receptionist vendors already target.
- **Body contouring** (CoolSculpting / EmSculpt / Morpheus8) — packages priced
  $2k–$6k per area, 4–8 sessions, strong upfront cash collection, demand up ~22% YoY.
  Price-shopped hard over the phone, which means high call volume where each captured
  package is a huge ticket.
- **Laser hair removal / laser clinics** — high volume, package-based,
  price-shopper-heavy, but already explicitly named and targeted by incumbents like
  AgentZap. Good economics, crowded lane.

---

## Tier 3 — good but situational

| # | Niche | Why it's situational |
| --- | --- | --- |
| 9 | Concierge / functional / longevity medicine | Recurring cash-pay memberships, but nascent — thinner demand. Early-mover window. |
| 10 | Bariatric surgery | $15k–$25k, but more insurance-gated and lower volume. |
| 11 | TRT / men's health | Recurring cash-pay like GLP-1, but the same or heavier controlled-substance compliance friction. |
| 12 | Vein / vascular cosmetic, IV therapy | Lower ticket or event-driven, so per-call ROI is weaker and the yes is slower. |

---

## What ships on the site

The marketing site leads with six specialties, chosen as the intersection of Tier 1 and
"demoable in a 30-second conversation":

1. Med Spas & Aesthetics
2. Plastic & Cosmetic Surgery
3. Fertility & IVF
4. Dental & Orthodontics
5. Dermatology
6. Weight Loss & GLP-1

Med spas and dermatology are on the site despite their Tier 2 placement because they are
the most *recognizable* entry points — they earn the click, and the Tier 1 verticals earn
the revenue. Specialty content lives in
[`apps/web/src/lib/specialties.ts`](../apps/web/src/lib/specialties.ts); adding a seventh
is a single entry in that array.

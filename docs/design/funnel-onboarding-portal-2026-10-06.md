> **Approved by the owner on 6 October 2026.** This is the plan for the sales funnel, onboarding and the
> clinic portal (launch steps 2.6-2.8), copied verbatim from the planning session. Precedence: `docs/v1-product-spec.md`
> wins, then this plan, then `docs/design/stripe-launch-2026-10-05.md`. What other sessions build to is extracted in
> `docs/design/funnel-portal-contracts-2026-10-06.md`. The owner's open items are tracked on the "healdesk Launch Open
> Items" page (https://claude.ai/artifact/JowPjYhhLcffkm7R4qev7s), not in this file.
>
> **Changed since approval (6 October 2026), by the owner's answers on that page and the sessions'
> acknowledgements.** The contracts file is current; where this plan disagrees with it, the contracts file wins.
> - **No opening dates.** A channel is sold only once it is ready; one that isn't comes off the product list.
>   `CHANNEL_OPENING`, `published_opening_on`, O12, the opening-date alerts and the Meta switch-or-refund date are gone.
> - **No plan-start backstop.** Monthly billing starts only on the day AYA first answers a patient. Instead there is a
>   30-day setup window: six reminders, one every five days, while no channel is live, and an unfinished clinic is
>   closed at the end of it. The setup fee is never refundable. No subscription schedule; L5, L6 and
>   `extendPlanStart` are gone.
> - **The direct-booking kill switch** is `HEALDESK_DIRECT_BOOKING_ENABLED`, set only by the owner (5 October
>   decision). The clinic's own control is Auto-confirm, behind step-up.
> - **Setup links** stay closed in production until the owner sets `HEALDESK_SETUP_LINKS=open` (Gate A).
> - **Smaller answers:** the calendar-list permission is included; vets' bookings may record the animal's name and
>   species; the support line is the Retell number; the announcement bar's wording is the owner's.

# Get AYA: sales funnel → onboarding → minimal clinic portal (v1)

## Context

You asked for three things on 5 Oct 2026.

1. **Remove the hero paragraph.** Done on disk. It lands with the hero session's HeroOrbit commit, by your choice.
2. **A customer-first sales funnel**, from "Get AYA" to Stripe Checkout, with onboarding straight after.
3. **A very minimal clinic portal**, with:
   - an expiring email link instead of a password;
   - every spec switch and the failure modes;
   - payment preferences and the calendar connection;
   - Healdesk support by phone, email, and a chatbot on the same Anthropic key as the clinic's assistant.

**Where things stand now (origin/main, eba6683):**
- **Packages split.** The chat packages are now seven plan ids under five cards. `chat-web`/`chat-meta` and `web-voice`/`meta-voice` are twins, so the channel choice picks the plan id.
- **F0 is on main.** The Stripe foundation is migration `0043_stripe_launch`: checkout intents, sign-in links, `clinic_settings`, the usage ledger, the billing-notice outbox, Connect ledgers, `publicUrl()` and `app_user_clinic_grants`.
- **The rest of the Stripe launch is designed and paused.** `docs/design/stripe-launch-2026-10-05.md`, packages A1–E, will be built to match this plan. That doc's own rule: the spec wins, then this plan, then the design.
- **Nothing exists after payment.** There is no sign-in UI, wizard, portal or welcome email. Provisioning still runs before the invoice is paid. Checkout still asks a phase-two question, offers two of three coverage modes, and uses the phase-two booking-system list.

**Outcome.** A clinic:
- buys, paying only the setup fee that day;
- protects patient details with Face ID in one tap;
- finishes a four-step setup pre-filled from its own website;
- watches its AYA being built on a live tracker, then talks to her before she answers patients;
- runs everything from six calm screens.

Monthly billing starts the day AYA first answers a patient, and covers only the channels in service.

**Email.** Annex X, at the end, covers every email across the client's life: before purchase, during and after. It was audited through three lenses (lifecycle and experience; compliance, privacy and abuse; Resend and infrastructure), then checked for consistency.

**Your 6 October comments are applied:**
- **One email address per clinic** (info@ is fine): it is the sign-in, the billing address and where every notification goes. One shared sign-in, and each device adds its own Face ID. No team invites or roles in v1.
- **Plan start validated.** Visa's 7-day reminder is mandatory only for free trials and introductory promotions (Visa Business News AI09334, 26 Sep 2019). Ours gives nothing free, so billing starts the day AYA first answers, as you decided. It is built without a Stripe trial, so Stripe never treats it as one. No week's delay and no hold on the card.
- **Every email can be replied to.** Replies go to hello@healdesk.io, which stays the one inbox, with no BAA mailbox.
- **Booking requests go out the moment they're made**, and a summary with calendar links arrives at the start of each working day.
- **One Resend account** sends from hello@healdesk.io (product) and noreply@healdesk.io (marketing), on the free plan until volume needs Pro.
- **Subprocessor notice: 24 hours** from the next agreement versions. **Incident reports** go only when ops sends them from /admin.
- **Your open items** become a page with collapsible items, published as the first step after you approve.

**How this plan was reviewed:**
- Two adversarial rounds: nine reviewers, each serious finding checked by a skeptic. The first round's simplicity skeptic hit a usage limit, so I judged those recommendations myself and say where I departed from them.
- Five rounds of your answers.
- The Stripe launch design.
- Every confirmed fix is folded in below.

---

## Decisions

**Your answers:**

| Topic | Decision |
|---|---|
| Portal | Six screens: **Home · Settings · Knowledge · Conversations · Bookings · Billing**. Settings is every switch on one page, in cards. Help is on every screen. |
| Launch | The full funnel behind a **pilot switch**. Pilot is the default; public opens after Google verification. "Pilot" is an internal word only. |
| Copy | **Nothing client-facing signals that we are new.** Never "pilot", "beta", "early access", "first clinics", "founding" or "cohort". |
| Selling | **Any package can be bought.** Opening dates are **not part of the purchase**. Each channel's opening date appears after purchase, **in the dashboard only**. |
| Plan start | **Today: the setup fee only.** Monthly billing starts **the day AYA first answers a patient, and no later than {purchase date + a fixed term}**. The term defaults to 60 days and you set it; we extend it automatically while the delay is ours. The term reveals no channel schedule. **Validated on 6 Oct:** Visa makes its 7-day reminder and "trial" statement wording mandatory "only for merchants that offer free trials or introductory promotions" (Visa Business News AI09334, 26 Sep 2019). Our deferred start gives nothing free, so it isn't one. It is built without a Stripe trial, which Stripe would treat as one (A4). |
| Price meanwhile | **Billed by channels in service.** Until every channel in the package is in service, the monthly price is that of the package matching the channels in service. Each new channel's price applies **from the day it first answers**, prorated onto the next invoice. Once the plan has started, a channel ready on our side and waiting on the clinic joins 30 days after the later of its readiness and the plan start, with a week's notice (L4). **At the backstop**, a channel ready on our side and waiting on the clinic counts as in service. If no channel is ready on our side, the delay is ours and the backstop moves. |
| Account | **One email address per clinic** (info@ is fine). It is the sign-in, the Stripe billing address, the agreement's notice address and where every notification goes. **One shared sign-in**, and each phone or computer adds its own Face ID, so the access log still shows which device opened what. **No team invites or roles in v1**; the spec's three roles come later. |
| Setup-fee promise | Refunded if no channel is in service **30 days after its published opening date** (shown in the dashboard), for a reason on our side. Meta-only packages get a fixed switch-or-refund date. Both rules live in the terms and the dashboard, **not in the funnel**. |
| Trust | A **live build tracker** on Home. **Talk to your AYA** unlocks when the build stages are complete. |
| Sign-in | Expiring email link only, **no password anywhere**. |
| Second factor | **Passkey per device**, with an **authenticator-app backup**. It gates Conversations and Bookings. |
| Pre-fill | The **website is read** from the funnel's field. A three-field fallback covers failures and clinics with no website. |
| Funnel | **Package first, four steps.** |
| Locations | One per purchase. Extra locations are added from Billing at the price you set in the Stripe design: the package price again plus its setup fee once, with pooled allowances. |
| Support | A **voicemail line** (notification-only email), **hello@healdesk.io**, and a chat bubble that **stores nothing**. |
| Meta/WhatsApp connect | Out of this build. |
| Non-HIPAA practices | A **Data Protection Agreement** for vets and for HIPAA-if-covered practices that answer "No". It is **built and released with everything else at launch**. Its text gets your release sign-off on the launch checklist, as the BAA's did. |

**Binding decisions recorded by other sessions:**
- **Calendar (memory `calendar-baa-decisions-2026-10-05`):**
  - the funnel asks the booking system **and** the Google account type, and both select the agreement's calendar clause;
  - 1.15: "name and service anyway";
  - variant now, elections later;
  - direct booking = Auto-confirm, a healthy calendar and signed terms, plus a kill switch (in v1, the clinic's one sign-in, with step-up);
  - a 5-minute calendar watch.
- **Stripe design §0:**
  - overage $0.80 a voice minute; $0.40 a chat on `chat-web`/`chat-meta`, $0.30 elsewhere;
  - extra locations priced as above;
  - a chat conversation is one person's thread until 24 h of silence;
  - voice minutes round up per call;
  - Stripe Connect is the only deposit gateway.

**My defaults** (override any):

| Topic | Default |
|---|---|
| CTA and badge | "Get AYA" everywhere. The "Most clinics" badge becomes "Recommended". |
| Payment | Cards only (Apple Pay and Google Pay ride on card). |
| Marketing sender | `noreply@healdesk.io`, as you chose, with replies going to hello@, because the nurture emails invite them ("Reply to this email and a person answers"). |
| Sessions | 14-day absolute sessions. |
| Step-up | Expires after 15 minutes idle on patient pages, 8 hours at most, with a "Keep open" warning. |
| Retention | Transcripts and records 90 days; the clinic can shorten to 30 or 7. |
| Model | `claude-opus-5-5`. Per-channel engine config, so voice can tune latency later. |
| Where the work happens | A fresh worktree from origin/main, with its own test database. Migrations are generated at merge time. |

---

## Who builds what

| Owner | Builds |
|---|---|
| **This plan** | The funnel UI and pilot gate; the website read; the purchase backend (intents extension, provisioning cutover, `/welcome`); sign-in pages, per-device factors, step-up and "I can't get in"; the wizard; the **portal, every screen including Billing's UI**; the engine's text core, practice questions, Talk to your AYA and automatic go-live; the support chat; **the email platform and its sender** (Annex X, replacing F0's sender stubs), every non-billing email and ops alerting; the /admin queues; the Data Protection Agreement; retention and offboarding coverage; every schema change these contracts need. |
| **Stripe session** (resumes after approval, built to this plan's contracts) | **Package B:** usage, `assistantMayAnswer`, fallback. **Package C:** the billing lifecycle, plus the billing notices' kinds, payloads and templates on this plan's email platform; `startPlan`, `extendPlanStart`, `stepUpPackage`, `changePlan`, `addLocation`, `setAutoRenew`, portal configurations, refunds, and E's ops billing panel. **Package D:** deposits and Connect. **A1, A2 and E's portal screens are superseded by this plan.** |
| **Calendar session** (`acc932a3`) | The Google OAuth backend (production client In production, unverified; PKCE; sealed tokens); per-location elections; the watch; the **calendar-variant BAA**, carrying the shared state-law and Payments clauses and **24 hours' notice before a new PHI subprocessor**; the direct-booking gate; making `agreementCarriesCalendarWrite` aware of the agreement kind. |
| **Hero session** (`afb5b63d`) | Commits the subtitle removal **together with** HeroOrbit. The "Get AYA" rename follows as its own small commit. |
| **Runtime** (Launch-plan steps) | Web widget (1.8). Retell voice, number allocation and the test call to the direct line (2.1, 2.2). Meta (1.6, 2.3, 2.5). Booking tools that write price snapshots (1.5). The routed/answered counter. Each calls this plan's engine and `recordTurn()`. |

**Contracts written in M0, each acknowledged by its owning session:**
- **Calendar:** `getCalendarConnection`, `startGoogleConnect(returnTo)`, `disconnect`, `listCalendars` (if the scope is approved), `effectiveBookingMode(clinicId) → {mode, reason}`.
- **Stripe session:**
  - **The deferred start, with no Stripe trial anywhere.** Checkout takes the setup fee plus a **$0 "Monthly plan: starts when AYA first answers" line** (A4). At provisioning, a **subscription schedule** is created from that subscription:
    - phase 0 is the $0 line until the backstop;
    - phase 1 holds the bought package as a placeholder, with `billing_cycle_anchor: phase_start`, and `startPlan` rewrites it to the channels in service. On annual plans, phase 1 carries no metered items; overage is invoiced separately, as today.

    Stripe itself enforces the backstop. Nothing is ever `trialing`, so no charge carries Stripe's automatic "TRIAL OVER" wording.
  - `startPlan(clinicId, reason: first_answer | backstop)`:
    - **`first_answer`** ends phase 0 now and starts phase 1 now, with the package matching the channels in service. The first period is charged that day;
    - **`backstop`** is called by a job 7 days before the backstop. It sets phase 1 to the channels ready on our side, live or waiting on the clinic, and enqueues L5, a courtesy reminder. If no channel is ready on our side, the delay is ours, and it calls `extendPlanStart` instead. `notifyOps` fires if this job hasn't run by 3 days before the backstop;
    - **for either reason**, the first plan invoice's `invoice.paid` sets `plan_started_at`, opens the allowance window and sends L2 with its receipt. At the backstop it reads "Your plan started today, as scheduled". A failed charge sends the payment-failed notice instead;
  - `stepUpPackage(clinicId, channel, reason: first_answer | waiting)` adds a channel to the current phase, **once the plan has started**:
    - from the channel's first answer (L3 that day);
    - or 30 days after the later of its readiness and the plan start (L4 seven days ahead).

    Before the start, waiting channels count only at the backstop, and a channel already priced in at the start sends no L3. Monthly plans are prorated onto the next invoice; annual plans use `always_invoice`. It never re-charges a setup fee, and keeps metered rates at the **bought** package's;
  - `extendPlanStart(clinicId, date, reason)` moves phase 0's end. It runs automatically when no channel is ready on our side, or by ops, and sends L6, merged with O12 when an opening date moved;
  - **cancelling before the plan starts** sets the schedule to end with phase 0, so nothing more is charged;
  - the gate additions: channel Off, channel not live, `ai_paused_until`, and refusing go-live once a cancellation before the start is set;
  - the notice kinds and payloads for L2–L6, L19, L26, L27 and E1–E2 (Annex X): `plan_started`, `price_stepped_up`, `step_up_reminder`, `plan_start_reminder`, `plan_start_moved`, `allowance_fallback`, `meta_deadline`, `receipt`, `refund_issued`, `card_expiring`, and `renewal_upcoming` at 30 and 21 days, plus carrier-specific steps for undoing call forwarding in the suspension and end notices. $0 invoices send nothing.
- **Calendar session:** the next BAA version gives **24 hours' notice** by email before adding a subprocessor that will handle PHI, keeping the right to object. The DPA uses the same clause.
- **Engine (this plan; runtime consumes):** `respond(...)`, `recordTurn(...)`, the channel events `live` and `first_answer`, the specialty-keyed urgent matcher, and per-channel config.

---

## The journey, from the owner's side

1. **"Get AYA".**
   - In pilot mode the public CTA opens a short form: **"Tell us about your clinic"**, with the button "Request my setup".
   - The setup link we email opens the funnel, pre-filled from their request.
2. **Package.** Five cards, prices, setup fee, what's included. Channel twins pick the plan. No dates.
3. **Your clinic.**
   - Name; website (or none); specialty; where bookings live; which Google account.
   - The consequence shows at once. The site is read in the background.
4. **Agreement.** The right paper for the practice (BAA or DPA), worded for it. Signed as today.
5. **Review & pay.** For example:
   - "**Today: $997 setup fee.** Monthly billing ($897) starts the day AYA first answers a patient, and no later than 4 Dec."
   - "Until every channel in your package is in service, your monthly price is the price of the channels that are."
   - "We read glowmedspa.com: 14 services, your hours, 3 providers."
   - The guarantee, the terms tick-box, and Pay.
6. **Stripe → app.healdesk.io/welcome.** "Payment received. Setting up AYA…", then **"Protect patient details: use Face ID"** (one tap), then setup.
7. **Setup.** Step 1 of 4 → Step 4 of 4, pre-filled from their site. It ends on the **build tracker**. When the tracker completes, "Talk to your AYA" unlocks.
8. **Opening.**
   - The dashboard shows when each channel opens.
   - "Website chat is ready: one step left" emails the snippet.
   - AYA's first patient conversation starts the plan that day, and an email says so. Phone's price joins the day phone first answers, prorated.
   - Day to day: Home, Settings, Knowledge, Conversations and Bookings (Face ID), Billing, and Help.

---

## Part A: Sales funnel (apps/web, no PHI)

**A1. Label.**
- "Get AYA" in `site.ts`, `PricingCards.tsx`, `CTA.tsx`, the `BuyModal` aria-label, the `StepShell` eyebrow, the `get-started` title and `demo-prompt.ts:65`.
- A separate commit after HeroOrbit lands (`site.ts` is shared).
- Pricing cards open the sheet in place with the package already chosen.

**A2. Pilot gate.** The first apps/web commit; it never touches `site.ts`.
- **Mode:** `HEALDESK_CHECKOUT_MODE=pilot|public`, **fail-closed to pilot**.
  - The static pages fetch it from a `no-store` route. `/api/checkout`, `/api/pilot-request`, `/api/clinic-site` and `/api/agreement` enforce it server-side.
  - It is declared in `turbo.json`. To flip it: redeploy without cache, curl, then check the GitHub Production deployment.
- **Setup request** (internal name: pilot request). Titled "Tell us about your clinic", button "Request my setup".
  - Fields: name, clinic, website, the email your clinic will use with healdesk (info@ is fine), channels wanted.
  - It writes a Sheet lead and emails hello@.
  - Confirmation: "Thanks. We'll reply to {email} by {Tuesday 7 October} with your next step." The date is the next business day.
  - If the request came from a nurture lead, it records the lead id. That stops the nurture and carries any setup credit still valid.
- **Invites** (internal name). Client-facing, they are the **setup link**: "Your setup link for {clinic}", never "invitation", which reads as early access.
  - minted in /admin as signed tokens (the `agreement-download.ts` shape, its own purpose, 14 days, bound to an email);
  - **single use** through a unique `invite_ref` on `checkout_intents`;
  - the email goes from apps/web (P4 and P5 in Annex X);
  - the funnel opens pre-filled from the pilot request: card, name, website (which starts the read) and contact;
  - /admin shows each invite's progress (opened · package · signed · paid), read from intents through ops;
  - the Google 100-account count comes from the calendar backend.
- **URLs and analytics:** the `?setup=` token (client-facing, so not `?invite=`) becomes an httpOnly cookie on first load, then `replaceState` clears it. **PostHog strips query strings** on /get-started.

**A3. Four steps.**
- The step rules are pure `.ts` modules, so they can be tested.
- The `CheckoutFlow` helpers are exported.
- **PrimaryButton moves to `bg-brand-gradient-deep`.** White on the current gradient fails AA, at 2.67:1.

| Step | Shows and asks | Rules |
|---|---|---|
| **1 Package** | Five cards from `pricingCards`, each with price, setup fee, allowance, channel chips and the "Recommended" badge, plus the monthly/annual toggle. On twin cards, the channel pick **selects the plan id**. **No opening dates or timing lines.** Locations line: "This sets up one location. Add more from Billing after setup: {price}/mo + {setup} each." | Preselected only from a pricing card or `?plan` |
| **2 Your clinic** | Practice legal name (120 characters max). Website, or "We don't have a website". Specialty: the vet chip appears only when the DPA's vet branch is released (Part L). "Where do bookings live today?": Google Calendar only · Calendly · Cal.com · Mindbody · Boulevard · Something else · No system. "Which Google account will bookings go into?": the calendar session's three types, in plain words. Email and specialty are pre-filled from the demo gate when present. | No website: offer **Phone first**, then Meta Chatbot with its conditional line, and refuse web chat server-side too. The consequence line comes from `effectiveBookingMode`'s global state; while the gate is closed: "For now your team confirms each booking AYA takes; live booking switches on once your calendar is connected and checked." The browser time zone is kept as a fallback. |
| **3 Agreement** | `AgreementStep`, driven by `agreementKindFor` (Part L). The BAA or the DPA, with explainer, titles and assent label per kind. The covered-entity question is worded around billing: "Do you bill any health insurance electronically, yourself or through a clearinghouse?" Below 640 px the agreement renders inline, and signing unlocks at an end marker. **"Read to end" and the assent tick reset whenever the rendered kind or text changes.** Name, title and email. The email becomes the clinic's one address (sign-in, billing and every notification), and a shared inbox such as info@ is fine: "This is where healdesk signs you in and sends everything." | `attributionMode` is fixed to `estimated`. A render test covers every combination of kind, specialty, booking system and Google type. |
| **4 Review & pay** | In order: **Today: setup fee** and what it covers. **The plan-start sentence**, one catalog constant also used in `custom_text`, on Home, on Billing, in the welcome email and in the terms: "Monthly billing ({price}) starts the day AYA first answers a patient, and no later than {date}." On annual plans: "Annual billing ({price} a year) starts the day AYA first answers a patient, and no later than {date}." The **channels-in-service sentence**, for packages with more than one channel: "Until every channel in your package is in service, your monthly price is the price of the channels that are." Included each month, and the provisional overage, with a run-out line that fits the package. **No opening dates.** The setup-fee and Meta rules are in the linked terms. "Plus sales tax where it applies" when Stripe Tax is on. The **site-read line**, shown only once the read finished with at least one service ("We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup."; on failure: "Setup starts with three quick questions."). The **guarantee in full**. A compact "Agreement signed ✓ · Download". | On phones, the terms tick-box and **Pay** sit in a sticky bar, with scroll-padding. The terms record (`LEGAL_VERSION`, time, IP) goes into the intent. |

**A4. Server path** (`/api/checkout`)
1. Validate the allowlisted payload **before any upstream call**. That includes the invite, the terms version, the website rule, and the profile shape from the read.
2. Make a signed POST to apps/app `/api/checkout/intents` (F0 table).
   - Everything goes in the `payload` jsonb except the read profile and status, the invite ref, the attempt and open session id, and the nonce hash, which get columns.
   - **apps/app checks** that the agreement exists, is unbound, and was signed by this email. Its kind must equal `agreementKindFor`, and **every input that selects or names the document** must match its signed variables: legal name, specialty, covered answer, booking system, Google type. Its template must be released.
   - It returns `{ref, successUrl}`, built with `publicUrl('/welcome?h=…&cs={CHECKOUT_SESSION_ID}')`.
3. Create the Stripe session:
   - subscription mode, `payment_method_types: ['card']`;
   - the **bought** package's setup fee (one-time), plus a **$0 recurring line, "Monthly plan: starts when AYA first answers"**. **No `trial_end`, so no Stripe trial.** The package price and the metered items join at the plan start (the schedule in the M0 contract);
   - why not payment mode: a setup credit brings the total to $0, and Stripe then collects no card. Subscription mode always saves one;
   - metadata `{app, ref}`, `client_reference_id = ref`;
   - `branding_settings.display_name = "healdesk"`;
   - `automatic_tax` when `STRIPE_AUTOMATIC_TAX=true`;
   - `custom_text` carrying the plan-start sentence;
   - **an idempotency key per attempt**, reusing the intent's open session, and the previous open session expired on a new attempt.
4. Set a random **nonce cookie** (`Domain=healdesk.io; Path=/welcome; HttpOnly; Secure; SameSite=Lax`, 30 minutes). Only its hash goes into the intent.
5. Sheet writes run in `after()`. A duplicate subscription raises an ops alert; it is not auto-refunded in the pilot.

**A5. Back and cancel.**
- All four steps persist in sessionStorage, and a Stripe cancel returns to step 4 intact.
- The agreement is reused only when every document input matches.
- **Deferred to public mode:** resume refs and the abandonment-email rewrite. Buyers in pilot mode come back through their setup link, which P7 resends.

**A6. Copy and legal.**
- **No timing before purchase.** Marketing pages, the funnel and nurture describe **how** each channel goes live (paste one line; set call forwarding; connect Instagram), never **when**. "Same day" claims are removed until that channel's runtime ships. Applies to pricing `LIVE_WHEN`, `KnowMore`, demo prompt, nurture, metadata and the done page. Opening dates come from catalog `CHANNEL_OPENING` and appear only in the dashboard, never in email.
  - At provisioning, each clinic's dates are snapshotted into `clinic_channels.published_opening_on`. The setup-fee refund clock runs from that date.
  - Only ops moves one (`setChannelOpening`), which sends O12.
  - `notifyOps` fires 3 days before a date whose runtime isn't ready, so a date is moved before it passes. A past date that slipped through renders "New date by {Tuesday 7 October}", and ops moves it that day (O12).
- **No newness signals.** A copy test fails on "pilot", "beta", "early access", "first clinics", "founding" or "cohort" in client-facing strings. Existing hits to fix:
  - the Stripe-visible coupon name "Founding-cohort setup credit" becomes "Setup credit";
  - nurture's cohort lines;
  - the "Launching with…" announcement bar (your call; open item).
- **Claims:** use the spec's line verbatim ("We sign a business associate agreement and handle patient data under it"). Drop **"with every clinic"** from `Footer.tsx:50`, `KnowMore.tsx:107`, `knowledge/index.ts:154` and `demo-prompt.ts:78`, and fix `nurture.ts:90/130` and `checkout/route.ts:156`. A grep test keeps "with every clinic" out. The DPA sentence appears only where non-covered practices are addressed.
- **Reassurance lines:** fix the ones in StepShell and AgreementStep.
- **Privacy fields:** each is added in the commit that first collects it, with the `LEGAL_VERSION` bump.
- **Terms changes** ship with the deferred-start Checkout:
  - §3: the setup-fee clock runs from the published opening; the Meta switch-or-refund.
  - §4: renewal anniversary is the plan start.
  - §5: the 14-day first-period refund runs from the plan start.
  - §13 (subprocessors) and the agreements: 24 hours' notice before a new PHI subprocessor, from the next BAA version and DPA 1.0.0.
  - **"Data Agreement"** is defined (BAA or DPA), with a test that fails on stray "Business Associate Agreement" wording outside BAA passages.
  - The "no trial" comments (`plans.ts:11-20`, `billing.ts:36-38`) stay true. Their first-invoice line changes to "setup fee + the $0 monthly line; the monthly price starts when AYA first answers".
- **"Sign in"** on the healdesk.io nav and footer, through `NEXT_PUBLIC_PORTAL_URL`, shipping with the portal.

---

## Part B: Reading the clinic's website (apps/web; untrusted fetching stays off the PHI host)

- **Route:** `/api/clinic-site`, started from step 2.
  - It is gated by mode, limited to one read per session, rate-limited per IP, and capped daily through `GLOBAL_CAP_KEYS`.
  - `maxDuration` stays within the Vercel plan's limit.
  - It **returns the screened profile to the browser**, which keeps it in sessionStorage and sends it into the intent at Pay. apps/web stores nothing.
- **Fetch guard:**
  - an undici Agent whose `connect.lookup` **pins** each connection to the address it checked;
  - refuses 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, ::1, fc00::/7, fe80::/10, ::ffff:0:0/96, 64:ff9b::/96 and the `HEALDESK_APP_URL` host;
  - `redirect:'manual'` with each hop re-checked (3 at most);
  - no URL credentials, proxy environment variables ignored;
  - `text/html` only, 1.5 MB after decompression, at most 8 same-site pages, robots.txt respected.
- **Extraction:** `claude-opus-5-5` on the marketing organisation's key, with structured output and server-side fallback.
  - **Fields:** a **list of locations** (address, phone, hours each); services with **price kind** (exact / from / range / per unit) and duration; providers; policies; FAQs; **"accepts insurance" yes/no/unknown**; practice kind.
  - A `refusal` stop reason is its own failure, and the wizard falls back to the three questions. Tests use neurotoxin-heavy med-spa pages.
- **Screening:** `findClinicalContent`, **regime-aware**. Vets' service *names* are not screened against the human-medical patterns. The dropped count feeds the wizard line.
- **Re-reads:** the route also accepts **signed, clinic-scoped re-read requests from apps/app**, with their own limit, for:
  - a missing profile after purchase;
  - a website corrected in 1.1;
  - the monthly drift check.

  apps/app keeps the purchase profile as the **drift baseline**.
- **Why not after Pay in apps/app:** the simplicity review proposed it. I kept the read here because the Review & pay line needs the result before payment, and because fetching URLs a buyer supplies belongs off the PHI host, which is what the fidelity skeptic said too.

---

## Part C: Payment → signed into setup (apps/app)

**C1. Provisioning cutover** (design D2 semantics, built here)
- **Trigger:** `invoice.paid` with `billing_reason=subscription_create` and the healdesk marker.
  - Read `ref` from the invoice's subscription metadata snapshot.
  - Relay `/api/provision {ref, idempotencyKey: subscription id, customer, subscription}`, then forward the event to billing events.
- **Failures:** a 5xx returns 500 and does not forward. A 4xx is logged loudly, sent to **`notifyOps`**, and still forwarded.
- **Replays:** an existing clinic for the subscription or customer is a replay.
- **No legacy branch.** M1's pilot gate reaches Production at least 24 hours before the cutover, and Stripe is checked for open Checkout Sessions (they expire within 24 hours).
- **The first invoice** carries the setup fee and the $0 monthly line, so a paid invoice means money cleared. With the setup credit it is $0, and the card is still saved.
- **Tests:**
  - a subscription still on its $0 line must not trigger `recordFirstInvoice`, the allowance windows, the renewal reminder, usage alerts or a receipt email;
  - no subscription is ever `trialing`.

**C2. What provisioning creates**
- **The clinic's one sign-in:** design D3: find-or-create the user by the buyer's email, member owner, `clinic_memberships` owner. No other members in v1.
- **The clinic:**
  - `regulatory_regime` and the agreement kind stored;
  - `clinic_settings` defaults, with Auto-confirm set from the funnel's booking system;
  - `clinic_channels` rows for the bought channels;
  - knowledge from the profile, plus the drift baseline;
  - entitlements (not started), with `bought_plan_id` and `plan_start_backstop_at`. Package C creates the subscription schedule (M0 contract);
  - the terms record; the **90-day** clock;
  - `booking_requirements_confirmed` stamped from the specialty defaults.
- **The time zone** comes from the chosen location's address, then the browser, then New York.
- **The welcome email** is sent after commit.
- **Retired in the wizard's commit:** the "One thing to set up" email, `/setup/[token]` and `issueSetupLink`.

**C3. `/welcome`** (supersedes design §4.3/4.4's done-page polling; recorded in the design doc in M0)
- **The page:** a pure reader of the intent.
  - It checks the **nonce cookie hash**, that `cs` belongs to the intent, and the intent's state.
  - It polls every 1.5 s for up to 90 s.
- **When provisioning has landed:**
  - it issues F0's `checkout` link (10 minutes, `source_ref` = the intent) and auto-submits it, since this is the paying browser;
  - the session starts;
  - it goes to the **factor screen**, then `/c/<slug>/setup`.
- **Provisioning failed:** "Payment received, and your payment is safe. Setting up your account needs one step on our side. We'll email l•••@glowspa.com by {Tuesday 7 October}." B3 confirms the order by email at once.
- **Timeout:** "Your account is almost ready. We'll email your sign-in link to l•••@glowspa.com the moment it is." There is no account to sign in to yet, so no sign-in link is sent here; the welcome email (B1) is that link.
- **Hygiene:** `h` is removed from the address bar, and the success URL is never logged.

**C4. Welcome email** (B1 in Annex X; once only; sent at provisioning; ships with the wizard in M3)
- **The order confirmation:** what was bought, the setup-fee receipt (Stripe's hosted receipt), the plan-start sentence, the monthly price, and how to cancel online.
- **Continue setup:** a fresh 72-hour link, plus the four steps still to do.
- Each bought channel's status in words: "See when each channel opens on Home". No dates in email.
- The Terms version, the agreement download, and Help.

---

## Part D: Getting in (apps/app)

**D1. Links**
- **The link itself:** F0's `sign_in_links` and `/link/[token]`.
  - A GET shows "Continue as l•••@…". A POST uses up the link. Checkout links auto-submit.
  - Sessions come from the design's server-only Better Auth endpoint.
- **`/sign-in`:**
  - sends only to a clinic's address;
  - uniform response and timing;
  - per-email and per-IP limits reusing `attempt-limit.ts`;
  - names the sender ("It comes from healdesk, hello@healdesk.io"); "Send again" after 60 s.
- **Session settings:** `emailAndPassword.enabled=false`; `session.disableSessionRefresh` for the **14-day absolute** session.
- **Already signed in:** a used link opened in an already-signed-in browser goes straight to the portal.

**D2. Step-up**
- 15 minutes idle on patient pages, extended by activity, with a "Keep open" warning 60 s before; 8 hours at most.
- On idle, patient pages clear and re-prompt (one tap, with "Use your phone instead").
- Cleared on sign-out, and when that device's passkey is removed.

**D3. Factors: our own implementation, not the plugins.**
- **Why not the plugins:** their verify endpoints create sessions (a second sign-in path) and don't require user verification.
- **Building blocks:**
  - passkeys through `@simplewebauthn/server`, `userVerification: required`, with the RP ID and origin from `publicUrl()`;
  - TOTP to RFC 6238, with a replay guard and persisted lockout counters;
  - backup codes stored hashed;
  - one `user_factors` table, with TOTP secrets sealed (needs the KMS fix).
- **Enrolment:**
  - **the first screen after `/welcome`**: "Protect patient details: use Face ID", worded for the device, with "Use your phone instead";
  - skippable, with the line: "You won't be able to open Conversations or Bookings until you add this";
  - the backup is offered at the end of setup, with a Needs-attention item until it's added;
  - a **7-day same-browser cookie window** for first enrolment.
- **More devices** (the clinic's one sign-in, shared by its staff):
  - "Add this device" registers another passkey, named by the person adding it ("Front desk Mac", "Maria's iPhone");
  - it needs a step-up from a device that already has one (the phone's passkey works across devices by QR code); with none at hand, the human route below. The billing-details check (D5) only ever sends a sign-in link, because receipts showing the card's last digits reach the same shared inbox;
  - the authenticator backup only enrols a new device's passkey; patient pages open only after a passkey step-up;
  - the access log records which device's passkey opened each transcript or booking, so device-level attribution survives the shared sign-in.
- **Before go-live** (no PHI exists yet), a first passkey can be added from any signed-in session, and the clinic's address is emailed (O3).
- **Lost every device:** the human route: a call to the published number, operator TOTP, the same business day, and a link sent only to the clinic's address.
- **Removing a device** needs a step-up, from Settings → Sign-in, and ends the sessions that stepped up with it.
- **"Someone left"** (step-up) signs out every session, removes the devices you pick, and resets the authenticator backup and backup codes (O3).

**D4. Access** (one sign-in per clinic in v1; design §6's roles are deferred)
- The clinic's sign-in can do everything; patient pages need step-up.
- **Enforcement:** `requirePortal(slug)` on every page and server action, using `app_user_clinic_grants` (F0). Any other user sees "not found".
- **Sensitive changes** need step-up (a value set for the first time does not), email the clinic's address (O4), and record before/after values in `clinic_settings_history`:
  - the direct line, the transfer number;
  - the clinic's address itself (D5's change flow);
  - shortening retention;
  - connecting or disconnecting the Stripe account (O14);
  - adding or removing a device; exports.

**D5. "I can't get in"** (`/sign-in/help`; no table)
- **The form:** email, clinic, and a billing detail (the card's last 4 digits and expiry, or an invoice number), checked with Stripe **server-side**.
  - Response: "If the details match, we've sent a link to the clinic's address".
  - Links go **only** to the address already on the account.
  - Anything else emails hello@ with structured fields.
- **Lost access to the address itself** (an inbox closed, a person left): the change of address follows a runbook.
  - A callback to the published number.
  - A notice to the old and the new address (O5), with a **72-hour** objection window.
  - The operator's TOTP through ops `changeClinicEmail`, which also updates the Stripe customer and the agreement's notice address.
  - A billing match counts only as evidence. Every resolution writes a `security_events` row.
- **Changing the address from Settings** (signed in, step-up) sends a confirmation link to the new address, and O5 with "Stop this change" to the old one. It takes effect 72 hours after confirmation, moving the sign-in, the Stripe customer and the notice address together.

**D6. Headers and rendering**
- Nonce CSP, HSTS, and `Permissions-Policy` limiting publickey-credentials to `self`.
- Transcripts and chat render as plain text.
- CSV exports are injection-safe.
- A header test.

---

## Part E: Setup wizard (`/c/[slug]/setup`)

**Format:**
- "**Step 1 of 4 · Your practice**", with a bar inside the step.
- One decision per screen, with "Saved" ticks. Resume opens on the first unfinished screen.
- Every screen can be skipped and says what skipping costs. Anyone using the clinic's sign-in can continue setup.

| Step | Screens |
|---|---|
| **1 Your practice** | **1.1:** name, address, main phone, website, time zone. "Which location is this AYA for?" appears when the site lists several. Time zone: the address first; if the browser disagrees, ask. **1.2:** hours plus closures (skip line: "Phone can't go live without your hours"). **1.3:** services, with price kind, price and duration, and "We left out N items that mention doses or recovery; add them back in your own words". **1.4:** the most-asked question. **1.5:** *only if "not sure" at checkout*, the insurance-billing question (recorded as the practice's notice; the BAA stays). |
| **2 How AYA works** | **2.1:** tone; greetings pre-filled behind "Edit", after the locked AI line. **2.2** *(voice)*: which calls reach AYA, three modes; for After hours only on a landline: "dial one code at closing and another at opening, every day". **2.3** *(voice)*: the direct line, "a second line or a manager's mobile; AYA also gives this to someone reporting something urgent". **2.4:** "Do any treatments need a deposit?" (No, or Yes per service). Chat packages may **Connect Stripe** (returns to /setup), with "Do it later in Settings → Payments" as the default. **2.5:** **"a number patients can call for urgent help"** (defaults to the direct line; the main phone for chat-only; vets must give an emergency referral number), and where alerts go: "Urgent alerts, booking requests and everything else go to {clinic address}. Read it on a phone with notifications on." |
| **3 Calendar** | **3.1:** **Sign in with Google** (calendar backend). Before it: a picture of Google's unverified-app warning and its two taps; Google's notice and tick-box; a personal Gmail account detected from `hd`; a non-blocking Workspace-BAA check. After it, the funnel's booking system with **Change**, and Auto-confirm's "Right now: …" line. **3.2:** named providers, **only if the calendar-list scope is approved**, otherwise Generic only. If the calendar backend isn't on main yet: "Bookings arrive as requests your team confirms." |
| **4 Your channels** | Bought channels only, each with a **status word** (catalog `CHANNEL_STATUS`): "Opens Mon 20 Oct" / "Waiting on you: {one action}" / "Live since …" / "Paused until …" / "Off". **Website chat:** the snippet once open. **Phone, once voice is ready** (Retell answering on the BAA path, the pass-through test passed, the direct line set): **the forwarding screen**, with the AYA number large plus copy; a carrier and phone-system picker whose codes match the coverage mode (`forwardingInstructions` extended to all three modes); undo codes; "Email these to my office manager"; "**Book a five-minute call and we'll do it with you**" with equal weight; "Test it now" (the clinic's own run of the forwarding-test window); then "Waiting for call forwarding" until the first forwarded call. Before voice is ready: "Don't change your call forwarding yet; phone opens Mon 10 Nov." **Meta:** its line. |
| **End** | The backup factor, if missing, then the **build tracker**. |

**Tracker stages and when each is done:**
- Agreement signed ✓
- Payment ✓
- Your website read ✓, or "No website / couldn't read it: you answered 3 questions"
- Your answers set up ✓, at the spec's minimum: services with prices, hours, the most-asked question
- Calendar connected ✓, or "Bookings arrive as requests", which never blocks
- Assistant built ✓
- Practice questions passed ✓, or, while in review, "Being checked by our team; ready by {Tuesday 7 October}", the next business day

**Talk to your AYA** unlocks when every stage is done. The locked button names what's left.

---

## Part F: The portal (`/c/[slug]/…`; `/` redirects to your clinic or `/sign-in`)

**F0. Shell**
- **Header before go-live:** "AYA isn't answering {patients|clients} yet", linking to the tracker.
- **Header after go-live:** **AYA is answering [On]**.
  - Turning it off offers **for 1 hour / until tomorrow 8 am / until I turn it back on**, with one line per *live* channel ("Phone: calls go to your direct line (…)"; "Website chat: shows a contact form"). There are no undo steps here; those live in Safety net.
  - While paused, a banner reads "Paused from Front desk Mac at 9:14" (the device's name). A pause until tomorrow or indefinitely emails the clinic (L15), and again 24 hours into an indefinite one.
- **Menu:** Home · Settings · Knowledge · Conversations · Bookings · Billing.
- **A location switcher** appears only when there are several.
- **Help:** a bubble.

**F1. Home**
- **Before go-live:**
  - the tracker, then **Talk to your AYA**;
  - opening rows;
  - "Your plan starts the day AYA first answers a patient, and no later than {date}."
- **After go-live:**
  - **the first card:** "Waiting for you: 3 people to call back (oldest 2 h) · 1 deposit to collect · 1 handover", counts only, one tap into Bookings;
  - **this week, from one claims function** that Home, the weekly recap and the daily summary share:
    - conversations handled;
    - **booking requests taken · confirmed by your team** while bookings are requests, then "appointments booked by AYA";
    - booked value (at your listed prices; from the low end of "from" and range prices; per-unit prices counted separately);
    - deposits collected;
    - the rang-out count in the voice row;
  - "Your plan started on 12 Oct, when AYA first answered; your first month runs to 11 Nov."
- **Needs attention:** calendar or payment account disconnected, payment failed, a quiet channel, setup unfinished, the insurance question, the backup factor, website changes found, "We're double-checking your change to Prices".

**F2. Settings: one page, cards, bought channels only.**
- Instant save, with a toast naming the consequence.
- **Every switch ships with an effect test, or says "applies when {channel} opens".**

| Card | Contents (default) |
|---|---|
| **Channels** | Each bought channel: On/Off with its status word. Phone Off sends calls to the direct line; Website chat Off shows the contact form. Voice coverage (Overflow & after hours) uses `coverage_mode`, **the single source**: `call_routing` is copied once and every reader moves in the same change. Changing it shows the forwarding steps again. Snippet and "Email to my web person" once open. "Add Instagram, Messenger & WhatsApp → Billing". |
| **How AYA talks** | Tone (Warm); phone and chat greetings after the locked AI line; languages (English); suggest add-ons (Off); **Mention promotions (On)**. Add-ons and promotions apply on phone and website chat only, because the signed BAA's Meta rule bars them there. |
| **Calendar** | Connected calendar [Change] [Reconnect] [Disconnect] (step-up to change); booking system; **Auto-confirm (On)** with "Right now: …"; booking detail (Generic). |
| **Payments** | Stripe [Connect] / [Disconnect] (step-up). Take deposits (Off until connected *and* an amount is set). Deposit per service. Book by phone without a deposit (On). Book by chat without a deposit (Off). When a deposit can't be collected (Book and flag; hold 60 minutes). The **precedence rule** in its one-liners: a channel's "book without a deposit" switch decides first. The trade-off line. |
| **Safety net** | **Direct line** (F0 validation refuses loops; step-up for later changes); the urgent-help number; a read-only list of what AYA does when paused, Phone is off, the calendar disconnects, our system or a vendor fails, a payment fails, the plan is cancelled, **or the allowance runs out** (its current choice, linking to Billing); "How to undo call forwarding" (carrier codes). |
| **Alerts** | "Everything goes to {clinic address}": urgent alerts, handovers, booking requests and deposits, summaries and billing. **Daily summary (On)**, the spec's switch. Transfer live calls (Off) and number (defaults to the direct line; "applies when phone opens"). |
| **Sign-in** | The clinic's address [Change] (step-up; confirmed from the new address, and in effect 72 hours later, D5). **Devices with Face ID**: the list by name, "Add this device", Remove (step-up). **"Someone left"** (step-up): signs out every session and resets the backup (D3). |

**F3. Knowledge**
- **Your practice:** name, address, phone, website, time zone, policies.
- **Prices:** price kind, price and duration.
- **Promotions:** under the line "AYA mentions these: On · change", which links to Settings.
- **Quick answers:** flag corrections are tagged.
- **Never say:** pre-seeded with the clinical defaults, **editable**, with "Restore the defaults". The protections themselves stay in the engine's code guards.
- **Hours:** weekly plus closures.
- **"Changes on your website":** the drift confirm-or-ignore list, with ignores stored (M7).
- **When a save is refused,** the phrase is named and a rewrite offered.
- **Edits apply at once.** The practice questions re-run in the background. A failure shows "We're double-checking your change", calls `notifyOps`, and never takes AYA offline.

**F4. Conversations** (step-up)
- **Rows:** channel, time, outcome (answered / booked / request / handover / urgent), and a link to any booking it produced.
- **Search:** caller name, phone digits and words, with Today / Yesterday / This week chips and a **Flagged** filter showing whether each correction is live.
- **Transcripts:** plain text; each open is logged.
- **Flag this answer:** one click opens an ops ticket (ids and counts only; two flags in 7 days emails ops). An **optional** correction, typed by staff and screened, applies immediately; it is never copied from the transcript.
- **Export:** behind step-up, logged. A *complete* export after cancellation, once its download has reached the practice, stamps `export_delivered_at` (`markExportDelivered`): delivered, never merely produced.
- **Retention:** step-up, with a confirmation that names the count and the date. The nightly purge allows a same-day undo.

**F5. Bookings** (step-up)
- **Needs you:**
  - requests, each with "**Call {first name}**" (tel:) and Confirm / Propose / Decline, through `decideBookingRequest`'s core refactored to (clinicId, requestId), with the user and the step-up's passkey as actor;
  - each request is emailed the moment it's taken (L7), and the morning summary lists every open one (L13);
  - at expiry, "**Missed: they were told you'd call**", with one email (L9);
  - deposits to collect, open handovers, and messages left while AYA was off.
- **Booked by AYA:** with deposit status and a one-click Showed / No-show / Cancelled.
- **`/booking/[token]`** shows no patient fields and no actions. It points through sign-in and step-up to the request.

**F6. Billing.** The UI is this plan's; the actions are Package C's.
- **Plan:** plan, channels and locations.
- **Plan-start line:** before the start, "Your plan starts the day AYA first answers, and no later than {date}"; after it, the next charge (invoice preview).
- **Billing by channels in service:** "Billed at the Web Chatbot price until phone is in service. The full Web + Voice price applies from the day phone first answers."
- **Usage meters:** used against pooled included, overage in dollars, days left.
- **The three switches, together** (step-up): when the allowance runs out; usage alerts; **auto-renew**. Before the plan starts, auto-renew Off reads: "Your plan won't start, and nothing more is charged. Turn it back on any time before {date}."
- **Change plan:** shows the setup-fee difference first (step-up).
- **Add a location:** shows the price and setup fee; lands in that location's setup (step-up).
- **Stripe portal:** one configuration, for payment method and invoices.
- **Agreement:** kind and version, download. Notices under it go to the clinic's address, which the Notices clause allows the practice to change in writing; changing the address in Settings does that.
  - "We've started billing insurance electronically" starts the DPA→BAA re-sign (Part L).
- **After cancellation:** read-only until the data is destroyed (`dueForDestruction`), with the export deadline shown.

**F7. Help**
- **Chat:** Part H.
- **Voicemail:** "Leave a message; we reply the next business day. Please don't include {patient|client} details." The provider is notification-only (caller and time, no audio or transcript) and listed as a no-PHI channel.
- **Email:** hello@healdesk.io.

**F8. Look and accessibility**
- **Identity:** the healdesk.io identity, with tokens copied into apps/app; one column, mobile first.
- **Switches:** buttons with `role=switch`, `aria-checked` and `aria-describedby` for the one-liner.
- **Announcements:** a polite status region for saves; streamed replies announced once complete.
- **Targets and motion:** targets at least 24 px; reduced motion respected.

---

## Part G: Engine text core, practice questions, Talk to your AYA, go-live (apps/app)

The text core of Launch-plan steps 1.4 and 2.10. Runtime adapters build on it.

- **Client:** `lib/engine/anthropic.ts`, one client on the patient-organisation key.
  - Per-channel config: model `claude-opus-5-5`, effort, `max_tokens`, streaming.
  - `tool_choice: auto` with strict tools.
  - `refusal` is handled as its own outcome.
- **Prompt:** `prompt.ts` assembles knowledge, settings, never-say, guardrails and the **locked disclosure line**, with a cached static prefix.
- **Pre-model urgent matcher**, **keyed by specialty** (human and **veterinary** sets).
  - Catalog-fixed replies: the AI line, then "If this is an emergency, call 911 now" (voice: "hang up and call 911"), then the **urgent-help number**, then "I've told the team".
  - On web chat, a fixed "Leave a number for the clinic to call you".
  - The vet reply gives the emergency referral number.
- **Output guard:** covers the clinical defaults, prices from the list only, and each channel's treatment-name rules.
- **`recordTurn()`** is the single writer to `conversation_turns`. `transcript_uri` is retired, so no S3.
- **Channel events:**
  - `live`: setup done, runtime present, the channel's audit passed.
  - **`first_answer`**: the first inbound *patient* conversation answered on a live channel. It **excludes** Healdesk test calls, the forwarding-test window, calls from the clinic's own published or direct numbers, the preview and the practice questions.
  - **Each channel's first answer starts its price that day.**
    - The clinic's first one calls `startPlan(first_answer)` exactly once. That starts the plan and the first charge; L2 follows when the invoice is paid.
    - Each later channel's first one calls `stepUpPackage`, prorated onto the next invoice, which sends L3.
- **Practice questions:** the spec's nine cases, **templated from the clinic profile** (no LLM writes cases).
  - **Deterministic checks:** the exact listed price and no other dollar figure; the consultation offer; the matcher fires; the disclosure; dry booking and deposit tool calls with the right arguments.
  - An Opus judge only for the clinical, hostile, unknown and language cases. A judge failure goes to the **review queue**.
  - Vet cases for vets.
  - Results are kept per channel and per audit-input version (knowledge plus the settings the cases read).
  - Re-runs are debounced to 2 minutes, one at a time.
  - They **gate only a clinic's first go-live, or a new channel's**, never a live channel.
- **Talk to your AYA:** the clinic's sign-in. The same engine with **dry tools** (real availability when a calendar is connected, nothing held or written). Banner: "Preview: nothing here reaches patients, and nothing is booked." Rate-limited, not stored.
- **Automatic go-live.** The audit-pass event fires `app_mark_clinic_production` once these hold:
  - the agreement is sufficient for the practice (Part L);
  - the covered status is determined;
  - `platform_compliance` is attested;
  - Gate B is met.

  It switches retention-purge on. No operator step.

---

## Part H: Support chat (apps/app)

- **Stores nothing.** The browser holds the conversation.
- **Same engine module;** the help text is markdown in the repo, partly generated from the switch registry, and cached.
- **Tools** (read-only, no patient data):
  - `get_account_state`
  - `get_forwarding_steps` (returns nothing until voice is ready)
  - `link_to(setting)`
  - `escalate_to_support(category, fields)`
- **Guards:**
  - the permanent line "This is product support. Please don't paste {patient|client} information";
  - an identifier screen (the clinic's own numbers and the user's own email pass);
  - **treatment names replaced visibly before the model sees them** ("we hide treatment names here"), the literal reading of spec line 688.
- **Escalation email to hello@:** the category, its structured fields (e.g. carrier, mode, a symptom picked from a list), **the `get_account_state` output**, and reply-to. Never chat text.
- **Limits:** per clinic and per device. A refusal shows a fixed line with the phone and email.

---

## Part I: Emails and ops alerting

Every email, before, during and after purchase, plus every ops alert, is specified once, in **Annex X: Email automation (Resend), end to end**, at the end of this plan.

Part I's job is ownership. This plan builds the email platform (X1–X4) and every non-billing message. Package C builds the billing messages on the same platform and templates, through F0's `billing_notices` outbox, which the annex extends.

---

## Part J: Data model (after `0043_stripe_launch`; each table lands in the milestone that first uses it)

**Rules:**
- Generated with drizzle-kit at merge time from a fresh origin/main; every journal `when` later than all earlier entries; never renumbered by hand.
- **No enum growth:** text with CHECKs.
- New tenant tables: FORCE RLS, `TENANT_SCOPED_TABLES`, column grants, append-only REVOKEs, and the BAA gate on PHI tables.
- **Every `clinic_id` table** is in the offboarding destroy list and the purge, or in a reasoned keep-list, with a catalog comparison test.
- Jobs are seeded OFF, each with a named owner and the point at which it is switched on.

**Changes:**
- **`checkout_intents`** (F0): payload fields, plus columns for profile and read status, `invite_ref` (unique), attempt and open session, nonce hash.
- **`clinic_settings`** (F0) gains: tone, greetings, languages, add-ons, promotions, auto_confirm, booking_detail, booking_system, google_account_type, urgent-help number, vet emergency referral number, transfer, daily summary, **`coverage_mode`**, `transcript_retention_days`, **`ai_paused_until`**. No recipient columns: every email goes to the clinic's address, the email of its one user.
- **Email (Annex X):**
  - `billing_notices` (F0) keeps its name and becomes the single outbox; its kinds CHECK widens from the kind registry;
  - `report_deliveries` keeps its name and becomes the ledger, gaining `delivery_status` and `delivery_at`;
  - `report_recipients` is no longer read: the weekly recap moves to the clinic's address;
  - outbox and ledger go on the offboarding **keep-list**: they hold no PHI and are the record of every notice sent.
- **New:**
  - `clinic_settings_history`
  - **`clinic_channels`** (with `published_opening_on`) and **`channel_events`**: live, first_answer, pause windows, setup states with `waiting_on`, and the evidence for §3 and the guarantee
  - `patient_requests` (PHI, BAA gate): a patient's request to healdesk about a practice, recorded by the operator from a trusted shell, shown on Home behind step-up (L32)
  - `incidents` (ops-only): each logged incident, its BAA deadline, and ops' decision (report sent, or not reportable with a reason)
  - `clinic_closures`
  - `clinic_providers` (only if the scope is approved)
  - `user_factors` and passkey credentials, each passkey named for its device
  - **`conversation_turns`** (PHI, BAA gate)
  - `conversation_flags` (BAA gate)
  - `audit_review_queue`
  - **`platform_compliance`** (ops-only, TOTP-attested: Anthropic, database, AWS; Retell for phone; plus Gate B readiness flags)
- **Existing tables extended:**
  - appointments: listed-price and price-kind snapshot, written by 1.5;
  - entitlements: `plan_started_at`, `bought_plan_id`, `plan_start_backstop_at`, `stripe_schedule_id`;
  - knowledge: price kind and `depositUsd` on services; promotions, quick answers and never-say.
- **Agreements:** see Part L.
- **Go-live:** `app_mark_clinic_production` and `goLivePreconditions` are rewritten together. Voice-only, operator-stamped steps are removed, and the conditions follow G and L.
- **Overview function:** `app_clinics_overview` is recreated for the new columns, with `ops.test.ts` and `database-audit.test.ts` updated.
- **Voice number:** a vendor-neutral `aya_number_e164` behind one accessor that returns null until voice is ready. The Synthflow voice webhook refuses non-synthetic clinics.

---

## Part K: Operator console (apps/web /admin; projections only)

**Kept or added:**
- Pilot invites (mint, progress, Google count)
- `changeClinicEmail` (TOTP; D5)
- **Incidents** (new page): log an incident, see the BAA's reporting deadline (5 calendar days for a breach, 5 business days for a security incident), and decide. **Send report** sends L29 from fixed fields; **Not reportable** records the reason. Nothing reaches a clinic unless ops sends it.
- Platform-compliance attestation
- Site-read failures
- The audit review queue
- `setCoveredEntity` (BAA path; refuses vets; on a DPA clinic it starts the supersede flow)
- Clinic cards: channel states, the tracker, the agreement-kind label
- Health flags keyed on `first_live_at`: 48 hours of zero interactions, 14 days of zero inbound calls. They stay internal, as the spec says; they reach ops through `notifyOps`, not the clinic.
- Operator actions that send a clinic email:
  - move an opening date (O12);
  - terms and agreement notices (L28, L29);
  - guarantee claim received and finding (L30);
  - a suspension for a legal or security reason (L31).

**Changed:** the onboarding page is trimmed (no Synthflow-number entry, no two-mode routing).

**Elsewhere:** escalations and flags arrive by email. E's billing panel is Package C's.

---

## Part L: Data Protection Agreement (non-HIPAA practices)

**Selection.** `agreementKindFor` in the catalog, called by AgreementStep, `validateSignRequest`, intents, provisioning and the go-live function:
- **`hipaa` regime:** BAA always.
- **`hipaa-if-covered`:** Yes or Not sure → BAA. No → **DPA**.
- **`non-hipaa` (vets):** DPA, with no covered-entity question and `isCoveredEntity` false.
- **Release flag:** read inside the function. While the DPA is unreleased, the "No" branch falls back to the BAA and vets are refused.
- **Its one existing caller,** a leadgen test, is updated with it.

**The document.** "healdesk Data Protection Agreement", versioned `dpa/1.0.0`, mirroring 1.2.1's order and facts. Clauses:
- definitions ("Client Information")
- **one status clause**: animals outside HIPAA; or a warranted non-covered practice that must notify, upon which AYA pauses until the BAA is signed
- instructions; permitted uses
- the **shared state-law processor clause** and the **Payments clause**, both constants shared with the calendar session's next BAA
- data sources
- **one calendar clause** from the calendar selector
- safeguards: the same as under HIPAA
- minimum and disclosure, by category
- subprocessors (**24 hours' notice** by email before a new one that handles client data, with the right to object; Anthropic's 30-day retention, *annotated 19 October 2026: no more than 30 days under standard retention, two years for flagged content alone, law-required content for as long as the law requires, as the DPA now says; agreement-changes.md § 16*); incidents (5 days); requests; confidentiality (plus a vet paragraph); prohibited; assistance and audit
- term, written from the **real** offboarding clock (or the code changes first; the same gap is flagged for the next BAA)
- liability; notices and law (Delaware)

Every sentence must be true on the day it's signed.

**Customisable** means validated answers only: legal name, signatory, date, specialty (with a legal descriptor), platform, booking system and Google type. Plan, channels, retention and state are deliberately not variables.

**Engine.**
- The kind-neutral renderer is shared, or the DPA gets a parallel assembler. Either way **no BAA golden hash moves**.
- `docs/dpa-v1.0.0.txt` holds one full sample plus every alternative clause.

**Storage.**
- **`baa_acceptances.agreement_kind`** is a STORED generated column, from the namespaced version.
- **`clinics.regulatory_regime`** and **`clinics.agreement_kind`** are gate columns the runtime role cannot update.
- **`app_agreement_kind_sufficient`** gets a TypeScript mirror and a parity test.
- It is used by `app_mark_clinic_production`, **`app_clinic_accepts_phi`** (a DPA clinic whose covered status flips refuses PHI writes) and `goLivePreconditions`.
- **`app_supersede_agreement`** handles DPA→BAA, and re-acceptance of a superseded BAA. Never BAA→DPA. The re-sign screen reuses AgreementStep through a signed one-time link.

**Hand-offs.**
- Intents and provisioning require every document input to match.
- Provisioning checks the **bound row's own template** release, not "the current BAA".
- `/api/agreement` sits under the pilot switch.

**Copy.**
- `AGREEMENT_COPY[kind]`, `DPA_EXPLAINER` and assent labels per kind. **BAA_EXPLAINER never appears beside a DPA.**
- **`audienceFor(specialty)`:** "client(s)" for vets everywhere, from the funnel to the support chat.
- **Client data is controlled exactly as PHI on every path.**

**Vet readiness (the chip's gate).**
- The veterinary urgent set and its fixed reply.
- The emergency referral number (wizard 2.5).
- Vet practice cases.
- Client wording.
- Decide the "animal's name and species" field **before** releasing the DPA.

**Misclassification signal.** A DPA "No" practice whose site says it accepts insurance goes to the review queue.

**Counsel.** The DPA questions go into the existing `docs/counsel/brief.md` risk rows (3, 5, 6, 10) with triggers (the first WA/NV/CT DPA practice, the first California vet). It is recorded as *narrowing* the 1 Oct §9 decision.

**Release: at launch, with everything else.** The DPA is built across M2–M4 alongside the BAA path; none of it is a later phase. Its launch-checklist items (Gate A):
- your release of `docs/dpa-v1.0.0.txt` (the same flag the BAA uses);
- vet readiness: the veterinary urgent set, the referral number, vet practice cases, client wording;
- the supersede function, for the "No" branch.

Until you flip the flag, staging and tests use it like any unreleased template.

---

## Gates (fail-closed)

| Gate | Opens when |
|---|---|
| **Invites (Gate A)** | All of these: M1–M4 on main; **the DPA released by you, with vet readiness** (Part L); **the email launch set** (Annex X9: X7 done, X8 passed); app.healdesk.io with its worker and database live (Launch-plan steps 1.2, 0.10); `platform_compliance` (Anthropic, database, AWS); Package C's plan start, reminders and billing notices on main; ops alerting and an uptime check that reads `/api/health`; `CHANNEL_OPENING` dates set; the jobs that pre-live clinics need switched on; the production Google client In production. |
| **Public checkout** | Gate A, plus Google verification. |
| **A channel goes live (Gate B)** | **M5 and M6 on main** (step-up, Conversations, Bookings, alerts; the go-live events and the plan-start hooks), with Annex X9's live set; that channel's runtime; its practice questions passed; a sufficient agreement; compliance attested; Package B's answer gate; the routed/answered counter and miss notice. **Phone also needs:** Retell, the direct line, and the pass-through test ("calls reach your direct line when AYA is off"). |
| **AYA number and forwarding codes shown** | Voice is ready for that clinic. |
| **Plan starts** | The day of `first_answer` (L2 that day), or on the backstop date (Stripe enforces it through the schedule; L5 goes seven days ahead as a courtesy). `extendPlanStart` moves the backstop while the delay is ours: automatically when no channel is ready on our side, or by ops. |
| **DPA signing** | With launch (Gate A): your release flag, vet readiness, and the supersede function. |

---

## Build order (by outcome, each with a done-when)

**Rules:**
- A fresh worktree from origin/main, with its own test database.
- Commits with explicit paths and prose messages that say why.
- Before each push: CI's exact steps, then merge origin/main, then push to `main` and `claude/epic-babbage-n9g119`.
- For apps/web changes, check the GitHub Production deployment and curl.
- **Every link or call a milestone ships must work the day it ships.**

| # | Milestone | Done when |
|---|---|---|
| **P0** (others) | HeroOrbit commit with the subtitle removal. | Hero session reports done |
| **M0** Contracts | **First: publish your open-items page** ("healdesk launch: your open items"; see Open items). Spec edits approved and re-exported; CLAUDE.md portal section; the **design-doc header records** that A1, A2 and E-portal are superseded and B, C and D are built to these contracts; the env inventory; contracts acknowledged by the Stripe and calendar sessions; **the calendar-list scope decided before step 1.7 submits (due 6 Oct)**; `CHANNEL_OPENING` dates and Meta's date set by you. | Both sessions acknowledge |
| **M1** Pilot gate | A2. "Get AYA" follows separately, after P0. | Production with the mode unset shows the pilot form, and `/api/checkout` refuses missing, forged, expired and used invites |
| **M2** Buy → signed in | Catalog registries (opening, status words, plan-start sentence, booking systems, Google types, price kinds, audience, claims); agreement selection with **both kinds**, BAA and DPA (no BAA golden moves), plus the supersede function; the email platform and sender (Annex X1–X4, replacing F0's stubs); the funnel UI; the site read; the intents extension; the deferred-start Checkout ($0 monthly line, no trial) and terms; the provisioning cutover (after M1 has been in Production at least 24 hours); `/welcome`; sign-in, factors (enrol first), "I can't get in"; headers; the KMS/SES production-build fix. | A 4242 purchase on a phone lands signed in within 90 s; a factor is enrolled; replays create nothing; cancel and re-pay works; a sign-in link (B2) signs in |
| **M3** Setup and the non-PHI portal | Wizard, tracker, Home, Settings (effect tests; Sign-in and devices), Knowledge, Billing UI, Help, the welcome (B1) and the onboarding emails, `notifyOps` and the digest, and the /admin invites, attestation and failures views. | A non-builder finishes setup on an iPhone and an Android phone in under 15 minutes |
| **M4** Engine core | G: engine core, practice questions (including the vet cases), review queue, Talk to your AYA, the veterinary urgent set. | A test clinic's preview quotes its own prices; a deliberately wrong price fails the practice questions → **Gate A can open** |
| **M5** PHI readiness | Step-up enforcement; Conversations; Bookings (Needs you, reminders, Missed); the `/booking/[token]` pointer; the alert emails (L7–L12, L20); patient requests (L32); the /admin incidents page; `conversation_turns` and `recordTurn`; purge and offboarding coverage. | The security tests pass (part of Gate B) |
| **M6** Go-live and billing | The `live` and `first_answer` events; automatic go-live; the `startPlan` and `stepUpPackage` hooks; pause; the claims function; the live and post-cancellation emails (Annex X9); health flags. | On staging, the first answered conversation starts the plan and charges the first month exactly once, with L2 sent; each later channel's first answer steps the price up exactly once, with L3 sent |
| **M7** The rest | Support chat; the **drift list** (before the first clinic's 30th live day); L23, L25 and L33. | — |
| **Public mode** | Abandonment and resume, Postgres-backed limiters, duplicate-subscription auto-refund. | Gate A plus Google verification |

---

## Verification

**Before every push, CI's exact steps against the worktree's own database:**
1. `db:migrate` plus a fresh migrate from zero.
2. `npm test` in every workspace, with `TEST_APP_URL` set, checking the passed count (at least 200 app tests).
3. `tsc` for all four workspaces, then `npm run build`.

**Security tests:**
- a link-only session can't add a device after go-live without a passkey step-up from an existing device or the human route, or remove one; the billing check only ever sends a sign-in link; wrong codes lock;
- "Someone left" ends every session and resets the backup;
- step-up expires when idle;
- the access log names the device's passkey on every transcript open;
- `/booking/[token]` shows no PHI;
- clinic isolation through grants;
- sign-in sends only to a clinic's address;
- setup-link single use;
- the hand-off: a cookie or `cs` mismatch, expiry;
- the SSRF guard: rebinding, IPv6 and mapped ranges, redirects, size;
- headers;
- CSV injection;
- support identifiers, and escalations carrying no free text;
- the offboarding and purge catalog test.

**Flow tests:**
- provisioning races;
- re-pay after a cancel (the old session expired);
- the $0 monthly line does not trip `recordFirstInvoice` or any email;
- no subscription is ever `trialing`, and no charge carries "TRIAL OVER";
- `first_answer` excludes tests and own numbers;
- the plan starts once, the day of the first answer, or on the backstop that Stripe enforces;
- step-up pricing: no setup fee charged again, metered rates kept at the bought package's;
- the refund-rule alerts;
- the tracker unlocks the preview;
- a re-run on a knowledge change never takes AYA offline;
- refusal handling;
- every switch's effect.

**Agreements:**
- `agreementKindFor` across every combination;
- the TypeScript and SQL parity test;
- the DPA goldens per variant;
- the BAA goldens unchanged, and a pinned BAA PDF digest;
- the AgreementStep reset;
- the "with every clinic" grep and the "Data Agreement" grep;
- the vet render test, which never says "patient" for people.

**Accessibility:** axe per screen, one keyboard and VoiceOver pass, contrast on Pay.

**Local end to end:**
1. `npm run db:up -w @healdesk/app`, migrate, `npm run queue:install -w @healdesk/app`.
2. Start the worker, apps/app on :3001 and apps/web on :3000.
3. `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, with the console email transport.
4. Walk it: setup link → buy (4242) → `/welcome` → Face ID (virtual authenticator) → setup → tracker → preview → Settings (add a second device) → Bookings → support chat → sign out and back in by link → cancel and re-pay.

**Real devices:** iPhone and Android: the sheet, the BAA scroll, Apple Pay, links from Apple Mail and the Gmail app, Face ID, pausing from the header.

---

## Spec-doc edits (M0: source doc, then re-export) and repo docs

1. **Portal map:** six screens. Settings holds the Channels, Behaviour and Escalation switches in cards. Billing keeps its three switches. Pause sits in every header.
2. **Account access:**
   - **one email address per clinic** (a shared inbox is fine): the sign-in, the billing address, the agreement's notice address and every notification;
   - **one shared sign-in**; the spec's three roles are deferred past v1;
   - no password;
   - a passkey per device plus an authenticator backup, enrolled first after payment, gating Conversations and Bookings;
   - the 14-day session and the 15-minute step-up;
   - the billing-details self-check before the human route;
   - step-up for where calls and money go (beyond spec line 496).
3. **Support:** the voicemail line (notification-only); the chat stores nothing.
4. **Escalation:** email only, to the clinic's address. The urgent fixed reply is 911 plus the urgent-help number. Dunning also goes to the clinic's address, which replaces the spec's "never the public inbox" (your decision, 6 Oct).
5. **Pause AI:** labelled "AYA is answering"; durations; banner.
6. **Retention:** the clinic can shorten it; records 90 days.
7. **Stage 0:** the website is read from the funnel; one location per purchase; extra locations from Billing at the package price plus setup fee, with pooled allowances; the location picked in 1.1.
8. **Stage 1 and Commercial:**
   - setup fee at purchase;
   - monthly billing starts the day AYA first answers, no later than purchase plus a fixed term, built without a trial (a $0 monthly line until then);
   - billing by channels in service, each channel's price applying from its first answer;
   - 24 hours' notice before a new subprocessor that handles PHI;
   - the setup-fee refund 30 days after the published opening; the Meta switch-or-refund;
   - §4 and §5 anchored to the plan start.
9. **Launch:**
   - the pilot switch, internal only, with no newness language anywhere client-facing;
   - **no timing before purchase**: opening dates appear in the dashboard only;
   - the set-up promise describes the step, not the time, until each channel's runtime ships.
10. **Onboarding:** the build tracker and Talk to your AYA; phone shows no number until voice is ready; the covered-entity screen; the forwarding screen as specified.
11. **Who is what:** the DPA for practices HIPAA doesn't cover. Vets are sold only with the vet urgent set and referral number. "Not sure" signs the BAA.
12. **Daily summary:** sent at the start of each working day, listing every booking and booking request with its link, plus every request still open; the quiet-day line only when unusual. The week's first summary carries the weekly recap.
13. **Email:** Annex X's rules in one paragraph. Every email can be replied to, health flags stay internal, booking requests go out the moment they're made, and incident reports go only when ops sends them.

**Repo:**
- **CLAUDE.md:** the portal section (six screens, links, per-device factors, one sign-in per clinic); "client data of a DPA practice is controlled exactly as PHI"; the DPA claim form; the email rules (pointers only, one Resend account, the outbox).
- `docs/hipaa-compliance.md`: "Practices outside HIPAA". The pointer-alert decision is recorded where §120 still calls it "a decision still to make".
- `apps/web/src/lib/subprocessors.ts`: the voicemail provider (no PHI).
- `docs/counsel/dpa.md`.
- **The design-doc header:** the supersession note.
- **Unchanged from the spec:** the never-say list stays editable; the allowance switch stays on Billing; Mention promotions stays in Settings.

## Open items for you (published as a page, step 1 after approval)

**The page:**
- **Title:** "healdesk launch: your open items".
- **Layout:** grouped by when each item is needed. Each item is one plain-English line with a status (To do · Decided · Done) and the date it's needed by, plus a **dropdown, closed by default**. The dropdown holds:
  - why it matters;
  - the options;
  - my recommendation;
  - what happens if it waits.
- **Statuses** are saved in the page's own database, so you can tick items off as you go, and I can read your answers while I build.
- **Stripe tasks:** a link at the top points to "Stripe launch: your steps" for the Stripe setup tasks, so nothing is listed twice.

Plan mode can't publish anything, which is why the page is the first step after you approve.

**Needed now (before building starts)**
1. **Google's calendar-list permission: include it in today's submission (6 Oct)?**
   - It lets AYA book against named providers; without it, bookings go into one shared calendar.
   - Adding it later means another Google review.
   - Recommendation: include it.
2. **Each channel's opening date, and Meta's switch-or-refund date.**
   - Shown only in the dashboard, never before purchase.
   - The setup-fee refund clock runs from them.
3. **The latest plan-start date.**
   - Billing starts the day AYA first answers, and no later than purchase plus this term.
   - Recommendation: 60 days. We extend it automatically while the delay is ours.
4. **Confirm the price step-up rule.**
   - A channel's price joins the day it first answers.
   - Once your plan has started, a channel ready on our side but waiting on you (forwarding not set, snippet not pasted) joins 30 days after it became ready, with a week's notice.
5. **The "Launching with Instagram, Messenger and WhatsApp" bar above the hero.**
   - Keep it, or reword it so nothing signals that we're new.

**Needed before the first setup link goes out (launch gate)**
6. **Release the Data Protection Agreement.**
   - Read `docs/dpa-v1.0.0.txt` and flip its release flag.
   - First, decide whether vets' bookings may record the animal's name and species.
7. **The support voicemail line:** pick a provider that emails a notification only (caller and time, no recording), and a number.
8. **The five-minute call:** a scheduling link (for example, Calendly or Google appointment slots) for clinics setting up call forwarding.
9. **Stripe:**
   - automatic sales tax, yes or no;
   - the statement descriptor clinics see on their card;
   - at launch, switch off Stripe's own customer emails (our emails replace them), with screenshots.
10. **Resend:**
    - verify healdesk.io for sending (DNS records);
    - one sending key for the website and one for the app;
    - start on the free plan, which allows 100 emails a day, and move to Pro ($20 a month) before about 15 clinics are live. The ops digest warns at 70 a day.
11. **The US mailing address in email footers:** confirm it's a USPS-registered private mailbox (Form 1583), which the CAN-SPAM Act accepts.
12. **Counsel's risk rows** (none blocks the build):
    - the DPA's clauses;
    - the plan-start and refund terms;
    - the covered-entity notice;
    - the calendar-variant BAA;
    - **24 hours' notice before a new subprocessor**, which is shorter than the usual 15 to 30 days and so weakens the clinic's right to object.

**Optional, any time**
13. **Ask Stripe support to confirm in writing** that the deferred start (a $0 monthly line until AYA first answers) isn't treated as a trial. Visa's own bulletin already says the trial rules don't apply.
14. **Tighten DMARC on healdesk.io** from "none" to "quarantine" once its reports show only Resend and your own mail sending as healdesk.io. This stops others impersonating hello@.

---

## Annex X: Email automation (Resend), end to end

### X0. Scope

- **Covers** every email healdesk sends:
  - prospects, before purchase;
  - clinics, during, at **the clinic's one address**;
  - former customers, after;
  - people a clinic asks us to email (its web person, its office manager);
  - our own team.
- **Never an automated email to a patient.** v1 contacts no patient on any channel. The BAA has one duty that runs the other way: if a patient ever writes to healdesk about a practice, we pass the request on within five business days and tell the patient we have. Ops does that by hand (L32), never through automation.
- **Two senders, one rulebook.** apps/web sends to people with no account yet. apps/app sends everything about an account.
- **Audited** on 5 October 2026 through three lenses (lifecycle and experience; compliance, privacy and abuse; Resend and infrastructure), then revised to your 6 October decisions.

### X1. Rules every email follows

1. **No patient or client information anywhere in the message.** That covers subject, body, headers, tags, idempotency keys and file names.
   - Patient-related mail is a **pointer**: what kind of thing needs attention, at which clinic, and a link into the portal behind sign-in and step-up.
   - Aggregate counts are allowed. Times, names, numbers, services and any text from a conversation are not.
   - Resend has no BAA: its site says "HIPAA is in progress", and its enterprise terms allow PHI only under a BAA we don't have. It is listed on /subprocessors as receiving no patient information.
   - Templates validate against a **payload allowlist** (X4), not `assertNoPhiInReport`, which would reject masked addresses and the clinic's own numbers.
2. **No treatment names,** even beside a count or in a Knowledge item: "2 bookings", "1 price in Knowledge → Prices". Never the service.
3. **One job, one next action, an exact time.**
   - Calm and confident, with no newness words.
   - Never "we'll be in touch" or "within one business day" without the date: "We'll reply by Tuesday 7 October."
   - Claims come only from the shared claims function, and `audienceFor` decides patients or clients.
   - A transactional email carries no promotion.
4. **Sent after commit, once per recipient.** State is written first (outbox row, ledger row, link row or Sheet row).
   - Resend's `Idempotency-Key` is `hd-<kind>-<row id>-<recipient n>`, with `-<attempt>` added on link emails, and never an address. One row can send several emails (P2 and P3 share a setup request; O5 goes to two addresses), so the kind and recipient number keep each key unique.
   - Bodies render only from the stored payload, so a retry within Resend's 24-hour window repeats the request exactly. A `409 invalid_idempotent_request` is recorded as sent.
5. **Tokens are minted at send time and never stored.** Link emails (B1, B2, O5's confirmation, O6, O7, L22 and its reminders) carry a fresh single-use link; a retry mints a new link under a new key. P4, P5 and P7 carry the setup link minted in /admin. Every other email links to a page, which asks the reader to sign in.
6. **Links go only to public origins,** over https, in bodies and headers: `publicUrl()` on apps/app, `site.url` on apps/web. Never `HEALDESK_APP_URL`.
7. **Tracking is off** (opens and clicks), checked through Resend's API at launch. Click tracking would send tokens through a redirect host.
8. **Plain text first,** with a light HTML twin built from the same blocks: one column, system fonts, no images, no remote content, under 100 KB (Gmail clips at 102 KB). *(1 November 2026: every email now wears healdesk's branded shell, and the logo is the one image fetched, at one fixed public URL; see `docs/design/email-branding-2026-11-01.md`.)*
9. **Every email can be replied to,** and replies reach hello@healdesk.io. The footer carries:
   - the sender identity, as on the site: "healdesk is a service of Viixi FZC" and the US mailing address for correspondence;
   - why the recipient gets the email;
   - "Replies reach the healdesk team. Please leave out patient details", so hello@ stays free of them;
   - where the email is optional or commercial, the one-click way to stop it.
10. **CAN-SPAM class is declared per kind** in the registry. There is no business-to-business exemption.
    - Commercial kinds (P1, P4, P5, P7) carry `List-Unsubscribe` and `List-Unsubscribe-Post`, a footer opt-out and the postal address. A test enforces this, and opt-outs take effect at once.
    - The link in the body opens a confirmation page whose button posts the unsubscribe, so link scanners can't unsubscribe anyone. Today's route unsubscribes on GET.

### X2. One Resend account, two addresses

**One Resend account, with healdesk.io verified.** The email address tells the two streams apart, as you asked.

| Stream | From | Replies go to | Sent by | Carries |
|---|---|---|---|---|
| **Product** | `healdesk <hello@healdesk.io>` | hello@healdesk.io | apps/app | Everything to a clinic: welcome, sign-in links, setup, go-live, alerts, booking requests, summaries, billing, receipts, Terms and agreement notices, product updates. Also P6 and our own ops alerts |
| **Marketing** | `healdesk <noreply@healdesk.io>` | hello@healdesk.io, because nurture invites replies | apps/web | Nurture, and every other email before purchase |

- **hello@ stays the one inbox.** legal@ and privacy@ stay as published, because the Terms and the signed BAA name them, and they already forward to the same inbox. *(Superseded by the owner on 9 October 2026: hello@healdesk.io is the only address, and no client-facing copy names legal@ or privacy@. BAA 1.2.2 names hello@ as its notice address; docs/counsel/agreement-changes.md § 13.)*
- **Free plan to start.** It allows 3,000 emails a month and **100 a day**. Past the daily cap, every email fails until midnight UTC (8 pm Eastern), sign-in links and urgent alerts included.
  - The count comes from Resend's `x-resend-daily-quota` response header, which covers both apps. The ops digest shows it, and `notifyOps` fires at 70.
  - A `daily_quota_exceeded` 429 waits until 00:05 UTC without spending a retry.
  - Move to Pro ($20 a month: 50,000 a month, no daily cap) before about 15 clinics are live, at roughly 5 emails a clinic a day.
- **What the two streams share in one account,** and how each risk is handled:
  - **the daily cap:** the alarm above;
  - **one suppression list:** a prospect who marked nurture as spam is suppressed for product mail too. A product email to a suppressed address raises `notifyOps`, so ops can lift it in Resend's dashboard, and Home shows "We can't email {address}";
  - **one spam-rate pause and one domain reputation:** marketing goes only to people who ticked the consent box, carries one-click unsubscribe, and is low volume.
- **Keys:** one sending-access key for apps/web and one for apps/app, both restricted to healdesk.io. No full-access key on any server, and two-factor sign-in on the Resend account.
- **TLS:** Resend's enforced TLS is on for healdesk.io, so no email is delivered in cleartext. The stale "no TLS-REQUIRE equivalent" comment in `deliver.ts` is corrected.
- **DNS:** SPF and the bounce MX on Resend's `send.healdesk.io`, plus DKIM. Inbound mail is untouched; Cloudflare keeps routing healdesk.io's own MX. DMARC stays at `p=none` until its reports show only Resend and your own mail sending as healdesk.io (open item 14).
- **Cold outreach** (`packages/leadgen`) stays on its own domains. When it is deployed, it checks the Sheet's unsubscribes before any send.

### X3. The platform

**apps/app**
- **`lib/email/send.ts`:** `sendEmail()` uses `ResendTransport` when `HEALDESK_EMAIL_TRANSPORT=resend`, and otherwise `ConsoleTransport`, which is refused in production. It still refuses anything not classed "none"; `getTransport` stays for a future PHI path.
  - `OutgoingEmail` gains optional `from`, `replyTo`, `headers`, `tags` and `idempotencyKey`.
  - The tags are `app`, `clinic` and `delivery` (row ids) and `kind`. Never an address. One account's webhook sees both apps' mail, so each app acts only on its own `app` tag.
- **One outbox: F0's `billing_notices`, name kept.**
  - Why keep the name: renaming would ripple through 0043's policies, grants and tests, drizzle-kit asks about renames interactively, and Package C builds against the name.
  - Its kinds widen from a **kind registry** in code that declares, per kind: CAN-SPAM class, priority (critical or normal), optional switch, quiet-hours rule and owner. No columns are added.
  - **This plan replaces F0's sender stubs in M2.** Package C supplies its kinds, payloads and templates, as recorded in the design doc in M0. F0's `welcome_resend` kind leaves the CHECK, because a welcome resend is a link email.
  - **Kinds without a clinic** (P6, B2, B3, O6, I1, I2) keep their state on their own row (acceptance, link, intent, ops log) and use that row's id as the key. They carry no `clinic` tag. The webhook logs their bounces, and a bounce, complaint or suppression on B2, B3 or O6 also fires `notifyOps`, because a sign-in that can't arrive locks the clinic out.
- **One ledger: `report_deliveries`, name kept.** Its unique (clinic, kind, period key, recipient) is already the key it needs.
  - It gains `delivery_status` and `delivery_at`, written by the webhook.
  - A row claimed but never sent is retried, not skipped (`recipients.ts` skips it today).
- **Sending:**
  - **One function delivers a notice.** Critical kinds and link emails call it in-process right after commit: `after()` in route handlers, a plain promise in the voice process.
  - **Everything else, and every retry,** runs from a pg-boss schedule (`* * * * *`) on a new `notices` queue, which replaces the hourly call. The `billing-notices` job row stays as its on/off switch.
  - Each row is claimed by a conditional update of `send_after` (a two-minute lease), not `runJob`'s 60-minute lock.
  - **Retries** run at 1, 5, 30, 120 and 360 minutes. 429s, 5xx errors and timeouts retry with the same key; other 4xx errors fail at once.
  - **A critical notice still unsent after ten minutes** turns `/api/health` red for the uptime check and calls `notifyOps`, so a mail outage can't hide behind a mail alert.
- **One recipient: the clinic's address**, read at send time from the clinic's one user. It is also the Stripe customer's email (Terms §18) and the agreement's notice address, and the three change together (D5). Every clinic email goes there, unless a catalogue row names someone else (prospects, the person steps are sent on to, ops).
- **Webhook: one endpoint,** the existing apps/web route. Resend's free plan doesn't document a second one.
  - It is verified from the `svix-*` headers, falling back to `webhook-*`. Today's verifier reads only `webhook-*`, so real Resend events may be failing now; the fix ships in M1.
  - It handles `app=web` events itself. It relays `app=app` events to apps/app as a signed ops request (`emailEvent`): the established apps/web → apps/app pattern, carrying no PHI.
  - apps/app opens the tenant from the `clinic` tag and updates the `delivery` row.
  - Only a permanent bounce, a complaint or `email.suppressed` marks the address undeliverable. With one address there is no one else to email, so Home shows "We can't email {address}: check it in Settings → Sign-in", and `notifyOps` fires so ops can call the clinic.
  - There is no separate suppression table: an address is undeliverable while its latest ledger row says so, and Resend's own list enforces it.
- **Optional email:**
  - the daily summary (the spec's switch), also turned off by its one-click `List-Unsubscribe`;
  - usage alerts (the spec's switch);
  - product updates (one-click opt-out).
  - Everything else is part of the service.
- **Quiet hours:** reminders and other non-urgent kinds wait for 07:00–20:00 in the clinic's time zone. Alerts (urgent, booking requests, handovers, deposits, website messages), billing and link emails go **at once, at any hour**.
- **Designed merges, not a generic mechanism:**
  - one setup reminder per clinic, naming each channel's single action;
  - no separate receipt for an invoice paid inside an event that has its own email (B1, L2, L3, plan changed, location added, restored, overage invoiced); that email links Stripe's hosted receipt, with the cancel link. Every other paid invoice gets its own receipt;
  - the week's first summary (Monday, or that week's first working day) carries the weekly recap, so no separate weekly email goes while the daily summary is on.

**apps/web**
- `send()` gains the `Idempotency-Key`, the `kind` tag and attachments, which the review email needs. Contact, review and setup-request mail moves onto it; today two routes call Resend by hand.
- The Sheet stays the state for leads, setup requests and setup links. Its webhook keeps handling marketing bounces and complaints for `app=web` mail, with the Svix header fix.
- The nurture cron moves from 05:07 UTC (1 a.m. Eastern) to 14:07 UTC.
- **Abuse limits:** the acknowledgements (P2, P8) go once per address per day, never echo a submitted field, and sit behind the existing per-IP limits.

### X4. Templates and tests

- **Templates:** `lib/email/templates/{kind}.ts`, each a pure `(payload, ctx) → { subject, preheader, text, html }`.
  - Payload types allow only listed fields: ids, counts, cents, ISO dates, plan and channel names, the clinic's name, masked addresses, the clinic's own numbers and public URLs.
- **Tests:**
  - a snapshot per kind and per audience (patients, clients);
  - a payload lint that fails on any field outside the allowlist;
  - a link scanner over bodies and headers: https only, public origins only, never `HEALDESK_APP_URL`, tokens only in link emails;
  - a copy lint that fails on any of these:
    - newness words;
    - "revenue", "HIPAA compliant", "live in two minutes", "with every clinic";
    - "collected" except in "deposits collected";
    - "within one business day";
    - timing before purchase, and any opening date in any email (`published_opening_on` never enters a payload);
    - any treatment name from the catalog;
  - subjects of at most 70 characters, with no links;
  - CAN-SPAM: every commercial kind has `List-Unsubscribe`, the opt-out and the postal address;
  - a registry test: every kind has a template, an owner and a milestone.
- **Previews:** the committed snapshots, plus `npm run email:seed -w @healdesk/app -- --to <addresses>`, which renders every kind from fixtures and sends them to the test inboxes given.

### X5. The catalogue

**Before purchase (apps/web, except P6)**

| # | Email | Sent when | To | Ships |
|---|---|---|---|---|
| P1 | Nurture 1–4 | 24, 72, 120 and 192 hours after the demo's consent box; stops once a setup request or a purchase is recorded | The lead | M1 (copy fixed, X6) |
| P2 | "We've got your request" | Setup request submitted | Requester | M1 |
| P3 | New setup request | Same | hello@ | M1 |
| P4 | Your setup link for {clinic} | The operator mints one | Requester | M1 |
| P5 | Your setup link works until {date} | 4 days before expiry, if unpaid | Requester | M1 |
| P6 | Your agreement (copy) | Signing at step 3 | Signer | M2 |
| P7 | Your setup link for {clinic} is still open | 24 hours after an unpaid Checkout Session expires, re-checked at send time | Buyer | M2 (pilot mode); public mode (resume) |
| P8 | "We've got your message" | Contact form | Sender | M1 |
| P9 | Website enquiry · review | Contact form · review | hello@ | Exists |

- **P2:** "We'll reply to {email} by {Tuesday 7 October} with your next step."
- **P4:**
  - what the four steps ask for, and that the link works until {date};
  - when the lead's setup credit is still valid, "Your setup fee is waived" until its date.
- **P6:** worded by agreement kind (BAA or DPA).
  - In pilot mode it goes only to the email bound to the setup link.
  - In public mode it goes once per address per day, with the typed variables restricted to safe characters.
- **P7:** subject and body no longer claim anything is "saved". The agreement sentence depends on the kind.
- **P8:** never echoes their text.

**From purchase on, every email goes to the clinic's one address, unless a row says otherwise.**

**Purchase (apps/app)**

| # | Email | Sent when | Ships |
|---|---|---|---|
| B1 | Welcome: your order is confirmed | First invoice paid and provisioned | M3 |
| B2 | Sign-in link | /sign-in, "Send again" | M2 |
| B3 | Your order is confirmed: one step on our side | Provisioning failed or dead-lettered | M2 |

- **B1** is sent at once, with the terms on record from the first day. Contents:
  - what was bought, and the setup-fee receipt (Stripe's hosted receipt);
  - the plan-start sentence, the monthly price, and how to cancel online;
  - the Terms version and the agreement download;
  - **Continue setup** (a fresh 72-hour link), and the four steps still to do;
  - each bought channel's status in words, with no dates: "See when each channel opens on Home";
  - Help.
- **B2** is not sent at the /welcome timeout, because there is no account to sign in to yet. B1 is that email.
- **B3** carries B1's order terms and "We'll email you by {Tuesday 7 October}". Ops is alerted.

**Onboarding**

| # | Email | Sent when | Ships |
|---|---|---|---|
| O3 | A device was added or removed | A passkey is added (except the first, in the paying browser), removed, or locked after wrong codes | M2 |
| O4 | Setting changed | A sensitive change (D4) after the value was first set, or an export | M3 |
| O5 | Your sign-in address is changing | An address change from Settings, or ops' `changeClinicEmail` | M3 |
| O6 | Sign-in link (help) | A `/sign-in/help` match | M2 |
| O7 | Setup reminder | An action of theirs has been outstanding for 48 hours: finishing setup, or a channel ready on our side and not yet live | M3 |
| O8 | Your AYA is ready to talk to | Tracker complete | M4 |
| O9 | One thing to fix | The practice questions fail on the clinic's own data | M4 |
| O10 | {Channel} is ready: one step left | A channel is still waiting on the clinic an hour after it became ready | M3 (chat), with voice (phone) |
| O11 | Steps from {clinic} | The clinic sends the snippet or the forwarding steps on (to the person it names) | M3 |
| O12 | An opening date has moved | Ops moves a published opening date | M3 |
| O13 | Calendar stopped working · reconnected | A calendar backend event after setup | M3 |
| O14 | Payments connected · disconnected | Package D | M3 / Package D |

- **O1 and O2** (team invitations, membership changes) are not in v1: there is one sign-in per clinic.
- **O3:** names the device.
- **O4:** shows before → after, masked. Stripe connect and disconnect are O14's, not O4's.
- **O5:**
  - **From Settings:** a confirmation link goes to the new address, and a notice with "Stop this change" to the old one. It takes effect 72 hours after confirmation.
  - **Through ops** (`changeClinicEmail`): both addresses get the notice, naming the end of the 72-hour objection window.
- **O7:** one email per clinic, naming each channel's single action, as the spec asks ("one reminder naming the single action outstanding"). At most one per channel. For phone, it offers the five-minute call.
- **O9:** names the Knowledge section and a count, never the service.
- **O10:** website chat carries the snippet. Phone carries the AYA number, the forwarding steps for the clinic's carrier, and the five-minute call. Not sent if the step was finished within the hour.
- **O11:** a fixed template with no free text, at most 3 a day per clinic. Footer: "Someone at {clinic} asked us to send this", with a link to stop further mail to that address.
- **O12:** names the channel and links to Home; the date itself stays in the dashboard. When the plan start moves too, O12 and L6 go as one email.
- **O13:** when it stops: "Bookings arrive as requests until you reconnect." Connecting it during setup sends nothing.

**Live**

| # | Email | Sent when | Ships |
|---|---|---|---|
| L1 | AYA is answering on {channel} | `live` | M6 |
| L2 | AYA answered her first patient: your plan has started | The first plan invoice is paid (after the first answer, or at the backstop) | Package C, M6 hook |
| L3 | {Channel} is in service: your new price | A later channel's first answer → `stepUpPackage` | Package C, M6 hook |
| L4 | {Channel} joins your plan on {date} | Once the plan has started, a channel ready on our side has waited on the clinic for 23 days, counted from the later of its readiness and the plan start | Package C, M6 hook |
| L5 | Your plan starts on {date} | 7 days before the backstop, if AYA hasn't answered a patient yet | Package C, Gate A |
| L6 | Your plan start has moved | `extendPlanStart` | Gate A |
| L7 | Booking request | **The moment one is taken, at any hour** | M5 |
| L8 | Request still open | At the next opening hour, only while the daily summary is off | M5 |
| L9 | Missed: they were told you'd call | A request expires | M5 |
| L10 | Deposit to collect | A deposit is flagged or held, or a booking is refused for want of one | M5 |
| L11 | Someone asked for a person | A handover | M5 |
| L12 | URGENT | The urgent matcher fires | M5 |
| L13 | Daily summary, with every booking and request | **At the clinic's opening time, each working day** | M6 |
| L14 | Your week with AYA | Monday, only while the daily summary is off; otherwise it is part of the week's first summary | M6 (retargeted) |
| L15 | AYA is paused | A pause until tomorrow or indefinitely, or a channel switched Off; again 24 hours into an indefinite pause | M6 |
| L17 | Calls are going to your direct line | Our system or a vendor has failed for 10 minutes | M6 |
| L18 | AYA is answering again | That incident ends | M6 |
| L19 | Allowance used: calls go to your direct line until {date} | "Stop and fall back" engages, whatever the usage-alerts switch says | Package B/C, Gate B |
| L20 | A message was left on your website | The website contact form, while chat is off or paused | M5 |
| L21 | We missed a {call or message} | A guarantee miss is recorded | M6 |
| L22 | Sign your updated agreement | A supersede (DPA→BAA) or a new BAA version | M2 |
| L23 | Changes on your website | The drift check finds changes | M7 |
| L25 | We've got your request | A support-chat escalation | M7 |
| L26 | Choose by {date}: switch package or refund | 14 and 3 days before Meta's switch-or-refund date, while no Meta channel is in service | Package C (`meta_deadline`), Gate A |
| L27 | Billing notices (Package C) | Stripe events and jobs | Package C, Gate A |
| L28 | Terms notices | An operator broadcast from /admin | Gate A |
| L29 | Agreement notices | A new subprocessor (operator broadcast), or an incident report ops chooses to send | Gate A |
| L30 | Guarantee: claim received · our finding | An operator action in /admin | Gate A |
| L31 | Service suspended for a legal or security reason | An operator action | Gate A |
| L32 | A request from a patient | The operator records one | M5 |
| L33 | What changed in healdesk | An operator broadcast | M7 |

(L16 is merged into L15. L24 is not an email: an address that can't be emailed shows on Home and alerts ops, X3.)

- **L1:** before the first answer, says the plan starts the day she first answers a patient. For a later channel, says its price joins from its first answer.
- **L2:** "AYA answered her first patient on {channel} today, so your monthly plan has started: {price} a month, charged today." It carries the receipt and how to cancel online. At the backstop it reads "Your plan started today, as scheduled". Sent once the charge succeeds, critical; a failed charge sends the payment-failed notice instead.
- **L3:** the new monthly price from today, with the prorated difference on the next invoice.
- **L4:** a week's notice before a waiting channel's 30-day step-up, naming its one action.
- **L5:** a courtesy reminder, as Visa recommends for every subscription. It names the date, the amount, how to cancel, and the channels ready for them.
- **L7–L12 and L20:** pointers only, sent at once at any hour. L12 is critical.
- **L13, the daily summary,** gives the full picture each morning:
  - the day's counts from the claims function (handled, booked, escalated), and the spec's quiet-day line only when unusual;
  - **every booking and booking request since the last summary, plus every request still open,** one row each, with its channel and status (booked by AYA, waiting for you, confirmed) and a link:
    - a booking opens its **Google Calendar event**;
    - a request opens **Bookings in healdesk**, where confirming it creates the calendar event;
  - no names, times or services, which open behind the link;
  - in the week's first summary, last week's recap.
- **L15:** names the device it was paused from. A channel switched Off counts as an indefinite pause.
- **L17 and L18:** one pair per incident, critical. L18 gives how many calls and chats went to the clinic meanwhile. L21 still applies to any miss.
- **L19:** critical. The usage-alerts switch governs L27's 80% and 100% emails, not this one.
- **L21:** within the Terms' notice days.
- **L22:** carries a signed link, with reminders at 3 and 7 days. For a DPA practice that now bills insurance, it says AYA is paused until it's signed and calls go to the direct line (Part L).
- **L23:** names the Knowledge section and a count, never the service.
- **L25:** says when we'll reply, by date.
- **L26:** gives both choices, the date, and what happens if they do nothing.
- **L27, the Package C kinds:**
  - payment failed, action required, grace ending, suspended, restored;
  - usage at 80% and 100%; overage invoiced;
  - renewal upcoming (annual, at 30 and 21 days, which meets the Terms and the state notice windows that reach business contracts);
  - plan changed; location added;
  - **receipt**, with the cancel link, for an invoice paid outside another email;
  - **refund issued**; **card expiring**.
- **L28:** a change to the terms or to prices, 30 days ahead (Terms §4 and §16). Mandatory, with no unsubscribe.
- **L29:**
  - **A new PHI subprocessor:** notice ahead by email, as the agreement in force says: 15 days under BAA 1.2.1, and **24 hours** from the next BAA version and in the DPA.
  - **An incident report goes only when ops sends it** from the /admin incidents page (Part K), which shows the BAA's deadline. It is built from fixed fields only:
    - what happened, with the dates of the event and of its discovery;
    - the types of information involved, with counts;
    - the mitigation, and a contact.
  - Once sent it is critical, and a dead letter means `notifyOps` plus a phone call.
  - **The list of individuals is never emailed.** It sits on a page behind step-up.
- **L30:**
  - **Claim received:** gives the date of our finding.
  - **Finding:** the result, the refund date, and what failed (Terms §5).
- **L31:** tells them why, as Terms §15 requires.
- **L32:** a pointer. The request itself is on Home, behind step-up.
  - The operator records it from a trusted shell (`npm run ops:patient-request -w @healdesk/app`), never through apps/web.
  - The reply to the patient (X0) is written by a person.
- **L33:** changes to features the clinic already has. It is transactional, never promotional, with a one-click opt-out.

**After cancellation**

| # | Email | Sent when | Ships |
|---|---|---|---|
| E1 | Cancellation scheduled · reversed | Package C | Gate A |
| E2 | Your service has ended | The subscription ends | Gate A |
| E3 | Calls stop passing through on {date} | 7 days and 1 day before pass-through ends, if calls were forwarded to AYA in the last 14 days | M6 |
| E4 | Your export is ready | Automatically when service ends, once the export is built | M6 |
| E5 | Download your export by {date} | 7 days before destruction, if the export hasn't been downloaded | M6 |
| E6 | Your data has been destroyed | Destruction completes, to the address captured before destruction | M6 |

- **E1:** how to reverse it, and by when. Cancelling before the plan starts has its own variant: "Your plan won't start, and nothing more is charged."
- **E2:**
  - how many days calls still pass through;
  - how to undo forwarding, by carrier;
  - chat shows a contact form until the snippet is removed;
  - the export and destruction dates, from `destructionPlan` (lib/offboarding) by the rule of the clinic's own agreement: under BAA 1.2.1 and earlier, a day before 30 days after the end, whatever the export; under BAA 1.3.0 and the DPA, a day before 30 days after the end once the export has been delivered, otherwise when it is, and a day before 90 days after the end at the latest (an hourly job, so each limit holds whatever the hour).
- **E3:** the carrier undo codes.
- **E4:** a link to the read-only portal (sign-in and step-up). The export is never attached. Terms §7 says "we deliver an export", so it isn't waiting to be asked for.
- **E6:** what was destroyed and when, and what remains and why:
  - database backups, until {date};
  - what our model provider keeps under its own terms, as the Terms describe;
  - the signed agreement and its disclosure record (six years);
  - billing history.

Refunds are L27's "refund issued", so there is no separate after-cancellation refund email.

**Internal (ops; ids and counts only)**

| # | Email | To |
|---|---|---|
| I1 | `notifyOps` alerts (listed below) | `HEALDESK_OPS_EMAIL` |
| I2 | The 07:00 ops digest | Same |
| I3 | Setup requests, enquiries, reviews, support escalations, access requests | hello@ |
| I4 | Each flag, and two flags in seven days | Ops |
| I5 | Admin signed in | Operator (exists) |

- **I2, the digest:**
  - every queue, with the age of its oldest item;
  - email health per kind: sent, failed, bounced, complaints, dead letters;
  - connection health.

**`notifyOps` fires on:**
- provisioning rejected or dead-lettered;
- a paid intent with no clinic 10 minutes after payment;
- a duplicate subscription;
- a practice-question failure;
- the setup-fee refund rule's alerts on day 23 and day 30 after the published opening, with channel-event evidence (each refund is confirmed through Package C's `commitRefund`);
- a dead-lettered billing event;
- a critical notice undelivered after 10 minutes (with `/api/health` red);
- a clinic's address bounces, complains or is suppressed (ops calls the clinic);
- the day's email count reaches 70 (the free plan stops at 100);
- a published opening date 3 days away whose runtime isn't ready;
- a dated promise past due: a setup request's reply, B3's follow-up, L25's reply, a practice-question review;
- L22 still unsigned after 7 days;
- the spec's internal health flags:
  - 48 hours with no interactions on any channel after go-live;
  - 14 days with no inbound calls on a live phone channel.

### X6. Changes to existing emails

- **Nurture** (`nurture.ts`):
  - touch 4: "founding cohort" goes, and the credit is called "Setup credit". The link opens the setup request in pilot mode, which records the lead id so the setup link carries the credit, or the funnel in public mode;
  - touch 3: "usually the same day" goes, replaced by the step itself;
  - "the Business Associate Agreement" becomes "the data agreement your practice needs";
  - the sequence stops once a setup request is recorded; today `canEmail` stops it only on purchase.
- **Checkout not finished:**
  - in pilot mode, it carries the setup link;
  - it no longer claims anything is "saved";
  - the agreement sentence depends on the agreement kind;
  - the public rewrite waits for public mode.
- **Agreement copy:** the subject, explainer and title depend on the agreement kind.
- **Setup link email** (`setup-link.ts`): retired with the wizard (Part C2).
- **Connect link:** phase two, so it is sent by no v1 flow.
- **Live alerts and `notifyDesk`:** replaced by L7–L12 through the outbox. **Direct bookings send no email**: they are in the clinic's calendar and the daily summary.
- **Weekly recap:** moves to the clinic's address and into the week's first daily summary (L14). "Reply to this email with anything that looked wrong on a call" becomes "Something look wrong? Open the conversation and use Flag this answer", because a flag reaches the right fix faster than an email.
- **Annual renewal reminder:** replaced by Package C's `renewal_upcoming`, sent to the clinic's address.
- **Connection health:** folded into the ops digest, and sent at once only when critical.
- **Unsubscribe route:** a GET shows a confirmation page, and the button posts.
- **Resend webhook (apps/web):** accepts the `svix-*` headers.

### X7. Stripe's own emails

They are turned off in one step at Gate A, **only once the replacement for each is live and tested**:
- successful-payment receipts;
- refunds;
- failed payments;
- upcoming renewals;
- trial reminders;
- expiring cards.

**No trial, so the trial rules don't apply.** Visa's trial rules bind "only… merchants that offer free trials or introductory promotions"; for other subscriptions they are "strongly recommended" (Visa Business News AI09334). We follow the recommended practice anyway:
- **B1:** the terms on record from the first day;
- **L5:** a reminder 7 days before a backstop start;
- **L4:** a week's notice before a waiting channel joins the price;
- receipts that say how to cancel online.

Stripe's own trial reminders have nothing to fire on.

The settings live in Stripe's dashboard only, so this is a launch-checklist item with screenshots.

### X8. Launch checks and monitoring

- **Resend:**
  - healdesk.io verified, with the two sending keys;
  - the free plan to start, and the 70-a-day alarm live;
  - `GET /domains/:id` shows open and click tracking off and enforced TLS on, and no tracking CNAME is published;
  - Resend's test event returns 200 on the webhook, and a test `app=app` event reaches apps/app through the relay.
- **Queue:** `queue:install` re-run in each environment, for the `notices` queue.
- **DNS:** X2's records verified. Gmail Postmaster Tools is registered on healdesk.io.
- **Seed test:** one email from each address (hello@, noreply@), plus the longest template, into Gmail, Microsoft 365, Outlook.com, iCloud and Yahoo. Each must land in the inbox, render in light and dark mode, and carry a DKIM signature covering the `List-Unsubscribe` headers.
- **Postal address:** the US mailing address is a USPS-registered private mailbox (Form 1583), which CAN-SPAM accepts, and not only a registered-agent address.
- **Targets,** shown in the ops digest: complaints under 0.05% (Resend pauses a team at 0.08%), hard bounces under 2%.

### X9. Release

- **Gate A needs the launch set:**
  - P1–P9, B1–B3 and O3–O13 (O14 with Package D);
  - L2, L5, L6, L22 and L26–L31;
  - E1 and E2, and I1–I5;
  - X7 done and X8 passed.
- **Gate B (with M5 and M6) needs the live set:** L1, L3, L4, L7–L15, L17–L21 and L32; E3–E6.
- **M7** brings L23, L25 and L33.

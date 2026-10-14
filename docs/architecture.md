# Architecture

Stack decisions, the repo layout, and why the deploy targets are split.

What the product does is decided by [v1-product-spec.md](./v1-product-spec.md); this
document describes how the code is arranged to do it, and where the code stands. Where
the two disagree about the product, the spec wins. The live task list is the
[Launch plan tab](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) of the spec's source
doc.

---

## The one decision everything follows from

**The marketing site and the product have different compliance boundaries, so they are
different deploy targets from day one.**

- `apps/web` touches **zero PHI**. Deploy anywhere.
- `apps/app` holds every patient conversation: call and chat transcripts and the
  callback-slip fields (name, number, requested service, preferred time), bookings,
  deposit status and the clinic portal. It holds no intake, clinical notes or diagnosis.
  It needs BAA-covered infrastructure end to end.

They share a repo (types, design tokens, docs stay in one place) and split at deploy.
Retrofitting this boundary later means untangling a database, an auth session, and a
logging pipeline that all assumed one environment. Building it in now costs nothing.

See [hipaa-compliance.md](./hipaa-compliance.md) for what "BAA-covered" requires, and
the root [`CLAUDE.md`](../CLAUDE.md) for the table that decides which app a new
surface belongs in.

> **Updated 2026-09-30.** v1 changes what `apps/app` is for. It will serve the clinic
> portal (seven screens, magic-link sign-in, a second factor before any transcript opens,
> owner, manager and billing-contact roles), the four-step onboarding wizard and the
> portal support chat, alongside the three patient channels: the Retell custom-LLM
> WebSocket endpoint (its own long-lived process), the web chat widget's API, and the
> Meta webhooks and send adapters. **None of those is built yet.** What `apps/app`
> serves today, all of it pre-spec:
>
> - Synthflow post-call and mid-call tool routes (`api/webhooks/voice/[clinicId]`,
>   `api/voice/tools/[clinicId]`). Removed on 14 October 2026: the Retell endpoint
>   (`src/voice/server.ts`, built 13 October) replaced them.
> - The Meta webhook (`api/webhooks/meta`, `lib/meta/front-door.ts`), which answers
>   public facts and takes booking requests; it books nothing.
> - Single-use links: `/booking/[token]` (staff decide a booking request), `/setup/[token]`
>   (from the 23 September design) and `/connect/[token]` (the credential handover for
>   phase-two POS read-back). The portal replaces the first two as the way a clinic acts.
> - The ops API behind `/admin`, provisioning, Stripe billing events, and the worker.
>
> `apps/web` (audited 2026-09-12) runs the route handlers, the `/admin` **operator**
> console, a voice demo that dials a real phone on the owner's request, contact and
> review forms that send mail, and HMAC-signed channels into the covered app. Its lead
> capture takes a phone number, a name, free text and a photograph, all business data.
>
> The boundary holds: `apps/web` has no database client, and nothing patient-shaped
> crosses `/api/ops`.

---

## Repo layout

```
healdesk.io/
├── apps/
│   ├── web/          Marketing site + /admin operator console → Vercel project #1 (no PHI)
│   └── app/          Product: patient channels, clinic portal, worker → BAA host (PHI)
├── packages/
│   ├── catalog/      Shared contract: plans, BAA, forwarding codes, clinical-content patterns
│   ├── connectors/   Anti-corruption layer for phase-two POS read-back
│   └── leadgen/      Prospecting pipeline (runs locally / in a job runner)
└── docs/             These documents
```

npm workspaces + Turborepo. npm because it needs no global install; Turborepo for task
orchestration and caching across the workspaces.

---

## apps/web — the marketing site

**Next.js 15 (App Router) · TypeScript · Tailwind v4 · Motion**

**Why Next.js and not a static site generator.** The live chat demo needs a server route
to hold the Anthropic API key. That requirement exists on day one, which rules out a
pure static host. Route Handlers give us a server surface — `/api/chat` and the rest —
while every other page stays a static or streamed Server Component.

> The prototype hero called `api.anthropic.com` directly from browser JavaScript. Any key
> shipped that way is public the moment the page is live. `/api/chat` exists specifically
> to close that hole; see [Chat demo](#chat-demo) below.

**Why Tailwind v4.** The design tokens were already decided in the prototype. v4's
CSS-first `@theme` block maps them 1:1 — `--color-red`, `--color-paper`, `--font-display`
are declared once in `globals.css` and become utilities automatically. No JS config file,
no token duplication.

**Why Motion.** The panel strip, scroll reveals, and the transcript playback are real
animation work, and Motion handles `prefers-reduced-motion` natively — which the
prototype already respected and we shouldn't regress.

**Where its data lives.** In a Google Sheet in the company Google account's Drive — demo
leads, funnel events, the demo-call consent record and the two daily spend counters,
one tab each (`src/lib/sheets/`), written through a service account. Not a database:
`apps/web` has no database client, which is what makes "the marketing site cannot reach
patient data" a fact you can check rather than a policy. The same Sheet is the CRM at
`/admin/crm`. Analytics is PostHog on its US cloud, consent-gated, and blocked by the
CSP from talking to anything else.

**The demo talks to owners, not patients.** That is the only reason it sits here. It
answers from a generic knowledge tree; the owner-requested demo call runs on a Retell
demo agent, separate from the product's, since 5 October 2026. When the demo starts building a clinic's
profile from its own website (the spec's "Stage 0"), that profile is business data and
reaches the wizard inside a signed request to `apps/app`, never a store in `apps/web`.

### Design tokens

Carried over verbatim from the prototype rather than re-invented:

| Token | Value | Role |
| --- | --- | --- |
| `--color-red` | `#E23A2A` | Primary brand, gradient start |
| `--color-orange` | `#F47B1F` | Secondary brand, gradient end |
| `--color-ink` | `#24160F` | Body text |
| `--color-paper` | `#FBF4EA` | Page background |
| `--color-paper-2` | `#F5E8D6` | Raised surfaces |
| `--color-muted` | `#8B7A6C` | Secondary text |
| `--font-display` | Fraunces | Headlines, brand mark |
| `--font-sans` | Hanken Grotesk | Body, UI |

Warm paper + a red→orange gradient, on purpose: healthcare SaaS defaults to blue-white
clinical sterility, and this reads as hospitality instead. That's the correct register for
elective, cash-pay, experience-driven medicine.

### Chat demo

`POST /api/chat` → Claude, streamed back as newline-delimited JSON.

- **Key stays server-side.** `ANTHROPIC_API_KEY` has no `NEXT_PUBLIC_` prefix and is read
  only inside the Route Handler. It belongs to the marketing (non-PHI) Anthropic
  organisation, never the patient one.
- **Email-gated.** The chat unlocks after an email is submitted; every demo becomes a
  lead. Gate state is a signed HTTP-only cookie.
- **Rate-limited** per IP, with a hard cap on `max_tokens` and conversation length, so a
  scraper can't run up the bill. The per-IP limit is per instance; the site-wide daily
  caps (`chat:global:day`, `callback:global:day`) are the only counters shared across
  instances, through the Sheet's `counters` tab on a cached read (`src/lib/rate-limit.ts`
  explains the trade).
- **Model:** `claude-opus-5` with adaptive thinking at `low` effort — the fast, cheap end
  of the ladder, which is right for short pricing Q&A. Raise effort if answers get shallow.

---

## apps/app — the product

**Next.js (App Router) · TypeScript · Postgres · Drizzle ORM · pg-boss**

Deliberately boring, and deliberately **portable**: no Vercel-specific runtime APIs, no
edge-only primitives, no platform KV. It runs as plain Node processes, so moving it to
the AWS HIPAA account is a deploy-config change, not a rewrite. CLAUDE.md lists what
still stops it deploying.

**One brain, four adapters.** Claude decides what to say on every channel. Each channel
adapter (voice, web chat, Meta, and the portal support chat) translates and enforces its
own platform's rules. Bookings and payments are written only by a fixed tool layer,
never by the model directly. The guardrails run around the model in code: complication
and urgent-symptom patterns are matched before the model sees the message, prices come
only from the clinic's configured list, the never-say list is injected on every channel,
and the AI disclosure is the opening line and cannot be configured away.

**Why Postgres + Drizzle.** The v1 needs are relational and transactional: tenant
isolation with forced row-level security, idempotent booking writes (a retried request,
a duplicate webhook or a repeated tool call returns the original booking), 60-second slot
holds, an append-only audit log including every transcript open, and the job queue in
the same database. Drizzle keeps the schema in TypeScript and generates SQL migrations,
so all of it stays reviewable in code.

**Phase two: attribution.** The schema in
[`apps/app/src/db/schema.ts`](../apps/app/src/db/schema.ts) also models the
`clicks → booked → showed → spent` chain, with each stage carrying its own source-system
ID. That chain, `src/lib/attribution`, `src/lib/sync` and the monthly revenue report are
phase two: kept and tested, fenced out of v1 flows, screens, emails and claims. v1 shows
booked value (bookings times the clinic's configured prices), never revenue.

---

## Voice: Retell

Locked in the spec. Retell is pay-as-you-go and handles telephony and speech. At the
start of every call it opens a WebSocket to a Healdesk-hosted Claude endpoint in
`apps/app`, and every tool call it makes (availability, slot hold, booking) runs there.
Because a Next route handler cannot accept a WebSocket upgrade and a serverless function
cannot hold one open for a call, the endpoint is its own long-lived Node process, run
from the same image as the web tier and the worker so all three ship the same schema
and tool layer.

- **Calls arrive by conditional forwarding** on the clinic's own line, in the coverage
  mode the clinic picked: all calls; overflow and after hours (the default); after hours
  only. The clinic keeps its published number. The Healdesk number is allocated at
  payment, in the clinic's area code.
- **Vendor-side recording off**, transcript retention set per agent (Retell allows 1 day
  to 2 years) to the minimum, and per-agent PII controls set. The working transcript
  lives in Healdesk under the clinic's retention policy.
- **Languages** come from the platform: 55 languages across 63 locales. The clinic picks
  which its agent handles; the agent answers in the caller's language and stays in it.
- **Concurrency:** 20 concurrent calls are included on pay-as-you-go; more cost extra
  per slot. Whether 20 is enough is an open item in the spec.

**Built 13 October 2026, never tested against Retell itself.** The endpoint is
`src/voice/server.ts` and `lib/voice/retell.ts` in `apps/app`; each finished call goes to
the vendor-neutral post-call ingest (`lib/voice/ingest.ts`). Check its protocol fields
against Retell on a synthetic clinic before a real call
([design/web-chat-and-voice-2026-10-13.md](./design/web-chat-and-voice-2026-10-13.md)).

### The voice agent is PHI-light by design

Locked. The agent **collects only** four things: name, callback number, requested
service, preferred time — what a receptionist writes on a callback slip, and the
irreducible minimum to place a booking. Nothing clinical, no history, no medication, no
diagnosis, no date of birth, no insurance.

- **A clinical question or an off-menu price pivots to booking a consultation** with the
  named provider. No advice, no reassurance that reads as advice.
- **A complication or urgent symptom never reaches the model.** It is matched first and
  short-circuits to a fixed response and immediate escalation to the clinic's on-call
  contact.
- **The agent never promises a text or a link.** Voice cannot send one in v1 (there is
  no SMS). It books on the call; where a deposit is required it books and flags the
  deposit for staff, or follows the clinic's deposit setting.
- **Any other tool failure** gets a fixed, pre-written line and an offer of a transfer,
  never an improvised explanation. A broken or expired calendar connection switches the
  clinic to manual booking mode in the same turn.

Call audio is PHI in transit through Retell, which makes Retell a subcontractor: its BAA
(self-serve, in Retell's click-agreements portal) must be signed before any real call.
Vendor-side PII redaction (about a cent a minute) is an open cost decision and a
mitigation, not the design: v1 has no intake for redaction to break, and the design is
to keep clinical content off the call in the first place.

Two consequences worth stating, because both have been drifted back into before:

- **The demo must match the product.** Marketing scripts and the chat demo may
  not show the agent taking a member ID or a date of birth, or answering a
  clinical question. An agent that gives clinical guidance sits in the
  bodily-injury exclusion that tech E&O and cyber policies carry.
- **The disclosure is code, not a setting.** The opening line says the assistant is an
  AI and that the call is transcribed, in the same breath; the clinic cannot switch it
  off or edit it out through the greeting field.

### Recovery is a reason, and after-hours needs opening hours

`conversations.recovery_reason` records WHY a contact would have been lost —
`after_hours`, `line_busy`, `rang_unanswered` — and feeds the v1 figure "calls answered
that would previously have rung out", shown on the portal's Home screen and in the daily
summary and weekly emails. Null means the clinic would have handled it anyway and we
claim nothing. The enum also holds `missed_call_callback`; v1 places no call-backs, so
nothing in v1 may set it.

The coverage mode decides what counts. In overflow and after hours, and in after hours
only, the agent sees only calls the clinic did not answer, so every forwarded call
qualifies. In full coverage, a call inside opening hours is not one that would have
rung out.

**When building voice ingestion, set this at the moment the call arrives.** It
cannot be reconstructed afterwards.

`after_hours` depends on `clinics.opening_hours`, which in v1 come from wizard step 1
and the portal's Knowledge → Hours screen, including holiday closures (today the
operator sets them through the ops API). They are evaluated by
`lib/clinic/opening-hours.ts`. Call `isAfterHours(hours, at, clinic.timezone)` and
record the reason only when it returns `true` — it returns **null** when hours were never
collected, and that null must not be coerced. A clinic wrongly assumed to shut at 5
would have its 6pm calls claimed as recovered while its own staff answered them, which
overstates the one number a clinic checks us on. Understating is survivable;
overstating is not.

### No conversion attribution to ad platforms

Removed entirely — not deferred, not a paid add-on. `ad_interactions` and
`conversations.ad_interaction_id` were dropped in `drizzle/0017`.

**Phase two (POS read-back), not in v1 flows or claims.** What survives in the code is
revenue reporting, a different thing wearing a confusingly similar name:
`src/lib/attribution` reconciles the money event read from the clinic's own POS against
recovered calls, and reports it back to the clinic. Nothing leaves for a third party,
and nothing may. v1 shows booked value, never revenue.

The distinction is load-bearing. Linking a patient conversation to a Meta or
Google click id is person-level health data — the GoodRx and BetterHelp fact
pattern, neither of which involved a breach — and the 2024 HBNR amendment makes
the disclosure itself reportable. Hashing does not help: a hashed email is one of
HIPAA's 18 identifiers, hashed so it can be matched. Separately, Meta's Business
Tools Terms §1.h bans health data outright, so a lawful transmission could still
break the clinic's own Meta contract.

### Calendar: decided

Google Calendar is the single write target for every clinic, on every channel, connected
by OAuth in wizard step 3. Nothing is written anywhere else. The clinic links its own
booking system to that calendar; that is a setting in its system, not a Healdesk
integration.

| Clinic's system | Does a Healdesk event in Google block the slot there? | v1 booking |
| --- | --- | --- |
| Google Calendar alone, Calendly, Cal.com | Yes | Live booking |
| Mindbody | No: its sync runs one way, Mindbody to Google | Manual booking mode, or staff mirror bookings into Mindbody |
| Boulevard | Unverified; treat as no until Boulevard confirms in writing | Manual booking mode |

"Auto-confirm bookings" is on by default; off turns every booking into a request staff
approve from the portal's Bookings screen. A broken or expired calendar connection flips
the clinic into manual booking mode in the same turn, and a background job watches token
expiry so the flip happens before a booking fails. Writes are idempotent and the slot is
held for 60 seconds before anything confirming is said. Writes into Cal.com, Mindbody or
Boulevard are phase two.

**Not built yet.** No Google Calendar code exists. `src/lib/booking/calendar.ts` writes
to Cal.com through the connector port, from the 23 September design; v1 does not use it.
The existing staff-approval booking-request path (`booking_requests`) is the
auto-confirm-off and manual-booking-mode path, and stays.

---

## packages/connectors — the anti-corruption layer

> Phase two (POS read-back for attribution). Kept and tested, not wired into v1 flows or
> claims.

**No Drizzle, no `pg`, no Next.** That is what lets the whole layer be contract-tested in
milliseconds with no database, and stops our storage shapes leaking into what we call
"canonical".

The organising insight: an incumbent's integration is a **write** — one request, known
outcome. Ours is a **read** — a continuous, rate-limited, partially-supported stream from
eight vendors who disagree about whether "the patient showed up" and "we got paid" are
representable at all.

So every vendor limitation is a first-class value rather than a null:

| Concept | Why it exists |
| --- | --- |
| `CapabilitySet` | Acuity has no arrival concept; Vagaro has no sales history. Permanent platform properties, declared, so "unsupported" reaches the customer as a sentence rather than rendering as zero |
| `Result<T>` | One clinic being rate-limited must not abort the run for everyone else. `retryable` separates a 429 (back off) from a 401 (needs a human) |
| `Money = string` | Floats lose cents and cents are the entire product |
| `arrival: "unknown"` | Distinct from `no_show`. "Can't tell" is not "didn't turn up" |
| `BUDGETS` | Zenoti allows 60 requests a minute; PatientNow allows 1,000 a **day**. That shapes the architecture — delta sync is mandatory, not an optimisation |
| Fixture adapter | A synthetic clinic that no-shows, pays deposits weeks early and emits orphan sales, so the engine is built and demoed before any vendor grants access |

Only the fixture is registered. Registering an unimplemented adapter would let the sync
engine pick it up and fail at runtime rather than at connect time.

---

## The sync and reconciliation path

> Phase two (POS read-back for attribution). Kept and tested, not wired into v1 flows or
> claims.

```
platform → adapter → sync engine → contacts/appointments/transactions
                                       ↓
                                   matcher → matched revenue → monthly report
                                       ↓
                                 exception queue → console
```

Four properties hold this together, each of which would silently corrupt a monthly figure
if it broke:

1. **Every write is an upsert** keyed on `(clinic, source, the platform's own id)`, against
   *partial* unique indexes — Postgres treats NULLs as distinct, so a missing `targetWhere`
   makes `ON CONFLICT` match nothing and every re-sync duplicates.
2. **The cursor advances only on a clean run**, and every run re-reads a two-day overlap,
   because platforms let staff backdate edits.
3. **Network I/O never happens inside a transaction.** Each page is fetched with none open
   and written in its own short one, so a run that dies at page 40 keeps pages 1–39.
4. **Ambiguity produces an exception, not a guess.** A wrong match silently misattributes
   revenue; an unmatched one shows up as a caveat the clinic can check.

---

## The background worker and the queue

The queue is **pg-boss**, in the database we already have — no Redis, no fourth vendor to
hold a BAA with, and jobs commit alongside the data they describe. Its schema has no
`clinic_id` and no RLS, so payloads carry ids only and an allowlist enforces it.

The worker (`npm run worker -w @healdesk/app`) is v1 infrastructure, not phase two. The
spec's background behaviour runs there: the calendar-token watch, knowledge re-audits
when a clinic's knowledge changes, the monthly re-scrape diff, retention and demo-sandbox
purges, the 14-day zero-inbound and 48-hour zero-interaction flags, the daily summary,
billing and offboarding. Most of those jobs are not built; today's tick runs the billing
sweep, the connection watchdog, the weekly recap, retention and offboarding, plus the
phase-two monthly report and nightly sync (see [on-call.md](./on-call.md)).

---

## packages/leadgen — prospecting

TypeScript scripts implementing [leadgen-playbook.md](./leadgen-playbook.md): Apify Maps
scrape → booking-footprint detection → LLM classification → scored CSV.

Not a service. It runs on demand, writes to `packages/leadgen/data/` (gitignored, because
scraped output is business data that shouldn't land in git), and feeds a CRM.

**It never touches the PHI boundary.** Clinic firmographics are not patient data and must
not be co-mingled with it.

---

## Deployment

| Workspace | Target | Root directory | PHI |
| --- | --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` | No |
| `apps/app` | Vercel project #2 → BAA host (AWS, `us-east-1`) | `apps/app` | **Yes** |
| `apps/app` worker | Same BAA host, separate process | `apps/app` | **Yes** |
| `apps/app` voice endpoint (Retell custom-LLM WebSocket) | Same BAA host, separate long-lived process | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

Two Vercel projects from one repo: each points at a different root directory with its own
env vars, domain, and build settings. A repo split is **not** required — the compliance
boundary is about where data flows and who signed a BAA, not where code lives.

**The caveat that matters:** Vercel signs BAAs only on Enterprise. Two projects give the
correct *architecture* split, not *coverage*. `apps/app` must not receive real patient
data until every link in the spec's chain is in place: the clinic's BAA (accepted inline
at checkout), Retell, Anthropic, the database provider (AWS RDS under the AWS agreement
already held, or Neon on its Scale plan) and AWS. Meta and Stripe never sign one and are
handled by scoping. That constraint is why `apps/app` is built portable.

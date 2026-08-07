# Architecture

Stack decisions, the repo layout, and why the deploy targets are split.

---

## The one decision everything follows from

**The marketing site and the product have different compliance boundaries, so they are
different deploy targets from day one.**

- `apps/web` touches **zero PHI**. Marketing copy, a chat demo about pricing, an email
  capture. Deploy anywhere.
- `apps/app` touches **intake, consent, and clinical notes**. Needs BAA-covered
  infrastructure end to end.

They share a repo (types, design tokens, docs stay in one place) and split at deploy.
Retrofitting this boundary later means untangling a database, an auth session, and a
logging pipeline that all assumed one environment. Building it in now costs nothing.

See [hipaa-compliance.md](./hipaa-compliance.md) for what "BAA-covered" requires.

---

## Repo layout

```
healdesk.io/
├── apps/
│   ├── web/          Marketing site      → Vercel project #1 (no PHI)
│   └── app/          Product / dashboard → BAA-covered host (PHI boundary)
├── packages/
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
pure static host. Route Handlers give us exactly one server surface — `/api/chat` — while
every other page stays a static or streamed Server Component.

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
  only inside the Route Handler.
- **Email-gated.** The chat unlocks after an email is submitted; every demo becomes a
  lead. Gate state is a signed HTTP-only cookie.
- **Rate-limited** per IP, with a hard cap on `max_tokens` and conversation length, so a
  scraper can't run up the bill.
- **Model:** `claude-opus-5` with adaptive thinking at `low` effort — the fast, cheap end
  of the ladder, which is right for short pricing Q&A. Raise effort if answers get shallow.

---

## apps/app — the product

**Next.js (App Router) · TypeScript · Postgres · Drizzle ORM**

Deliberately boring, and deliberately **portable**: no Vercel-specific runtime APIs, no
edge-only primitives, no platform KV. It runs as a plain Node server, so moving it to
AWS/Fly/Render when BAA coverage lands is a deploy-config change, not a rewrite.

**Why Postgres + Drizzle.** The differentiator in [prd.md](./prd.md) — reconciling
`clicks → booked → showed → spent` — is a join across four external systems. That is a
relational problem. Drizzle keeps the schema in TypeScript and generates SQL migrations,
so the attribution model stays reviewable in code.

The schema in [`apps/app/src/db/schema.ts`](../apps/app/src/db/schema.ts) models exactly
that chain, with each stage carrying its own source-system ID so a row can be traced back
to the ad platform, the booking system, the check-in, and the POS independently.

---

## Voice: deliberately not built yet

The intended end state is **LiveKit Agents or Pipecat, self-hosted** — best margin, full
control, and the only way to keep audio inside a BAA boundary you own.

The right *first* move is a managed orchestration layer (Vapi or Retell) so demand gets
validated before anyone owns a media pipeline. Component choices are stable either way:

| Layer | Choice | Note |
| --- | --- | --- |
| Telephony | Twilio | Signs BAAs |
| STT | Deepgram | Signs BAAs, low latency |
| TTS | Cartesia or ElevenLabs | Cartesia for latency, ElevenLabs for voice quality |
| Reasoning | Claude | Same provider as the web demo |
| Orchestration | Vapi/Retell → LiveKit | Managed now, self-hosted at scale |

Keep the orchestration layer behind an interface so the swap is contained.

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
| `apps/app` | Vercel project #2 → BAA host | `apps/app` | **Yes** |
| `packages/leadgen` | Not deployed | — | No |

Two Vercel projects from one repo: each points at a different root directory with its own
env vars, domain, and build settings. A repo split is **not** required — the compliance
boundary is about where data flows and who signed a BAA, not where code lives.

**The caveat that matters:** Vercel signs BAAs only on Enterprise. Two projects give the
correct *architecture* split, not *coverage*. Until an Enterprise BAA (or a move to
AWS/Fly/Render) is in place, `apps/app` must not receive real patient data. That
constraint is why it's built portable.

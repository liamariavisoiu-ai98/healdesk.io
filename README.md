# healdesk.io

One AI assistant for cash-pay elective clinics, sold as three inbound-only products that
launch together: an AI voice agent (on Retell), a web chat widget on the clinic's own site,
and a Meta bot covering Instagram, Facebook Messenger and WhatsApp.

Answers every call, message and DM, day or night. Books straight into the clinic's Google
Calendar during the conversation. Takes the deposit in chat where the clinic wants one.
Screens and routes anything clinical to the right person. Inbound only: nothing is sent
after a conversation ends.

What the product is and does is decided by
**[docs/v1-product-spec.md](./docs/v1-product-spec.md)**, an export of the source doc; the
live task list is that doc's "Launch plan" tab.

---

## Layout

```
healdesk.io/
├── apps/
│   ├── web/          Marketing site, demos, checkout, /admin     → Vercel #1 (no PHI)
│   └── app/          The product: channel adapters (voice          → BAA host (PHI)
│                     WebSocket, web chat API, Meta webhooks),
│                     bookings, the clinic portal, the worker
├── packages/
│   ├── catalog/      Shared contract: plans, BAA text, onboarding steps
│   ├── connectors/   Booking/POS read adapters (phase two: POS read-back)
│   └── leadgen/      Prospecting pipeline (Apify + Claude)
└── docs/             v1-product-spec.md (source of truth), architecture, HIPAA,
                      runbooks, policies
```

Start with **[docs/v1-product-spec.md](./docs/v1-product-spec.md)**, then
**[docs/README.md](./docs/README.md)**, which indexes everything else and marks what is
superseded.

---

## Quick start

```bash
npm install
cp .env.example apps/web/.env.local     # add ANTHROPIC_API_KEY + HEALDESK_GATE_SECRET
npm run dev:web                         # → http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Every workspace at once |
| `npm run dev:web` | Marketing site only (port 3000) |
| `npm run dev:app` | The product, `apps/app`, only (port 3001) |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | Typecheck all workspaces |

Lead-gen runs on demand:

```bash
npm run discover -w @healdesk/leadgen -- --location "Austin, Texas"
```

---

## ⚠️ The PHI boundary

`apps/web` handles **no PHI** and can deploy anywhere. `apps/app` handles every patient
conversation: call transcripts (no call audio is kept), web chats, and Meta DMs that are
kept non-clinical by design. It also holds bookings, deposit status and the clinic portal,
so it needs **BAA-covered infrastructure**. POS read-back for attribution is phase two.

They share this repo and split at deploy. A repo split is not required: the compliance
boundary is about where data flows and who signed a BAA, not where code lives.

**Vercel signs BAAs only on Enterprise.** Two Vercel projects give the correct
*architecture* split, not *coverage*. So:

1. The split is built now — two projects, one repo.
2. `apps/app` stays free of Vercel-specific APIs (`output: "standalone"`, plain `pg` over
   `DATABASE_URL`, no edge runtime) so it can move to AWS (or any BAA-covered host)
   without a rewrite.
3. **No real PHI touches `apps/app` until coverage is in place.** Synthetic data only.

Read [docs/hipaa-compliance.md](./docs/hipaa-compliance.md) before writing anything that
touches patient data.

---

## The chat demo

The marketing site runs a **live** Claude conversation, not a script — visitors can ask a
med-spa or fertility front desk anything.

It is email-gated: submit an email, the server sets a signed HTTP-only cookie, and only
then does [`/api/chat`](./apps/web/src/app/api/chat/route.ts) answer. Every demo becomes a
lead, and the gate is the first line of abuse control alongside a per-IP rate limit and
hard caps on conversation length and `max_tokens`. Leads live in a Google Sheet in the
company Google account's Drive ([`apps/web/src/lib/sheets`](./apps/web/src/lib/sheets/client.ts)),
business contact data only: `apps/web` has no database client.

`ANTHROPIC_API_KEY` is read **only inside the Route Handler** and has no `NEXT_PUBLIC_`
prefix, so Next will never inline it into a client bundle. The original prototype called
`api.anthropic.com` straight from browser JavaScript; that route exists specifically to
close that hole.

---

## Deployment

| Workspace | Target | Root directory |
| --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` |
| `apps/app` | Vercel project #2 → BAA host (AWS, `us-east-1`) | `apps/app` |
| `apps/app` worker | Same BAA host, separate process | `apps/app` |
| `apps/app` voice endpoint (Retell custom-LLM WebSocket) | Same BAA host, separate long-lived process | `apps/app` |
| `packages/leadgen` | Not deployed | — |

Both Vercel projects point at this repo with different root directories, their own env
vars, and their own domains. The voice endpoint cannot run on Vercel at all: Retell holds a
WebSocket open for the whole call, which a route handler cannot accept. See
[CLAUDE.md](./CLAUDE.md) → Deployment.

---

## Status

Read out of the code on 30 September 2026. The spec's "Launch plan" tab is the task list;
this is only a summary.

- ✅ Marketing site — hero, six-specialty strip, live chat + voice demo, ROI calculator,
  attribution section. The demo call still runs through Synthflow until the Retell agent
  exists. Any copy claiming collected or recovered revenue is phase two and has to come out
  of v1 copy.
- ✅ Server-side gated chat route
- ✅ Lead-gen pipeline
- ✅ Click-through BAA — version 1.0.0 approved by counsel and enforced: provisioning refuses
  an unapproved template
- ✅ Entitlements + billing lifecycle — per-clinic channel and allowance entitlements,
  Stripe invoice/subscription/dispute events handled
- ⏸ Attribution data model and reconciliation (`apps/app/src/db/schema.ts`,
  `src/lib/attribution`, `src/lib/sync`) — built, phase two, fenced out of v1 flows and
  claims
- ⬜ Pricing — five channel-priced packages in `packages/catalog` (monthly + annual +
  one-time setup fee, no trial) and `stripe:setup` exist, but the pricing page is not
  final: the overage rates ($0.80/min; $0.40/conversation on the single-channel chat package, $0.30 on the rest, set 5 October 2026) are provisional until measured,
  and WhatsApp service replies inside Meta's window become billable on 1 October 2026
- ⬜ Provisioning on the first paid invoice — today the Stripe webhook in `apps/web`
  creates the account on `checkout.session.completed`, and `invoice.paid` only activates it
- ⬜ Voice on Retell — the custom-LLM WebSocket endpoint in `apps/app`, a number in the
  clinic's area code allocated at payment, the three coverage modes. Not built;
  `apps/app/src/lib/voice` still ingests Synthflow payloads
- ⬜ Web chat widget — not built
- ⬜ Meta bot booking and payment links inside the 24-hour window — not built.
  `apps/app/src/lib/meta` holds an earlier front-door handler that books nothing. Meta
  Business Verification of Viixi FZC, App Review and WhatsApp Tech Provider status are
  pending
- ⬜ Google Calendar booking — OAuth connection, idempotent writes, 60-second slot holds,
  manual booking mode, and Google's verification of the calendar scope. Not built
- ⬜ Clinic portal (seven screens) and the four-step onboarding wizard — not built

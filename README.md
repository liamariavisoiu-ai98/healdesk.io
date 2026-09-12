# healdesk.io

Vertical AI front-desk / voice-agent service for high-ticket elective healthcare.

Answers every call, text, and DM — then shows the clinic which recovered call became
**collected revenue**. That last part is the wedge: every other AI receptionist writes
*into* the booking system and never reads the money back *out* of the point-of-sale.

---

## Layout

```
healdesk.io/
├── apps/
│   ├── web/          Marketing site + live chat demo   → Vercel #1 (no PHI)
│   └── app/          Product console + data model      → Vercel #2 (PHI boundary)
├── packages/
│   └── leadgen/      Prospecting pipeline (Apify + Claude)
└── docs/             PRD, ICP, lead-gen playbook, architecture, HIPAA
```

Start with **[docs/README.md](./docs/README.md)** — it indexes everything and explains how
the pieces relate.

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
| `npm run dev:app` | Product console only (port 3001) |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | Typecheck all workspaces |

Lead-gen runs on demand:

```bash
npm run discover -w @healdesk/leadgen -- --location "Austin, Texas"
```

---

## ⚠️ The PHI boundary

`apps/web` handles **no PHI** and can deploy anywhere. `apps/app` handles intake, consent,
clinical notes, and POS reconciliation — it needs **BAA-covered infrastructure**.

They share this repo and split at deploy. A repo split is not required: the compliance
boundary is about where data flows and who signed a BAA, not where code lives.

**Vercel signs BAAs only on Enterprise.** Two Vercel projects give the correct
*architecture* split, not *coverage*. So:

1. The split is built now — two projects, one repo.
2. `apps/app` stays free of Vercel-specific APIs (`output: "standalone"`, plain `pg` over
   `DATABASE_URL`, no edge runtime) so it can move to AWS / Fly / Render + Supabase or Neon
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
hard caps on conversation length and `max_tokens`.

`ANTHROPIC_API_KEY` is read **only inside the Route Handler** and has no `NEXT_PUBLIC_`
prefix, so Next will never inline it into a client bundle. The original prototype called
`api.anthropic.com` straight from browser JavaScript; that route exists specifically to
close that hole.

---

## Deployment

| Workspace | Target | Root directory |
| --- | --- | --- |
| `apps/web` | Vercel project #1 | `apps/web` |
| `apps/app` | Vercel project #2 → BAA host | `apps/app` |
| `packages/leadgen` | Not deployed | — |

Both Vercel projects point at this repo with different root directories, their own env
vars, and their own domains.

---

## Status

- ✅ Marketing site — hero, six-specialty strip, live chat + voice demo, ROI calculator, attribution section
- ✅ Server-side gated chat route
- ✅ Attribution data model (`apps/app/src/db/schema.ts`)
- ✅ Lead-gen pipeline
- ✅ Click-through BAA — version 1.0.0 approved by counsel and enforced: provisioning refuses an unapproved template
- ✅ Pricing — five channel-priced packages in `packages/catalog`, monthly + annual + one-time setup fee, no trial; `stripe:setup` creates the 17 prices and 2 meters
- ✅ Entitlements + billing lifecycle — per-clinic channel and allowance entitlements, Stripe invoice/subscription/dispute events handled (this pass)
- ⬜ Product console — auth, connectors, reconciliation job (see the console page for the ordered list)
- ⬜ Voice — Synthflow is the vendor; clinics forward their existing number to a Synthflow-issued one. Agent provisioning and the forwarding page are not built yet

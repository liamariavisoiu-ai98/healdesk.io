# Cold-Email Infrastructure — Step-by-Step Execution

From nothing to 30 warmed mailboxes. Companion to
[coldemail-infra-runbook.md](./coldemail-infra-runbook.md); where the two disagree, **this
file wins** — the runbook was written before the live APIs were read, and §11 of it says as
much ("open items to confirm in-dashboard, not fabricated here").

Every endpoint below was fetched from live documentation on 2026-08-09 and put through an
adversarial verification pass. Endpoints marked ⚠️ could not be confirmed and must be tested
against your account before you build on them.

- `[HUMAN]` — a person must do it (payment, login, dashboard-only setting)
- `[CODE]` — scriptable; the script is named where one exists
- **GATE** — do not continue past this until it passes

Record every gate result and every paid authorization in [run-log.md](./run-log.md).

---

## Corrections to the runbook (read before executing)

Fifteen things the runbook gets wrong or omits. Several change what you actually do.

| # | Runbook says | Reality | Impact |
|---|---|---|---|
| 1 | Provision via the **Orders API** (`POST /orders`) | `POST /orders` **registers domains AND makes mailboxes in one call**. You already own the domains at Cloudflare, so the correct call is `POST /mailboxes/buy` on already-connected domains | **Changes the core provisioning step** |
| 2 | Poll order status for `queued, checking_availability, registering, creating_mailboxes, completed, error` | Those states do not appear in the docs. Real polling is `POST /mailboxes/status`, with lifecycle states listed in Step 12 | Runbook's state machine is unusable |
| 3 | `[CODE]` ramp warmup volume ~5/day | **The API cannot set warmup volume.** Warmup has exactly 8 endpoints; the only writable fields are `mailbox_uids` and `activate_immediately`. Ramp is auto-managed | Step becomes `[HUMAN]` dashboard-only |
| 4 | `[CODE]` taper warmup to 10–15/inbox/day during outreach | Same — no API. Dashboard default target is **40/day**, not 12 | Cannot be scripted |
| 5 | Domain registration is `[HUMAN]`-only | Cloudflare **does** have a registration API (`POST /registrar/registrations`, beta) | Optional automation; see Step 3 |
| 6 | Cost table: $99 + $90 + domains | Omits **$30 per Azure tenant** for the Microsoft half | Month-1 cash is higher than $293 |
| 7 | Google MX | InboxKit writes **`smtp.google.com`**, not `aspmx.l.google.com` | Naive MX checks false-fail |
| 8 | — | InboxKit's default DMARC sets `rua=mailto:reports@inboxsetup.com` — **reports go to the vendor, not you** | You stay blind to auth failures |
| 9 | — | Microsoft provisioning has a `waiting_for_activation_email` state | A human must click a Microsoft activation email |
| 10 | Brand domain is `healdesk.ai` | `healdesk.ai` is **unregistered**. Your brand is `healdesk.io` (registered 2026-08-07, parked, no MX/SPF/DMARC) | Guardrail must say `.io`; reply routing unsolved |
| 11 | — | Warmup batch calls cap at **100 mailboxes** and return `results.success[]` / `results.failed[]` | Must inspect `failed[]`, not HTTP status |
| 12 | — | The InboxKit API is **RPC-style POST**, not REST. Listing uses POST; IDs go in the body, not the path | Do not assume `/resource/{id}` |
| 13 | — | **Prewarm** sells mailboxes already 2–8 weeks warmed at $6–9 each | Could collapse the 8-week timeline; see Step 0 |
| 14 | .com ≈ $10.44/yr | Cloudflare publishes **no** .com price reachable publicly (FAQ target 403s) | Confirm at runtime via `registrar/domain-check` |
| 15 | 6-week send window | Model says 5.0 weeks sending but **8.0 weeks end-to-end** from a standing start | Plan the calendar on 8 |

Two further notes. InboxKit is contractually a **reseller** of Google/Microsoft accounts, not
the licensor — its ToS disclaims liability for account outcomes. And InboxKit sells its own
inbox-placement testing at $0.05/mailbox; useful telemetry, but runbook §9 is right that your
go/no-go must be an independent seed test.

---

## Step 0 — Two decisions before spending `[HUMAN]`

**0a. Reply routing.** `healdesk.io` has no MX, SPF, or DMARC and is parked at Hostinger. Cold
mail will link to it, and replies must land somewhere a person reads. Decide: mailbox on
`healdesk.io`, or route replies to an existing address. This does not block Steps 1–3 but must
be solved before the first live send.

**0b. Build vs buy the warmup.** The model says **8 weeks** from standing start to last send.
Prewarm sells mailboxes already warmed 2–8 weeks:

| | Standard build | Prewarm |
|---|---|---|
| Time to first send | ~3 weeks warmup | Same day |
| Cost | plan + $3/mbx warmup | $6–9/mailbox + ~$15/domain |
| Domain control | your Cloudflare, your names | InboxKit inventory, transferred |
| Brand match | `gethealdesk.com` etc. | whatever inventory exists |

Prewarm domains will **not** be Healdesk-branded. For cold outreach where the sender name
carries the brand, that is a real cost. Recommend the standard build and accept 8 weeks.

---

## Phase 1 — Domains at Cloudflare

### Step 1 — Confirm availability `[CODE]` ✅ done

All 10 were free as of 2026-08-09 (`whois`). Re-check immediately before buying — availability
is not a reservation.

```bash
for d in $(node -e "import('./scripts/outreach/lib/domains.mjs').then(m=>console.log(m.ALL_DOMAINS.join(' ')))"); do
  whois "$d" | grep -qiE '^\s*(No match|NOT FOUND)' && echo "$d AVAILABLE" || echo "$d TAKEN"
  sleep 1
done
```

If any is taken, substitute in the same style (`get/try/use/join` prefix, `pro/hub/app/co/team`
suffix), change it in [scripts/outreach/lib/domains.mjs](../../scripts/outreach/lib/domains.mjs)
— the single source of truth every script reads — and record it in the run log.

### Step 2 — Cloudflare account `[HUMAN]`

Sign in at dash.cloudflare.com and add a payment method. No minimum account age applies —
Registrar is available on all plans, including Free.

### Step 3 — Register all 10 `[HUMAN]` 💵 GATE: authorization

**This is the first charge.** Record explicit authorization in the run log before proceeding.

Dashboard path: **Domain Registration → Register Domains**, search each name, add to cart,
checkout. Cloudflare sells at cost with no markup — and *"those fees are non-refundable. All
renewals are final and Cloudflare will not issue refunds."* Verify the actual .com total at
checkout; Cloudflare does not publish the price anywhere publicly reachable.

<details>
<summary>Optional: register via API instead (beta)</summary>

Contrary to the runbook, registration is scriptable:

```bash
# 1. Confirm .com is registrable through the API beta (only a subset of TLDs are)
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/registrar/extensions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | select(.name=="com")'

# 2. Authoritative price + availability, up to 20 domains per call. Docs: always call this
#    immediately before registering. domain-search is cached and explicitly non-authoritative.
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/registrar/domain-check" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"domains":["gethealdesk.com","tryhealdesk.com"]}' | jq '.result.domains'

# 3. Register — BILLABLE, charges the account default payment method. ONE domain per call.
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/registrar/registrations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"domain_name":"gethealdesk.com","years":1,"auto_renew":true}'

# 4. 201 = done inside the ~10s wait window. 202 = still running; poll to terminal state.
curl -s ".../registrar/registrations/gethealdesk.com/registration-status" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Three footguns:

- **`auto_renew` defaults to `false`.** Set it explicitly or the fleet silently lapses in a year,
  mid-campaign. The dashboard default differs — this is an API-only trap.
- **No bulk registration.** `domain_name` is a single string, not an array. Ten domains means ten
  billable calls. Only `domain-check` batches (max 20).
- **Registrant contact required.** If `contacts` is omitted the account's default address-book
  entry is used, and *"if no default exists and no contact is provided, the request fails"* —
  with *"no API exists for managing address book entries at this time"*. Set a default in the
  dashboard first.

Beta limits, verbatim: only a subset of TLDs are available; renewals, transfers and contact
updates are **not** yet available via API. Registrations are non-refundable once
`state: succeeded`. Given guardrail §9 ("never register domains without a recorded human
authorization"), the dashboard remains the recommended path.
</details>

### Step 4 — Scoped API token `[HUMAN]`

**My Profile → API Tokens → Create Token → Create Custom Token.**

- Permissions: `Zone → DNS → Edit` **and** `Zone → Zone → Read` (the second is needed to list
  zones and read status; the runbook omits it and the script will fail without it)
- Zone Resources: **Include → Specific zone** → add all 10, one row each
- Never the Global API Key: it is account-wide, cannot be scoped, and leaking it exposes
  `healdesk.io` too

Export it — never commit it:

```bash
export CLOUDFLARE_API_TOKEN='cfut_...'
export CLOUDFLARE_ACCOUNT_ID='...'   # Dashboard > any zone > Overview > right sidebar
```

### Step 5 — Verify token and zones `[CODE]` **GATE**

```bash
node scripts/outreach/cf-verify-zones.mjs
```

Validates the token via `GET /user/tokens/verify`, lists zones with pagination, asserts all 10
are `status: active`, and writes `docs/outreach/zone-ids.json` for later steps. Exit 0 = gate
passed.

Zone states that are **not** ready: `initializing` (setup started, no plan selected — Cloudflare
answers no DNS queries at all, auto-deleted after 28 days), `pending` (nameservers not yet
propagated), `moved` (failed DNS checks). Only `active` means Cloudflare is authoritative and
InboxKit can write records.

> **GATE 1:** 10/10 zones active, token verified. Record zone IDs in the run log.

---

## Phase 2 — Mailboxes on InboxKit

Base URL `https://api.inboxkit.com/v1/api`. Every call needs `Authorization: Bearer $INBOXKIT_API_KEY`;
most also need `X-Workspace-Id`.

### Step 6 — Account, key, wallet `[HUMAN]` 💵

Create the account, then **Settings → API** for the key. Choose the plan:

| Plan | Monthly | Annual | Slots | Extra mailbox |
|---|---|---|---|---|
| Professional | $39 | $31/mo | 10 | $3.50 / $3.10 |
| **Agency** | **$99** | **$81/mo** | **30** | $2.70 |
| Enterprise | $299 | $250/mo | 100 | $2.50 |

Agency at 30 slots is an exact fit. **Plus $30 per Azure tenant** for the Microsoft half —
confirm at checkout how many tenants 5 Microsoft domains require; if it is one per domain that
is +$150, not +$30. This is the single largest unknown in the budget.

```bash
export INBOXKIT_API_KEY='...'
curl -s https://api.inboxkit.com/v1/api/account -H "Authorization: Bearer $INBOXKIT_API_KEY" | jq
curl -s https://api.inboxkit.com/v1/api/workspaces/list -H "Authorization: Bearer $INBOXKIT_API_KEY" | jq
export INBOXKIT_WORKSPACE_ID='<uid from above>'

# Live pricing rather than trusting this table, and wallet balance
curl -s https://api.inboxkit.com/v1/api/billing/pricing-plans -H "Authorization: Bearer $INBOXKIT_API_KEY" | jq
curl -s https://api.inboxkit.com/v1/api/warmup/pricing -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" | jq
curl -s https://api.inboxkit.com/v1/api/billing/wallet -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" | jq
```

### Step 7 — Sender identities `[CODE]` ✅ done

```bash
node scripts/outreach/gen-identities.mjs
```

30 identities in [sender-identities.csv](./sender-identities.csv) — 15 Google, 15 Microsoft, all
local-parts unique, patterns mixed `firstname@` / `firstname.lastname@` within each domain so
three mailboxes on one domain don't share a fingerprint. Deterministic: re-run and diff.

### Step 8 — Connect Cloudflare zones `[CODE]`

One endpoint takes the token. This is the no-nameserver-change path — InboxKit writes into
*your* zones and you keep control.

```bash
curl -s -X POST https://api.inboxkit.com/v1/api/cloudflare-domains/connect \
  -H "Authorization: Bearer $INBOXKIT_API_KEY" \
  -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"api_token\":\"$CLOUDFLARE_API_TOKEN\", \"domains\":[...]}"   # confirm exact body shape against docs

curl -s https://api.inboxkit.com/v1/api/cloudflare-domains/zones -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" | jq
curl -s https://api.inboxkit.com/v1/api/cloudflare-domains/list  -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" | jq
```

This endpoint is rate-limited and returns a 429 with *"Too many connect requests. Please wait a
few minutes and try again."* — connect in one call, not ten.

Do **not** use `POST /domains/nameservers`: that is the alternative route where InboxKit creates
zones in *its own* Cloudflare and you repoint your registrar at them. You would lose DNS control.

> **GATE 2:** all 10 zones show connected with healthy credentials.

### Step 9 — Authorize provisioning `[HUMAN]` 💵

The charge point. Record authorization in the run log. Do not let this run unattended.

### Step 10 — Buy mailboxes `[CODE]`

**Use `POST /mailboxes/buy`, not `POST /orders`.** Orders registers domains *and* provisions;
you already own the domains, so `mailboxes/buy` provisions onto domains already in the
workspace. This is correction #1 and the most consequential departure from the runbook.

Three mailboxes per domain, matching InboxKit's own "Rule of 3". Provision in two batches by
platform (`GOOGLE` / `MICROSOFT`), feeding names from the CSV. Confirm the exact request body
against `https://docs.inboxkit.com/` before firing — the platform enum and field names must
come from the live spec, not from here.

### Step 11 — Poll provisioning `[CODE]`

```bash
curl -s -X POST https://api.inboxkit.com/v1/api/mailboxes/status \
  -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" \
  -H 'Content-Type: application/json' -d '{"mailbox_uids":[...]}' | jq
```

Real lifecycle states — use these, not the runbook's list:

- **Pre-active:** `pending`, `processing`, `waiting_for_dns_propagation`,
  `waiting_for_activation_email` *(Microsoft)*, `activation_email_received`,
  `configuring_workspace`, `configuring_dns`, `configuring_dkim`, `configuring_auth`,
  `finalizing_setup`
- **Active:** `active`, `inactive`, `scheduled`
- **Failure:** `suspended`, `failed`, `renewal_failed`, `scheduled_for_cancellation`

`waiting_for_activation_email` is a **`[HUMAN]` step** — Microsoft sends an activation mail
someone must action. The Microsoft half will stall here until a person intervenes.

On `failed`, get the reason rather than retrying blindly:

```bash
curl -s -X POST https://api.inboxkit.com/v1/api/mailboxes/failure-reason ... | jq
```

⚠️ `GET /orders/:id` appears only in InboxKit's marketing guide, not the API reference — the
official Order folder contains exactly one endpoint (Place Order). Don't build on it.

Optionally register a webhook (`POST /workspaces/webhook`) for `mailbox.status_changed` instead
of polling.

### Step 12 — Verify DNS both ways `[CODE]` **GATE**

Two independent checks that must agree.

```bash
# 1. InboxKit's view, cross-checked against Cloudflare (up to 50 domains/call)
curl -s -X POST https://api.inboxkit.com/v1/api/dns/verify \
  -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" \
  -H 'Content-Type: application/json' -d '{"domains":[...]}' | jq

# 2. Public DNS — what a receiving mail server actually sees
node scripts/outreach/verify-dns-auth.mjs
```

The second is the one that counts, and it is deliberately vendor-independent: it resolves
against 1.1.1.1 and 8.8.8.8 and checks SPF (exactly one record, terminal `all`, not `+all`),
DKIM (`google` selector for Google, `selector1`/`selector2` for Microsoft), DMARC (single
record, valid `p=`), and MX (provider match). Exit 1 = at least one domain must be held back.

Expected values InboxKit writes: MX `smtp.google.com`; SPF `v=spf1 include:_spf.google.com ~all`;
DMARC `v=DMARC1; p=reject; pct=100; rua=mailto:reports@inboxsetup.com; ruf=...`.

**Change that DMARC.** As shipped, aggregate reports go to InboxKit, so you never see your own
authentication failures. Add an address you control via `POST /domains/dmarc`. The script now
flags this automatically. If records are missing or wrong, `POST /dns/repair` rewrites MX, SPF,
DKIM and DMARC and pushes them to Cloudflare.

> **GATE 3:** 30 mailboxes active; both DNS checks pass on all 10 domains. Any domain failing
> auth is held back, not shipped and watched.

### Step 13 — Export credentials `[CODE]`

`GET /mailboxes/show-credentials` returns SMTP/IMAP details and passwords per mailbox. Write to
a secure local store — **never** the repo, never a log. `*.csv` is gitignored outside `docs/`;
keep credentials out of `docs/` entirely. `GET /mailboxes/generate-totp` covers 2FA where
enabled.

---

## Phase 3 — Warmup

### Step 14 — Enable warmup, staggered `[CODE]`

```bash
curl -s -X POST https://api.inboxkit.com/v1/api/warmup/add \
  -H "Authorization: Bearer $INBOXKIT_API_KEY" -H "X-Workspace-Id: $INBOXKIT_WORKSPACE_ID" \
  -H 'Content-Type: application/json' \
  -d '{"mailbox_uids":["..."],"activate_immediately":true}' | jq '.results'
```

Max 100 mailboxes per call. The response is a **partial-success envelope** — inspect
`results.failed[]` per mailbox; a 200 does not mean all succeeded.

Stagger 5 mailboxes every 3 days across 6 cohorts. See the schedule:

```bash
node scripts/outreach/plan-schedule.mjs --start 2026-08-18
```

### Step 15 — Warmup ramp `[HUMAN]` — *not scriptable*

Correction #3. **The API cannot set warmup volume.** Warmup exposes exactly 8 endpoints (List,
Details, Add, Pause, Resume, Cancel, Stats, Pricing) and the only writable fields are
`mailbox_uids` and `activate_immediately`. The words *volume*, *ramp* and *target* appear
nowhere in their schemas.

InboxKit auto-manages the ramp. Dashboard defaults: **start 2/day, +2/day, target 40/day**, with
30–50% inbox reply rate. Tunable in the dashboard only. Runbook §4 step 3 says "follow InboxKit's
default ramp if it manages this automatically; do not override it upward" — that is the correct
instruction, and it is now the *only* available instruction.

Same applies to the Phase 5 taper to 10–15/inbox/day: dashboard-only, and the default target is
40/day, so it is an active change someone must make.

Monitor rather than control:

```bash
curl -s -X POST https://api.inboxkit.com/v1/api/warmup/list ...   # health per subscription (POST, not GET)
curl -s "https://api.inboxkit.com/v1/api/warmup/details?mailbox_uid=..." ...
curl -s https://api.inboxkit.com/v1/api/warmup/stats ...
curl -s "https://api.inboxkit.com/v1/api/email-insights/mailbox/<uid>/warmup-stats" ...  # SPF/DKIM/DMARC pass rates
```

Health score composition (dashboard metric, no API): Inbox Rate 40%, Spam Avoidance 35%, Bounce
Avoidance 15%, Promotions Avoidance 10%. Tiers: 90–100 Excellent, 70–89 Good, 50–69 Warning,
0–49 Critical.

### Step 16 — Wait. Send nothing. `[HUMAN]`

No live cold email during warmup. InboxKit's own duration claims conflict across their pages —
"14 Days to Full Capacity" on one, "14–28 days" on another. The runbook's 2–3 weeks sits inside
that. **The gate is the measurement in Step 17, not the calendar.**

---

## Phase 4 — The real go/no-go

### Step 17 — Independent seed test `[CODE]` **GATE**

After ~3 weeks of warmup, run a **GlockApps or MailReach** seed test — not InboxKit's. InboxKit
does sell placement testing (`POST /inbox-placement/tests`, $0.05/mailbox) and it is useful
telemetry, but runbook §9 is right: a vendor grading its own warmup cannot be the gate. Use it
as a cheap early signal, then confirm independently.

**The unit of testing is one sending address.** Both vendors count 1 test = 1 mailbox, so full
fleet coverage is 30 tests. Both also warn, in almost identical language, that the test must be
sent *from the exact production setup* — same domain, same ESP, same mailbox. A test from
anywhere else measures nothing.

| | GlockApps | MailReach |
|---|---|---|
| Free tier | **2 tests total** (one-off trial) | **3 tests per rolling 24h** |
| Paid | Essential $59/mo → 360 credits | Credit packs from 20 |
| API | On all plans incl. free ¹ | Yes — but *it does not send for you* |
| Seed list | 100+ addresses, splittable in 25s | 30+ mailboxes, 4 rotatable variants |
| Provider split | Separate `googleApps` and `microsoftEOP` objects | `btob_score` = Google Workspace + M365 only |
| Gmail tabs | Inbox / Tabs / Spam broken out | inbox / categories / spam / missing |
| Latency | "almost immediately", no SLA | 3–5 min; poll every 10–15s |

¹ Contradicted by a help-centre article updated 2025-12-04 saying API is custom-subscription
only. Confirm on your account before scripting against it.

**Recommendation.** GlockApps' free tier is 2 tests total — not enough to gate a 30-mailbox
fleet, and not a recurring allowance. Either buy Essential ($59) for 360 credits, which also
covers the weekly re-tests for the mailbox lifetime, or use MailReach's 3-per-24h free quota and
spread full coverage across ~10 days. For a one-off gate the free MailReach route works; for the
weekly monitoring the runbook mandates, budget the $59.

Note MailReach's API only *prepares* a test and returns the recipient list — your own code must
do the sending from each mailbox. Budget for that; it is not a one-call integration.

- Score Google and Microsoft mailboxes **separately** — they behave differently, and both tools
  expose the split natively
- Require **≥85% primary-inbox** on each provider. Count Gmail *Promotions* as a miss: both
  tools separate tabs from Inbox, and Promotions is not the primary inbox
- Below 85%: hold, keep warming, retest in several days. Do not start outreach to hit a date
- Rotate MailReach's seedlist variant between runs to avoid single-seedlist skew
- Schedule weekly for the mailbox lifetime

> **GATE 4:** ≥85% verified primary placement on both providers, from an independent seed list.
> This is the only gate that authorizes live sending.

---

## What this produces

| | |
|---|---|
| Domains | 10, owned in your Cloudflare, DNS under your control |
| Mailboxes | 30 — 15 Google Workspace, 15 Microsoft 365 |
| Auth | SPF, DKIM, DMARC, MX verified two independent ways |
| Warmup | isolated network, auto-ramped, never switched off |
| First live send | ~3 weeks in, gated on measured placement |
| End-to-end | **8.0 weeks** to the 14,800th send |

Recurring: $99 Agency + ~$90 warmup + $30/Azure tenant (verify count) ≈ **$219+/mo**, above the
runbook's $189. Month 1 adds ~$104 of domains. Optional InfraGuard is $3/domain/mo.

Phases 5–7 of the runbook (Instantly, cold ramp, monitoring) begin after Gate 4 and are outside
this document.

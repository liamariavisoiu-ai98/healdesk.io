# Healdesk Cold-Email Infrastructure Runbook

Purpose: stand up the sending infrastructure for the first outreach batch. Domains registered and owned at Cloudflare, mailboxes provisioned and warmed on InboxKit's isolated network, sending sequenced through Instantly.

This file is written for execution by Claude Code. Steps are tagged `[HUMAN]` (a person must do it, usually a purchase, a login, or a payment authorization) or `[CODE]` (Claude Code can script it against an API once credentials exist). Read every `[HUMAN]` gate before running anything after it. Do not skip the verification gates.

Money is spent in Phase 2 and Phase 1. Do not place any paid order without an explicit human go-ahead recorded in the run log.

---

## 0. Config

All parameters for this build. Treat as the single source of truth.

```yaml
batch:
  leads: 3700
  touches: 4
  total_sends_ceiling: 14800          # 3700 x 4, plan to the ceiling
  send_window_weeks: 6                # warmup consumes weeks 1-3/4; a single
                                      # calendar month of live sending from a
                                      # standing start is not achievable

infrastructure:
  domains: 10
  mailboxes: 30
  mailboxes_per_domain: 3             # InboxKit supports 1-5; 3 keeps isolation
  # one domain = one provider. A domain does not host both Google and Microsoft
  # primary mailboxes at once. Provider-to-group assignment below is arbitrary
  # and can be swapped; the split just needs to be 5 domains each.
  google_domains:                     # 5 domains x 3 mailboxes = 15 GWS
    - gethealdesk.com
    - tryhealdesk.com
    - usehealdesk.com
    - healdeskapp.com
    - joinhealdesk.com
  microsoft_domains:                  # 5 domains x 3 mailboxes = 15 M365
    - healdeskpro.com
    - healdeskusa.com
    - healdeskteam.com
    - healdeskco.com
    - healdeskhub.com

registrar: cloudflare                 # domains owned in YOUR Cloudflare account
mailbox_provider: inboxkit
warmup_provider: inboxkit             # isolated network, NOT Instantly's shared pool
sequencer: instantly                  # sending only; Instantly warmup stays OFF

sending:
  cold_start_per_inbox_per_day: 8     # start 5-10
  cold_ramp_step_per_day: 5
  cold_cap_per_inbox_per_day: 27      # cap 25-30
  warmup_maintenance_per_inbox_per_day: 12   # keep 10-15 running during outreach
  no_live_cold_until_placement_verified: true

thresholds:
  bounce_rate_max: 0.02               # 2%, pause and slow if exceeded
  spam_complaint_target: 0.0008       # keep near zero, 0.08% is a repair trigger
  inbox_placement_min: 0.85           # independent seed test, not vendor dashboard

secrets:                              # never hardcode; read from env
  - CLOUDFLARE_API_TOKEN              # scoped to DNS edit on the 10 zones
  - INBOXKIT_API_KEY                  # from app.inboxkit.com > Settings > API
  - GLOCKAPPS_API_KEY_OR_SEED_LIST    # or MailReach equivalent
```

---

## 1. Pre-flight gate (do not spend until cleared)

`[HUMAN]` Answer three questions before committing the ~$293 first-month spend. The prior outreach attempt (ScaleBid) underperformed on deliverability. This stack only fixes that if the cause was the warmup pool. If the cause was authentication, list quality, or content, the same result repeats at a new cost.

1. What metric was disappointing: primary-inbox placement %, reply rate, spam-folder rate, or bounce rate?
2. Did that number come from an independent seed test, or from Instantly's own warmup dashboard?
3. Were SPF, DKIM, and DMARC verified valid on the ScaleBid domains, and was the list verified before sending?

If the answer points to the warmup pool, proceed. If it points to authentication, list, or content, fix that first. Record the answers in the run log before Phase 1.

`[HUMAN]` Confirm accounts exist: a Cloudflare account, an InboxKit account, an Instantly account, and a GlockApps or MailReach account.

---

## 2. Phase 1: Domains at Cloudflare

Goal: 10 domains registered and owned in your Cloudflare account, DNS managed by Cloudflare, with an API token InboxKit can use.

1. Domain list is finalized. These 10, all brand-variant lookalikes of healdesk.io, which is the standard cold-domain pattern (replies still read as legitimate). Do not use healdesk.io itself for cold sending (the brand domain's reputation is what the product runs on; burning it on cold outreach is irreversible).

   Google group (GWS): gethealdesk.com, tryhealdesk.com, usehealdesk.com, healdeskapp.com, joinhealdesk.com
   Microsoft group (M365): healdeskpro.com, healdeskusa.com, healdeskteam.com, healdeskco.com, healdeskhub.com

2. `[HUMAN]` Register all 10 at Cloudflare Registrar (Dashboard > Domain Registration > Register Domains). At-cost pricing, roughly $10 to $11 per .com. Registration is a payment action and stays a human step. If any name is already taken, pick a replacement in the same variant style (a verb prefix like `get/try/use/join` or a suffix like `pro/hub/app/co/team`) and record the substitution in the run log before proceeding.
3. `[CODE]` Once registered, confirm each domain is an active Cloudflare zone. Use the Cloudflare API `GET /zones` to list zones and assert all 10 are present and `status: active`.
4. `[HUMAN]` Create a scoped Cloudflare API token (My Profile > API Tokens > Create Token). Scope: `Zone.DNS Edit` limited to the 10 zones. Store it as `CLOUDFLARE_API_TOKEN`. Do not use the global key.
5. `[CODE]` Validate the token: `GET /user/tokens/verify`. Confirm it can read and edit DNS on all 10 zones before proceeding.

Gate: all 10 zones active, token validated. Record zone IDs in the run log.

---

## 3. Phase 2: Provision mailboxes on InboxKit

Goal: 30 mailboxes (15 Google, 15 Microsoft) provisioned by InboxKit onto your Cloudflare domains, with DNS auth written into your Cloudflare zones automatically.

Reference the live InboxKit API before writing any calls. Do not assume endpoint paths or payloads from this file. Fetch the current schema from `https://docs.inboxkit.com/` and the API integration guide at `https://www.inboxkit.com/learn/inboxkit-api-integration-guide`. The API exposes categories: Orders, Domains, Cloudflare Domains (5 endpoints), Mailboxes, DNS, Warmup, Inbox Placement, InfraGuard, Prewarm.

1. `[HUMAN]` In InboxKit, add funds or confirm the wallet/plan can cover Agency (30 slots, $99/mo) plus warmup (30 x $3/mo). Purchases below draw on this.
2. `[CODE]` Generate the sender-identity list as data: for each of the 30 mailboxes, a real-looking first and last name and a username pattern (`firstname@`, `firstname.lastname@`). Real identities improve warmup signal. Output as a CSV for the run log.
3. `[CODE]` Connect the Cloudflare zones to InboxKit via the Cloudflare integration endpoints. This authorizes InboxKit to write DNS without changing nameservers. Use `CLOUDFLARE_API_TOKEN`. Confirm each of the 10 zones shows connected in InboxKit.
4. `[HUMAN]` Authorize the paid provisioning order. This is the charge point. Do not let the agent place it unattended.
5. `[CODE]` Place the provisioning order via the Orders API, per the Config groups:
   - Google Workspace, 3 mailboxes each: gethealdesk.com, tryhealdesk.com, usehealdesk.com, healdeskapp.com, joinhealdesk.com (15 GWS)
   - Microsoft 365, 3 mailboxes each: healdeskpro.com, healdeskusa.com, healdeskteam.com, healdeskco.com, healdeskhub.com (15 M365)
   - Use the identity list from step 2 for mailbox names.
6. `[CODE]` Poll order status until `completed`. Provisioning typically finishes within ~48 hours. Handle the documented states (queued, checking_availability, registering, creating_mailboxes, completed, error). On `error`, pull the failure reason and surface it; do not retry blindly.
7. `[CODE]` Verify DNS: for every mailbox and domain, confirm SPF, DKIM, DMARC, and MX are present and valid. Use InboxKit's DNS verify endpoint and cross-check against the Cloudflare zone records directly (`GET /zones/:id/dns_records`). Both must agree. Authentication is the single largest deliverability determinant; do not proceed on any domain that fails this.
8. `[CODE]` Export mailbox admin credentials and connection details to a secure local store for later Instantly import. Never print secrets to logs.

Gate: 30 mailboxes provisioned, DNS valid on all 10 domains cross-checked at Cloudflare. Any domain failing auth is held back, not sent from.

---

## 4. Phase 3: Warmup on InboxKit isolated network

Goal: all 30 mailboxes warming on InboxKit's isolated network. Instantly warmup is never turned on.

1. `[CODE]` Enable InboxKit warmup on all 30 mailboxes via the Warmup endpoints.
2. `[CODE]` Stagger the start in batches (for example 4 to 6 mailboxes every 2 to 3 days) rather than all 30 at once. Staggering smooths later campaign capacity and leaves warm mailboxes available if one domain has an issue.
3. `[CODE]` Ramp warmup volume gradually (roughly 5/day in the first days building toward 30 to 40/day by weeks 2 to 3). Follow InboxKit's default ramp if it manages this automatically; do not override it upward.
4. Do not send any live cold email during this phase.

Gate is not a calendar date. See Phase 4.

---

## 5. Phase 4: Independent placement gate (this is the real go/no-go)

Goal: prove primary-inbox placement with a seed test you control, not with InboxKit's own warmup dashboard number.

1. `[CODE]` After roughly 2 to 3 weeks of warmup (4 to 6 weeks if any domain was previously flagged), run a GlockApps or MailReach seed-list test from a sample of mailboxes across both providers.
2. `[CODE]` Assert primary-inbox placement >= 85% (`thresholds.inbox_placement_min`). Test Google-provider and Microsoft-provider mailboxes separately; they behave differently.
3. `[CODE]` If below 85%, hold. Continue warmup, recheck in several days. Do not start outreach to clear a calendar deadline.
4. `[CODE]` Schedule this seed test to repeat weekly for the mailbox lifetime and log the result.

Gate: >= 85% verified primary placement on both providers. Only then proceed to Phase 5.

---

## 6. Phase 5: Connect to Instantly for sending

Goal: mailboxes connected to Instantly for sending only. InboxKit warmup stays ON as a maintenance baseline.

1. `[CODE]` or `[HUMAN]` Add the 30 mailboxes to Instantly (Instantly > Email Accounts > Add Account), using the exported credentials. InboxKit documents direct sequencer integration; use it if available, otherwise import per mailbox.
2. `[HUMAN]` Confirm Instantly's own warmup is OFF for all 30 accounts. This is the entire point of the setup. Do not enable it.
3. `[CODE]` Confirm InboxKit warmup is still running, tapered to a maintenance baseline of ~10 to 15/inbox/day (`sending.warmup_maintenance_per_inbox_per_day`). Warmup does not stop when outreach starts; the positive signal offsets the negative signal of cold sends.

Gate: all 30 in Instantly, Instantly warmup confirmed off, InboxKit maintenance warmup confirmed on.

---

## 7. Phase 6: Ramp cold sending

Goal: ramp to target volume without burning the domains.

1. `[CODE]` or `[HUMAN]` Start live cold at 8/inbox/day (range 5 to 10).
2. Ramp by ~5/day per inbox toward the cap of 27/inbox/day (range 25 to 30).
3. Keep InboxKit maintenance warmup at ~12/inbox/day throughout.
4. Capacity check: 30 inboxes x 27/day = 810/day at full ramp. Against 14,800 total sends, plan the window at ~6 weeks of live sending. A single calendar month from a standing start does not fit once warmup is subtracted.

---

## 8. Phase 7: Monitoring and throttle rules

`[CODE]` Build a monitoring job that polls daily and enforces these rules automatically.

- Bounce rate > 2% on any domain: pause that domain's campaigns immediately, keep its warmup running, investigate list quality.
- Spam complaints trending above ~0.08%: stop scaling, audit content and list, repair before continuing.
- Weekly seed placement < 85%: pause cold campaigns for the affected mailboxes, keep warmup on, do not resume sending until placement recovers.
- If placement drops, never stop warmup. Stopping warmup degrades reputation faster.

`[CODE]` Alert to a channel or the run log on any threshold breach. Do not auto-scale volume past the cap without a human go-ahead.

---

## 9. Guardrails (do not violate)

- Never send cold from healdesk.io (the brand domain's reputation is what the product runs on). Cold domains are disposable variants only.
- Never turn InboxKit warmup off once outreach starts.
- Never turn Instantly warmup on.
- Never start live cold before the 85% seed-placement gate passes.
- Never load a list into Instantly unless `packages/leadgen/data/*.csv` was regenerated after the last copy change and the leadgen copy-guard test passes (no win-backs, lapsed patients, reactivation, check-ins, follow-ups, reminders, SMS or texting, revenue, deposit on a call, "HIPAA compliant" or "live in N minutes"). The lists dated 22 September 2026 fail it. See STEP-BY-STEP.md Step 18.
- Never place a paid InboxKit order or register domains without a recorded human authorization.
- Never hardcode `CLOUDFLARE_API_TOKEN` or `INBOXKIT_API_KEY`. Read from env, never log them.
- Never trust a vendor's own warmup or placement percentage as the go/no-go. The seed test is the gate.
- Do not fabricate InboxKit or Cloudflare API endpoint signatures. Fetch the live docs and use the actual schema.

---

## 10. Cost reference (monthly billing, UAE)

| Item | Rate | Qty | Cost |
|---|---|---|---|
| Agency plan (30 mailbox slots) | $99/mo | 1 | $99/mo |
| Warmup | $3/mailbox/mo | 30 | $90/mo |
| Domains (Cloudflare, at-cost) | ~$10.44/yr | 10 | ~$104/yr |
| InfraGuard (optional) | free month 1, then ~$3/domain/mo | 10 | $0 month 1 |

Recurring: $189/mo (warmup stays on, so this does not drop after warmup). Month-1 cash: ~$293. VAT: expect no line on the invoice; both suppliers are US, billing USD, and the UAE 5% is reverse-charge, net zero for a VAT-registered entity. Verify on the checkout total with a UAE billing address.

---

## 11. Open items to confirm in-dashboard (not fabricated here)

- Exact InboxKit Cloudflare-zone connection click-path and the exact Orders/Warmup/Inbox-Placement endpoint schemas. Source: docs.inboxkit.com.
- Exact Cloudflare .com registration price at checkout.
- Whether any VAT appears on either checkout for a UAE billing address.
- InboxKit sending-IP region for the provisioned mailboxes (one third-party review disputes the US-IP claim). Confirm with InboxKit before scaling.

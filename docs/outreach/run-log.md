# Cold-Email Infrastructure — Run Log

Execution log for [coldemail-infra-runbook.md](./coldemail-infra-runbook.md).
Every `[HUMAN]` authorization and every gate result gets recorded here, newest phase last.

**Never record secrets in this file.** Token/key presence is logged as `set` / `not set` only.

---

## Phase 0 — Pre-flight recon (2026-08-09)

Free, non-spending checks run before the pre-flight gate.

### Domain availability — all 10 clear

Checked via `whois`, 2026-08-09. No substitutions needed; the Config list stands as written.

| Domain | Group | Status |
|---|---|---|
| gethealdesk.com | Google (GWS) | AVAILABLE |
| tryhealdesk.com | Google (GWS) | AVAILABLE |
| usehealdesk.com | Google (GWS) | AVAILABLE |
| healdeskapp.com | Google (GWS) | AVAILABLE |
| joinhealdesk.com | Google (GWS) | AVAILABLE |
| healdeskpro.com | Microsoft (M365) | AVAILABLE |
| healdeskusa.com | Microsoft (M365) | AVAILABLE |
| healdeskteam.com | Microsoft (M365) | AVAILABLE |
| healdeskco.com | Microsoft (M365) | AVAILABLE |
| healdeskhub.com | Microsoft (M365) | AVAILABLE |

### Brand-domain discrepancy — runbook says `.ai`, project is `.io`

The runbook describes the 10 domains as "brand-variant lookalikes of healdesk.ai" and
guardrails against sending from `healdesk.ai`. Actual state:

- `healdesk.ai` — **not registered**. Nobody owns it, including us.
- `healdesk.io` — **registered 2026-08-07** (2 days ago), registrar Hostinger, parked on
  `dns-parking.com` nameservers. This is the real brand domain
  (`NEXT_PUBLIC_SITE_URL=https://healdesk.io` in `.env.example`).
- `healdesk.com` — taken since 2019, GoDaddy, expires 2027. Not ours.

Consequences, unresolved:

1. The guardrail "never send cold from healdesk.ai" should read **healdesk.io**. The
   variant logic is unaffected — `get/try/use/join + healdesk + .com` reads as a brand
   variant regardless of the primary TLD.
2. `healdesk.io` has **no MX, no SPF, no DMARC** and is parked. It is not currently able to
   send or receive mail. Not a Phase 1 blocker, but it must be resolved before cold copy
   links to it or replies are routed to it.
3. `healdesk.io` is 2 days old. Domain age is a trust input; the cold domains will be
   younger still. Warmup is what covers this — it is a reason not to compress Phase 3.

### Credentials

| Secret | Status |
|---|---|
| `CLOUDFLARE_API_TOKEN` | not set |
| `INBOXKIT_API_KEY` | not set |
| `GLOCKAPPS_API_KEY_OR_SEED_LIST` | not set |

### ScaleBid post-mortem data

No campaign metrics, Instantly exports, or placement data found in
`/Users/liamariavisoiu/scalabid` — grep hits were unrelated application code.

**But the ScaleBid sending domains themselves are still live, and DNS answered question 3
empirically.** Fleet discovered by variant sweep, all registered 2026-04-08 (~4 months old,
fresh at send time), all on Cloudflare nameservers, all Google Workspace:

| Domain | NS | MX | SPF | DKIM (`google` selector) | DMARC |
|---|---|---|---|---|---|
| scalabidapp.com | Cloudflare | Google | valid | 2048-bit RSA published | `p=reject` |
| scalabidhq.com | Cloudflare | Google | valid | 2048-bit RSA published | `p=reject` |
| scalabidusa.com | Cloudflare | Google | valid | 2048-bit RSA published | `p=reject` |
| scalabidgroup.com | Cloudflare | Google | valid | 2048-bit RSA published | `p=reject` |

Full DMARC on all four: `v=DMARC1; p=reject; rua=…; ruf=…; adkim=r; aspf=r; fo=1;`
SPF on all four: `v=spf1 include:_spf.google.com ~all`

Root `scalabid.com` is separate — Microsoft 365, `p=none`, parked NS. Not a cold sender.

**Finding: authentication was correctly configured and is RULED OUT as the cause.** All
three mechanisms present and well-formed, with DMARC at the strongest policy (`p=reject`)
and failure reporting on. This is a better-built auth posture than most cold setups.

---

## Phase 1 — Pre-flight gate

**Status: NOT CLEARED. No spend authorized.** The gate does not pass, but not for the
reason the runbook anticipated.

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Which metric was disappointing? | Inbox placement | Human, 2026-08-09 |
| 2 | Source of that number? | **Instantly's own dashboard** | Human, 2026-08-09 |
| 3 | SPF/DKIM/DMARC valid? | **Yes — all three, all 4 domains** | DNS, 2026-08-09 |
| 4 | List verified before sending? | Unknown / not remembered | Human, 2026-08-09 |

### Why the gate does not clear

The runbook's rule is "if the answer points to the warmup pool, proceed." The answers do
not point anywhere with enough confidence to justify the spend:

- The **only evidence** of a placement problem is Instantly's own dashboard — which
  §9 of this very runbook forbids as a go/no-go ("never trust a vendor's own warmup or
  placement percentage"). The problem has never been independently measured.
- **Authentication is now ruled out** (above), which removes the largest confounder but
  does not by itself implicate the warmup pool.
- **List quality remains unmeasured** and is a live alternative explanation.

Net: the thesis "the shared warmup pool caused it" is *unfalsified*, not *established*.

### What the new stack actually changes

ScaleBid already ran: Cloudflare-hosted brand-variant lookalike domains, Google Workspace
mailboxes, correct SPF/DKIM/DMARC. That is most of what Phases 1–2 of this runbook rebuild.
The genuinely new variables are only:

1. InboxKit isolated warmup pool instead of Instantly's shared pool
2. A Microsoft/M365 half alongside the Google half
3. 30 mailboxes instead of ~4 domains' worth

So the $293 buys a change to essentially **one suspected variable**, chosen on the strength
of a number the runbook says not to trust.

### Blocking action before any spend

Run an independent seed test **from the existing ScaleBid mailboxes**. They are alive, aged
4 months, and correctly authenticated. Cost ~$0–59 (GlockApps free tier is 3 tests/month)
versus $293 to rebuild blind. Turnaround ~1 day.

- Result **≥85%** → placement was never the problem; the dashboard misled. Do not rebuild.
  Redirect effort to list verification and copy.
- Result **<85%** despite clean auth → reputation/warmup-pool is the live suspect, the
  runbook's thesis holds, and Phase 2 spend is justified.

Caveats to state honestly: (a) this requires the ScaleBid Google Workspace tenant to still
be active — DNS cannot confirm billing status; (b) current placement reflects any damage
accumulated since the campaign, so a poor result proves reputation harm exists without
perfectly isolating the shared pool as its cause.

**Decision: HOLD.** Do not register domains or place the InboxKit order until the seed test
returns a number.

### Accounts confirmed to exist

Cloudflare / InboxKit / Instantly: **confirmed by the founder, 5 Sep 2026.**
GlockApps-or-MailReach: still unconfirmed — see the open item below.

---

## Authorizations

Paid actions require an explicit, dated human go-ahead recorded here before execution.

| Date | Action | Est. cost | Authorized by | Notes |
|---|---|---|---|---|
| 2026-09-05 | Register 10 domains at Cloudflare Registrar | ~$104/yr | Founder | **Done.** All 10 registered. |
| 2026-09-05 | InboxKit Agency plan + warmup | ~$189/mo | Founder | **Done.** Mailboxes provisioned and warmed. |

Both entries were recorded retrospectively on 5 Sep 2026, after the founder
confirmed the work was already complete. Noting that rather than back-dating an
authorization that was never written at the time — the value of this table is
that it reflects what actually happened, and a tidied one would not.

### The HOLD above is now spent, not lifted

The decision recorded earlier was to hold until a seed placement test returned a
number. Domains and mailboxes were bought before that test ran, so the gate it
described no longer has anything to gate — the money is committed either way.

What it protected is still worth having, and now applies one step later: run the
independent placement test (Phase 5 in the runbook) BEFORE the first cold send,
not before the purchase. A warmed mailbox that lands in spam is a mailbox that
burns its domain on the first campaign, and 21 days of warmup with it.

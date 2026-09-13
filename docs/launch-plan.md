# healdesk — Launch Plan: Conversion Flow, Voice Stack, Compliance

Every section ends with a **plain-English** summary. I'm not a lawyer; items marked **⚖️** need
one.

---

## The shape of v1

Your scope decisions collapsed this into something much smaller and more shippable.

| In v1 | Deferred |
|---|---|
| Marketing site + **fully automated purchase flow** | Write-back into clinic software (Channel B) |
| Voice agent answering calls | Additional connector adapters |
| **Monthly email report** (Channel A) | Ad-platform conversion feedback (**⚖️ blocked**) |
| **Optional** read-only connection for real attribution | Clinic-facing detail viewer |
| Admin CRM for your team | |

**The default customer needs no integration at all.** They buy, the agent answers their phone,
and they get a monthly email with estimated attribution. Connecting their systems is an
*optional upgrade* during checkout for clinics who want verified revenue numbers.

That inverts the previous plan's assumption and removes integration from the critical path to
revenue.

> **In plain English:** most customers just buy it and it works — no connecting anything. The
> email tells them roughly what the front desk earned them. If a clinic wants exact verified
> numbers instead of estimates, they connect their systems during checkout as an extra step.

---

## Synthflow (voice) + Claude (chat): can this be compliant?

**Yes — subject to Condition 0 below, then eight configuration and contract conditions.** Nothing
here is a legal blocker; the open question is which Synthflow plan gives you HIPAA, and what that
costs.

These are two independent systems: Synthflow handles the phone, Claude handles web chat. They
don't need to interoperate, so each is assessed on its own. *(Worth noting since it's easy to
assume otherwise: Synthflow cannot itself run Claude — its model selector is OpenAI-only. That's
irrelevant to this architecture, but it does rule out consolidating onto one vendor later.)*

### ⚠️ Condition 0 — ask this before anything else

Synthflow has two editions: **pay-as-you-go** (~$0.13–0.20+/min, the $25/month account) and
**Enterprise** (from $30,000/year). Their public pricing page shows only Enterprise, which is
misleading.

**Multiple third-party sources state HIPAA is Enterprise-only** — that pay-as-you-go covers SOC 2
and GDPR but **not** HIPAA. Synthflow's own documentation doesn't state tier eligibility either
way, so treat this as a strong indication rather than a confirmed fact.

If it's correct, the current plan **cannot legally carry patient data**, because the "HIPAA
Setting" their BAA is conditioned on wouldn't be available on it.

> *"Is the HIPAA Setting available on pay-as-you-go, and will you sign a BAA at that tier? If
> not, what is the lowest-cost plan that includes both?"*

Everything downstream depends on the answer. If HIPAA requires Enterprise, the question becomes
whether $30k/year is acceptable at this stage — a commercial call, not a technical one.

> **In plain English:** you were right that Synthflow has a cheap plan; I was wrong to say
> $30,000 was the only option. But the cheap plan probably can't handle patient data — everything
> I can find says their healthcare mode is Enterprise-only. Ask them directly before anything
> else, because if that's true, the real cost of using Synthflow for clinics is $30,000 a year,
> not $25 a month.

### Claude for chat — clean

Anthropic's terms are the strongest of any vendor reviewed:

- **Commercial Terms §B: "Anthropic may not train models on Customer Content from Services."**
  No product-improvement carve-out — precisely the language *Ambriz* rewards.
- **Real zero data retention** on the standard Messages API, requested via Sales.
- **Real BAA.**

Conditions: **disable web search** (explicitly excluded from BAA coverage), disclose AI at
session start (their usage policy requires it — which also satisfies state law), and never let
call or chat content near a consumer Claude account, whose terms are far more permissive.

**One thing to note:** a clinic-deployed web chat where a patient types *"do you treat acne, I'm
on Accutane"* is PHI, and it carries **its own CIPA exposure** — website chat wiretapping is an
active litigation wave, parallel to the voice cases. Same mitigations apply. The demo chat on
healdesk.io is different: it talks to clinic owners, not patients, so the risk is much lower.

### Synthflow for voice — workable, with eight conditions

Their no-training clause is genuinely the best-drafted of any vendor I reviewed —
Subscriber Terms **§14.4**: *"Synthflow does not use Customer Input or Output to train,
fine-tune, or otherwise improve its own or any third party's AI or machine learning models."*
That covers both them and third parties.

But *Ambriz* tests **capability**, not promises, so the configuration and the contract both have
to do work:

| # | Condition | Why |
|---|---|---|
| 1 | **Enable the "HIPAA Setting" on every agent, always** | Their BAA limits liability to *"incidents where the HIPAA Setting was properly enabled."* One agent created without it voids coverage |
| 2 | **Create a US workspace at the outset** | Default cluster is **EU** and the choice is **permanent**. Get this wrong and you rebuild |
| 3 | **Disable Save Recordings** | Directly reduces the "capability" a CIPA plaintiff points at |
| 4 | **Get the subprocessor BAA list in writing** | GCP, OpenAI, Deepgram, ElevenLabs, Twilio, **Bubble.io**. Whether they hold BAAs with each sits behind a login I couldn't access |
| 5 | **Pull §14.4 into the BAA itself** | The no-training promise lives in the ToS, which is separately amendable. The BAA is silent on training |
| 6 | **Reconcile the retention contradiction in writing** | Product docs say 30 days; their AI Transparency Statement says 90 |
| 7 | **Reconcile the residency contradiction in writing** | Their privacy policy says sensitive data is stored *"exclusively on servers hosted in the EU"*, contradicting the US-cluster docs. They're a German entity; the policy reads EU-first |
| 8 | **Bring your own Twilio** | Supported. Numbers stay in your account, so you hold your own telephony BAA and remove one hop |

**One open configuration question.** Synthflow's transcript toggle is coupled: disabling it
*"also strips transcripts from logs, analytics, and post-call webhooks."* We need post-call data
to book and attribute. So: can we disable transcript **storage** while still receiving structured
outcome data (booked / treatment / contact) by webhook? If yes, that's a materially better CIPA
posture. If no, we retain transcripts at Synthflow for 30 days and rely on §14.4 alone. **Worth
asking them directly before signing.**

> **In plain English:** yes, Synthflow for phone and Claude for chat can stay on the right side
> of the law. Synthflow's contract promise not to train on your data is the best of any vendor I
> looked at. But you must switch their HIPAA mode on for every single agent, pick the US region
> at the very start because that choice is permanent, turn off call recording, and get several
> contradictions in their own documents cleared up in writing.

---

## Channels: WhatsApp, Instagram, Google Maps, SMS

You asked for the best, most compliant, cheapest option across these. The research produced one
finding that governs everything else.

### Meta will not sign a BAA — and the ad surfaces go further than that

*(Citations corrected 17 Aug 2026 after re-verification — the conclusion is unchanged and
the operative prohibition turned out to be stronger than the one originally quoted.)*

The business-associate disclaimer lives in the **Meta Horizon Managed Solutions Terms of
Service §9.c ("Prohibited Data")**, effective 26 Feb 2025 — with respect to health
information, the customer acknowledges Meta is neither its Business Associate nor its
Subcontractor as defined in HIPAA, and that the Services are not HIPAA compliant. That
governs Meta's business-device product, **not** advertising or messaging.

For the surfaces that actually matter to a clinic, Meta has no BA disclaimer because it has
something more restrictive — a flat contractual ban on health data at all. **Business Tools
Terms §1.h** (effective 3 Nov 2025) prohibits sharing Business Tool Data that *"includes or
is based on, directly or otherwise, health information, financial information, consumer
report information, or other categories of sensitive information."*

**The practical consequence is the inverse of the usual framing.** It is tempting to read
"Meta isn't a business associate" as "Meta tools are fine as long as no BA relationship is
created." That is wrong for Business Tools: health information is banned **unconditionally**,
whether or not any BA analysis applies. A clinic cannot cure a Business Tools health-data
problem by disclaiming a BA relationship — this is the exact fact pattern behind the
pixel-related enforcement against health systems.

WhatsApp Business Solution Terms (effective 6 Mar 2026) are **silent** on HIPAA. Silence is
not permission and is not a BAA.

There is **no tier, region, or enterprise plan that changes this.** No BAA means we may not
disclose PHI to Meta — and as a business associate we're *directly* liable for our own
impermissible disclosures, so we can't shelter behind the clinic.

**Two workarounds that don't work, and why:**
- **"Our BSP will sign a BAA."** A BSP can only bind itself. The message still transits and is
  stored on Meta's infrastructure. Treat this sales claim as a red flag about the vendor.
- **"The patient asked us to use WhatsApp."** The right to request an unsecured channel
  (45 CFR §164.522(b)) is about *transmission security*, not third-party disclosure. A patient
  cannot waive the BAA requirement — it isn't their right to waive. And the conduit exception is
  narrow: it covers pure transmitters, not platforms that **store**. Meta hosts the endpoint,
  decrypts server-side, and retains conversation history.

### Google Maps messaging no longer exists

**Google Business Messages was discontinued on 31 July 2024**, with no successor API. There is no
current way for a business to receive and reply to messages originating from a Maps listing.
RCS is not a replacement — it's keyed to phone numbers, has no Maps entry point, and isn't
BAA-covered.

**Remove it from the PRD.** The correct Google play for an AI front desk is to make the Maps
**Call** button reach the voice agent — which is higher-intent than chat anyway.

### ManyChat and its category are the wrong tool

ManyChat's terms disclaim liability if the service doesn't meet HIPAA. Chatfuel has no BAA
programme at all. But the deeper point: **these tools exist to sit on Meta channels**, and Meta
is where the compliance failure occurs. A ManyChat BAA wouldn't help even if it existed.
Building the Meta integration directly is cheaper *and* more defensible.

### Why not just use Synthflow's own numbers?

Fair question — they do sell numbers at **$1.50/month**. Three reasons that isn't enough, from
their own docs:

1. **Two-way SMS is impossible on a Synthflow number.** Their docs are explicit: *"Both WhatsApp
   and SMS channels require you to connect your own Twilio account and use your own Twilio
   credentials."* Missed-call text-back and two-way texting — core to the product — cannot run on
   a native number.
2. **Missed-call text-back isn't a Synthflow feature at all.** No documentation describes it. We
   build it regardless, so it should sit on infrastructure we control.
3. **BAA coverage of their numbers is unconfirmed.** Twilio isn't named anywhere in Synthflow's
   BAA — there's a standard subcontractor flow-down clause and no carve-out, so the legal reading
   *would* cover it, but nothing states it. Their subprocessor list sits behind a login I couldn't
   access.

Also worth knowing: Synthflow's own docs frame native numbers as *"for quick testing"*, they're
US/CA/AU only, there's no toll-free option, and **porting is undocumented** — their marketing blog
claims it, the docs never mention it. Forwarding is the only documented path.

### Use Bandwidth, not Twilio

> **Decision (September 2026): neither.** Numbers are issued inside Synthflow and each clinic
> sets conditional call forwarding (busy / no answer / after hours) from its existing carrier
> line to its Synthflow number. There is no Bandwidth account and no Twilio account. The
> research in this section and the one above it is kept as the record of what was weighed —
> the lock-in and SMS points are real and were accepted: a vendor switch is a re-forwarding
> exercise per clinic, SMS from a Synthflow number still needs A2P 10DLC registration, and
> the forwarding page has to show each clinic its number and its carrier's star codes. The
> live version of this decision is `docs/handover.md` → "Telephony — decided".

I said Twilio earlier without checking the alternative. **Bandwidth is the better call:**

| | Twilio | Bandwidth |
|---|---|---|
| BAA gate | **Requires Security or Enterprise Edition** | **No documented tier, uplift or minimum** |
| Price of that gate | **Unpublished, sales-only.** The one public figure is a 2016 Enterprise quote of $15k/mo — ten years stale | None documented |
| SMS scope | Programmable SMS covered | 10DLC + toll-free SMS/MMS explicitly covered |

Plivo gates its BAA behind a **$1,000/month** Enterprise plan. Bandwidth is the only provider
found with no documented structural gate — though absence of a published fee isn't proof there
is none, so get it in writing.

**Architecture: own the numbers ourselves.** Provision DIDs in our own Bandwidth account under our
own BAA, bring them into Synthflow for the voice leg, and run all SMS on our own stack against the
same numbers. This also kills the lock-in question — switching voice vendors becomes a config
change rather than a port.

### What we build

| Channel | Verdict | Reasoning |
|---|---|---|
| **Voice (Synthflow + our own DIDs)** | **Launch. Primary.** | Highest value. Also the answer to "Google Maps" — point the Call button here |
| **SMS (Bandwidth BAA)** | **Launch. Primary PHI text channel.** | Cheapest BAA path; carries reminders and missed-call text-back |
| **Web chat (Claude + our infra)** | **Launch.** | We control the whole path. *Synthflow has a chat widget too, but its HIPAA scope is undocumented and we'd inherit their pricing for a surface we can host cheaply* |
| **WhatsApp Cloud API** | **Launch, PHI-free, per-tenant opt-in** | Free for inbound service conversations. Intent capture and handoff only |
| **Instagram DM / Messenger** | **Launch, same restrictions** | In the PRD, genuinely valuable for acquisition — just not for care |
| Google Business Messages | **Drop** | Discontinued, no successor |
| ManyChat / Chatfuel / respond.io | **Drop** | No BAA, and irrelevant to the actual problem |

**A2P 10DLC is on us, per clinic.** Synthflow has no managed 10DLC flow — each clinic is its own
Brand under its own EIN, with 1–4 week campaign approval. Build this into the onboarding wizard,
or the first customer discovers it as a delay.

### The Meta pattern: a front door, not a hallway

The AI greets, gives publicly available information, captures intent, and moves the conversation
to a secure channel — **without ever confirming anything**.

**Safe to send:** public business info (hours, address, services, published price ranges); a
channel warning in the greeting; a request for a phone number; a link to secure intake on our own
infrastructure.

**Never send:** any confirmation the person is a patient; any appointment date, time or provider;
**any acknowledgement of a condition they mentioned** — *"sorry to hear about your acne"* is a
disclosure; anything about payment or insurance status; any clinical guidance.

```
✅ "Thanks for reaching out! I can get you booked. This channel isn't secure for
    health details, so what's the best mobile number to text you at?"

❌ "Yes, we treat acne! I've got you down with Dr Chen Tuesday at 2pm."
```

**Enforcement:** the Meta-channel agent gets a **different, narrower system prompt and tool set**
than the voice/SMS agent — a hard runtime guardrail per channel, not a prompt suggestion. Test it
adversarially, because patients volunteer symptoms and a helpful model wants to acknowledge them.
Also: don't persist Meta free text into the clinic record, and consider auto-deleting threads
after handoff so Meta isn't acting as a record store.

**The residual risk, stated honestly:** even done perfectly, Meta ends up holding
patient-volunteered content in the clinic's business inbox. The patient disclosed it, not us —
but the clinic is arguably then *maintaining* PHI on a non-BA platform, and OCR has never blessed
either reading. **Do not sell this as "compliant."** Sell it as a documented risk-mitigation
pattern with a named residual risk, put it in the BAA, and let each clinic accept it explicitly.
A dermatology or behavioural-health practice may reasonably decline — so Meta channels must be
**switchable off per tenant**.

### Cost

| Item | Cost |
|---|---|
| WhatsApp inbound service conversations (24h window) | **Free** |
| WhatsApp utility / authentication message | $0.004 |
| Twilio SMS + carrier pass-through | ~$0.011–0.013 per message |
| Phone number | ~$1.15/mo |
| A2P 10DLC brand registration | ~$4.50 one-time |
| A2P 10DLC campaign | $1.50–10/mo |
| **Twilio Security Edition** (required for the BAA) | **Not publicly priced — get a quote** |

Roughly **$40–50/month per clinic** for SMS at 500 conversations, before the Security Edition
uplift. That uplift is the biggest unpriced item in the stack; **Bandwidth** is the escape hatch
if it's steep — their BAA programme is aimed squarely at healthcare platforms.

**Two A2P details that will bite:** health is **not** a restricted content category (CTIA's
SHAFT list is Sex, Hate, Alcohol, Firearms, Tobacco), so registration is straightforward — but
from **30 June 2026** campaign registration **requires a live Privacy Policy URL and Terms URL**,
so every clinic needs both before we can submit. And **never put real PHI in campaign sample
messages** — humans at the registry read them. Use placeholders.

*Avoid Twilio Frontline entirely — it reaches end of life 30 September 2026.*

> **In plain English:** patient information can travel by phone call and text message, because
> Twilio will sign a healthcare agreement. It cannot travel over WhatsApp, Instagram or Facebook,
> because Meta states in its own contract that it isn't a healthcare business associate and never
> will be. So we still use those channels — they're great for catching new enquiries — but the AI
> there only shares public information and moves the person to a phone call or text before
> anything medical is discussed. Google's Maps chat was shut down in 2024 and never replaced, so
> we point the Call button at the voice agent instead. ManyChat and similar tools can't fix any
> of this, because the problem is Meta, not them.

---

## The website purchase flow

This is now a **primary build**, not an afterthought. Every step is designed for conversion, and
integration is woven into it rather than bolted on afterwards.

### The flow

```
1  Choose specialty          → the six from the marketing site
2  Choose your platform      → visual picker, incl. "No platform / phone only"
3  Attribution: on or off?   → the optional upgrade
4  ↳ if on: interactive connection guide, tailored to their platform
5  Account + click-through BAA
6  Payment (Stripe Checkout)
7  Number provisioning + agent goes live
```

Steps 1, 2, 3, 5, 6 are always present. Step 4 appears only if they opt in.

### Step 2 — the platform picker

A visual grid of logos. Every platform we support, plus the option most likely to describe a
first customer:

| Option | What we tell them |
|---|---|
| Boulevard, GoHighLevel, Zenoti, PatientNow, Acuity, Vagaro, Mindbody | "We can connect to this" |
| **No platform / phone and paper** | **"That's completely fine — most of our customers start here"** |

**The "no platform" copy matters.** It must not read as a downgrade. Something like:

> **No booking software?** You'll get everything: the AI answers every call, books
> appointments, and sends you a monthly report of what it recovered.
> The only difference is that revenue figures will be **estimates based on your average
> treatment values**, rather than verified against your point-of-sale. You can connect a system
> later at any time.

That is honest, and per the lead-gen research these clinics are arguably the **hottest**
prospects — the most primitive front desk means the most leakage.

### Step 3 — attribution as an opt-in

Two cards, side by side:

| **Estimated** (default) | **Verified** (opt-in) |
|---|---|
| Nothing to connect | Connect read-only access |
| Revenue from your average treatment values | Revenue read from your actual sales |
| Live in 5 minutes | Adds ~5 minutes to setup |
| Report says "estimated" | Report shows verified totals |

Default is **Estimated**, so nobody is blocked from buying by an integration step.

### Step 4 — the interactive connection guide

Per platform, a step-by-step wizard with real screenshots, progress state, and live validation.
The pattern differs by platform:

**OAuth platforms** (Boulevard, GoHighLevel, Stripe, Square):
> One button. They approve a permissions screen. We verify and confirm. Done.

**Read-only user platforms** (Acuity, Zenoti, Vagaro, Mindbody, PatientNow):
> 1. "Open your [platform] settings" — deep link straight to the right page
> 2. Numbered steps with a screenshot per step, one action each
> 3. Copy-to-clipboard for the email address they must add: `connect+<clinic>@healdesk.io`
> 4. Paste the credential into our field
> 5. **We test it live and show exactly what we can and can't see**

Step 5 is the trust-builder: an honest read-back like *"✓ Connected. We can see appointments and
sales. We cannot see clinical notes."* It proves the read-only claim rather than asserting it.

**Design principles:** one decision per screen, progress always visible, everything skippable and
resumable, and the reassurance line (*read-only · revoke any time · we never see clinical
records*) persistent throughout.

> **In plain English:** buying is a short guided flow with a picture of each step. Choosing "no
> booking software" is presented as completely normal, not a lesser option. Connecting your
> systems is an optional extra for clinics who want exact figures instead of estimates — and
> when they do connect, we show them exactly what we can see, so the read-only promise is
> demonstrated rather than claimed.

---

## Pricing and unit economics

### What competitors charge

The market has **converged hard at $295–299** for a single-location med spa. Three vendors
arrived there independently, which makes it a genuine reference price rather than one company's
guess.

| Band | Range | Who |
|---|---|---|
| Entry / horizontal | $29–199 | Dialzara $29–199, Rosie $49–149, Goodcall $79–249, Smith.ai AI $0–150 |
| **Mid / vertical — the battleground** | **$250–599** | **AgentZap $295**, **MedspAI $299**, **Clara $299**, Slang.ai $399, MedReception $495 |
| Premium / clinical | $700–1,500 | Peerlogic $699, MedspAI Scale $1,299, MedReception $1,495 |
| Enterprise | $2,000–10,000+ | Assort, Infinitus (third-party figures only) |

**The bundled-AI threat is weaker than we assumed.** Boulevard, Mindbody and Vagaro have **no
native AI receptionist product at all** — Mangomint's $70 "Phone" add-on is a telephony line, not
an agent. Only Zenoti and Weave have real bundled AI, and **both hide the price behind sales**, so
neither can undercut us publicly. This partly reverses the earlier ICP concern about Zenoti and
Boulevard bundling AI: Boulevard doesn't.

**What we're displacing:** an in-house receptionist costs **$3,900–4,830/month** fully loaded for
40 hours a week. A medical answering service runs **$400–1,500/month**, with hidden fees and
28-day billing cycles inflating the quoted price by 25–50%.

### Recommended pricing

The catalog of record is `packages/catalog/src/plans.ts`; this table is a copy for the argument
below and the code wins if they disagree. Five packages, priced **by channel** rather than by
minutes alone, because the cost driver differs per channel (voice minutes are metered by the
vendor, chat conversations by LLM tokens). Annual is a flat 20% off, quoted per month.

| Package | Monthly | Annual (per mo) | Setup (once) | Voice min / mo | Chat conv / mo |
|---|---|---|---|---|---|
| **Web OR Meta Chatbot** | **$397** | $317 | $497 | — | 1,500 |
| **Web + Meta Chatbot** | **$597** | $477 | $997 | — | 3,000 |
| **AI Voice Agent Alone** | **$797** | $637 | $997 | 1,000 | — |
| **Web OR Meta + Voice** | **$897** | $717 | $997 | 1,000 | 1,500 |
| **Complete FrontDesk AI** | **$1,197** | $957 | $997 | 1,500 | 4,000 |

**Overage rates are provisional.** The catalog carries placeholder per-minute and per-conversation
rates flagged `OVERAGE_RATES_PROVISIONAL`; the pricing page does not print them and checkout
attaches no metered price while the flag is set, so overage is not billed until the rates are
signed off. Setting them needs the Synthflow per-minute cost (see the blocker above) and a
measured LLM cost per conversation.

**Why above the $295–299 cluster, not under it.** The cluster is voice-only, single-channel,
and sold on answered calls. These packages are sold on *recovered* calls with closed-loop
revenue reporting, and the voice packages ship a provisioned, QA-tested agent rather than a
self-serve configurator. Below ~$199, dental analysts report buyers assume it's a chatbot with
no real integration — **pricing too low actively hurts conversion here** — and the same logic
runs upward: a $797 voice package with a $997 setup reads as a service, not a widget.

**Two non-price decisions, both made:**
- **A setup fee, not $0 setup.** Provisioning builds the voice agent, allocates the number, and
  runs a QA pass before the clinic hears a call; the fee is what pays for that work, and it is
  charged on the first invoice alongside the first period. An earlier draft argued $0 setup was
  the wedge against AgentZap's $499; with a per-channel package and a person in the loop it is
  the thing that would have made the first month unprofitable. An upgrade owes only the
  difference between fees (`setupFeeDeltaUsd`), collected by hand until it is automated.
- **No free trial.** A trial and a setup fee do not compose: either nobody is provisioned for
  fourteen days or the agent ships before a dollar clears. The trial-length constant is gone
  from the catalog and nothing may reintroduce it. The demo on the homepage is the try-before-
  you-buy.

**Minutes must be capped.** Voice minutes are the dominant cost and scale with usage, which is why
every competitor caps them. A flat "unlimited" price would be a margin trap.

### The white space: outcome pricing

Across every med spa vendor with published pricing — AgentZap, MedspAI, Clara, My Salon Desk,
MedReception, Booking Pro, Slang.ai — **not one prices on booked appointments.** The four vendors
who do price on outcomes (Parakeet, Numa, Insight Health, Assort) sell into other verticals, and
**all of them still hide their rates behind sales.**

Nobody has made outcome pricing self-serve and public. That's the open position, and it maps
exactly onto the recovered-revenue attribution — it turns the reporting from a feature into the
billing mechanism. Worth a **$149/mo + $X per AI-booked appointment** tier once attribution is
proven. Not at launch.

### Cost breakdown — per clinic, per month

Modelled on a single-location med spa: **300 AI-handled calls, 2.5 min average = 750 minutes.**

| Item | Cost |
|---|---|
| Synthflow voice (750 min @ ~$0.15) | **$113** |
| Bandwidth SMS (~1,200 messages) | $8 |
| DID | $1 |
| A2P 10DLC campaign | $2–10 |
| Claude web chat | ~$10 |
| Stripe fees (2.9% + 30¢ on $249) | $8 |
| **Marginal cost per clinic** | **≈ $140–150** |

At $249, that's roughly **$100–110 gross contribution per clinic**, a ~42% margin before fixed
costs. Thin for SaaS, normal for AI voice — and it's why the minute cap matters.

### ⚠️ The number that decides everything

Fixed monthly costs depend entirely on **Condition 0** — whether Synthflow's HIPAA mode needs
Enterprise:

| Scenario | Fixed cost/mo | Break-even |
|---|---|---|
| **HIPAA on pay-as-you-go** | ~$145 (AWS only) | **~2 clinics** |
| **HIPAA requires Enterprise** | ~$2,645 ($30k/yr + AWS) | **~24 clinics** |

At 10 clinics on Enterprise, Synthflow alone costs $250 per clinic — **more than the entire $249
subscription.** The plan doesn't work at small scale under that scenario.

So Condition 0 isn't just a compliance question, it's the difference between profitability at two
customers and profitability at twenty-four. **If HIPAA requires Enterprise, the honest options are:
raise prices well above the market cluster, delay HIPAA-covered clinics until scale, or reconsider
the voice vendor.**

> **In plain English:** competitors have all landed around $295–299 a month, so we price at $249
> with no setup fee — which makes us 26% cheaper over the first year, because our closest
> competitor charges $499 just to get started. Each clinic costs us about $140–150 a month to
> serve, mostly voice minutes, so we make around $100 per clinic.
>
> The thing that decides whether this business works is the Synthflow question. If their
> healthcare mode works on the cheap plan, we're profitable at two clinics. If it needs the
> $30,000 contract, we're not profitable until twenty-four — and at ten clinics Synthflow alone
> would cost more per clinic than we charge. Ask them before building anything.

---

## Delivery: Channel A only for v1

| | Channel A — email (**v1**) | Channel B — write-back (**deferred**) |
|---|---|---|
| Carries | Totals: calls recovered, revenue, trend | Per-appointment detail |
| PHI? | **No** | Yes, inside their system |
| Login? | None | Already logged in |
| Status | **Build now** | **Design for, build at scale-up** |

Keeping Channel B in the plan matters even though we're not building it: it's why write scopes
stay an opt-in checkbox rather than being designed out, and why the report schema separates
aggregate from detail from day one. Retrofitting that split later is expensive.

**Verified research for when Channel B is built:** GoHighLevel and Boulevard are the best
targets; PatientNow needs `customeruserdefined` not `customernote` (it's a real EMR); **Vagaro
has no write-back path at all** — its complete API surface was enumerated. Boulevard's write
mutations exist in their schema but **not their published docs**, so confirm before building.

### On suppression — taking your direction

You disagreed with hiding metrics below five encounters. Adopted:

- **Always show the real number**, whatever the count, with the count disclosed alongside it.
- **Don't combine dimensions that pinpoint one person.** "1 call, $18,000" is fine. "1 call,
  $18,000, rhinoplasty, Dr Chen, March 3" identifies that patient.
- Enforce **TLS-required** on SES delivery.

Residual risk, stated so it's your call: at N=1 the clinic can identify the patient — but it's
their own patient and the number alone carries no identifier. **⚖️** should approve the final
template once.

---

## Compliance

### The universal opening disclosure

One sentence covers most of the landscape, and it's non-negotiable in code — not a clinic toggle:

> *"Hi, I'm an AI assistant for [Clinic] — not a human. This call is recorded and transcribed.
> Say 'representative' any time to reach a person."*

It must be **first**, before audio reaches transcription, and **captured inside the recording**
so it's self-proving. It satisfies California SB 1001 and **AB 2905**, Utah AIPA (health counts
as high-risk), Maine LD 1727, Texas TRAIGA, Anthropic's usage policy, and the all-party
recording states. Add the **AB 3030** human-provider instruction whenever the conversation
touches clinical information.

**Announce on 100% of calls.** Don't build a state matrix — area codes don't track location.

### The three findings that shape the product

**1. Ad-platform feedback is the GoodRx fact pattern.** Sending person-level conversion data to
Meta/Google drew **$1.5M** against GoodRx and **$7.8M** against BetterHelp. Meta won't sign a
BAA; hashing isn't de-identification; the 2024 FTC rule makes unauthorised *disclosure* itself
the breach at **$53,088 per violation per day**. **Aggregate-only. Deferred pending ⚖️.**

**2. Transcription creates CIPA exposure.** *Ambriz v. Google* (Feb 2025) — an AI vendor can be
a third-party eavesdropper even when the business consented, on a **capability** test. $5,000
per violation, class-certifiable, and California's fix was gutted in July 2026. Mitigations are
architectural: no training on customer audio ever, no cross-customer analytics, **no
product-improvement carve-out in any contract**, storage disabled at the voice vendor.

**3. Many med spas aren't HIPAA covered entities.** A provider is covered only if it bills
electronically. Cash-pay med spas often don't — and they're the likely first customer. That
removes five defences at once, including Washington MHMDA's exemption, which carries a **private
right of action** and no revenue threshold. **Determine covered-entity status at onboarding**
and hold a different posture for those clinics. **⚖️**

### TCPA — the AI voice is an "artificial voice"

FCC ruling **24-17 (Feb 2024)** confirmed AI voices fall under §227(b)(1), **independent of
autodialer status**. Every outbound AI call needs consent.

| Use case | Requirement |
|---|---|
| Appointment reminders | Exempt only if **all seven** conditions hold: patient-provided number, ≤1/day and ≤3/week, ≤60 sec, no billing or promotional content, easy opt-out, free to end user |
| Missed-call callback | Consent theory needs review **⚖️** |
| Reactivating lapsed patients | Likely marketing → prior express **written** consent **⚖️** |

Build now: a **consent ledger** (number, channel, source, timestamp, exact wording), a
**unified suppression list** propagating within minutes, §64.1200(b) identification, automated
opt-out, and calling windows in recipient local time.

### Other required controls

- **PAN/CVV redaction across every sink** — recording, transcript, LLM context, logs, warehouse
- **BAAs with every subprocessor**, zero-retention verified in the vendor console, not just the
  contract. Prompt logging on a non-BAA tier is a reportable disclosure
- **Documented §164.308(a)(1)(ii)(A) risk analysis** — OCR's most-cited failure against BAs
- **No AI voice ever dials a prospect.** Prospect voice is inbound or click-to-call only — the
  prospect initiates, every time, through the one consent gate (`canContactProspect()`); a
  scraped listing has given no consent and never will
- **No geofencing near clinics** — Washington MHMDA bans it within 2,000 feet, no consent exception
- **Hard clinical guardrails** — no candidacy, dosing, symptom or triage output; adversarially
  tested escalation
- **Cyber / tech E&O insurance with explicit TCPA and privacy endorsements** — standard policies
  exclude exactly these

> **In plain English:** say up front it's an AI and the call is recorded — that one line covers
> most of the law. Never call or text without permission on file, keep a careful record of it,
> and honour "stop" instantly. Never let the AI sound like it's giving medical advice. Don't send
> anything patient-level to Facebook or Google. Get insurance that specifically covers phone and
> privacy lawsuits.

---

## Auth and the admin CRM

**Self-hosted Better Auth, one instance, mostly for us.** Clinic account data isn't PHI so it
could be hosted, but our staff auth guards PHI and does need self-hosting — running one system
beats two.

| Who | Auth |
|---|---|
| **healdesk staff** | Full: MFA mandatory, per-clinic grants, every PHI read audited |
| **Clinic owner** | Signup, BAA acceptance, optional OAuth connect, billing |
| **Clinic staff** | **None** — the email has no PHI |

### The admin CRM — yes, with one correction

You asked about `healdesk.io/admin`. Build it, **but not at that URL**: `healdesk.io` is on
Vercel, which only signs BAAs on Enterprise, so a path there routes PHI through uncovered
infrastructure.

- `healdesk.io` → marketing + purchase flow → **Vercel** → no PHI
- `admin.healdesk.io` → the CRM → **AWS (ECS Fargate + RDS)** → PHI, BAA-covered

Internal-only means it can be locked down hard: no public signup, mandatory MFA, optional IP
allowlist, short sessions.

**Contents:** clinic list with covered-entity status, connection health, consent and suppression
ledger, report previews before send, audit log search, BAA tracking.

---

## Architecture

**Tenancy** — org owns clinics; clinic is the PHI root. `ON DELETE RESTRICT` so closing a
billing account can never cascade into deleting patient records.

**Isolation** — RLS *on top of* application scoping. Transaction-local
`set_config('app.clinic_id', $1, true)` because session-scoped settings leak across pooled
connections; a runtime role without `BYPASSRLS`; `FORCE ROW LEVEL SECURITY` because table owners
bypass policies too. Structurally enforced by deleting the `db` export in favour of
`withTenant()`.

**Connectors** — separate workspace, no Drizzle/pg/Next imports, capabilities declared so
"unsupported" reaches the output instead of rendering as zero.

**Queue** — pg-boss, in the database we already have.

**Credentials** — AES-256-GCM envelope encryption, AAD bound to `{clinic_id, credential_id}` so
ciphertext can't be moved between tenants. `KeyWrapper` interface: local key in dev, AWS KMS later.

> **In plain English:** two locks on the patient-data door. Connections get recycled between
> requests, so the "which clinic am I" tag is tied to a single transaction and the database
> clears it automatically. Each clinic's credential sits in a box stamped with their name — move
> it to another clinic's shelf and it won't open.

---

## Build phases

| # | Phase | Notes |
|---|---|---|
| **1** | Foundation — auth, tenancy, RLS, crypto, audit | Migrations `0000`–`0004`, incl. the BAA gate trigger |
| **2** | **Purchase flow** — specialty → platform picker → attribution choice → BAA → Stripe | The conversion surface. Includes "no platform" |
| **3** | **Interactive connection wizards** — per-platform, screenshots, live validation | Only reached if they opt into Verified |
| **4** | Voice — **Synthflow** (US workspace, HIPAA Setting on, recordings off) + Twilio BYO | Disclosure injection, consent ledger, suppression list |
| **4b** | Channels — SMS (Twilio + 10DLC), web chat (Claude), then Meta channels with the narrow PHI-free agent | Per-channel system prompts and tool sets; per-tenant on/off |
| **5** | Admin CRM at `admin.healdesk.io` | |
| **6** | Estimated attribution engine | The default path — no integration needed |
| **7** | Connector ports + fixture + first real adapters | Verified path. Stripe/Square, Boulevard, GoHighLevel |
| **8** | Monthly email report generator + SES | Channel A |
| **9** | Compliance controls | PAN redaction, audit coverage, retention |
| — | *Later:* write-back, more adapters, ad-platform feedback | Deferred |

**Two existing-schema fixes** in Phase 7: add a `provider` discriminator to the external-ID
unique indexes, and replace unique indexes on nullable columns with partial unique indexes —
Postgres treats NULLs as distinct, so they currently neither prevent duplicates nor support
`ON CONFLICT`.

---

## Infrastructure & cost

`db.m6g.large` + 100 GB ≈ **$145/mo**. **Users are not a billing dimension** — RDS bills compute
and storage, not seats. 100 GB is far more than needed: recordings go to S3 (~$0.023/GB) and
transcripts are text, so a clinic at 500 calls/month generates tens of megabytes a year.

| Stage | Setup | Cost |
|---|---|---|
| **Development (now)** | Local Postgres in Docker | **$0** |
| **First clinic** | `db.t4g.small` + 20 GB | **~$25/mo** |
| ~10 clinics | `db.t4g.medium` → `m6g.large` | $50–145/mo |
| Production HA | Multi-AZ | ~$280/mo |

*(App Runner is not HIPAA-eligible — use ECS Fargate.)*

**Open the AWS account now** — the BAA is free, instant, and covers RDS + KMS + SES + S3 +
Fargate in one agreement. Provision RDS only when the first clinic signs.

---

## What you do, what I do

### You only

| # | Task | Time |
|---|---|---|
| 1 | Create the AWS account | 15 min |
| 2 | Accept the BAA in AWS Artifact — free, click-through | 5 min |
| 3 | **Ask Synthflow Condition 0** — is HIPAA/BAA available on pay-as-you-go, or Enterprise-only? Then the eight conditions | A call |
| 4 | **Request Anthropic BAA + zero data retention** via Sales | 15 min + wait |
| 4b | **Bandwidth account + BAA** (SMS + our own DIDs). No documented tier gate — confirm in writing | A call |
| 4c | Meta developer account (WhatsApp Cloud API + Instagram Messaging) | 30 min |
| 5 | Engage a healthcare attorney for the **⚖️** items | — |
| 6 | Stripe account (billing + the optional Connect integration) | 20 min |
| 7 | Cyber / tech E&O insurance with TCPA + privacy endorsements | — |
| 8 | Boulevard and GoHighLevel developer accounts *(only when Phase 7 starts)* | 25 min |

### You grant, I take over

| You create | You give me | I handle |
|---|---|---|
| AWS account | IAM user or SSO access | All infra, RDS, SES, S3, KMS, deploys |
| Synthflow (US workspace) | API key + workspace access | Agent config, disclosure injection, webhooks, storage settings |
| Meta developer account | App credentials | WhatsApp + Instagram integration, the narrow PHI-free agent |
| Bandwidth account | API credentials | DID provisioning, SMS, 10DLC registration per clinic, BYO into Synthflow |
| Anthropic org | API key under the BAA | All model integration |
| Stripe | Test keys first | Checkout, billing, Connect |
| Domain DNS | Access or applied records | Subdomains, SES verification, DKIM |

### Entirely me

Everything in the nine phases: schema, auth, tenancy, RLS, purchase flow, connection wizards,
voice integration, admin CRM, attribution engine, connectors, report generation, compliance
controls, tests.

---

## Verification

**Tenant isolation** — cross-tenant read by known primary key returns **0 rows**; cross-tenant
write rejected with `42501`; no tenant tag set → every PHI table empty; the tag doesn't survive
into the next borrower of a pooled connection; runtime role has `rolsuper = false` and
`rolbypassrls = false`.

**Drift** — every table with a `clinic_id` column must have RLS **enabled and FORCEd**. Keeps
working on tables that don't exist yet.

**Conversion flow** — the purchase path completes end to end with **zero** integration steps
(the default), and separately with each platform's wizard.

**Compliance** — the opening disclosure appears on 100% of simulated calls and **cannot be
disabled by configuration**; opt-out stops recording and is logged; suppression propagates;
PAN/CVV redaction holds across every sink.

**Email safety** — property tests asserting no patient identifier, and no identifying
*combination* of dimensions, can reach an email body.

---

## Open items

| Item | Owner |
|---|---|
| **Condition 0 — is Synthflow's HIPAA Setting available on pay-as-you-go, or Enterprise-only?** Decides break-even at 2 clinics vs 24 | You — ask first |
| Synthflow written confirmation: US region, retention period, subprocessor BAAs, §14.4 pulled into the BAA | You / ⚖️ |
| Can Synthflow send structured post-call data with transcript storage **off**? | You — ask before signing |
| **Bandwidth BAA** — no documented tier gate, but confirm there's no hidden commit | You |
| Are Synthflow **chat agents** in scope of their HIPAA Setting? Undocumented — matters only if we use their widget instead of Claude | You |
| Covered-entity determination method + non-CE posture | ⚖️ |
| CIPA positioning — party-extension or third party? | ⚖️ |
| Click-through BAA drafting | ⚖️ |
| Reactivation = HIPAA marketing? Missed-call callback consent | ⚖️ |
| Ad-platform attribution — deferred, needs sign-off before ever building | ⚖️ |
| Better Auth + Next 16 `getSession()` null with cookie cache | Me — verify in Phase 1 |
| Boulevard write mutations undocumented | Me — only matters when Channel B is built |

*Resolved this session and removed: voice vendor (Synthflow, decided), processor-vs-POS money
source, Vagaro viability, shared-inbox safety, database vendor, Mindbody strategy (no API, ever),
suppression thresholds, Google Maps messaging (discontinued — dropped), ManyChat-class tools
(no BAA, and irrelevant), and whether integration blocks purchase (it doesn't — it's optional).*

> **In plain English:** the lawyer questions gate the advertising feature and how we describe
> ourselves legally. Everything else can start now. The single most urgent item is asking
> Synthflow whether their healthcare mode works on your current plan — if it doesn't, the cost of
> the whole voice layer changes. After that, open the AWS account: its healthcare agreement is
> free and takes five minutes.

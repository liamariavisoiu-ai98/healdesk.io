# What the research found, in plain English

**Read this one first.** It explains the whole picture end to end — what the rules actually
are, why they exist, which of your vendors trip over them, and what it means for the
business. [blockers-runbook.md](./blockers-runbook.md) is the companion: same findings, but
written as click-by-click instructions once you already understand why you're doing them.

---

## How this was produced, and how much to trust it

On 17 August 2026 I ran two research passes across nine topics: Synthflow, AWS, Anthropic,
telephony, Boulevard, GoHighLevel, insurance, the lawyer questions, and Stripe — plus a
tenth on trust badges. **99 independent agents**, 1,895 tool calls, roughly 4.9 million
tokens of reading.

The important part is the second half. Every claim that mattered was handed to a **separate
agent whose instructions were to disprove it** — go to the vendor's actual page, read the
actual clause, and default to "unverifiable" when in doubt. That's deliberate: the failure
mode with research like this isn't missing something, it's confidently repeating something
that used to be true.

**Sixteen claims died in that second pass.** Some were stale (a penalty figure that had been
inflation-adjusted), some were third-party blog posts dressed up as vendor documentation,
and a few were things I had told you earlier that turned out to be wrong. Those are all
corrected below and flagged where they appear.

Three tiers of confidence are used throughout:

- **Confirmed** — read on the vendor's own page or in the regulation itself, today
- **Likely** — strongly implied by a primary source but not stated outright
- **Unconfirmed** — could not be verified. *Treated as unknown, not as true.* Where you see
  this, it usually means only the vendor can answer, and the runbook has the question to ask

---

# Part 1 — The thing everything else hangs off

Before any vendor detail makes sense, you need one concept: **the chain of contracts**.

## What HIPAA actually requires of you

HIPAA divides the world into two kinds of organisation.

A **covered entity** is a healthcare provider that bills insurance electronically, plus
health plans and clearinghouses. Your clinics are *usually* covered entities — but not
always, and that turns out to matter enormously (Part 3).

A **business associate** is anyone who handles patient data *on behalf of* a covered entity.
That is you. The moment a clinic's patient data touches healdesk, you are a business
associate, with direct legal liability of your own — you cannot hide behind the clinic.

The rule that structures everything: **a covered entity may not hand patient data to a
business associate without a written contract**, and that contract is a **Business Associate
Agreement (BAA)**. That's 45 CFR 164.502(e). And 45 CFR 164.504(e)(2)(ii) lists what the
contract has to contain — it's a short list and worth knowing, because it's the answer to
"why do I need a BAA if they already promise not to train on my data":

1. Use appropriate safeguards
2. **Report breaches — and security incidents — to you**
3. **Flow the same obligations down to their own subcontractors**
4. Make records available to HHS if it investigates
5. **Return or destroy the data at the end of the contract**
6. Let you terminate for material breach

Notice that "don't train on the data" isn't even on that list. It's a nice thing a vendor
might promise in its terms of service, but a terms-of-service promise gets you none of the
six things above.

## The chain, drawn out

Every arrow is a BAA you need in place. Miss one and the chain is broken.

```
Patient
   │
Clinic  ─────────────── covered entity
   │  ← you need a BAA here (you sign it with each clinic)
healdesk ────────────── business associate  ← that's you
   │
   ├──→ AWS            ← BAA needed. Free, click-through
   ├──→ Anthropic      ← BAA needed. Self-serve in the Console
   ├──→ Synthflow      ← BAA needed. Published, but sales-led
   ├──→ Twilio         ← BAA needed. ⚠️ Requires a paid Edition
   └──→ Boulevard / GoHighLevel  ← they will NOT sign with you
```

**That last line is the surprise, and it's a structural problem.** Neither booking platform
will sign a BAA with an integrator. Their BAA runs to the clinic only. So when patient data
crosses out of Boulevard into healdesk, you are relying entirely on your *own* BAA with the
clinic, and the platform contractually disclaims the middle of the transaction.

## Why "we don't train on your data" isn't the answer

You asked this directly about Anthropic, and it's the right question — so here it is
concretely.

Anthropic's Commercial Terms of Service, Section B, effective 17 June 2025, says verbatim:

> **Anthropic may not train models on Customer Content from Services.**

That's confirmed, it's real, and it's genuinely one of the strongest such clauses of any
vendor reviewed. You can read it yourself at `anthropic.com/legal/commercial-terms`.

But look back at the list of six. Without a BAA you have **none** of them. No obligation to
tell you about a breach. No requirement that *their* subcontractors are bound. No HHS access.
And their terms-of-service destruction clause (Section E.4) actually *exempts* "copies in
Recipient's automated back-up systems" — which is weaker than what HIPAA requires.

So: they don't train on your data **and** you still need the BAA. They're answers to
different questions.

---

# Part 2 — The vendors, one at a time

## Synthflow (voice) — the tier question, and the thing underneath it

**Your question:** is HIPAA available below Enterprise?

**Best answer available: probably yes, and the evidence is better than expected.** Synthflow
publishes a complete BAA at `docs.synthflow.ai/baa`, version 1.0, dated 13 May 2026. Read
end to end, it contains **no tier gate, no plan reference, no add-on fee, and no per-agent
or per-workspace HIPAA charge**. The one sentence in their docs that mentions HIPAA and
Enterprise together turns out, read carefully, to be two separate sentences — it gates
**SSO** to Enterprise, not the BAA. And HIPAA is conspicuously *absent* from the Enterprise
page's own "what's included" compliance row, which lists only SOC 2, GDPR and ISO 27001.

**What I could not confirm** is whether they will actually *sign* it on a self-serve plan.
Their BAA says it "is executed between Synthflow and Customer at contract signing," which
describes a salesperson, not a checkbox. And their public pricing page today shows exactly
one card — *"Enterprise contracts start at $30,000 annually"* — with no self-serve tier
listed at all, while their homepage simultaneously says you can start free and pay as you go.
Their own billing docs acknowledge the mess: *"Synthflow uses sales-led pricing… If you
already have an active workspace, do not use public documentation as a quote."*

So your $25/month account is real and governed by live self-serve terms. It just isn't
advertised any more.

### But two things outrank the tier question

**First — and do this today — your data is probably stored in Europe.**

Synthflow runs three clusters: Global (storage EU, compute US and EU), US, and EU. Their
docs are unambiguous:

> **Cluster selection is permanent. The cluster you choose when creating a workspace cannot
> be changed afterward.**

And: *"Global is the default for workspaces created before dedicated US and EU clusters were
available. Data for Global workspaces is stored in the EU."* The US cluster only launched on
**27 January 2026**. Your account predates that, so it is almost certainly Global — meaning
EU storage, permanently, with no migration path.

Check it at **Admin → Workspace Settings → Preferences → Customer Region**. If it says
Global, you need a brand-new workspace on the US cluster before any patient data goes near
it. There's a second reason too: SMS and WhatsApp channels are **US-region only**, so a
Global workspace can't do SMS at all.

**Second, the BAA has four defects worth negotiating.**

| Clause | What it says | Why it matters |
|---|---|---|
| Parties | The counterparty is **AgentFlow AI GmbH**, Kurfürstendamm 15, Berlin | You are contracting with a German company for US patient data |
| §15 | Liability capped at "the fees paid… during the six (6) month period prior" | On a $25/month plan that is a **~$150 cap** against a breach that could cost you six figures |
| §14 | Indemnification runs one way — *you* indemnify *them* | No reciprocal protection |
| §9 | "may assign or subcontract… **without the express written consent of Covered Entity**" | They can hand your patient data to a new subprocessor and not tell you |
| §8 | Governed by "the laws of the State in which Business Associate maintains its principal place of business" | A German GmbH has no US state. This is a drafting error, not a formality |

### Two more things you'd only find by reading the docs closely

**The "HIPAA Setting" doesn't exist in the product.** Their BAA is built entirely around it —
liability is *"limited to incidents where the HIPAA Setting was properly enabled at the time
of the breach,"* and it's **off by default**. But searching their entire documentation, there
is no control by that name anywhere. The agent-level Security & Compliance page has four
toggles: Save Recordings, Save Transcripts, Limit Data Retention to 30 days, and PII
Redaction. Nobody can tell you which of those constitutes "the HIPAA Setting," which means
nobody can tell you whether your coverage is live. **That's the single most important
question to ask them.**

**PII redaction breaks patient intake.** Their docs, verbatim: *"Information extractors
cannot extract redacted PII — if you have extractors configured to capture data such as
names, they will not be able to extract it."* So the privacy feature that looks most
attractive for a healthcare agent is the one that stops it capturing the patient's name.

**The good news:** §14.4 of their Subscriber Terms is real and exactly as remembered —
*"Synthflow does not use Customer Input or Output to train, fine-tune, or otherwise improve
its own or any third party's AI or machine learning models"* — and the identical sentence
carries into their US enterprise contract, so it survives a move to Enterprise.

---

## AWS — the easy one, with one nasty default

Accepting the BAA takes about five minutes, costs nothing, is instant, and doesn't need the
root user. The click path is in the runbook.

**The thing nobody expects:** there is no step where you say which services you'll use.
People assume there's a form. There isn't. Accepting designates the **entire account** as a
"HIPAA Account," and AWS deliberately wrote it that way so they can add newly-eligible
services without amending your contract.

The flip side is that **nothing enforces the boundary**. You may only put patient data in
services on the HIPAA Eligible Services Reference, nothing in the console warns you if you
don't, and **AWS keeps no record of which services you intended to use** — so the only
evidence you stayed inside the list is a record you keep yourself. That's why the runbook has
you write a one-page memo.

All five of your services are covered, as of the list's 3 August 2026 revision: **RDS**
(PostgreSQL named explicitly), **KMS**, **SES**, **S3**, **ECS**, and **Fargate** — the last
one conditionally, "ECS and EKS engines only," which is fine because you're on ECS.

**App Runner is not on the list.** The earlier analysis was right, and it's now doubly moot:
*"AWS App Runner is no longer open to new customers."* Watch out for someone quoting App
Runner's own docs, which say auditors assess it "as part of multiple AWS compliance programs.
These include SOC, PCI, FedRAMP, HIPAA" — that's boilerplate that appears on many AWS service
pages and it does **not** mean BAA-covered.

### The default that will get you

The BAA requires patient data encrypted in transit. **Amazon SES does not do that by
default.** Their docs:

> By default, Amazon SES uses opportunistic TLS… **If SES can't establish a secure
> connection, it sends the message unencrypted.**

Read that again in context: healdesk emails monthly reports and appointment confirmations to
clinics. If a clinic's mail server doesn't support encryption, SES sends the message **in the
clear** and reports success. That is a BAA violation that leaves no trace.

The fix is one CLI command creating a configuration set with `TlsPolicy=REQUIRE` — and it
changes the failure mode: messages to badly-configured servers get **dropped** instead, so
you need bounce monitoring. This is the most likely single BAA violation in a product shaped
like yours.

Two more of the same species: `rds.force_ssl` defaults to **off** on PostgreSQL 14 and older,
and CloudWatch log groups default to **"Never expire"** retention — an indefinite store of
patient data you never meant to create.

And one thing that's easy to miss: **patient data leaks through names, not just payloads.**
S3 object keys, bucket names, database identifiers and resource tags all end up in CloudTrail
logs, console listings and billing exports. Naming an S3 folder after a patient defeats every
encryption control underneath it.

---

## Anthropic — the BAA is easy, the feature list is the constraint

Self-serve at **Console → Settings → Privacy**. Download the BAA, download the
Implementation Guide (each step unlocks the next), accept as an authorised representative.
Takes effect immediately.

Three things to know before you click.

**1. It's a one-way door.** *"Once HIPAA readiness is enabled for your organization, the
configuration is permanent and cannot be disabled by an administrator."* And it's org-wide,
hard-blocking ineligible features for everything in that organisation. **Create a separate
organisation for patient traffic first** — Anthropic says so themselves. Don't enable it on
the org you use for the marketing site, internal tools, or Claude Code.

**2. Don't chase zero data retention.** You'd think you'd want both. Their FAQ answers it
directly: *"Do I still need ZDR if I have HIPAA readiness? **No.** HIPAA-ready API access is
designed as an alternative to ZDR."* HIPAA readiness applies a broader set of safeguards, and
it's the only one of the two that is *technically enforced* — under ZDR the API happily lets
you use ineligible features, whereas HIPAA readiness returns an error.

**3. A large slice of the API is excluded, and one exclusion has architectural consequences.**

Blocked entirely (the API returns HTTP 400): Batch API, Files API, Agent Skills, code
execution, Managed Agents, MCP connector, web fetch, tool search, **context editing**, and
**compaction**.

That last pair matters more than the rest combined. Compaction is the server-side feature
that summarises a long conversation so it fits in the model's context. **A voice agent on a
long call is exactly the case it exists for**, and you can't use it. You'll have to manage
transcript history yourself — truncate, window, or summarise with a separate eligible call.
Better to know now than to discover it as a 400 in production.

Two smaller traps worth internalising:

- **Keep patient data out of JSON schemas.** Anthropic: *"the API compiles JSON schemas into
  grammars that are cached separately from message content. These cached schemas do not
  receive the same PHI protections."* Meaning: no patient names in an enum, no real record
  formats in a regex
- **Console and Workbench are never covered.** You can turn HIPAA readiness *on* from the
  Console, but you must never paste real patient data into the Workbench to debug a prompt.
  On a one-person team this is the most likely real violation there is

**One thing you cannot contract away:** if Anthropic's automated safety systems flag a
conversation, they may retain it **up to 2 years** — and that applies *"even with ZDR or HIPAA
arrangements in place."* Your clinics' lawyers will ask about this. It's also a reason to keep
the agent's prompts clinically neutral; an over-eager classifier hit on a dermatology
conversation means data sits for two years.

---

## Telephony — you were right about Bandwidth, and wrong about the conclusion

**Your position:** Synthflow provides numbers we can share with customers, or customers bring
their own — so why do we need a carrier?

**On Bandwidth specifically, you're right.** Don't open the account. Bandwidth isn't one of
Synthflow's native telephony integrations (those are Twilio, Telnyx, RingCentral and Vonage),
and their pricing page has no self-serve signup — it routes to "Request a quote." At zero
customers you'd be negotiating a carrier contract to solve a problem a free signup solves.

**But the wider idea doesn't survive contact with the details**, for a reason that has nothing
to do with SMS:

> **A Synthflow number is a new number.**

"Sharing Synthflow's numbers with our customers" means asking a med spa to abandon the number
printed on their signage, listed on their Google Business Profile, filed with insurance
directories, and saved in every past patient's phone. No clinic will do that, and the ask
alone makes you look like you've never sold to one.

And they can't literally be shared anyway — *"No two inbound agents can share the same
number."* Every clinic needs its own number in every architecture. Synthflow numbers save
nothing; they only change whose account holds them. Synthflow's own docs call their numbers
*"for quick testing"* and tell you to *"Move to Twilio or SIP/PBX for scale and control."*

### What works

**The clinic keeps its published number and conditionally forwards it** (on busy, no-answer,
or after hours) **to a landing number you own in your own Twilio account.** Usually
`*61*<number>#` on a landline, or a routing rule on a cloud phone system.

Forwarding is reversible in one step. That single fact is the biggest objection-killer in the
sales conversation — you are not asking them to change their number, port anything, or trust
you with their front door permanently.

### Two things this research corrected

**SMS is double-billed.** I previously said Synthflow doesn't bill SMS. Wrong. Synthflow
counts SMS as chat usage — **5 AI-generated messages = 1 Synthflow usage minute**, drawn
against the same meter as voice — *and* Twilio bills its own rate directly. Budget for both.

**Synthflow does have standalone outbound SMS.** I previously said every SMS feature was
call-triggered. Also wrong — it's just not in the voice-agent docs. It lives in the chat-agent
product: `POST /v2/chat/outbound` with `channel: "sms"`. Two-way SMS *still* requires your own
Twilio account either way.

### The trap you'll hit on a real deal

**Twilio can only text-enable landlines and toll-free numbers** — *"Mobile numbers and VoIP
numbers are not supported."* A large share of modern clinics publish a RingCentral, Nextiva or
Dialpad number, which is VoIP. You will find this out per deal, *after* they've signed, when
the paperwork is rejected. Add one question to discovery: **"Is your main number a traditional
landline or a cloud phone system?"** Telnyx accepts VoIP where Twilio doesn't, so this may
eventually force you onto two carriers.

### And the thing that actually costs money

It isn't per-minute rates. Voice and SMS for one clinic is a few dollars a month.

> **Twilio will only sign a BAA with customers on Security Edition or Enterprise Edition.**

Those editions are unpublished and sales-negotiated — almost certainly four figures monthly.
Twilio is explicit that there's no different product behind the gate: *"The HIPAA-eligible
version of Twilio's products is the same as the non-HIPAA-eligible version."* You're paying
purely for the contract.

So before your first covered-entity customer you have a real decision: **buy the Edition, or
ship v1 with no patient data in SMS at all.** Option two is harder than it sounds — *"Reminder
of your appointment at [Dermatology Clinic] tomorrow at 2pm"* identifies the recipient as a
patient of a named specialist. That's a lawyer's call.

> **⚠️ On Telnyx:** their support article says *"there is no need for Telnyx to sign a BAA"*
> under the conduit exception, while their own HIPAA architecture guide addresses customers
> who *have* a BAA with them. A vendor declaring itself a conduit doesn't bind the regulator,
> and the exception is narrow — it covers pure pipes like the postal service, not platforms
> that store message bodies and call recordings. Don't accept "we don't need to sign one."

**Bandwidth comes back later.** Their BAA is the most accommodating of the five reviewed —
it explicitly covers customers acting *as a business associate*, which is precisely your role,
and isn't visibly tier-gated. Revisit past roughly 50 clinics or $2,000/month of telephony.

---

## Boulevard — good API, dangerous contract, tiny addressable market

### The question that ends most conversations in five minutes

Their API page says, verbatim: **"Available for Enterprise tier only."**

Their published tiers start around $140/month per location, and Enterprise is bespoke and
unpriced. So a single-location med spa on a standard plan **cannot connect healdesk at all**,
regardless of what Boulevard grants you. That belongs in your sales qualification, not your
onboarding.

### There's no application form

Email **partnerships@blvd.co**. Their partner page lists three tracks; Integration and
Development Partners both just say "Email Us to Apply."

⚠️ Don't apply through the PartnerStack link — that's the **Affiliate** track, a referral
programme paying $750 per demo and $750 per closed sale. It grants no API access, and applying
there signals you misread the programme.

### The good news is real

There is **no** blanket "don't build a competing product" clause — the thing that ruled
Mindbody out. That language exists only in their *consumer-facing* Client Terms of Service,
which governs patients booking appointments, not integrators. This was checked specifically
because it's the assumption everyone makes.

Technically it's a well-built modern API: GraphQL, OAuth 2.1, granular read scopes, a real
sandbox, documented rate limits that are **per app per business** (so one busy clinic can't
starve another), and the APIs are currently free.

### The bad news is three clauses aimed almost exactly at you

| Clause | What it forbids | The problem |
|---|---|---|
| **§4.2(c)** | Using per-clinic credentials "for any commercial purpose, including… the sale or licensing of any Application… made available to third parties" | The obvious integration route — a simple app per clinic — is barred for a paid product |
| **Addendum A §4.2.2** | "not scrape, access, download, store, build databases or otherwise create permanent copies of any Customer Data… without the express consent of Boulevard **and** the Customer" | Verifying recovered revenue *is* building a database of their appointments and sales. This is your core mechanic |
| **Addendum A §4.2.16** | Using API data to "develop, train, fine-tune, **evaluate**, or improve any artificial intelligence or machine learning model" without prior written consent | Written for AI vendors. "Evaluate" is broad enough to cover *measuring your own agent's performance*, which is the product |

None of these is unnegotiable — they all have "without consent" escape hatches. But you need
that consent **in writing, before you build**, not after.

### And a fourth problem that lands on your customer

Their Acceptable Use Policy §7(e) bars the *clinic* from putting patient data *"into any
third-party AI system not expressly authorized under your DPA or BAA with Boulevard."*

healdesk is a third-party AI system. So a clinic that connects you without that authorisation
is in breach of its own vendor agreement — meaning you'd be selling your customers a
compliance liability. Get expressly authorised in writing.

Add to that: **Boulevard will not sign a BAA with you** (their API agreement never mentions
HIPAA, PHI or business associate at all), they can **terminate for any reason on 30 days'
notice**, and total liability is capped at the greater of $100 or fees paid — and since the
APIs are free, that's **$100**.

---

## GoHighLevel — easy to start, a wall at customer six

Signup is genuinely self-serve at `marketplace.gohighlevel.com`, no paid subscription
documented as a prerequisite, and free sandbox accounts from inside the portal. Build it as a
**Private** app: not listed publicly, **no review**, goes live immediately, and the clinic
installs from a link you send.

Everything you need is read-only and documented — contacts, calendars, appointments,
opportunities, payments, transactions.

### Three things will break it

**1. Refresh tokens are single-use.** *"Once you use a Refresh Token to obtain a new Access
Token, the original Refresh Token becomes invalid."* If two background workers refresh the same
connection at the same moment, one wins and the other **permanently orphans it** — the clinic
has to manually reconnect. This is the single most common way HighLevel integrations die. It
needs a lock around refresh, not just careful code.

**2. Agency installs give you the wrong kind of token.** Even when your app targets individual
clinics, if a *marketing agency* installs it on their behalf you get an agency-level token and
every clinic-level call fails. That needs a whole second code path. Med spa chains and
agency-managed clinics will hit it.

**3. The 5-agency wall.** Private apps created after 18 November 2025 cap at **5 agencies**.
At the sixth, new installs are blocked — *and you also lose the ability to ship updates to
existing customers*, which is the worse half. The exits are publishing publicly, or requesting
a Security Review (a demo video, a video justifying every scope you requested, and a written
rationale). **Start recording those videos around customer three**, not six.

> **Worth knowing:** for your first two or three design partners you can skip all of this.
> **Private Integration Tokens** need no developer account, no app, no review, and have no
> cap — the clinic generates a scoped token in their own settings and hands it to you. Worse
> onboarding, much faster to ship.

### Two legal notes

The clinic needs HighLevel's **HIPAA add-on at $297/month** before their account can hold
patient data at all — it's off by default. ⚠️ It is **irreversible**: cannot be deactivated,
refunded or downgraded, and applies account-wide. Never casually tell a prospect to "just turn
on HIPAA"; that's a permanent $3,564/year commitment. And **their BAA does nothing for you** —
you still need your own with the clinic.

And their Terms of Service (June 2026) say you may not use the platform if you *"intend to
gain access to the Platform in order to compete with the Platform."* HighLevel ships its own
Conversation AI and Voice AI. That's worth a lawyer's opinion, and in the meantime it means
**treat HighLevel as a channel that can be revoked, not as infrastructure.** Don't architect
so that losing it is fatal.

---

## Stripe — reuse the account, avoid two specific habits

One Stripe account can serve both products cleanly. Stripe's own guidance reserves separate
accounts for genuinely independent businesses — separate legal entity, separate bank account.
The one real objection (a med spa seeing `SCALABID` on their card statement) is solved by
setting a statement descriptor **per product**, which Stripe says "overrides any account
descriptor for recurring payments."

About 60% of scalabid's implementation ports directly, including one thing it already gets
right that most people get wrong: **the account is created by the webhook, not by the browser
landing on the success page.** That matters because a customer who pays and immediately closes
the tab still gets their account, and someone who hand-crafts a success URL gets nothing.

### Two things must be fixed before any webhook points at healdesk

**1. Provisioning isn't safe to run twice.** Right now, if it hits a name collision it
generates a *new* slug and tries again. That's correct behaviour for two clinics genuinely
called "Radiance Med Spa." It's catastrophic when Stripe retries a webhook for one payment —
you'd get two organisations, two clinics, two signed BAA records and two invitations. **Stripe
retries for up to three days**, so this isn't hypothetical.

**2. Don't copy one specific guard.** scalabid checks `payment_status !== "paid"` and bails.
With healdesk's 14-day trial that *appears* to work — Stripe processes a $0 trial invoice and
marks it paid. But the moment anyone experiments with starting a trial without a card, that
line **silently drops every signup**: the customer sees a success page and no account is ever
created. Nothing errors. Nobody finds out until someone asks where their login is.

Also worth knowing: subscribing each webhook to different event types does **not** keep the
two products apart, because both emit the same events on the same account. The real separation
is a check inside the handler — *is this event mine?*

**I did not copy any keys.** The runbook names the variables and where they belong.

---

# Part 3 — The laws that aren't HIPAA

This is the part that surprises people. HIPAA is the one everyone knows about, and it is
probably not your largest exposure.

## TCPA — the phone call law

The Telephone Consumer Protection Act governs automated calls and texts. Damages are
**$500–$1,500 per call**, there's no cap, and it's the favourite statute of a large and
organised plaintiff bar.

In February 2024 the FCC ruled that **an AI voice is an "artificial voice"** under the
statute. That closes the loophole people had been relying on: it doesn't matter how the number
was dialled, an AI-voiced outbound call to a mobile needs consent.

There's a carve-out for healthcare messages — appointment reminders and the like — that lowers
the bar from *written* consent to ordinary consent. **But it is only available to a covered
entity or its business associate.** Hold that thought; it comes back in a moment.

And a distinction that will catch you: a med spa's *"time for your Botox touch-up"* message is
**not** a healthcare message. It's marketing, which needs prior express **written** consent.
Elective aesthetics is exactly where that line gets litigated.

## CIPA — the recording law

California's wiretapping statute, plus similar laws in other states. **$5,000 per violation**,
class-certifiable, no requirement to show anyone was actually harmed.

The case that changed things is *Ambriz v. Google* (2025), which held that **an AI vendor can
be an illegal third-party eavesdropper on a call even when the business consented** — and the
test is **capability**, not intent. Could the vendor use the call content for its own purposes?

That's why the mitigations here are architectural, not cosmetic:

> A perfect recording disclosure does not cure a subprocessor contract that permits training
> on clinic call audio.

Which is exactly why Synthflow's §14.4 and Anthropic's Section B matter so much — they are not
nice-to-haves, they're the evidence for your defence.

Don't wait for the California legislature to fix this. The bill people point to was amended in
July 2026 to touch only a narrow category of claims; the sections that reach call recording
are untouched.

## The FTC — the one that reaches you even if HIPAA doesn't

**GoodRx paid $1.5M. BetterHelp paid $7.8M.** Both for sending person-level health data to
advertising platforms.

The 2024 amendment to the Health Breach Notification Rule made the **unauthorised disclosure
itself the reportable breach** — you don't need to be hacked to have a breach. Penalties run
to **$53,088 per violation** (that figure was corrected during this research; an older
$51,744 was superseded in January 2025).

Two things counsel may need told plainly, because vendors say otherwise:

- **Hashing is not de-identification.** A hashed email is one of HIPAA's 18 identifiers, and
  it's hashed *precisely so it can be matched*, which is the opposite of anonymised. "We only
  send hashed emails" isn't a defence — it's a description of the violation
- **Meta's terms cut both ways.** Even if a lawyer blessed a disclosure as lawful, Meta's
  Business Tools Terms §1.h (effective 3 Nov 2025) bans sharing data that "includes or is
  based on, directly or otherwise, health information." So a technically lawful transmission
  can still breach the *clinic's* contract with Meta, get their ad account disabled, and make
  you the cause

> **A correction to something I told you earlier.** I previously quoted WhatsApp Cloud API
> Terms §4.4 as Meta's statement that it isn't a business associate. That clause is actually
> in the Meta Horizon Managed Solutions Terms of Service §9.c, and the WhatsApp terms are now
> **silent** on HIPAA. The conclusion is unchanged and in fact stronger: for advertising
> surfaces Meta doesn't disclaim business-associate status, it **bans health data outright**.
> A clinic cannot fix that by disclaiming a relationship.

## The dependency that sequences all the legal work

Here is the single most useful structural insight in the whole research.

Many cash-pay med spas **never bill insurance electronically**, which means they are **not
HIPAA covered entities**. And they're your likeliest first customers.

That sounds like good news — less regulation. It isn't:

1. If the clinic isn't a covered entity, you aren't its business associate
2. If you aren't a business associate, **the TCPA healthcare carve-out is unavailable to you**
3. Washington's My Health My Data Act has a **private right of action** and no revenue
   threshold, and its exemption is for HIPAA-covered data — which this isn't
4. So you fall under the FTC and state consumer-health-data laws instead

**One determination — is this clinic a covered entity? — decides your contract, your consent
standard, your state-law exposure and your best TCPA defence simultaneously.** It's cheap to
answer and it must be answered first. Every other legal question is downstream of it.

## The lawyer plan

**Two lawyers, not one.** A health-information-privacy lawyer for HIPAA, FTC and CIPA; a
TCPA/telemarketing lawyer for the calling and texting questions. These specialisms rarely
live in the same head, and TCPA changes every quarter.

The screening call is in the runbook — five questions, graded on whether they name the
governing case **without you naming it first**. If you ask about AI vendors and CIPA and they
say "you just need a recording disclosure," end the call; they're two years stale.

Buy it in three phases so you're not paying for everything before you know if the business
works:

| Phase | What | Why now |
|---|---|---|
| **1** | Covered-entity test + your click-through BAA + CIPA posture | All three block shipping. They interlock — the BAA needs the covered-entity output, and the CIPA answer needs to be a term of the BAA |
| **2** | Can we ever send conversion data to Meta/Google? | Your PRD calls this the moat. Get the answer **before** an engineer builds the pipe, not after |
| **3** | Reactivating lapsed patients | Depends on Phase 1's answer. Doing it first means paying twice |

---

# Part 4 — Insurance, and what it doesn't cover

You need **one combined Technology E&O + Cyber policy**, not a plain cyber policy. Here's the
difference in plain terms:

- **Cyber** pays when *your systems* fail — a breach, a ransomware event
- **Tech E&O** pays when *your product* fails your customer — missed bookings, bad
  transcription, a blown promise
- **Media liability** pays when *what your AI says* is actionable

An AI front desk can generate all three from one incident. Buying them separately from
different insurers creates gaps in the seams and arguments about which policy responds.

## Your two worst exposures are excluded as standard

Both confirmed against real policy wordings:

- **TCPA** is excluded by name in Coalition's base cyber form and in the standard general
  liability form
- **Wiretapping** — a real, bound Coalition policy carried a "Wrongful Collection Outside
  Privacy Liability" exclusion killing eavesdropping claims, plus a separate biometric
  exclusion

So the two statutes most likely to be used against an AI phone product are the two your policy
is written to exclude.

## The finding that will save you the most money

> **The exclusion that denies your claim doesn't live in the base policy. It arrives by
> endorsement, with a reassuring name.**

On the bound policy examined, the endorsement titled **"PRIVACY LIABILITY ENHANCEMENT
ENDORSEMENT"** is the one that *added* the wiretapping and biometric exclusions and imposed
**$100,000 sublimits**. It reads like an upgrade. It's a restriction.

Another endorsement on the same policy softened the TCPA exclusion — but only for *"an
unintentional violation of TCPA resulting from a security failure."* Useless: your TCPA
exposure comes from operating normally, not from being hacked.

**Practical rule: never compare quotes on price until you have the full endorsement schedule
by form number.** The quote letter will not show you the exclusions. The runbook has ten
questions to send every broker.

## Three other things

**Your application is a warranty, not a form.** Coalition generates a signed application from
your answers after you bind. An optimistic "yes" on multi-factor authentication or backups
becomes their argument to void the policy at exactly the moment you need it.

**"Voiceprint" is in the biometric statute** — and it's a question on the insurance
application. If you ever store voice embeddings or do speaker matching, even for a friendly
"welcome back" feature, you've created a biometric exposure *and* a coverage exclusion in one
move. Engineer it out and answer "no" truthfully.

**Bodily injury is excluded on both sides and no endorsement fixes it.** If the agent ever
gives clinical guidance and a patient is harmed, you are uninsured. Design so it never
triages, never advises, always escalates — and put that in the underwriting narrative,
because it's also an argument for a lower premium.

## What it costs, and who really decides

Roughly **$3,500–$9,000/year** for $1M limits, **$6,000–$16,000/year** for $2M, given patient
data plus call recording plus AI. Estimate, not a quote.

But healthcare vendor contracts routinely specify **$2M per occurrence and $2M aggregate**.
So your *customers*, not your risk appetite, will set the number. Send their insurance clause
to your broker before you sign it.

**Bind something small now.** These are claims-made policies: they only cover incidents that
happened after the retroactive date. Every day you're unbound is a day no future policy will
ever cover. A modest $1M policy pre-revenue is the cheapest point on the curve and it locks a
retroactive date you carry forward.

---

# Part 5 — The badges question

You liked Synthflow's footer strip: SOC 2, GDPR, HIPAA, ISO 27001, EU Hosting, US Hosting.

**Of those six, healdesk has honestly earned one: US Hosting.**

## Why "HIPAA Compliant" is the worst possible badge for you specifically

Three independent authorities say the same thing.

**HHS:** *"HHS does not endorse or otherwise recognize private organizations' 'certifications'
regarding the Security Rule."*

**The FTC:** *"the Department of Health and Human Services… doesn't certify companies or
products as 'HIPAA compliant.'"*

**AWS:** *"There is no HIPAA certification for a cloud service provider."*

There is no body anywhere that certifies HIPAA compliance. So what is a company displaying
that badge actually asserting? The FTC answered that in ***In re SkyMed International***
(2021), where displaying a "HIPAA Compliance" seal was charged as a **standalone count of
deception** — because the seal *"signaled to consumers that a government agency or other third
party had reviewed Respondent's information practices and determined that they met HIPAA's
requirements"* when none had.

And "we only sell to businesses" is no defence. *Henry Schein Practice Solutions* paid
**$250,000** over claims made in materials aimed at **dentists**, and its order specifically
bars misrepresenting *"the extent to which its products help ensure regulatory compliance"* —
which is precisely what a HIPAA badge on a clinic-facing site does.

You're the worst-positioned company to run that badge: you're a business associate handling
patient data, and your buyers are covered entities who will forward your website to their own
compliance counsel.

**Also don't copy the heading.** *"TRUSTED & VERIFIED BY"* asserts an external verifier, and
that implied third-party review is literally the SkyMed theory. Don't use it even after you
earn every badge under it.

## What we shipped instead

Under the heading **"How we handle patient data"** — which promises a first-party commitment
and implies no outside verifier:

- We sign a BAA with every clinic
- PHI stored in US-only AWS infrastructure under a signed AWS BAA
- We never use patient data to train models
- Read-only access to your practice management system
- Encrypted in transit and at rest with AWS KMS
- Delete any patient's data on request

Plus the line that does the most work:

> *No third party has audited healdesk. These are our own commitments, and we will show you
> the architecture behind any of them. SOC 2 Type II is on our roadmap — we'll publish the
> report date when we have one.*

**This is stronger with clinic procurement than badges would be**, because every line survives
the question *"show me."* And saying out loud that no government agency certifies anyone as
HIPAA compliant is simultaneously a weapon against every competitor flying that badge and an
inoculation for you.

Two notes: the "read-only" line becomes **false** the day the agent writes a booking back —
that's flagged in the code so it changes in the same commit. And the model-training line is
deliberately narrow ("we never…") rather than broad ("we or our vendors never…") because
Synthflow's published docs say nothing about training on customer audio. Upgrade it once you
have that in writing.

## Drop these

**GDPR Compliant** is a self-inflicted wound on a US-only product — it invites a procurement
thread about EU data subjects you can't answer, while obscuring the actual strength, which is
that patient data never leaves the US. **EU Hosting** is on Synthflow's footer because
Synthflow is a Berlin company selling into Europe.

**Any PCI badge is prohibited outright.** The card industry's own brand guide says of a
"PCI DSS Compliance" logo: *"This is NOT an approved logo and may not be used at any time."*
It's the one badge that's a violation even for a fully compliant company. Say instead:
*"healdesk does not store, process, or transmit cardholder data."*

## When to actually buy one

| | Cost, year one | Time | Verdict |
|---|---|---|---|
| SOC 2 Type I | $12–25K | 6–12 weeks | A waypoint, not the first move |
| **SOC 2 Type II** | **$20–45K** | **7–12 months** | The only one with a real trigger |
| ISO 27001 | $15–30K + annual audits | 6–12 months | Wrong credential for this market |
| HITRUST | $20–200K | Months | Not a close call |

**The economics are brutal at your price point.** At $249–799/month your annual contract value
is $2,988–$9,588. A $20,000 SOC 2 programme costs the entire annual revenue of **two to seven
customers**.

And the evidence is that small single-location clinics **don't run vendor security reviews** —
a signed BAA is treated as sufficient diligence at this tier. The "83% of buyers require SOC 2"
figure compliance vendors quote is explicitly about **enterprise** buyers.

**The trigger is buyer type, not deal size:** a private-equity-backed dental group, a
multi-location chain, anything hospital-affiliated. Their risk teams specifically want Type II.

A solo founder *can* pass SOC 2 — there's a generic provision allowing alternative controls
where separating duties isn't practical. **ISO 27001 is structurally harder**: its internal
audit must demonstrate objectivity, which in practice means a one-person company has to buy an
outside auditor.

## The cheapest credible thing to do first

**A documented HIPAA Security Rule risk analysis.** 45 CFR 164.308(a)(1)(ii)(A) is a
**required** implementation specification that applies to business associates — the regulation
opens *"A covered entity or business associate must…"* You owe this whether or not you ever
want a badge, the HHS tool for producing it is free, and its absence is the single most-cited
failure in enforcement actions.

Then a public trust page listing the six commitments with the architecture behind each. Then,
only when a large group appears, SOC 2 Type II.

---

# Part 6 — What we believed that turned out to be wrong

Worth reading on its own, because these are the beliefs that had already shaped decisions.

| We believed | Actually | Consequence |
|---|---|---|
| Bandwidth is the right carrier | Not a Synthflow native integration, no self-serve signup | **Don't open the account.** Twilio until ~50 clinics |
| Synthflow can't do standalone SMS | It can, via the chat-agent API — and SMS is **double-billed**, Synthflow *and* Twilio | Budget for both meters |
| Meta's disclaimer is in the WhatsApp Cloud API Terms | It's in the Horizon Managed Solutions ToS. WhatsApp terms are silent. The operative bar is Business Tools Terms §1.h — a **flat ban on health data** | Same conclusion, correct citation, stronger position |
| Boulevard's risk is a Mindbody-style competition clause | No such clause exists. **Three other clauses are worse**, including one barring use of API data to "evaluate" an AI system | Raise those three before building |
| Chase Anthropic ZDR alongside the BAA | *"HIPAA-ready API access is designed as an alternative to ZDR"* | Don't. It adds negotiation and costs features |
| HBNR penalties are $51,744 | **$53,088** since January 2025 | Update the figure everywhere |
| Third-party sites' Synthflow tier pricing | Not corroborated by any Synthflow source | Ignore it entirely |

---

# Part 7 — What nobody could confirm

Being honest about the edges, because the gaps matter as much as the findings.

- **Will Synthflow sign the BAA below Enterprise?** No primary source settles it. Their BAA
  has no tier gate, but it's "executed at contract signing." Only they can answer
- **Where is the "HIPAA Setting"?** It's the foundation of their entire BAA and doesn't appear
  anywhere in their product documentation. Nobody outside Synthflow can tell you whether your
  coverage is on
- **Do they hold BAAs with their own subprocessors?** They name six (Google Cloud, OpenAI,
  Deepgram, ElevenLabs, Twilio, **Bubble.io**). No evidence they hold executed BAAs with any.
  Bubble.io is the one to ask about — it's a general no-code platform doing "platform
  management"
- **What does Twilio Security Edition cost?** Unpublished. This is the largest unpriced item
  in the entire stack
- **Does the AWS acceptance dialog collect a signatory name?** Undocumented. Have your legal
  entity name to hand
- **Anthropic's own sources contradict each other** on whether Claude Code and Computer Use
  are covered. Their stated tiebreaker: *"Your signed BAA is the official source of truth"* —
  so read the executed PDF, not the docs table
- **Can a non-Boulevard-customer even get a developer account?** Their docs tie app ownership
  to a business. Unclear
- **Whether HighLevel considers you a competitor.** Their terms bar competitors; they ship a
  competing product. Only they, or a court, can answer

---

# Part 8 — What order to do this in

Rough sequencing by what unblocks the most for the least money.

**This week — free, fast, unblocks everything else**

1. Check the Synthflow cluster. If Global, create a US workspace. *(2 minutes to check.)*
2. Accept the AWS BAA in Artifact. *(15 minutes. Free.)*
3. Create a separate Anthropic organisation and enable HIPAA readiness there. *(30 minutes.)*
4. Open a Twilio account, buy one number, **start 10DLC registration** — it takes days to
   weeks and blocks all US texting.

**This month — costs money, or costs waiting**

5. Email Synthflow sales with the six questions. Everything about voice economics depends on
   the answer.
6. Get three insurance quotes going. Bind something small to lock the retroactive date.
7. Engage the health-privacy lawyer for Phase 1 — the covered-entity test first.
8. Set up Stripe products and webhooks, and fix the two provisioning blockers.

**Before customer one**

9. Decide the SMS question: buy Twilio Security Edition, or ship with no patient data in text
   messages.
10. Get the BAA drafted and into the catalog with `approvedByCounsel: true`.
11. Do the HIPAA risk analysis. It's free, it's required of you by regulation, and it's the
    cheapest credibility you can buy.

**When it's relevant, not before**

12. Boulevard and GoHighLevel developer accounts — only when a prospect actually uses one.
13. SOC 2 Type II — only when a multi-location or PE-backed group is in the pipeline.

---

## Where the underlying detail lives

Every claim in this document, with its source URL and confidence rating, plus the ~90
questions to ask vendors and lawyers phrased word-for-word, is in
[blockers-runbook.md](./blockers-runbook.md).

The raw research transcripts — all 99 agents, every fetched page — sit under
`~/.claude/projects/…/subagents/workflows/` in runs `wf_ef612804-ad9` and `wf_afada217-7fa`.
Those are session-scoped and will eventually be cleaned up; these two documents are the
durable record.

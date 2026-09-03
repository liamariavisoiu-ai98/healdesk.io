# Blockers runbook

Step-by-step for every account, contract and legal item that gates launch.

Researched and adversarially fact-checked on **17 August 2026**. Every claim below is
either quoted from a primary source or marked as unconfirmed. Pricing and terms move —
re-check anything load-bearing before you spend money on it.

> **How to read this.** Each section has the same shape: what changed from what we
> believed before, the steps, and the traps. Where a vendor has to answer something, the
> exact words to send them are in a quote block — paste them verbatim.
>
> **New here?** Read [research-conclusions.md](./research-conclusions.md) first. Same
> findings, written as an explanation rather than a checklist — what the rules actually are,
> why they exist, and what they mean for the business. Come back here to do the work.

---

## 0. What this research changed

Five things we previously believed turned out to be wrong or incomplete. They are listed
first because they change decisions, not just details.

| We thought | Actually |
|---|---|
| Bandwidth is the right carrier | **Twilio is, for now.** Bandwidth isn't a Synthflow native integration and has no self-serve signup. Revisit past ~50 clinics or ~$2,000/mo telephony spend |
| Synthflow can't send SMS without your Twilio | Two-way voice-agent SMS still needs your Twilio — but Synthflow **does** have standalone outbound SMS via the chat-agent API (`POST /v2/chat/outbound`), and it **double-bills**: 5 AI messages = 1 Synthflow minute, *plus* Twilio's charge |
| Meta's WhatsApp Cloud API Terms §4.4 disclaim business-associate status | That clause is in the **Meta Horizon Managed Solutions ToS §9.c**. WhatsApp Business Solution Terms are now **silent** on HIPAA. The operative bar for ad surfaces is **Business Tools Terms §1.h** — a flat ban on health data, which is *stronger* than a BA disclaimer. Same conclusion, better citation |
| Boulevard's risk is a Mindbody-style anti-competition clause | It has **no** such clause. Three *other* clauses are worse — see §5 |
| We should chase Anthropic ZDR | Anthropic says explicitly you **don't need ZDR if you have HIPAA readiness** |

---

## 1. Synthflow — the tier question, and a bigger one underneath it

**Answer: probably yes, but two things outrank it.**

Synthflow publishes a complete BAA at `docs.synthflow.ai/baa` (v1.0, 13 May 2026). It
contains **no tier gate, no add-on fee, and no per-agent HIPAA charge**. The one tier
sentence on their security page gates **SSO** to Enterprise, not the BAA. §14.4 (no
training on Customer Input/Output) still exists, verbatim, and carries into the Enterprise
US GTC.

But their public pricing page today shows **only** "Enterprise contracts start at $30,000
annually" — no self-serve card, no per-minute rate — and the BAA is described as "executed
at contract signing," which points at a sales motion. Your ~$25/mo account exists; their
pricing page no longer advertises the tier it sits on.

### ⚠️ Do this before anything else: check your cluster

Your existing workspace is almost certainly storing data **in the EU**, and it cannot be
moved.

1. Synthflow → **Admin → Workspace Settings → Preferences → Customer Region**
2. If it says **Global**, your data is in the EU. Global is documented as the "Default
   cluster for existing workspaces" and the US cluster only launched 27 January 2026
3. Their FAQ: *"Cluster selection is permanent. If you need a different region, create a
   new workspace in the correct cluster and migrate your agents and configuration."*
4. **Create a new workspace on the US cluster.** API base becomes
   `https://api.us.synthflow.ai/`. WhatsApp and SMS chat channels only work on US
   workspaces anyway

Do not put PHI into the existing workspace, whatever the tier answer turns out to be.

### The BAA itself has three defects worth negotiating

- **Counterparty is AgentFlow AI GmbH** — a Berlin company
- **§15 liability cap is six months of fees paid** — roughly **$150** on your plan, against
  HIPAA penalties in the hundreds of thousands
- **§8 governing law** says "the laws of the State in which Business Associate maintains
  its principal place of business" — but the business associate is a German GmbH with no US
  state. That is a drafting defect that needs fixing before signature
- **§9** lets them subcontract "without the express written consent of Covered Entity"
- **§14** indemnification runs one way, against you

### Send this to sales

Via https://synthflow.ai/talk-to-sales or contact@synthflow.ai:

> We are a HIPAA business associate serving US healthcare covered entities, currently on a
> self-serve plan with pay-as-you-go minutes. Please confirm in writing:
>
> 1. Will AgentFlow AI GmbH execute the BAA published at docs.synthflow.ai/baa on our
>    current self-serve plan, or is Enterprise required?
> 2. Is there a HIPAA add-on SKU, and is it priced per agent, per workspace, or per minute?
> 3. Where exactly in the product is the "HIPAA Setting" referenced in Exhibit A of your
>    BAA? It is not documented anywhere in docs.synthflow.ai. Is it the agent-level Save
>    Recordings / Save Transcripts toggles, or a separate flag your team enables?
> 4. Can the §15 liability cap be raised above six months of fees?
> 5. Do you hold executed BAAs with Google Cloud, OpenAI, Deepgram, ElevenLabs, Twilio and
>    Bubble.io? Please send copies or attestations.
> 6. Who is your telephony subprocessor for numbers purchased through Synthflow, and does
>    the BAA cover the PSTN leg on those numbers?
> 7. Please send the full schema of the post-call webhook. Specifically: does it report
>    the **carrier disposition before the call reached you** — whether the clinic's own
>    number rang and went unanswered, or was engaged — on a conditionally forwarded
>    line? If that is not in the payload, can it be passed through from the inbound SIP
>    headers or the forwarding diversion header?

**Why 7 matters more than it looks.** It is the only one of the seven that decides whether
a *shipped feature works*, rather than what it costs or who is liable.

`apps/app/src/lib/voice/ingest.ts` classifies every call as recovered or not, and that
classification is the number a clinic judges us on. On a conditionally forwarded line the
rule is "every call we answered is one their receptionist did not" — but that is only
defensible if we can show the call reached us *because* the clinic's line rang out or was
busy. Those are carrier facts, not Synthflow facts: `VoiceCallEvent.rangAtClinicFirst` and
`clinicLineBusy` are exactly this, and the module deliberately refuses to take the vendor's
own "missed call" flag instead, because platforms report disposition and we need the
counterfactual.

If Synthflow cannot supply it, the fallback is reading it from the **Twilio** call-status
webhook on the landing number and joining on the call id — a second integration, and worth
knowing before an engineer starts rather than after. Ask this before writing the ingest
route; the mapping is small once the shape is known and has to be rewritten if it is guessed.

Also request the Trust Vault documents at https://security.synthflow.ai/ (SOC 2 Type II
report, ISO 27001 certificate, subprocessor list) and the DPA from privacy@synthflow.ai —
the US Enterprise GTC says the DPA is "made available upon the Customer's request," so it
is not published.

### Verify the storage-off/webhook-on behaviour yourself

Turn **off** Save Recordings and Save Transcripts, keep an Information Extractor action
configured, place a test call, inspect the post-call webhook. Confirm `executed_actions`
still arrives with extracted values while `call.transcript` is empty. The docs don't state
this — test it.

**Same call, second thing to check:** place the test call through a conditionally
forwarded number rather than dialling the Synthflow number directly, and look for any
field carrying the pre-forward disposition (SIP `Diversion` / `History-Info`, a `reason`
of `no-answer` or `busy`, or similar). That answers question 7 empirically, and a captured
sample payload is what the ingest route gets written against.

**Do not enable PII Redaction on an intake agent.** Their docs: *"Information extractors
cannot extract redacted PII"* — redacting names breaks patient-name capture.

---

## 2. AWS BAA — the exact click path

Free, instant, self-serve. **There is no step where you list the services you will use** —
this is the single biggest misconception. Accepting designates the *entire account* as a
HIPAA Account, and policing the boundary is entirely on you.

### Steps

1. Sign in to the AWS account that will hold PHI. Root is **not** required — an admin, or
   any principal with `AWSArtifactAgreementsFullAccess`, can do it
2. Go to **https://console.aws.amazon.com/artifact/** → left nav → **Agreements**
3. Choose the **Account agreements** tab. (Organization agreements only applies if you're
   in the *management* account of an Organization with all features enabled. You're
   standalone, so: Account agreements. If you create an Organization later, re-accept there
   or new member accounts are uncovered)
4. Select **AWS Business Associate Addendum** → **Download agreement**. This forces the
   **AWS Artifact NDA** first — tick "I have read and agree to all the terms of the NDA",
   then **Accept NDA and download**. ⚠️ *People stop here thinking they've accepted the
   BAA. They haven't.*
5. **Read the PDF.** It's the only place the security-configuration obligations, breach
   timelines and the "HIPAA Account" definition appear. Your clinic-facing BAA cannot
   promise more than AWS promises you
6. Back in Artifact with the BAA selected → **Accept agreement** → tick "I agree to all of
   these terms and conditions" → **Accept agreement** → **Accept**
7. **Verify:** the row shows **Active**, and the button flips from *Accept agreement* to
   *Terminate agreement*. Re-download the executed copy and screenshot the Active status —
   clinic procurement will ask

### Your five services are all covered

As of the HIPAA Eligible Services Reference revision of **3 August 2026**: Amazon RDS
(PostgreSQL named explicitly), AWS KMS, Amazon SES, Amazon S3, Amazon ECS, and AWS Fargate
(**ECS and EKS engines only**) are all listed.

**AWS App Runner is not** — the earlier analysis was right — and it's now *closed to new
customers* anyway, so a new account can't provision it. Use ECS on Fargate.

> Watch for someone quoting App Runner's docs saying auditors assess it "as part of multiple
> AWS compliance programs. These include SOC, PCI, FedRAMP, HIPAA." That's boilerplate on
> many service pages. Only the HIPAA Eligible Services Reference governs.

### Because AWS records nothing, you must

Write one page for the compliance file: BAA accepted on `<date>` for account `<12-digit
ID>`; PHI processed only in RDS/KMS/SES/S3/ECS/Fargate; all six on the reference as of
3 Aug 2026; named person re-checks quarterly.

### The engineering obligations people miss

| Thing | Why |
|---|---|
| `rds.force_ssl = 1` via a custom parameter group + reboot | Default is `0` (**off**) on PostgreSQL **14 and older**. And `sslmode` defaults to `prefer` in libpq/JDBC, which silently falls back to plaintext — use `verify-full` |
| RDS storage encryption **at creation** with a customer-managed KMS key | Cannot be enabled in place. Fixing it later means snapshot → encrypted copy → restore → downtime |
| S3 bucket policy denying `s3:*` when `aws:SecureTransport` is `false` | Plus SSE-KMS default encryption, Block Public Access, versioning |
| **SES configuration set with `TlsPolicy=REQUIRE`** | ⚠️ **The most likely single BAA violation in this product.** SES defaults to *opportunistic* TLS: *"If SES can't establish a secure connection, it sends the message unencrypted."* `aws sesv2 put-configuration-set-delivery-options --configuration-set-name healdesk-phi --tls-policy REQUIRE`. Trade-off: non-TLS recipients get **dropped**, so wire bounce monitoring |
| CloudWatch log-group retention + customer-managed KMS key | Default retention is **Never expire** — an indefinite PHI store you didn't intend |
| Never put PHI in identifiers | S3 keys, bucket names, RDS identifiers, ECS task names and tags all land in CloudTrail, console listings and Cost & Usage Reports |
| AWS Config rules: `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled`, `cloudwatch-log-group-encrypted` | The encryption obligation is continuous. One unencrypted snapshot restored months later is the failure mode |

Pick **one US region** (us-east-1 or us-west-2) and deploy everything there.

---

## 3. Anthropic — what a BAA is, and why you need one anyway

### What a BAA is

A HIPAA-mandated **contract**, not a marketing promise. 45 CFR 164.502(e) bars a covered
entity from handing PHI to a vendor without one. 45 CFR 164.504(e)(2)(ii) lists what it
must contain: appropriate safeguards, reporting of breaches *and* security incidents,
subcontractor flow-down, availability of records to HHS, and return-or-destruction at
termination.

You're a business associate of each clinic, so you sign BAAs **with clinics** on the way in.
Anthropic is your subcontractor, so you need a BAA **from Anthropic** on the way out —
45 CFR 164.504(e)(2)(ii)(D) requires you to *"ensure that any subcontractors that create,
receive, maintain, or transmit protected health information on behalf of the business
associate agree to the same restrictions."*

### Yes, they already don't train on your data

Commercial Terms of Service **Section B** (effective 17 June 2025), verbatim:

> **Anthropic may not train models on Customer Content from Services.**

You can verify it yourself at https://www.anthropic.com/legal/commercial-terms, and in the
Privacy Center / Trust Center.

**But training is one item on a list of about ten.** None of the other required terms exist
for you without a signed BAA. The ToS destruction clause (E.4) is materially *weaker* than
164.504(e)(2)(ii)(J) — it exempts "copies in Recipient's automated back-up systems."

### Steps

1. **Create a dedicated organization for PHI traffic** at https://platform.claude.com/.
   Anthropic: *"HIPAA readiness is enforced at the organization level. If you need both
   HIPAA-ready and general-purpose API access, use separate organizations for each."*
   ⚠️ Enabling is **permanent and cannot be disabled by an administrator** — a one-way
   door. Don't do it on the org you use for the marketing site, internal tooling, or Claude
   Code
2. **Console → Settings → Privacy → HIPAA compliance card.** Three steps, each unlocking
   the next: download the BAA → download the HIPAA Implementation Guide → accept as an
   authorized legal representative. Your enablement "is bound to the exact BAA version you
   downloaded." Save both PDFs with the download date
3. **If the card isn't there**, use https://claude.com/contact-sales:

   > We are a HIPAA business associate building an AI front-desk (voice + chat) for elective
   > healthcare clinics, US-only. We need (a) Anthropic's BAA covering the Claude API for org
   > `<ORG_ID>`, and (b) written confirmation of which Messages API features are Eligible
   > Services under that BAA version. Self-serve HIPAA enablement is not appearing in
   > Console → Settings → Privacy for our org. Pre-revenue, first customer not yet signed.
   > What is required to enable this?

4. **Do not also request ZDR.** Their FAQ: *"Do I still need ZDR if I have HIPAA readiness?
   No. HIPAA-ready API access is designed as an alternative to ZDR."* Chasing both adds
   negotiation time and can cost features
5. The **DPA** is auto-incorporated when you accept the Commercial ToS — no separate
   signature. Save a dated PDF. It is *not* a substitute for the BAA

### What else to make sure of

**Excluded from BAA coverage** (the API returns HTTP 400): Batch API, Files API, Agent
Skills, code execution, programmatic tool calling, Managed Agents, MCP connector, MCP
tunnels, web fetch, tool search, **context editing**, **compaction**, and the Advisor tool.

Three of those matter architecturally:

- **Compaction and context editing are ineligible.** For a voice agent with long calls this
  is the biggest single constraint — you must manage transcript history client-side. Budget
  for it now, not after the first 400
- **Files API is out, but inline PDFs are fine.** *"HIPAA eligibility applies to PDFs sent
  inline through the Messages API, not through the Files API"* — intake forms go as base64
  in the message
- **Web *search* is eligible; web *fetch* is not.** And dynamic filtering is ineligible for
  both (it runs code execution underneath)

**Keep PHI out of JSON schemas.** Anthropic: *"the API compiles JSON schemas into grammars
that are cached separately from message content. These cached schemas do not receive the
same PHI protections as prompts and responses."* No patient names, DOBs or MRNs in enum
values, const values, property names, or regex patterns.

**Also:**

- **Console and Workbench are never covered.** Never paste PHI into the Workbench to debug
  a prompt. This is the most likely real-world violation on a one-person team
- **Trust-and-safety retention pierces both ZDR and the BAA** — flagged content up to
  2 years, classification scores up to 7. Another reason to keep prompts clinically neutral
- **The BAA doesn't follow you to Bedrock or Google Cloud** — there the cloud provider is
  the data processor and you need *their* BAA
- **Their own sources conflict** on Claude Code and Computer Use. Anthropic's stated
  tiebreaker: *"Your signed BAA is the official source of truth."* Read the executed PDF
- **Their Usage Policy adds product requirements the BAA doesn't**: disclose AI use *"at a
  minimum at the beginning of each session"* — for voice, the opening greeting of every
  call — and any advice affecting an individual needs qualified-professional review.
  Scheduling and intake are defensible; anything reading as triage is not

**Verify enforcement in staging:** send a deliberate `code_execution` request and confirm
the documented 400. Log it as evidence of technical safeguards.

---

## 4. Telephony — you're right about Bandwidth, wrong about "no carrier"

**Do not open a Bandwidth account.** It isn't in Synthflow's native telephony list, their
pricing is quote-only with no self-serve signup, and at zero customers you'd be negotiating
a carrier contract to solve a problem a free Twilio signup solves today.

But "Synthflow's numbers or the clinic's own numbers" doesn't work either, for a reason
that has nothing to do with SMS:

> **A Synthflow number is a *new* number.** "Sharing Synthflow's numbers with our
> customers" means asking a med spa to abandon the number on their signage, their Google
> Business Profile, insurance directories, and every past patient's phone. No clinic will
> do that.

Also: *"No two inbound agents can share the same number"* — so each clinic needs its own
number in **every** architecture. Synthflow numbers save nothing; they only change whose
account holds them.

### The architecture that actually works

**The clinic keeps its published number and conditionally forwards it to a landing number
you own in your own Twilio account.**

1. **Open Twilio** at https://www.twilio.com/try-twilio (free, no card for trial). Buy one
   US local number with Voice + SMS. Buy it **in Twilio, not in Synthflow** — Synthflow's
   own guidance calls their direct purchase *"for quick testing"* and says *"Move to Twilio
   or SIP/PBX for scale and control."* A Twilio number is an asset you can re-point or port
2. **Connect Twilio to Synthflow**: Admin → Workspace Settings → Integrations → Twilio,
   paste Account SID and Auth Token. This is what unlocks post-call SMS, in-call SMS
   actions, and the SMS chat channel
3. **Register A2P 10DLC on day one**, not at launch: Twilio Console → Messaging →
   Regulatory Compliance → A2P 10DLC. Register a Brand under healdesk's EIN, then one
   Campaign. Choose **Low-Volume Standard** (needs an EIN; you can't use Sole Proprietor if
   healdesk is an LLC). Use case: **Customer Care** or **Account Notification** — do not
   describe it as marketing. Approval is not instant and blocks all US SMS
4. **Clinic onboarding**: conditional forwarding (busy / no-answer / after-hours) from their
   published number to your landing number. Usually `*61*<number>#` for no-answer,
   `*67*<number>#` for busy, or a routing rule on a VoIP PBX. Forwarding is reversible in
   one step — that's the biggest objection-killer in the sales conversation. **Verify the
   original caller's CLI survives the hop** before go-live
5. **Later, when a clinic wants to text from its published number**: Twilio Console → Phone
   Numbers → Manage → **Hosted Numbers**, with an electronic LOA from the clinic's
   authorized signer. 1 business day for landline, up to 3 for toll-free

### Two traps that will bite

**The VoIP exclusion.** Twilio hosted numbers cover US/Canada **landline and toll-free
only** — *"Mobile numbers and VoIP numbers are not supported."* A large share of modern
clinics publish a RingCentral/Nextiva/Dialpad number. You'll discover this per deal, after
signing, when the LOA is rejected. **Ask during discovery**: *"Is your main number a
traditional landline or a VoIP/cloud phone system?"* Telnyx accepts VoIP; Twilio doesn't.

**Missed-call text-back is architecturally awkward here.** If the clinic forwards on
no-answer, the AI *answers* — so there's no missed call. Genuine missed-call events are:
caller abandons while ringing, hangs up on the AI, or concurrency overflow. And the SMS
comes from *your* landing number, not the number they dialled — so the patient gets a text
from a stranger's number seconds after calling their dermatologist. That reads as spam.
Hosted SMS on the clinic's own number is what makes the feature actually work.

### SMS is double-metered

Correcting an earlier belief: **both parties bill.** Synthflow charges SMS as chat usage —
5 AI messages = 1 Synthflow usage minute, against the same meter as voice — *and* Twilio
bills its own rate directly.

And Synthflow **does** have standalone outbound SMS, just not in the voice-agent docs:
`POST https://api.us.synthflow.ai/v2/chat/outbound` with `channel: "sms"`. That said,
build scheduled reminders on the Twilio API directly so reminders, missed-call text-backs
and post-call SMS all originate from one number and one campaign — otherwise you fragment
the patient's thread.

### The real budget line

**Twilio requires Security or Enterprise Edition before it will sign a BAA**, and that is
unpublished, sales-negotiated, and almost certainly four figures monthly. Your HIPAA
posture, not your traffic, is what makes telephony expensive.

Before your first covered-entity go-live, decide: buy Twilio Security Edition, or ship v1
with **no PHI in SMS**. Option two is harder than it sounds — *"Reminder of your
appointment at [Dermatology Clinic] tomorrow at 2pm"* identifies the person as a patient of
a named provider. **That is a lawyer's call, not an engineer's.**

> **When Bandwidth becomes right:** telephony spend over ~$2,000/month, past ~50 clinics,
> or when you need to be carrier of record for bulk porting. Their BAA is notably the most
> accommodating of the five — it explicitly covers customers acting as a business associate,
> which is exactly your role, and isn't visibly tier-gated.

> ⚠️ **Telnyx**: their support article (29 Jan 2026) claims no BAA is needed under the
> conduit exception, while their own HIPAA architecture guide addresses customers who *have*
> a BAA with them. A vendor declaring itself a conduit does not bind OCR, and the exception
> is narrow. Don't accept "we don't need to sign one."

---

## 5. Boulevard — the qualifying question that kills deals in five minutes

### Ask this first

> **Which Boulevard plan are you on — Essentials, Premier, or Enterprise? Do you have API
> access enabled?**

Boulevard's API feature page states verbatim: **"Available for Enterprise tier only."** A
med spa on a lower tier simply cannot connect healdesk, no matter what Boulevard grants
you. Enterprise is bespoke and unpriced. Make this a sales-qualification question, not an
integration-time discovery.

### There is no application form

Email **partnerships@blvd.co**. The partner page lists three tracks; Development and
Integration Partners both have a CTA reading *"Email Us to Apply"* pointing at that
address. (The PartnerStack link is the **Affiliate** track — a referral programme paying
$750/demo and $750/closed sale. It grants **no API access**. Applying there signals you
misread the programme.)

Subject: `Integration Partner application — healdesk (AI front desk for medspa/dental)`.
Send from your company domain.

> We build healdesk, an AI voice + chat front desk for high-ticket elective healthcare
> clinics, US-only. We are a third-party vendor, not a Boulevard customer. We need
> READ-ONLY Admin API access to a client clinic's appointments and orders solely to
> attribute and verify revenue recovered by our agent. Requested scopes: `appointment:read`,
> `order:read`, `client:read`, `location:read`. We would like to (1) register a Public App
> under the 2026-06 manifest model, (2) get a sandbox business, and (3) discuss four specific
> clauses in the API License Agreement before we build. Who is the right person to talk to?

### The good news

No blanket "no competing product" clause — the thing that ruled Mindbody out doesn't exist
here. That language lives only in the consumer-facing Client Terms of Service, which
doesn't govern integrators.

The technical path is genuinely good: 2026-06 Admin API is GraphQL over **OAuth 2.1** with
granular scopes, self-serve manifest-based app registration, a real sandbox at
`sandbox.joinblvd.com`, documented leaky-bucket rate limits (per app **per business**, so
one clinic can't starve another), and the APIs are currently free.

### The bad news — four clauses to raise *before* you write code

Quote them by number and ask for written answers.

| Clause | Text | Why it hits healdesk |
|---|---|---|
| **§4.2(c)** | Custom API Credentials may not be used "for any commercial purpose, including… the sale or licensing of any Application… that incorporates, integrates, or uses the Boulevard APIs and is made available to third parties" | The obvious per-clinic Custom App route is a **trap** for a paid SaaS |
| **Addendum A §4.2.2** | "not scrape, access, download, store, build databases or otherwise create permanent copies of any Customer Data… without the express consent of Boulevard and the Customer" | That is *exactly* what verifying recovered revenue requires |
| **Addendum A §4.2.16** | "not use Customer Data… to develop, train, fine-tune, **evaluate**, or improve any artificial intelligence or machine learning model or system… without Boulevard's prior written consent" | Aimed squarely at AI vendors. "Evaluate" is broad enough to cover measuring your own agent's recovered-revenue performance |
| **Addendum A §4.2.12** | "not communicate with Clients directly or indirectly" (carve-out if consent is in your Service Agreement or Privacy Policy) | Your agent phones and texts patients |

### And a fifth problem: your customer may be in breach

Acceptable Use Policy **§7(e)** bars the clinic from inputting PHI *"into any third-party AI
system not expressly authorized under your DPA or BAA with Boulevard."* healdesk is a
third-party AI system. Get expressly authorized in writing, or you are selling your
customers a compliance liability.

**Boulevard will not sign a BAA with you.** MSA §2.2.6 requires the *clinic* to execute one
with Boulevard (request via legal@joinblvd.com). The API License Agreement never mentions
HIPAA, PHI, BAA or business associate once.

### Then the build

Request a sandbox from **dev-support@blvd.co** (cc partnerships@). Register the app via
JSON manifest in the Developer Portal. For a read-only backend with no UI: `token_distribution: "offline"`, omit `install_url` and `oauth_redirect_urls` → client-credentials
grant. Sensitive scopes need a per-scope justification string, and *"Justifications are
reviewed by Boulevard."*

**Always pass the `scopes` parameter on `/oauth2/authorize`.** Omit it and Boulevard treats
it as `scopes=*`, and the clinic owner sees a consent screen saying your app can *"view and
modify all data… including appointments, clients, staff, orders, and business settings."*
That loses the deal on the spot.

Other sharp edges: authorization codes are **single-use, 60-second** — redeeming twice
revokes **all** grants for that app on that business. Client-credentials tokens last 24h
with **no refresh token**. Submitting a manifest version **locks it permanently**. Consent
alone doesn't complete the install — until your server exchanges the code, the clinic sees
"Install" with no error. And Addendum A §4.2.9 puts you on a **30-day deletion clock** after
uninstall, auditable "at any time, including after this Agreement has been terminated."

Liability is capped at the greater of $100 or fees paid — and the APIs are free, so
effectively **$100**. Boulevard can terminate for any reason on 30 days' notice, or
immediately if it believes you're in breach.

---

## 6. GoHighLevel — easier to start, harder to scale

Self-serve signup at **https://marketplace.gohighlevel.com** → Sign Up. No HighLevel agency
subscription is documented as a prerequisite. The first user becomes the **Owner** and
there can only be one — sign up with `dev@healdesk.io`, not a personal Gmail.

### Steps

1. **Sandbox first**: Developer Portal → **Testing** → **+ Create App Test Account**. Free
   Enterprise-feature trial access. 2 sub-accounts, email/SMS disabled by default
2. **My Apps → Create App.** App Type = **Private** (*"Not listed in the Marketplace"*,
   goes live immediately, **no review**). Target User = **Sub-account**. Who Can Install =
   **Both Agency & Sub-account** if some clinics are run by a marketing agency
3. **Build → Advanced Settings** → add exactly these scopes and nothing more:
   `contacts.readonly`, `calendars.readonly`, `calendars/events.readonly`,
   `calendars/groups.readonly`, `opportunities.readonly`, `payments/orders.readonly`,
   `payments/transactions.readonly`, `payments/subscriptions.readonly`, `locations.readonly`.
   Add `oauth.readonly` + `oauth.write` **only** if agencies can install
4. **Redirect URL** in the same panel: `https://app.healdesk.io/oauth/highlevel/callback`.
   Must match byte-for-byte or you get a 422
5. **Manage → Secrets → Client Keys → Add.** ⚠️ *"Copy and store your Client Secret
   immediately. Once you click OK, it will not be shown again."*
6. Authorize URL: `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=…&client_id=…&scope=…` (space-separated scopes). For white-labelled agency
   portals use `marketplace.leadconnectorhq.com` instead
7. Token exchange: `POST https://services.leadconnectorhq.com/oauth/token`, form-encoded,
   `user_type=Location`. All API calls need `Version: 2021-07-28` alongside the Bearer token
8. **Send clinic #1 the install link.** Private apps need no review, no fee, no wait

### The three things that break integrations

**Refresh tokens are single-use and rotate.** *"Once you use a Refresh Token to obtain a new
Access Token, the original Refresh Token becomes invalid."* If two workers refresh
concurrently, one wins and one **permanently orphans** the connection — the clinic must
manually reauthorize. Take a per-installation distributed lock around refresh, persist the
new token atomically with the access token, refresh proactively at ~T−60min.

**Agency install ≠ location token.** Even with Target User = Sub-account, an *agency* user's
install yields a Company-type token and every sub-account endpoint 401s. Second code path:
`GET /oauth/installedLocations` → `POST /oauth/locationToken` per location.

**The 5-agency wall.** Private apps created on or after 18 Nov 2025 cap at **5 agencies**
(sub-accounts don't count). At agency #6 new installs are blocked — *and you also lose the
ability to ship new versions*. Exits: publish publicly, or request a **Security Review**
(demo video + scopes-justification video + ≥20-character written rationale; no fee
mentioned). **Start recording those videos around customer #3.**

### Consider skipping the Marketplace entirely at first

**Private Integration Tokens** need no developer account, no app, no review, and have no
5-agency cap — the clinic generates a scoped token in their own settings and hands it to
you. Downsides: static tokens (manual 90-day rotation), worse onboarding UX, per-account
manual setup. For your first 2–3 design partners this is materially faster.

### HIPAA and the competing-products clause

- The clinic needs HighLevel's **HIPAA Compliance add-on at $297/mo**, then signs a BAA
  inside HighLevel's Documents & Contracts. Accounts are **not** HIPAA compliant by default
- ⚠️ The add-on is **irreversible** — cannot be deactivated, refunded, cancelled or
  downgraded, and applies account-wide. Don't casually tell a prospect to "just turn on
  HIPAA"; it's a permanent $3,564/yr commitment
- **HighLevel's BAA does nothing for you.** You need your own BAA with each clinic
- **Get counsel on this before building:** ToS Section 1 (Last Updated June 2026) states
  *"You may not use the Platform or the Services if You are an employee, partner, or
  director of our Competitors or intend to gain access to the Platform in order to compete
  with the Platform."* HighLevel ships Conversation AI and Voice AI. Treat HighLevel as a
  channel that can be revoked, not as infrastructure
- The **Marketplace Platform Agreement** (marketplace.gohighlevel.com/platform-agreement)
  is a JS SPA that returns nothing to a non-browser fetch. It's a *separate* contract from
  the main ToS and most likely to contain developer-specific restrictions. **Open it in a
  real browser and read it before signing**

---

## 7. Insurance — buy one combined form, and hunt the endorsements

Cyber pays when your systems fail. Tech E&O pays when your *product* fails your clinic
customer. Media liability pays when your AI *says* something actionable. An AI front desk
can generate all three from one incident — buy **one combined Tech E&O + Cyber form with a
single limit and single retention**, because splitting them across carriers creates seam
gaps and "other insurance" fights.

### Your two worst exposures are excluded by default

Both confirmed against real policy wordings:

- **TCPA** — excluded by name in Coalition's base cyber form (Exclusion W "Violation Of
  Acts/Laws", item 5) and in the ISO CGL (Coverage A exclusion q. / Coverage B exclusion p.,
  "Recording And Distribution Of Material Or Information In Violation Of Law")
- **Wiretapping / CIPA** — a real bound Coalition policy carried a *"Wrongful Collection
  Outside Privacy Liability"* exclusion killing wiretapping/eavesdropping/pixel claims, plus
  a separate **Biometric exclusion**

⚠️ **The exclusion that denies your claim arrives by endorsement with a friendly name.** On
that policy, the endorsement titled **"PRIVACY LIABILITY ENHANCEMENT ENDORSEMENT"** (form
CYUSP-50EN-000030-1123-01) is the one that *added* the wiretapping and BIPA exclusions and
imposed **$100,000 sublimits**. Another endorsement softened TCPA with a carve-back for *"an
unintentional violation of TCPA resulting from a security failure"* — useless, because your
TCPA exposure comes from normal operation, not from being hacked.

### Steps

1. **Write down three facts first** — they drive every quote and every exclusion fight:
   (a) does the agent make **outbound** calls/SMS or only answer inbound? (b) do you record
   and transcribe, and is there a disclosure before audio is captured? (c) do you store
   **voice embeddings or speaker-ID vectors**? Illinois BIPA's definition of "biometric
   identifier" expressly includes **voiceprint**, and it's question 8 on Corvus's
   application. If the honest answer to (c) is no, engineer it so it stays no
2. **Make the security controls true before you apply.** The application is a **warranty** —
   Coalition generates a signed application from your answers after binding, so an
   optimistic "yes" on MFA or backups is a rescission argument at the worst moment. Their
   literal questions: encryption on endpoints and portable media; MFA on email, VPN/RDP, and
   privileged/cloud admin; weekly backups held offline or on a separate network; out-of-band
   verification for transfers over $25,000. Corvus adds: immutable backups in 2+ geographies,
   EDR product name, encryption at rest and in transit, annual phishing training
3. **Three digital quotes in parallel**: [Vouch](https://www.vouch.us/) (they publish a
   healthcare/life-sciences page citing PHI, HIPAA and BAA expertise),
   [Embroker](https://www.embroker.com/) (their Tech E&O/Cyber carries an **AI coverage
   endorsement automatically at no extra charge** since 5 Aug 2025, including regulatory
   investigation defense and up to $150,000 algorithm removal expenses), and
   [Founder Shield](https://foundershield.com/)
4. **Plus one retail broker who can reach the E&S market** for the TCPA question — the
   digital brokers won't solve it. Name the wholesalers to them in writing: **CRC Group's
   ExecPro practice** and **Amwins**, and specifically ask them to approach **Munich Re
   Specialty – North America Financial Lines**, which has publicly stated its
   professional/management liability forms can offer affirmative TCPA coverage (usually
   defense-only and sublimited). You cannot approach wholesalers directly — they only accept
   business from licensed retail agents
5. **Send every broker the same ten questions** (see below)
6. **Refuse to compare on price until you have the endorsement schedule by form number.**
   The quote letter will not show you the exclusions
7. **Bind something now, at low limits.** These are claims-made policies: every day unbound
   is a day of wrongful acts no future policy will cover. A modest $1M/$1M combined form
   pre-revenue locks an early **retroactive date** you carry forward. Insist future renewals
   carry full prior acts, or at minimum the original retro date

### The email to send

> We are a pre-revenue US software vendor selling an AI voice and chat front desk to
> elective healthcare clinics. We are a HIPAA business associate and sign BAAs. Our software
> places and receives phone calls and SMS on behalf of clinic customers and records and
> transcribes those calls. Please quote a COMBINED Technology E&O and Cyber form with a
> single limit and single retention, and answer each of the following in writing against the
> specific form you are quoting:
>
> 1. Does the form exclude violation of the Telephone Consumer Protection Act — it may appear
>    as a Violation of Acts/Laws exclusion, an Unsolicited Communications exclusion, or a
>    Distribution of Material in Violation of Statutes exclusion? Quote the cost of
>    affirmative TCPA coverage; if only defense costs are available, state the sublimit and
>    whether it erodes the policy limit.
> 2. Does the form exclude wrongful collection, wiretapping, eavesdropping, session replay,
>    or tracking technologies? Quote the cost of a buy-back — for example Coalition Enhanced
>    Privacy Liability — and state whether it is at full policy limits or a sublimit.
> 3. Does the form exclude biometric claims including BIPA, Texas CUBI, or Washington My
>    Health My Data? Our product processes recorded human speech; please quote affirmative
>    coverage for voiceprint allegations.
> 4. State the exact wording of the bodily injury exclusion and whether mental anguish and
>    emotional distress are carved back for privacy liability and multimedia content liability.
> 5. Is any AI or generative AI exclusion attached to this quote, or to the GL if you are
>    quoting GL — specifically ISO forms CG 40 47, CG 40 48, or CG 35 08, or a
>    carrier-specific absolute AI exclusion? If yes, quote an alternative with affirmative AI
>    coverage.
> 6. Confirm the contractual liability exclusion is carved back to the extent we would have
>    been liable absent the contract, because we indemnify clinic customers under our MSA and BAA.
> 7. Confirm Multimedia Content Liability is included and that the definition of multimedia
>    wrongful act reaches right of publicity and appropriation of voice.
> 8. Confirm the Regulatory Defense insuring agreement responds to privacy regulatory
>    proceedings and HHS OCR, not only to a security failure or data breach, and state the
>    regulatory sublimit.
> 9. State the retroactive date and whether full prior acts is available.
> 10. State whether the carrier is admitted or surplus lines and give the A.M. Best rating.
>
> Please send the specimen policy form and the complete endorsement schedule with the quote.

### Budget and the number your customers will set

Roughly **$3,500–$9,000/yr** for combined $1M/$1M, **$6,000–$16,000/yr** for $2M/$2M given
PHI + call recording + AI. *(Estimate, not a quote.)*

But healthcare vendor contracts commonly specify *"Technology professional liability errors
and omissions insurance… with limits not less than two million dollars ($2,000,000) per
occurrence, and two million dollars ($2,000,000) per annual aggregate."* **Your customers,
not your risk appetite, will set the number.** Send the clause to your broker *before* you
sign it.

Also budget for a **tail** (extended reporting period, typically 100–200% of expiring
premium): vendor clauses routinely demand coverage stay in force **five years past contract
end**.

### Three traps

- **Bodily injury is excluded on both the cyber and E&O side and no endorsement fixes it.**
  If your agent ever gives clinical guidance and a patient is harmed, you are uninsured.
  Design so the agent never triages — and put that in the underwriting narrative, because
  it's also a pricing argument
- **The TCPA healthcare carve-out will lull you.** 47 CFR 64.1200(a)(2) only lowers the
  standard from prior express *written* consent to prior express consent, only for health
  care messages, only from a covered entity or its business associate. A med spa's "time
  for your Botox touch-up" recall is **telemarketing** — full written-consent standard, and
  elective aesthetics is exactly where that line gets litigated
- **Don't let a broker sell you an "AI policy" and call the privacy problem solved.** The
  AI-exclusion specialists (Armilla, Testudo, Relm) say nothing about TCPA or wiretapping

---

## 8. Counsel — you need two lawyers, not one

**Lawyer A (health-information privacy)** owns questions 1–4. **Lawyer B
(TCPA/telemarketing)** owns 5 and 6. The specialisms rarely live in the same head, and
questions 5 and 6 are TCPA questions wearing a HIPAA costume. One boutique can field both
*if* they have a named TCPA practitioner — ask for that person's name.

### The dependency that sequences everything

> The TCPA **"health care message" carve-out** at 47 CFR 64.1200(a)(2) is available **only
> to a covered entity or its business associate**. If question 2 comes back "most cash-pay
> med spas are not covered entities," questions 5 and 6 lose their best defence at the same
> moment. **Sequence question 2 first** and tell both lawyers the answer.

### Finding them

**Health privacy:** the [AHLA member directory](https://my.americanhealthlaw.org/Directories)
(filter for the Health Information & Technology Practice Group — AHLA can't make referrals,
so use it as a name source), the IAPP Privacy Bar Section, and — highest yield —
reverse-engineer from client-alert bylines. The alerts on *AHA v. Becerra*, the 2024 HBNR
amendments and Washington MHMD are written by exactly the people you want. Take the
**byline**, not the firm; the big firms will be too expensive but their alerts name partners
who have since moved to boutiques.

**TCPA** has a small, blog-driven bar: [TCPAWorld](https://tcpaworld.com), Kelley Drye's
Ad Law Access, Klein Moynihan Turco, Manatt's TCPA Connect. Also read who filed in FCC
CG Docket No. 02-278 in 2025–26 at https://www.fcc.gov/ecfs/search/search-filings.

### The 20-minute screening call

Don't ask "do you know HIPAA." Ask these and grade on whether they name the authority
*without you naming it*:

| Question | Right answer |
|---|---|
| "What happened to the OCR online-tracking bulletin?" | *AHA v. Becerra*, N.D. Tex., vacatur June 2024, OCR withdrew its appeal Aug 2024. Vagueness means their knowledge stopped in 2023 |
| "If a cash-pay med spa never bills a payer electronically, what regime applies?" | Probably not a covered entity → FTC §5 + HBNR + state consumer-health-data laws. They should volunteer **Washington My Health My Data** unprompted |
| "What's the current test for whether an AI vendor is a CIPA third party?" | *Ambriz v. Google* and the **capability** test. If they say "you just need a recording disclosure," **end the call** |
| *(Lawyer B)* "Is an AI voice covered by 227(b)?" | **FCC 24-17** (Feb 2024). Follow-up: "where does the one-to-one consent rule stand?" → vacated by the 11th Circuit in *Insurance Marketing Coalition v. FCC*, Jan 2025 |
| "Have you drafted a click-through BAA for a SaaS vendor? Can I see a redacted one?" | A yes **with an artifact** is worth twice a yes without |

### Buy it in three phases

**Phase 1 — blocking (3–5 weeks).** Questions **4, 2 and 3 together**, as one package. They
interlock: the BAA needs the covered-entity outputs, and the CIPA disclosure needs to be a
term of the BAA. Deliverables: a drafted versioned click-through BAA, a one-page intake
questionnaire with a decision rule, a non-covered-entity posture memo, and a disclosure
script with the architectural conditions as bullet requirements. **Add question 6 if
missed-call text-back is in v1** — the PRD says it is.

**Phase 2 — the moat, before an engineer builds it (2–3 weeks, can overlap).** Question 1
(ad-platform attribution). A no-go answer changes the pitch deck and the integration
roadmap. Frame it as a product-design question with three candidate architectures rather
than open-ended research — that's the single biggest cost lever.

**Phase 3 (2 weeks).** Question 5 (reactivation), *after* question 2 — doing it first means
paying for the analysis twice.

### Ask for fixed fees per deliverable

> I am a pre-revenue solo founder building an AI front-desk product (voice agent + chat) for
> cash-pay elective healthcare clinics in the US. I will be a HIPAA business associate where
> the clinic is a covered entity. I have not signed a first customer. I have six questions.
> For each I have stated the question, the background, the authorities I believe are
> relevant, and the deliverable I want. Please quote a FIXED FEE per deliverable, not a
> retainer, and tell me if you think any question is mis-scoped. I would rather have three
> questions answered properly than six answered thinly.

Then ask three commercial questions explicitly: the blended rate sheet by seniority; whether
they'll do a fixed fee for the drafting items; and whether they have a conflict with any AI
voice vendor, EMR, or med-spa chain. **Get the engagement letter to say you own the drafted
BAA and can reuse it across every customer without further fees** — a BAA drafted "for this
engagement" that you then ship to 200 clinics is a different deal.

### What counsel needs to be told, because they may not volunteer it

- **Hashing is not de-identification.** A hashed email or phone is one of the 18 safe-harbor
  identifiers under 45 CFR 164.514(b), and it's hashed precisely so it can be **matched**.
  "We only send hashed emails" is not a defence; it's a description of the violation
- **HBNR penalties are $53,088 per violation** (90 FR 5580, effective 17 Jan 2025 — the
  older $51,744 figure applied only between 10 Jan 2024 and 16 Jan 2025)
- ***AHA v. Becerra* helps less than it looks.** It vacated OCR guidance about IP addresses
  on unauthenticated web pages. It doesn't touch the FTC §5/HBNR theory, state
  consumer-health-data laws, or a case where you transmit an actual appointment
- **Meta's terms cut both ways.** Even if a lawyer blesses a disclosure as lawful, **Meta
  Business Tools Terms §1.h** (eff. 3 Nov 2025) bans sharing data that "includes or is based
  on, directly or otherwise, health information." A technically lawful transmission can
  still breach the *clinic's* contract with Meta, disable their ad account, and make you the
  proximate cause. Ask counsel to address **contract** risk, not only regulatory risk
- **CIPA is a capability problem, not a disclosure problem.** *Ambriz* turned on whether the
  vendor **could** use call contents for its own purposes. A perfect script does not cure a
  subprocessor contract permitting model training on clinic call audio — which is why
  questions 3 and 4 go to the same lawyer
- **Don't wait for SB 690.** As amended July 2026 it touches only Penal Code §638.51
  pen-register claims. §§631 and 632 — the ones reaching call recording — are untouched
- **State mini-TCPA laws are the real risk for a small vendor**, not the federal TCPA.
  Florida, Oklahoma, Washington and Maryland have broader definitions and private rights of
  action. Ask Lawyer B **which states to geofence out of automated callback at launch** —
  much cheaper than fifty-state compliance
- **California AB 3030 has a trap we've partly built for**: for *audio*, the disclaimer must
  be given at the **start and the end**. Check that `clinicalAddendum()` in
  [disclosure.ts](../apps/app/src/lib/compliance/disclosure.ts) actually fires at the end.
  Also note AB 3030's "patient clinical information" **excludes scheduling and billing**, so
  the trigger is narrower than the whole call. And the duty falls on the **clinic**, not on
  you — but only your product can discharge it. That asymmetry needs an explicit allocation
  clause in the BAA
- **A click-through BAA has a formation problem separate from its content problem.** 45 CFR
  164.504(e) governs what must be *in* it; whether the office manager who clicked had
  authority to bind the practice is ordinary contract law. Ask for the **acceptance flow**
  (named signatory, title capture, emailed countersignature), not just the text
- **Do not accept a "HIPAA compliance package" flat fee** from a compliance vendor in place
  of this work. Those produce policy templates. None of the six questions is answered by a
  policy template, and four are litigation-risk questions

### After each deliverable lands

- **#4** → add the approved text as a **new** entry in `BAA_DOCUMENTS` in
  [baa.ts](../packages/catalog/src/baa.ts) with `approvedByCounsel: true`. Never edit the
  `0.0.0-draft` entry — a released hash is a historical fact
- **#2** → encode the questionnaire as a gated step in
  [provisioning.ts](../apps/app/src/lib/provisioning.ts) and persist the answers plus derived
  CE status per tenant, so the determination is auditable
- **#3** → reconcile the script against `voiceDisclosure()` and implement the architectural
  conditions: zero-retention / no-training on every ASR and LLM subprocessor, with the
  no-secondary-use term flowed down in each contract
- **#6** → encode the consent wording and callback window as **constants**, not prompt text

---

## 9. Stripe — reuse the scalabid account, not its worst habits

**Stay on the existing account.** Stripe's guidance is that separate accounts are for
projects that "operate independently" — separate legal entity, payout bank account, public
business info. The strongest argument for splitting (a med spa seeing `SCALABID` on their
statement) is solvable with a per-**Product** statement descriptor, which Stripe says
"overrides any account descriptor for recurring payments."

### Steps

1. **Create three products in TEST mode** at https://dashboard.stripe.com/test/products —
   `healdesk Core` $249, `healdesk Growth` $449, `healdesk Multi-location` $799, all Flat
   rate / Recurring / Monthly, **statement descriptor `HEALDESK`**. Add product metadata
   `app=healdesk` and `plan_id=core|growth|multi`. **No setup-fee product** — healdesk is
   `setupFeeUsd: 0`, and that's the pricing wedge
2. **Attach lookup keys** (the Dashboard doesn't reliably expose them):
   ```
   curl https://api.stripe.com/v1/prices/<price_id> -u "<TEST_SECRET_KEY>:" \
        -d lookup_key=healdesk_core_monthly
   ```
   This is **the most important deviation from scalabid**, which hardcodes literal price IDs
   as fallbacks with a comment admitting the risk: *"if the live Stripe account is ever
   swapped, these fallbacks become stale and customers are charged against the wrong
   product."*
3. **Copy each product to live mode**, then **re-run the lookup-key calls against the live
   price IDs** — copied prices get new IDs and lookup keys don't reliably carry over. Verify:
   `curl -G https://api.stripe.com/v1/prices -u "<LIVE_KEY>:" -d "lookup_keys[]=healdesk_core_monthly"`
   must return exactly one active price at `24900`
4. **Two webhook endpoints** (test + live) at https://dashboard.stripe.com/webhooks →
   `https://healdesk.io/api/webhooks/stripe`, subscribing to exactly six events:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.paid`,
   `invoice.payment_failed`. **Do not touch the scalabid endpoint.** Test and live signing
   secrets are different values
5. **Env vars on `apps/web` only** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Keep
   Stripe keys off the PHI host, same reasoning that keeps the database off `apps/web`.
   *(`.env.example` currently lists them twice; that needs resolving in favour of `apps/web`.)*
6. **Local testing:**
   ```
   stripe login --project-name=healdesk
   stripe listen --project-name=healdesk --events checkout.session.completed,… \
          --forward-to localhost:3000/api/webhooks/stripe
   ```
   ⚠️ `stripe listen` prints a **third** `whsec_` that differs from both dashboard secrets.
   Drive a real session rather than `stripe trigger` — a triggered session has no metadata,
   so it exercises the ownership guard, not the provisioning path. Run it too, and assert
   you get 200 with `skipped: "foreign"`

### Two blockers to fix before pointing any webhook at us

**1. `provisionClinic` is not idempotent.** [provisioning.ts:100-116](../apps/app/src/lib/provisioning.ts)
reacts to a unique violation by minting a **new slug** and retrying. That's correct for two
clinics genuinely named "Radiance Med Spa" and catastrophic for a Stripe retry of one
payment — you get two organizations, two clinics, two BAA acceptances and two invitations.
**Stripe retries for up to three days, so this will fire in production.** Fix: add
`stripe_checkout_session_id` with a partial unique index, `ON CONFLICT DO NOTHING`, then
select the existing row and return its ids. Scope the slug-collision retry so it only fires
on the slug index.

**2. Do not port scalabid's `if (session.payment_status !== "paid") return;` guard.** With a
14-day trial and the default `payment_method_collection="always"`, Stripe processes a $0
trial invoice and `payment_status` *is* `"paid"` — so it appears to work in testing. The
moment anyone sets `payment_method_collection="if_required"` (a plausible growth
experiment), that guard **silently drops every signup**: the customer sees a success page
and no account is ever created. Guard on `session.status === "complete"` instead.

### The isolation that actually works

The endpoint event-type filter does **not** isolate scalabid from healdesk — both products
emit `checkout.session.completed`, `invoice.paid` and `customer.subscription.*` on the same
account. Separate URLs work in the happy path, but a mistyped URL or a future consolidation
makes each handler see the other's events. The durable isolation is an **ownership check
inside each handler**: `metadata.app === "healdesk"`, or a price-ID allowlist for events
whose metadata you don't control.

### What to reuse verbatim

About 60% of scalabid's webhook is directly portable: the signature-verify-then-dispatch
skeleton, the metadata-carried-through-to-webhook convention (put it on **both** the session
and `subscription_data`, "so it persists for future webhook events"), the **return-500-so-Stripe-retries**
contract, and the poll-a-status-endpoint success page — which already implements the rule
healdesk's own docs state: *provisioning fires on the webhook, never on the browser success
URL.*

**Don't** port: the hardcoded price-ID fallbacks, the `payment_status` guard, the
check-then-insert idempotency (no unique index backs it), the onboarding-fee line item, or
the `apiVersion` override — scalabid pins `2025-03-31.basil` while running an SDK whose
types describe `2026-03-25.dahlia`, two majors apart. Set none of them and let the SDK's pin
govern.

> ⚠️ [hipaa-compliance.md](./hipaa-compliance.md) claims a Stripe BAA is "Available." No
> primary source was found for that. It likely doesn't matter for healdesk's own
> subscription billing (clinic name + work email is business contact data, not PHI) but it
> matters a lot for the separate **Stripe-as-POS-connector** path, where clinic sales data
> flows. Treat them as two different relationships.

---

## 10. Trust badges — what we can honestly show

*(Answering the Synthflow footer question.)*

Of Synthflow's six badges — SOC 2, GDPR, HIPAA, ISO 27001, EU Hosting, US Hosting — healdesk
has earned **one**: US Hosting.

**Do not copy the heading.** *"TRUSTED & VERIFIED BY"* asserts an external verifier, and
that implied-third-party-review representation is literally the theory of FTC Count I in
*In re SkyMed International* (Docket C-4732, 26 Jan 2021), which was a **standalone deception
count for displaying a "HIPAA Compliance" seal** — because the seal *"signaled to consumers
that a government agency or other third party had reviewed Respondent's information
practices and determined that they met HIPAA's requirements"* when none had.

### The three authorities that settle "HIPAA Compliant"

There is **no** government or accredited certification for HIPAA compliance, anywhere.

- **HHS**: *"HHS does not endorse or otherwise recognize private organizations'
  'certifications' regarding the Security Rule, and such certifications do not absolve
  covered entities of their legal obligations."*
- **FTC**: *"the Department of Health and Human Services… doesn't certify companies or
  products as 'HIPAA compliant.'"*
- **AWS**: *"There is no HIPAA certification for a cloud service provider."*

And the FTC reaches B2B: *Henry Schein Practice Solutions* (2016, **$250,000**) was software
marketed to **dental practices**, and its order bars misrepresenting *"the extent to which
its products help ensure regulatory compliance"* — precisely what a HIPAA badge on a
clinic-facing site does.

### What to ship instead

Heading: **`HOW WE HANDLE PATIENT DATA`** — promises a first-party commitment, implies no
external verifier.

| Item | Exact string | Note |
|---|---|---|
| 1 | We sign a BAA with every clinic | Legally operative fact |
| 2 | PHI stored in US-only AWS infrastructure under a signed AWS BAA | Accept the BAA and pin the region **first** |
| 3 | We never use patient data to train models | Narrow first-person version. Upgrade to *"…ours or our vendors'"* only after written confirmation from Synthflow, whose docs say nothing about training on customer audio |
| 4 | Read-only access to your practice management system | ⚠️ Becomes **false** the day booking ships. Then: *"We read your schedule and write appointments — nothing else"* |
| 5 | Encrypted in transit and at rest with AWS KMS | Name the mechanism so it's checkable — Henry Schein's problem was the gap between the word "encryption" and a weaker scheme |
| 6 | Delete any patient's data on request | Or *"…within 30 days, including backups"* if backup windows require it |

**And the disclosure line, in the same visual block — the most important element:**

> No third party has audited healdesk. These are our own commitments, and we will show you
> the architecture behind any of them. SOC 2 Type II is on our roadmap — we'll publish the
> report date when we have one.

That strip is **stronger** with clinic procurement than fake badges, because every claim
survives the question *"show me."* And *"There is no HIPAA certification — no government
agency certifies anyone as HIPAA compliant"* is a competitive weapon against every rival
flying the badge, while inoculating you at the same time.

### Drop these outright

- **GDPR Compliant** — a self-inflicted wound on a US-only clinic product. It invites a
  procurement thread about EU data subjects, Article 27 representatives and DPAs you can't
  answer, while obscuring the actual strength: *"Patient data is stored and processed in the
  United States and is not transferred outside it."*
- **EU Hosting** — Synthflow carries it because it's a Berlin company selling into Europe.
  Pure cargo cult here
- **Any PCI badge** — PCI SSC's own brand guide says of a "PCI DSS Compliance" logo: *"This
  is NOT an approved logo and may not be used at any time."* The only badge that's a
  violation even for a fully compliant company. Say instead: *"healdesk does not store,
  process, or transmit cardholder data"*

### When to actually earn one

| | All-in, year one | Calendar | Verdict |
|---|---|---|---|
| **SOC 2 Type I** | $12K–25K (aggressive floor ~$6–10K bundled) | 6–12 weeks | Waypoint, not first move |
| **SOC 2 Type II** | $20K–45K | **7–12 months** incl. observation window | The only one with a real trigger |
| **ISO 27001:2022** | $15K–30K + surveillance audits years 2–3 | 6–12 months | **Wrong credential for this market** |
| **HITRUST e1 / i1** | $20K–70K / $60K–200K | Months | Not a close call |

**The commercial answer is unflattering to the badge strip.** At $249–799/mo, ACV is
$2,988–$9,588. A $20K SOC 2 program costs the entire annual revenue of **2–7 customers**.
The evidence is that small single-location med spas and dental practices do **not** run
vendor security reviews — a signed BAA is widely treated as sufficient diligence at this
tier, and the "83% of buyers require SOC 2" statistic compliance vendors quote is explicitly
about **enterprise** buyers.

**The trigger is buyer type, not deal size:** a PE-backed DSO, a multi-location group, or
anything hospital-affiliated. Their risk teams want Type II specifically, and a vendor
without one gets a raised risk score requiring extra review or attestations.

**A solo founder can pass SOC 2** — the Trust Services Criteria have a generic CC5.1
point of focus allowing alternative control activities where segregating incompatible duties
"is not practical." (Note: there is *no* small-company accommodation written into SOC 2; the
compensating-control route is generic, not a carve-out.) **ISO 27001 is different** — clause
9.2.2(b) requires audits that "ensure objectivity and the impartiality of the audit
process," which in practice forces a one-person company to buy an outsourced internal audit.

### The cheapest credible thing to do first

1. **A documented HIPAA Security Rule risk analysis.** 45 CFR 164.308(a)(1)(ii)(A) is a
   **required** implementation specification that applies to business associates — paragraph
   (a) opens *"A covered entity or business associate must…"* You owe this regardless of any
   badge, and OCR cites its absence more than any other failure. The HHS/ONC **SRA Tool** is
   a free download
2. **A public trust page** listing the six commitments above, with the architecture behind
   each
3. **A completed CAIQ** — free to download, complete and publish to the CSA STAR Registry.
   *(Not SIG-Lite: the SIG licence runs ~$7,000/yr.)*
4. Only then, when a DSO appears: SOC 2 Type II

---

## Where the sourced detail lives

The full research — every claim with its primary source, plus ~90 vendor and counsel
questions phrased verbatim — is in the workflow transcripts under
`.claude/projects/…/subagents/workflows/`. Two runs: `wf_ef612804-ad9` (vendors, legal,
insurance, Stripe — 81 agents) and `wf_afada217-7fa` (trust badges — 18 agents). Every
load-bearing claim was independently re-checked by an adversarial verifier; **16 claims were
refuted or found outdated** and the corrections are folded into this document.

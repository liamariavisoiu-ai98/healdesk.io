# Brief for counsel: healdesk v1 (launch step 1.14)

> **DRAFT for counsel review — not legal advice.** Prepared by an AI
> assistant on 1 October 2026 for the owner to send to counsel. It lists
> questions; it answers none of them with authority.

## The client in one paragraph

healdesk is an AI assistant for US cash-pay elective clinics (med spas,
aesthetics, hair restoration, cosmetic dentistry). It answers inbound only:
phone calls the clinic forwards to it (voice on Retell), chat on the
clinic's website, and Instagram, Messenger and WhatsApp messages. It books
into the clinic's own Google Calendar and can send a deposit link through
the clinic's own payment gateway. It never contacts a patient first, sends
no SMS and keeps no call audio. The seller is **Viixi FZC**, a company in
the Sharjah Publishing City Free Zone, UAE, trading as healdesk. It signs a
business associate agreement (BAA) with each clinic at checkout. Product
definition: `docs/v1-product-spec.md`. No clinic has gone live; no real
patient data has been processed.

## Read first

| File | What it is |
| --- | --- |
| [guarantee-and-refund.md](./guarantee-and-refund.md) | Proposed first-month guarantee wording, its measurement, and how it sits with the 14-day refund (step 1.10) |
| [agreement-changes.md](./agreement-changes.md) | Clause-by-clause changes to BAA 1.0.0, BAA 1.1.0-draft, the terms and the privacy page; DPA outline (step 1.11) |
| [state-disclosure.md](./state-disclosure.md) | State-by-state AI-disclosure and call-transcription consent table, with sources and gaps (step 1.13) |
| [../incident-response.md](../incident-response.md) | Breach procedure, template clinic notice, vendor-notice routes (step 1.12). Complete except the Security Official's name, still blank in [../policies/security-official.md](../policies/security-official.md) |
| [../counsel-audit.md](../counsel-audit.md) | Earlier AI-written analysis (21–29 Sep). §7 callback and WhatsApp-template questions are withdrawn; v1 has neither |
| [../baa-v1.1.0-draft.txt](../baa-v1.1.0-draft.txt) | The 1.1.0 draft as a clinic would see it |
| [../hipaa-risk-analysis.md](../hipaa-risk-analysis.md) | Security Rule risk analysis, redrafted 1 Oct 2026 |

## The five questions to answer first

1. **Does Meta allow this product on Messenger and Instagram at all?**
   Meta's Developer Policies (updated 3 February 2026), §5 "Messenger
   Platform and Instagram Messaging APIs", item 6.5:

   > "Don't use Messenger and/or Instagram Messaging features, including
   > messaging and calling, to facilitate direct conversations between
   > people and healthcare providers or to send or collect any patient data
   > obtained from healthcare providers."

   Read literally, an assistant answering a clinic's Instagram DMs
   facilitates conversations between people and a healthcare provider. If
   so, the Meta SKU fails App Review or risks app restriction later, whatever
   our HIPAA scoping. The WhatsApp Business Policy (updated 23 September
   2026) is narrower: "Don't use WhatsApp for telemedicine or to send or
   request any health related information, if applicable regulations
   prohibit distribution of such information to systems that do not meet
   heightened requirements". It also requires "prompt, clear, and direct
   escalation paths" to a human when automation is used. Since 15 January
   2026 WhatsApp bars general-purpose AI assistants but allows
   business-specific booking bots. Questions: does §5.6.5 reach a med spa
   (an elective, often non-covered provider) answering price and booking
   questions? Does scoping to non-clinical content take it outside "patient
   data"? Should we ask Meta before App Review? (Launch step 0.13.)
   Sources: [Meta Developer Policies](https://developers.facebook.com/devpolicy/),
   [WhatsApp Business Policy](https://whatsappbusiness.com/policy/),
   [TechCrunch on the WhatsApp AI-provider terms](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform).

2. **Stop offering BAA 1.0.0, and approve its replacement?** 1.0.0 is the
   counsel-approved version clinics sign today. It says language models keep
   nothing; Anthropic keeps 30 days. It bans disclosure to "any advertising
   platform" while the product replies through Meta. Its liability clause
   makes healdesk pay breach-notification costs; the terms and the incident
   procedure say the clinic pays. Its assent sentence confirms "the consent
   warranty above", which the document no longer contains. See
   agreement-changes.md §2.

3. **Is the opening line enough for call transcription in all-party
   states, with no audio kept?** Washington and Connecticut tie consent to a
   *recorded* announcement. California's *Ambriz v. Google* treats an AI
   vendor as a possible third-party eavesdropper. The line also promises "a
   person" when live transfer is off by default. See state-disclosure.md.

4. **What do we tell a US clinic's counsel about a UAE business associate?**
   HIPAA reaches a business associate wherever it sits, but a clinic will ask
   about enforcement, data location and subprocessors. Facts to build the
   answer on: PHI is hosted in AWS `us-east-1`; every PHI vendor is US;
   agreements choose Delaware law and courts; the notice address is a
   Delaware registered-agent mailbox; healdesk carries **no insurance** and
   gives **no indemnity**. Questions: Can HHS OCR enforce against Viixi FZC
   in practice, and does that matter to a clinic? Is a Delaware judgment
   enforceable in the UAE? Does the founder's access from outside the US
   change anything? Is a mailbox an adequate notice address? Does the UAE's
   own data-protection law (Federal Decree-Law 45/2021) apply to a UAE
   company processing US patients' data? **And: does Viixi FZC's Sharjah
   Publishing City licence list activities covering software services and
   marketing services, and permit serving customers outside the UAE?**
   Public guides say SPC offers IT, software and marketing activities, but
   only the licence itself answers this; Meta's Business Verification will
   also compare it with what we type
   ([SPC guide, secondary](https://www.aaconsultancy.ae/dubai/free-zone-company-setup-sharjah-publishing-city/)).

5. **Is the first-month guarantee wording sound, and how does it sit with
   the 14-day refund?** It must appear identically on `/pricing` and in the
   terms, and terms §12 currently disclaims "that the agent will answer
   every call". See guarantee-and-refund.md, open choices 1–12.

## All other questions

**Agreements** (agreement-changes.md)

6. Does writing a booking into the clinic's own Google Calendar need a BAA
   clause, and is Google the clinic's vendor rather than our subcontractor?
   What may a calendar event contain? (§6)
7. Retire the direct-booking addendum and move its allocation into the
   terms? Is a default-on "Auto-confirm bookings" switch enough to bind the
   clinic to that allocation? (§6)
8. One rule for what the assistant may say on Meta channels (booked time?
   payment link?) — four documents disagree today. (§7)
9. Does the payment-processing carve-out (HIPAA §1179) cover deposit links
   healdesk creates through the clinic's own gateway? (§7)
10. Terms §2, §6, §7 describe forwarded calls going unanswered on
    suspension or exit. The spec forbids a dead line. Confirm the
    replacement wording and how long the fallback must run after the
    contract ends. (§8)
11. Do clinics already signed need 15 days' notice of Retell, Anthropic and
    the database provider before go-live? (§5)
12. How does a 1.0.0 signer move to the new version: portal re-acceptance,
    or the 1.1.0 "replaces earlier versions" sentence? (§11)
13. Data-destruction timeline: is 30 days after termination right? (§3)
14. Is the one-way indemnity and liability exclusion enforceable against a
    clinic, and will it survive a clinic's counsel? (§3, §8)
15. Separate DPA for non-covered clinics, or the BAA's "data-protection
    agreement on the same terms" sentence? (§10)
16. Privacy §9 "a signed agreement with every vendor that touches it" and
    related claims: approve replacements. (§9)

**Disclosure and consent** (state-disclosure.md)

17. Do Texas TRAIGA, Utah's AI Policy Act or California AB 3030 reach a
    booking assistant for an aesthetic clinic?
18. Utah requires written disclosure *before* a written interaction; on a
    DM the patient always writes first. Is that a problem?
19. Washington MHMDA and similar laws: is any consent needed, beyond notice,
    to record "the treatment asked about" for a non-covered clinic?

**Carried over from earlier work** (counsel-audit.md)

20. The three-question covered-entity script at onboarding, and whether the
    clinic's answer can be relied on (§1).
21. "We sign a business associate agreement and handle patient data under
    it" — confirm this is the only compliance claim the site makes (§6).

## What is not being asked

Callbacks, SMS, reminders, reactivation, WhatsApp templates and attribution
are not in v1. `counsel-audit.md` §3, §4 and §7(1)–(3), (6) are moot for
launch.

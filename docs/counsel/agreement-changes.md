# Changes the BAA, the terms and the privacy page need for v1 (launch step 1.11)

> **DRAFT for counsel review — not legal advice.** Written by an AI assistant
> from the repo on 1 October 2026. It proposes changes; it makes none. The
> sources quoted are `packages/catalog/src/baa.ts` (BAA 1.0.0, approved and
> offered today; BAA 1.1.0-draft, not offered), its rendering
> `docs/baa-v1.1.0-draft.txt`, `apps/web/src/app/terms/page.tsx` and
> `apps/web/src/app/privacy/page.tsx`. Where they disagree with
> `docs/v1-product-spec.md`, the spec describes the product.

## Contents

1. [The five changes that matter most](#1-the-five-changes-that-matter-most)
2. [BAA 1.0.0, clause by clause](#2-baa-100-the-version-clinics-sign-today)
3. [BAA 1.1.0-draft, clause by clause](#3-baa-110-draft-clause-by-clause)
4. [New clauses v1 needs](#4-new-clauses-v1-needs)
5. [Subprocessors as they now stand](#5-subprocessors-as-they-now-stand)
6. [Google Calendar: clause, addendum, or neither](#6-google-calendar-clause-addendum-or-neither)
7. [Meta and Stripe: handled by scoping](#7-meta-and-stripe-handled-by-scoping)
8. [Terms of service, section by section](#8-terms-of-service-section-by-section)
9. [Privacy page statements that are now false](#9-privacy-page-statements-that-are-now-false)
10. [Outline of a data processing addendum](#10-outline-of-a-data-processing-addendum)
11. [How the change has to ship (for the engineer)](#11-how-the-change-has-to-ship-for-the-engineer)

---

## 1. The five changes that matter most

1. **The model-retention sentence is false.** Both BAA versions say, in
   effect, that the language model keeps nothing. Anthropic's covered
   service keeps inputs for 30 days. The spec requires the 30 days to be
   stated in the clinic agreement, with the reason (§2.6, §3.10).
2. **The "advertising platform" ban collides with the Meta channels.** BAA
   1.0.0 forbids disclosing PHI "to any advertising platform, in any form".
   Meta is an advertising platform, and the product replies to patients
   through it (§2.9, §7).
3. **Calls must never meet a dead line, but the terms describe one.** Terms
   §2, §6 and §7 say that on suspension or exit "forwarded calls are not
   answered" or "are lost". The spec requires every degradation path to end
   with calls forwarding to a direct clinic line (§8).
4. **The callbacks, the Cal.com write and the direct-booking addendum
   describe a product that no longer exists.** v1 places no calls, writes
   only to Google Calendar, and auto-confirms bookings by default on every
   channel (§3.12, §3.13, §6).
5. **The signed 1.0.0 liability clause contradicts the terms and the
   incident procedure.** 1.0.0 makes healdesk pay to notify patients about a
   breach it caused. Terms §14 and `docs/incident-response.md` step 6 put
   that cost on the clinic. For a 1.0.0 signer, the BAA controls on patient
   information (terms §1, §9) (§2.11).

---

## 2. BAA 1.0.0, the version clinics sign today

1.0.0 is `approvedByCounsel: true` and sits at `BAA_TEMPLATES[0]`. It
cannot be edited: anyone who signed it signed those bytes, and their stored
hash must keep reproducing. Every fix below lands in a **new version**. The
question for counsel is whether the 1.0.0 problems are serious enough to
stop offering 1.0.0 before the new version is approved.

What a v1 signer actually gets: `outboundMessaging` is `false` on both
signing paths and `VERIFIED_ATTRIBUTION_OFFERED` is `false` in
`CheckoutFlow.tsx`, so every new signer gets the clauses
`covered-entity-status`, `permitted-uses`, `data-sources-none`,
`safeguards`, `reporting`, `subcontractors`, `patient-rights`,
`acting-in-your-place`, `prohibited`, `return-or-destroy`, `liability`,
`records-to-hhs`.

**2.1 Preamble.** Current: `healdesk ("Business Associate")`. "healdesk" is a
trade name, not a legal person. Change: name Viixi FZC, its form and a
notice address (1.1.0 does this).

**2.2 `covered-entity-status`**, when the clinic does not know. Current:

> "healdesk applies the same safeguards either way, and will confirm the
> determination before any real patient information is processed."

Problem: healdesk "confirming" the clinic's legal status takes on a
determination it cannot make (`docs/counsel-audit.md` §1). 1.1.0 fixes it.

**2.3 `data-sources-none`.** Current:

> "Revenue figures are calculated from the average appointment value
> [Practice] supplied, and are labelled as estimates wherever they appear."

Two problems. v1 must never claim "revenue"; the honest figure is "booked
value" (bookings times the clinic's configured prices). And:

> "healdesk holds no credentials to [platform] and reads nothing from it."

is true of the booking platform but false of the clinic's Google Calendar,
whose OAuth token healdesk will hold for every clinic. Proposed:

> "healdesk reads nothing from Practice's booking or records system. Booked
> value is the number of bookings the assistant made multiplied by the
> prices Practice configured, and is labelled as booked value wherever it
> appears. The only patient information healdesk receives is what patients
> give it in a conversation, and the calendar access described in the
> calendar clause."

**2.4 `data-sources-verified`.** Reads settled sales "to measure the revenue
its agent recovered". Attribution is phase two and fenced out of v1. It
cannot render today (the checkout flag is off). Keep it out of any v1
template.

**2.5 `safeguards`.** Current:

> "healdesk will not transmit protected health information over a channel
> that cannot negotiate encryption — email included."

Problem: a telephone call is not end-to-end encrypted, and a Meta message is
not a healdesk-controlled channel. The voice product exists to answer phone
calls. 1.1.0 adds a telephone carve-out; v1 also needs a Meta one (§7).

**2.6 `subcontractors`.** Current:

> "Language models are used to understand a patient and answer them during
> the conversation. They are not permitted to retain patient information
> after it ends, and they are not permitted to train on it."

False once the Anthropic BAA is signed: covered models require 30-day
retention and cannot run with zero data retention (spec, "Five rules",
third rule). Proposed text in §4.3.

**2.7 `acting-in-your-place`.** Current: "answering a patient who calls,
and sending messages in [Practice]'s name". Accurate for v1 if "sending
messages" means replies. Suggest "answering a patient who calls or writes,
and replying in [Practice]'s name".

**2.8 `outbound-consent` and the assent label.** The clause never renders
(`outboundMessaging: false`). But the sentence every signer ticks still
says:

```ts
export const BAA_ASSENT_LABEL =
  "I agree to the Business Associate Agreement and confirm the consent warranty above";
```

There is no consent warranty above it. Every 1.0.0 acceptance records a
signer confirming a warranty the document does not contain. Change the label
in the new version, e.g. "I agree to the Business Associate Agreement".
Counsel: does the stray phrase affect 1.0.0 acceptances already taken?

**2.9 `prohibited`.** Current:

> "· Disclose protected health information to any advertising platform, in
> any form, including hashed or aggregated."

Meta is an advertising platform. On Instagram, Messenger and WhatsApp the
assistant sends replies through Meta to a named person who wrote to a
clinic. Even a non-clinical reply can be PHI (an identifier plus the fact
that the person sought care from this provider). Options: (a) narrow the ban
to "for advertising, marketing or measurement purposes"; (b) keep it and
treat the Meta channels as carrying no PHI by design, with the scoping
stated in the BAA (§7); (c) both. Recommendation: (c).

**2.10 `return-or-destroy`.** No timeline. The spec says offboarding is
"export first, then destroy, on a clock that matches the agreement text", and
lists the data-destruction timeline as open. 1.1.0 sets 30 days.

**2.11 `liability`.** Current:

> "That limit does NOT apply to healdesk's wilful misconduct or gross
> negligence, and it does NOT apply to healdesk's obligation to bear the
> cost of notifying patients and regulators about a breach that healdesk
> caused."

and

> "healdesk is not passing those caps through — the commitment above is
> healdesk's own, backed by healdesk."

Contradicted by terms §13 (liability excluded where the law allows), terms
§14 (the clinic indemnifies healdesk, including for notification costs) and
`docs/incident-response.md` step 6 ("The cost of that notification is the
clinic's, whoever caused the breach (terms §14, BAA Liability clause)").
Terms §1 and §9 say the BAA controls on patient information, so for 1.0.0
signers the BAA promise probably wins. Counsel: which governs for a 1.0.0
signer, and should the incident procedure say so?

---

## 3. BAA 1.1.0-draft, clause by clause

Rendered for counsel in `docs/baa-v1.1.0-draft.txt`. Never offered, never
signed. Clause numbers below are those in the rendered sample.

| # | Clause id | Change for v1 |
| --- | --- | --- |
| — | preamble | `ACCEPTED FOR HEALDESK BY [NAME, TITLE]` is a placeholder; needs the Security Official's name (`docs/policies/security-official.md`, still "[founder's legal name — fill in]"). Notice address is the Delaware registered-agent mailbox; counsel to confirm it is adequate for notices |
| 1 | `definitions` | Keep. Add "Booked value" and "Conversation" if used elsewhere |
| 2 | `practice-status` | Keep. It already makes the document a data-protection agreement for non-covered clinics (§10) |
| 3 | `permitted-uses` | Keep (shared 1.0.0 object) |
| 4 | `data-sources-none` / `data-sources-calendar-only` | Replace both with one clause, as §2.3. The "Revenue figures" sentence goes. Calendar access is every clinic's case in v1, not an option |
| 5 | `own-use` | Keep. The example "what fraction of after-hours calls are answered" is fine |
| 6 | `practice-duties` | Keep. Add: Practice gives healdesk a direct line that does not forward back to healdesk (needed for every fallback) |
| 7 | `safeguards` | Rewrite the third paragraph; see 3.7 below |
| 8 | `minimum-necessary` | Keep. Add what a calendar event may contain (§6) |
| 9 | `reporting` | Keep. Five calendar days is far inside the 60 allowed; owner confirms it is achievable with one person |
| 10 | `subcontractors` | Rewrite the model paragraph; see 3.10 below |
| 11 | `patient-rights` | Keep |
| 12 | `acting-in-your-place` | Keep; see §2.7 |
| 13 | `consented-callbacks` | **Delete.** Replace with "Inbound only" (§4.1) |
| — | `calendar-write` (appendix A) | **Delete.** Replace with a Google Calendar clause (§6) |
| — | `direct-booking` (appendix B) | **Delete from the BAA.** See §6 for where the allocation goes |
| — | `reactivation-gate` | Delete. It never renders and v1 has no reactivation |
| 14 | `prohibited` | New object with the narrowed advertising line (§2.9). Do not edit the 1.0.0 object (§11) |
| 15 | `term` | Keep the 30 days only if counsel and owner agree it is achievable (open item: "data destruction timeline") |
| 16 | `liability` | Counsel's call. Note it is one-way and reaches claims alleging healdesk's negligence; clinic counsel will push back. Make sure it does not cancel the first-month guarantee (`guarantee-and-refund.md`) |
| 17 | `records-to-hhs` | Keep |
| 18 | `notices-and-law` | Keep. Delaware law, UAE entity: see `brief.md` question on enforcement |

**3.7 `safeguards`, third paragraph.** Current:

> "One narrow exception: a patient who telephones, or who asked on their own
> call or message to be called back, has chosen the telephone, and a
> telephone call is not end-to-end encrypted. healdesk may answer such a
> call and may place the callback described in the Callbacks clause, limited
> to the minimum necessary and never including clinical detail, test results
> or payment information. healdesk sends no SMS. This exception does not
> extend to any other channel or content."

Proposed:

> "Two narrow exceptions. A patient who telephones Practice has chosen the
> telephone, and a telephone call is not end-to-end encrypted; healdesk may
> answer such a call, limited to the minimum necessary and never including
> test results or payment card details. A patient who writes to Practice on
> Instagram, Messenger or WhatsApp has chosen a channel healdesk does not
> control and whose operator signs no business associate agreement; healdesk
> may reply there only as the Meta channels clause allows. healdesk places
> no calls and sends no SMS. These exceptions do not extend to any other
> channel or content."

**3.10 `subcontractors`, model paragraph.** Current:

> "healdesk configures each provider to retain conversation content no
> longer than that provider's agreement with healdesk requires for abuse
> detection and security, and never for any other purpose."

This is truer than 1.0.0 but hides the number. The spec says state it.
Proposed text in §4.3.

---

## 4. New clauses v1 needs

Each is a proposal for counsel to rewrite, not settled text.

**4.1 Inbound only** (replaces `consented-callbacks`).

> "healdesk contacts a patient only in reply, inside a conversation the
> patient started: a call the patient placed to Practice, a chat the patient
> opened on Practice's website, or a message the patient sent to an account
> Practice connected. healdesk places no calls, sends no text messages, and
> sends no reminders, follow-ups or marketing to patients. On Meta channels
> it sends nothing outside the window Meta opens when the patient writes."

**4.2 Disclosure and transcription.**

> "The assistant says it is an AI assistant in its first words on every
> channel. On calls, the same words say the call is transcribed; no call
> audio is kept by healdesk. Practice cannot switch this off or edit it out.
> Whether these words satisfy the law of the state where the patient is, and
> any further notice Practice's own law requires, is addressed in
> [state-disclosure.md]."

Counsel to decide whether the BAA or the terms is the right home. The terms
already put "any disclosure your state requires" on the clinic (§8).

**4.3 Language-model retention** (the spec's third non-optional rule).

> "healdesk's language-model provider receives the content of each
> conversation to generate the assistant's replies. Under its business
> associate agreement with healdesk, the provider keeps that content for up
> to 30 days and then deletes it. It may not use it to train or improve any
> model or for any purpose other than providing and securing its service.
> The provider's covered service cannot run with shorter retention. This is
> the one place where conversation content is kept longer than healdesk's
> own minimum, and it is kept under that agreement."

Confirm the 30 days, and the stated purpose, against the executed Anthropic
BAA once signed. The spec gives the 30 days but not the purpose.

**4.4 Transcript retention.** The spec says transcripts live in healdesk
"under a stated retention period" and the portal shows them. No document
states the period. Add it, with the clinic's ability to shorten it.

**4.5 Meta channels.** See §7.

**4.6 Payments.** See §7.

**4.7 Every fallback reaches a person.**

> "If the service is paused, capped, suspended, ended, or fails, healdesk
> routes calls to the direct line Practice gave it, and website chat
> becomes a contact form. Practice keeps that line staffed and does not
> forward it back to healdesk."

This belongs in the terms more than the BAA, but it touches patient safety
and counsel may want it in both.

---

## 5. Subprocessors as they now stand

From `apps/web/src/lib/subprocessors.ts` and the spec.

| Vendor | Role | PHI? | Agreement | Note |
| --- | --- | --- | --- | --- |
| Retell | Voice: telephony and speech | Yes | BAA pending, self-serve | Region not confirmed. Confirm the executed BAA names the services used and covers Retell's own telephony and speech providers |
| Anthropic | Language model, every channel | Yes | BAA pending | 30-day retention. The marketing demo uses a separate, non-HIPAA organisation (risk analysis), but the register's Anthropic row says "Under the BAA" for both. Split the row |
| AWS | Hosting, keys, storage, SES for any PHI email | Yes | Signed 22 Sep 2026 (Artifact) | Designated account, eligible services only |
| Database provider | Postgres | Yes | Not chosen: AWS RDS (under the AWS BAA) or Neon Scale (own BAA) | If Neon, add a row and a 15-day notice is owed to signed clinics before first use |
| Resend | Transactional email | No | Not needed | Only messages declared `phiClass: "none"` |
| Synthflow | Marketing demo call only | No | Not needed | Never a patient call. Remove from every product document |
| Meta | Instagram, Messenger, WhatsApp | Scoped to none | None, ever | §7 |
| Stripe | Clinic billing; deposits where the clinic uses Stripe | Scoped to none | None, any tier | §7 |
| Google (clinic's calendar) | The clinic's own system | Yes | The clinic's own agreement with Google | Not healdesk's subprocessor (§6) |

Retired: Cal.com (no write in v1), Synthflow as a product vendor, Twilio (not
used), Supabase (not chosen).

Notice: both BAA versions promise notice before adding a PHI subcontractor
(1.1.0: fifteen days, with a termination right). Retell, Anthropic and the
database provider are new relative to any clinic that signed when Synthflow
was the voice vendor. Counsel: does a signed clinic need the 15-day notice
for each before go-live, given no patient data has yet flowed?

---

## 6. Google Calendar: clause, addendum, or neither

**What v1 does.** Every clinic connects Google Calendar by OAuth in the
wizard. healdesk reads free/busy on the chosen calendar (or one per
provider), creates events for bookings on every channel, and changes only
events it created (privacy §11). "Auto-confirm bookings" is on by default.
Off, or a clinic on Mindbody or Boulevard, means manual booking mode:
requests staff approve.

**Our reading, for counsel to confirm.**

- Writing a booking into the clinic's own calendar is a disclosure to the
  covered entity, or to the covered entity's own vendor acting for it. Google
  is not healdesk's subcontractor, because Google holds the data for the
  clinic under the clinic's agreement, not for healdesk. This is the
  `practice_account` basis `counsel-audit.md` §7(4) asked about for Cal.com.
- If the clinic is a covered entity, it needs its own BAA with Google
  (Workspace, paid plans). A free Gmail calendar has none. The spec says
  "confirm per clinic". The BAA should put that on the clinic.
- healdesk holds the OAuth token. That is a credential to a system holding
  PHI, so the BAA should describe it accurately. "Holds no credentials" is
  false the day the token is stored.

**So: yes to a clause, no to the addendum.** Proposed clause:

> "**Practice's calendar.** Practice connects a Google Calendar it controls.
> healdesk holds the connection, encrypted, and uses it only to read when
> that calendar is free or busy and to create, and change or cancel, the
> appointments the assistant books. It changes nothing it did not create.
> Each appointment carries only [the patient's name, a callback number, the
> service and the time]. Practice holds its own agreement with Google
> covering that calendar where the law requires one. Practice can disconnect
> at any time, which ends healdesk's access."

The bracketed list is a minimum-necessary decision. The old Cal.com clause
promised "never a telephone number"; staff will need the number to reach a
patient, so the v1 answer may differ.

**The direct-booking addendum.** It is drafted as an opt-in election, for
telephone only, accepted on a setup link
(`packages/catalog/src/direct-booking-addendum.ts`,
`approvedByCounsel: false`, never accepted). v1 inverts every part of that:
on by default, all channels, a portal switch. Its useful part is the
allocation:

> "Practice is responsible for those appointments as for any booked by its
> own staff, including the availability it publishes to that calendar and
> any deposit it requires; healdesk's responsibility is limited to booking
> only into that calendar, only at a time it showed as free…"

That is a commercial allocation, not a PHI term. Recommendation: move it into
terms §8 as "Bookings", keyed to the Auto-confirm switch; retire the
addendum. Counsel: is a default-on portal switch enough to bind the clinic
to that allocation, or does it need a separate acceptance?

---

## 7. Meta and Stripe: handled by scoping

**Meta.** No BAA, ever. The product scopes Instagram, Messenger and WhatsApp
to carry nothing clinical: clinical content is detected on arrival and not
stored, echoed or summarised; no treatment name is ever sent. Three
documents disagree about what else may be said there:

| Source | What it allows on Meta |
| --- | --- |
| Spec | Book, and send a hosted payment link, inside the 24-hour window. No treatment names |
| Terms §9 | A booking request only; "never states a time, service or practitioner" |
| `disclosure.ts` `META_CHANNEL_PROHIBITIONS` | No appointment date, time or provider; nothing about payment |
| Privacy §12 | "to book an appointment or send the clinic's own payment link" |

Counsel must settle one rule, then all four say it. Also see `brief.md` on
Meta's own Developer Policies, §5.6.5, which bars using Messenger and
Instagram messaging "to facilitate direct conversations between people and
healthcare providers". That may decide the question before HIPAA does.

Proposed BAA clause, once the rule is settled:

> "**Meta channels.** Instagram, Messenger and WhatsApp are operated by Meta,
> which signs no business associate agreement. If Practice connects them,
> healdesk replies there only inside a conversation the patient started,
> sends no clinical content and no treatment name, does not store clinical
> content a patient sends, and moves the patient to a call or Practice's own
> secure route. What a patient chooses to send to Meta, and what Meta keeps,
> is outside healdesk's and Practice's control. Practice accepts this
> limitation by connecting those channels."

**Stripe and the clinic's gateway.** Stripe signs no BAA. Deposits go
through the clinic's own gateway (Stripe Connect is the open v1 choice).
Only an amount, a generic descriptor and an opaque reference cross. Counsel:
confirm reliance on the payment-processing carve-out (HIPAA §1179), and
whether it covers a gateway the clinic owns, where healdesk creates the
payment link.

> "**Payments.** Where Practice takes deposits, healdesk creates a payment
> link through Practice's own payment processor. The link and the payment
> carry an amount, a generic description and a reference number, and no
> service name or clinical detail, including in metadata and the statement
> descriptor. healdesk never takes card numbers."

---

## 8. Terms of service, section by section

| § | Current text (quoted) | Problem | Change |
| --- | --- | --- | --- |
| 2 | "{agent} answers calls and, where purchased, Instagram, Messenger and WhatsApp" | Web chat is missing | Add website chat |
| 2 | "takes booking requests … and hands each to your front desk, who confirm a time … The agent confirms an appointment itself only where you have accepted the direct booking addendum (section 8)" | v1 auto-confirms by default on every channel | Describe Auto-confirm and manual booking mode |
| 2 | "and reports which recovered contacts became revenue" | Attribution is fenced out; "revenue" may not be claimed | "reports conversations handled, appointments booked and booked value" |
| 2 | "Every call opens with a disclosure that the caller is speaking to an AI" | Spec: every channel, and calls also say "transcribed" | Every conversation, every channel |
| 2 | "If the service is suspended or ends … we switch the agent off, so forwarded calls are not answered until you do" | A dead line. Spec forbids it | Calls route to the clinic's direct line (§4.7) |
| 3 | Overage "Until those rates are published, usage above the allowance is not billed" | Fine. Spec wants copy to say rates are placeholders | Keep |
| 5 | 14-day refund | Guarantee to add | See `guarantee-and-refund.md` |
| 6 | "the agent is suspended: it stops answering on every channel … your data is kept and stays readable in your console" | Dead line again; "console" is the old name | Calls to direct line; "portal" |
| 7 | "we tell you how to remove call forwarding (if you do not, forwarded calls are lost — that is why we tell you twice)" | Dead line | Calls to direct line until forwarding is removed. Counsel: for how long after the end? |
| 7 | "we revoke our access to your calendar and booking system" | v1 has no booking-system access | "your calendar and your Meta accounts and payment gateway" |
| 7 | "before destroying our copies on the schedule the Business Associate Agreement sets" | 1.0.0 sets no schedule | Fix in the BAA |
| 8 | "**Calls we place.** The agent places a call to a person only when …" (the whole bullet) | v1 places no calls | Replace with "Inbound only" |
| 8 | "**Direct booking.** If you accept the direct booking addendum …" | Addendum retired (§6) | Replace with "Bookings" |
| 8 | (missing) | | Add: the clinic sets call forwarding and keeps a direct line that does not forward back; the clinic keeps its own Google agreement; the greeting cannot remove the AI line |
| 9 | "**Meta channels.** … takes a booking request (a first name, a number, preferred times) and moves anything further to the phone; it never states a time, service or practitioner there, and after your decision it sends a fixed line naming none of those" | "after your decision it sends a fixed line" is outbound after the conversation; conflicts with spec | One rule from §7 |
| 9 | (missing) | | Anthropic's 30-day retention, one sentence, pointing to the BAA |
| 12 | "THAT THE AGENT WILL ANSWER EVERY CALL" | Contradicts the guarantee | Carve out the guarantee |
| 13–14 | Exclusion and one-way indemnity | Clinic counsel will resist; check it does not swallow the guarantee or conflict with BAA 1.0.0 §2.11 | Counsel's call |
| 20 | Entity line | Spec requires the Viixi FZC line; present | Keep. Registered address still blank, correctly |

---

## 9. Privacy page statements that are now false

Privacy §9, current:

> "The controls the product commits to for patient information — a signed
> agreement with every vendor that touches it, United States infrastructure,
> encryption at rest and in transit, no patient information over email, and
> breach notice to the clinic within five calendar days of discovery — are
> set out in the Business Associate Agreement"

| Claim | Why it is false or unproven today | Suggested wording |
| --- | --- | --- |
| "a signed agreement with every vendor that touches it" | Retell, Anthropic and the database provider are unsigned. Meta and Stripe are in the patient's path and will never sign | "an agreement with every vendor that holds patient information, signed before any patient information reaches it; Meta and Stripe sign none, so the product keeps clinical content away from them" |
| "United States infrastructure" | Retell's region is unconfirmed; Meta is "not region-pinned" | "United States infrastructure for everything we hold" once Retell's region is confirmed |
| "encryption … in transit" | A phone call is not end-to-end encrypted; a Meta message is outside our control | Add the telephone and Meta exceptions |
| "no patient information over email" | True only if alerts carry no patient detail. The risk analysis (T13) lists this as an open design decision | Keep only once decided |
| "set out in the Business Associate Agreement" | 1.0.0 says the model keeps nothing (false) | Fix the BAA first |

Other statements to check:

- §12 "to book an appointment or send the clinic's own payment link" — one
  of four conflicting Meta rules (§7).
- §12 "visible only to that clinic's own team in its portal" — the portal is
  not built; healdesk operators can also reach data under audit. Suggest
  "visible to that clinic's team in its portal, and to healdesk staff only
  as the clinic's agreement allows".
- §11 "Creates and changes the events it books" — true to the spec, not yet
  built. The page says every sentence must be true before the first clinic
  connects; keep that gate.
- §1 "It does not cover patients of our customers" sits beside §11–13,
  which describe data from patients. Counsel: does the scope sentence need
  to say §11–13 are the exception?
- `/subprocessors` (rendered from `subprocessors.ts`) says of Anthropic
  "Under the BAA Anthropic keeps inputs for 30 days" on a row that also
  covers the marketing demo, which is not under the BAA.
- Web chat greeting in `disclosure.ts`: "Ask for a person any time." v1 has
  no live staff inbox. A promise of a person in chat should say what
  happens (a handover request to the clinic).

---

## 10. Outline of a data processing addendum

Needed for clinics that are not HIPAA covered entities (many cash-pay med
spas), where state law replaces HIPAA. BAA 1.1.0 `practice-status` already
says it is "a data-protection agreement on the same terms where it is not"
a covered entity. Counsel decides whether that sentence is enough or a
separate DPA is cleaner.

1. **Roles.** Practice is the business/controller; healdesk is its service
   provider/processor (CCPA/CPRA "service provider"; Washington My Health My
   Data Act "processor"; Nevada SB 370 and Connecticut consumer health data
   equivalents).
2. **Subject matter and duration.** The Services, for the term plus the
   return-or-destroy period.
3. **Data subjects.** People who call, chat with or message Practice;
   Practice's staff users.
4. **Data categories.** Name, phone, email where given, service asked
   about, preferred time, bookings, deposit status, transcripts (no audio),
   Meta identifiers. Consumer health data under WA MHMDA.
5. **Instructions only.** Process only on Practice's documented
   instructions; no selling, sharing, or combining with other data; no use
   outside the direct relationship (the CCPA service-provider terms).
6. **Consent.** WA MHMDA allows collection without separate consent where
   necessary to provide the service the consumer asked for. Confirm a
   booking request falls inside that.
7. **Confidentiality of personnel.**
8. **Security.** Annex: the measures in the BAA safeguards clause.
9. **Subprocessors.** The register, 15-day notice, objection right.
10. **Consumer requests.** Assist with access, deletion, correction within
    set times.
11. **Breach notice.** Same five-day clock; note the FTC Health Breach
    Notification Rule may apply to Practice.
12. **Return or deletion.** Same 30 days.
13. **Audit and information.** Documents on request; no on-site audit.
14. **Cross-border.** healdesk is a UAE entity. Data is hosted in the US.
    Whether the founder's access from the UAE is a cross-border transfer
    that any state law cares about is for counsel.
15. **Liability.** By reference to the terms.

---

## 11. How the change has to ship (for the engineer)

Not for counsel to act on, but counsel should know the constraints.

- **Never edit a 1.0.0 clause object.** `CLAUSES_1_1` reuses 1.0.0 objects by
  id (`permitted-uses`, `data-sources-verified`, `patient-rights`,
  `acting-in-your-place`, `reactivation-gate`, `prohibited`,
  `records-to-hhs`, and the body of `data-sources-none`). Editing one of
  those changes 1.0.0's bytes and breaks every stored hash. New wording
  means a new clause object.
- **The two signing paths must change together.** `apps/app/src/lib/agreements.ts`
  (server) and `apps/web/src/components/checkout/AgreementStep.tsx` (browser)
  each build the same `BaaSelections`. The browser sends a hash of what it
  displayed; the server re-renders and refuses a mismatch. Retiring
  `calendarWrite`, `bookingMode` or `attributionMode` on one side only makes
  every signature fail. Both files carry comments asking for this.
- **Golden tests freeze the text.** `apps/app/tests/baa-golden.test.ts` and
  the agreements tests. A new version needs new golden hashes, and the
  assent label change (§2.8) is part of the stored record.
- **Order of operations.** Add the new template below 1.0.0 with
  `approvedByCounsel: false`; counsel approves; flip the flag; move it to
  `[0]`. Provisioning refuses an unapproved template.
- **Existing signers.** 1.1.0's notices clause says it replaces earlier
  versions "from the effective date forward". How a 1.0.0 signer moves to it
  (portal re-acceptance) is a counsel question. If no real clinic has signed
  1.0.0, the simplest answer is to stop offering it.
- Bump `LEGAL_VERSION` and `LEGAL_LAST_UPDATED` in `apps/web/src/lib/legal.ts`
  with any terms or privacy change.

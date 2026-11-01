# healdesk — documentation

Working documents for healdesk: one AI assistant for cash-pay elective clinics, sold as
three inbound-only products — an AI voice agent, a web chat widget, and a Meta bot for
Instagram, Messenger and WhatsApp.

## Start here

| Document | What it covers |
| --- | --- |
| [v1-product-spec.md](./v1-product-spec.md) | **The source of truth.** What healdesk v1 is: the three products, how they behave and what they cannot do, booking, onboarding, the clinic portal, HIPAA, the launch gates, and the copy the scope forces. An export of the source doc: never edit it here. Where any other document disagrees with it about what the product does, the spec wins. |
| [Launch plan](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) | **The only live task list**: the "Launch plan" tab of the spec's source doc, with owners, dates and status. Nothing in this folder replaces it. |

## Live references

How the code is built, and the compliance paperwork a business associate has to keep. These
are kept current against the spec.

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | How the two apps and three packages fit together, where each v1 surface lives, what exists in the code today, and the deploy targets. |
| [hipaa-compliance.md](./hipaa-compliance.md) | The PHI boundary, what needs a BAA, and the rules that keep `apps/app` portable. **Read before touching patient data.** |
| [hipaa-risk-analysis.md](./hipaa-risk-analysis.md) | The §164.308(a)(1)(ii)(A) risk analysis: where PHI lives in v1, vendor by vendor, the threats, the controls, and the accepted risks, stated plainly. |
| [incident-response.md](./incident-response.md) | The BAA's notification clocks as a procedure: classes, deadlines, who decides, what to preserve, vendor notices flowing up, the tabletop. |
| [on-call.md](./on-call.md) | The processes that matter, their signals, what to check first, and what the operator watches. |
| [policies/](./policies/) | The administrative safeguards a business associate must have on paper: the named Security Official, access control (including the clinic portal), sanctions, the training/access/review log, and the AWS HIPAA Account record. |
| [counsel-audit.md](./counsel-audit.md) | Legal questions answered with the statute behind each. |
| [baa-v1.7.0.txt](./baa-v1.7.0.txt) | **The BAA clinics sign once the C13 batch lands** (released by the owner on 30 October 2026, without external counsel; reconciled 1 November 2026): 1.6.0 with breach notice "in no case later than 10 calendar days after discovery" where 1.6.0 says 60, and at least 15 days' notice of a new subcontractor where 1.6.0 gives 24 hours; every other clause is 1.6.0's. The go-live floor with no overlap once `deploy-app.yml` runs migration 0142. Source of truth is `packages/catalog/src/baa.ts`, template 1.7.0 ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 22). |
| [dpa-v1.2.0.txt](./dpa-v1.2.0.txt) | **The Data Protection Agreement new DPA practices sign once the C13 batch lands**: dpa/1.1.0 with the same two changes as BAA 1.7.0 (10 calendar days to report, 15 days' notice). Released by the owner on 30 October 2026 as "DPA 1.1.0" on its branch and renumbered 1.2.0 because main had released its own 1.1.0; its text is that release word for word but for the version line. Written by `npm run dpa:review -w @healdesk/catalog` ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 22). |
| [dpa-v1.1.0.txt](./dpa-v1.1.0.txt) | dpa/1.0.0 with its telephone exception carrying the one optional payment-link text, released by the owner on 30 October 2026 and offered until dpa/1.2.0 replaces it; frozen for whoever signed it. Written by `npm run dpa:review -w @healdesk/catalog` ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 21). |
| [baa-v1.6.0.txt](./baa-v1.6.0.txt) | **Released by the owner on 29 October 2026, offered until 1.7.0 replaces it.** Drafted 19 October 2026: 1.5.1 with the Subcontractors clause's paragraph on Anthropic said as Anthropic's documentation says it for the models the product calls: no more than the 30 days of standard retention, the only retention under which Anthropic offers its service under a business associate agreement, two years for flagged content alone, law-required content for as long as the law requires, and no training without healdesk's permission; and the state-law and Term clauses, which point at that paragraph, naming no purpose for what Anthropic keeps, only the periods it states; and, since 29 October 2026, the Safeguards clause saying the assistant is engineered and designed to offer a caller one text with fixed wording and the practice's own payment link, where the practice has chosen that option ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 20). Rendered as a clinic would see it, with the same appendices as 1.5.1. Source of truth is `packages/catalog/src/baa.ts`, template 1.6.0, and `packages/catalog/src/model-retention.ts`; released by the owner on 29 October 2026 without external counsel ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 17). |
| [baa-v1.5.1.txt](./baa-v1.5.1.txt) | The BAA clinics signed from 19 October 2026 until 1.6.0 replaced it on 29 October, rendered as a clinic sees it, with the clauses that render only for some practices, the calendar election and the Google Calendar disclosure in appendices. Source of truth is `packages/catalog/src/baa.ts`, template 1.5.1: 1.5.0 with clause 11's items (b) and (c) saying the optional booking details (a last name, the service, new or returning, consultation or treatment, a practitioner) are asked on a call or in a website chat, as the website chat does, where 1.5.0 said on a call; released by the owner without external counsel, with a recommendation that counsel review it ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 16). |
| [dpa-v1.0.0.txt](./dpa-v1.0.0.txt) | The Data Protection Agreement (`dpa/1.0.0`) a veterinary practice, and a med spa, hair restoration, massage or chiropractic practice that answers "No" to billing health insurance electronically, sign from 20 October 2026 in place of the BAA. Rendered for a sample practice, with the clauses that render only for some practices in Appendix A and its own calendar election form (`calendar-election-dpa/1.0.0`) in Appendix B. Source of truth is `packages/catalog/src/dpa.ts` and `dpa-calendar-election.ts`, written by `npm run dpa:review -w @healdesk/catalog`; drafted 6 October 2026 and released by the owner on 20 October 2026, with its election form, without external counsel, with a recommendation that counsel review it before the first live DPA practice ([counsel/dpa.md](./counsel/dpa.md); [counsel/agreement-changes.md](./counsel/agreement-changes.md) § 18). |
| [baa-v1.5.0.txt](./baa-v1.5.0.txt) | The version offered from 14 October 2026 until 1.5.1 replaced it outright on 19 October, before any clinic signed it; kept frozen, below the go-live floor and no longer signable. Rendered as a clinic sees it, with the clauses that render only for some practices, the calendar election and the Google Calendar disclosure in appendices. Source of truth is `packages/catalog/src/baa.ts`, template 1.5.0: 1.4.0 with the transcript's one encrypted copy held only until the practice's mail server confirms delivery and then deleted, kept and sent again until it is delivered but never past 30 days, deleted 72 hours after a send nothing answered, and a record of each transcript's delivery kept without the words; released by the owner without external counsel, with a recommendation that counsel review it ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 15). |
| [baa-v1.4.0.txt](./baa-v1.4.0.txt) | The version offered from 13 October 2026 until 1.5.0 replaced it outright on 14 October, before any clinic signed it; kept frozen, below the go-live floor and no longer signable. Rendered as a clinic sees it, with the clauses that render only for some practices, the calendar election and the Google Calendar disclosure in appendices. Source of truth is `packages/catalog/src/baa.ts`, template 1.4.0: 1.3.0 with its transcript passages said as the product then worked (each call's and website chat's transcript emailed to the practice, one encrypted copy held for seven days to send it again, the conversation's record kept without the words, and nothing for the portal to shorten); released by the owner without external counsel, with a recommendation that counsel review it ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 14). |
| [baa-v1.3.0.txt](./baa-v1.3.0.txt) | The version offered from 12 October 2026 until 1.4.0 replaced it outright on 13 October, before any clinic signed it; kept frozen, below the go-live floor and no longer signable. Template 1.3.0: the calendar clause chosen by the booking system and the Google account, the Payments clause, the clause for a practice that is not a covered entity and 24 hours' notice of a new subcontractor; released by the owner without external counsel after Claude's audit of the text against the code ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 12.15). |
| [baa-v1.2.2.txt](./baa-v1.2.2.txt) | The version offered from 9 October 2026 until 1.3.0 replaced it outright on 12 October, before any clinic signed it; kept frozen, below the go-live floor and no longer signable. Template 1.2.2: 1.2.1 with the subcontractor list given on request, hello@healdesk.io as the notice email and the spec's 60-day breach wording; released by the owner without external counsel ([counsel/agreement-changes.md](./counsel/agreement-changes.md) § 13). |
| [baa-v1.2.1.txt](./baa-v1.2.1.txt) | The version offered from 1 October 2026 until 1.2.2 replaced it on 9 October, before any clinic signed it; kept frozen. Released by the owner without external counsel after an adversarial review (see [counsel/](./counsel/)). |
| [baa-v1.2.0.txt](./baa-v1.2.0.txt) | The version offered for part of 1 October 2026 before 1.2.1 corrected five sentences; kept frozen for anything signed against it. |
| [baa-v1.1.0-draft.txt](./baa-v1.1.0-draft.txt) | The superseded 1.1.0 revision, never offered; kept because the counsel notes cite it. |
| [handover.md](./handover.md) | Engineering handover notes. Not the task list: that is the Launch plan tab. |

## Selling

| Document | What it covers |
| --- | --- |
| [icp-niches.md](./icp-niches.md) | Which verticals to sell to, ranked by what a missed call costs them. The six specialties the site ships with come from here. |
| [leadgen-playbook.md](./leadgen-playbook.md) | How to find and qualify target clinics — targeting signals (including which booking systems v1 can book live), the Apify pipeline, and trigger events. Implemented in [`packages/leadgen`](../packages/leadgen). |
| [leadgen-enrichment.md](./leadgen-enrichment.md) | Turning the contact file into a launch segment: the enrichment pipeline, its cost, and how to read the result. |
| [outreach/](./outreach/) | Cold-email infrastructure for our own B2B outreach, gate by gate, and the run log. |
| [marketing-voice-demo-context.md](./marketing-voice-demo-context.md) | The brief for the demo call an owner requests from the site. Predates the spec; its banner says what still holds. |

## Superseded, kept for history

Each of these opens with a banner naming where it disagrees with the spec. They stay in
place, headings and all, because the docs-site task view and other documents still link
into them; read them for their research and reasoning, not for what to build.

| Document | What it was |
| --- | --- |
| [launch-plan.md](./launch-plan.md) | The August 2026 plan: Synthflow voice, SMS, the attribution opt-in and the monthly email report. Still useful for its vendor, legal and pricing research. |
| [prd.md](./prd.md) | The original requirements, including SMS, reminders, outbound and closed-loop revenue attribution. Its unchecked boxes are not the roadmap. |
| [next-steps.md](./next-steps.md) | A September sequencing of the work, built around Synthflow and the revenue report. |
| [state-of-play.md](./state-of-play.md) | A dated audit (2 September 2026): the BAA review, the code review and the niche argument. |
| [research-conclusions.md](./research-conclusions.md) | The 17 August 2026 research record: vendors, the laws that are not HIPAA, insurance, badges. |
| [blockers-runbook.md](./blockers-runbook.md) | Click-by-click vendor, legal and insurance steps from the same research. The AWS, Anthropic and trust-badge sections still hold. |
| [onboarding-runbook.md](./onboarding-runbook.md) | An operator-run onboarding on Synthflow. v1 onboarding is a self-serve wizard. |
| [design/booking-and-callbacks-2026-09-23.md](./design/booking-and-callbacks-2026-09-23.md) | A booking design around Cal.com writes, staff-approved requests and callbacks. v1 books into Google Calendar and makes no callbacks. |
| [archive/](./archive/) | The original working doc, preserved verbatim, and the prompt brief for the Synthflow patient agent (Synthflow was replaced by Retell on 5 October 2026); see its README. |

## How these relate

`icp-niches.md` decides **who we sell to**. `leadgen-playbook.md` is **how we find them**.
`v1-product-spec.md` is **what we sell them**. `architecture.md` and `hipaa-compliance.md`
are **how we build it without painting ourselves into a corner**.

The position all of it serves is the spec's: built for cash-pay clinics specifically; one
brain answering every channel rather than one tool per channel; books and takes deposits
rather than taking messages; and set up to carry patient data under a signed business
associate agreement rather than hoping the question never comes up. Closed-loop revenue
attribution is phase two: v1 claims only what it can count directly — conversations
handled, appointments booked, calls answered that would have rung out, deposits collected,
and booked value.

## Conventions

- These are living documents. Edit them directly, `v1-product-spec.md` included (since 22 October 2026 it is the
  source of truth, no longer re-exported). The archive keeps the original working doc.
- The roadmap is the source doc's "Launch plan" tab. No file here is a second task list.
- Dollar figures are approximate industry ranges, not quotes. Firm them up before they
  go on a sales deck or a pricing page.

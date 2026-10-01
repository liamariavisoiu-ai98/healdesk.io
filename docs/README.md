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
| [baa-v1.1.0-draft.txt](./baa-v1.1.0-draft.txt) | A BAA revision rendered for counsel review. Source of truth is `packages/catalog/src/baa.ts`; a draft is offered to no one until approved. |
| [handover.md](./handover.md) | Engineering handover notes. Not the task list: that is the Launch plan tab. |
| [synthflow-voice-agent-context.md](./synthflow-voice-agent-context.md) | A prompt brief written for a Synthflow patient agent. v1 voice runs on Retell, so read it for behaviour, not for the vendor. |

## Selling

| Document | What it covers |
| --- | --- |
| [icp-niches.md](./icp-niches.md) | Which verticals to sell to, ranked by what a missed call costs them. The six specialties the site ships with come from here. |
| [leadgen-playbook.md](./leadgen-playbook.md) | How to find and qualify target clinics — targeting signals (including which booking systems v1 can book live), the Apify pipeline, and trigger events. Implemented in [`packages/leadgen`](../packages/leadgen). |
| [leadgen-enrichment.md](./leadgen-enrichment.md) | Turning the contact file into a launch segment: the enrichment pipeline, its cost, and how to read the result. |
| [outreach/](./outreach/) | Cold-email infrastructure for our own B2B outreach, gate by gate, and the run log. |
| [marketing-voice-demo-context.md](./marketing-voice-demo-context.md) | The brief for the demo call an owner requests from the site. Predates the spec; its banner says what still holds. |
| [hero-frames.md](./hero-frames.md) | Production spec for the site's hero image grid. |

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
| [archive/](./archive/) | The original working doc, preserved verbatim; see its README. |

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

- These are living documents. Edit them directly — except `v1-product-spec.md`, which is an
  export: change the source doc and re-export it. The archive keeps the original working doc.
- The roadmap is the source doc's "Launch plan" tab. No file here is a second task list.
- Dollar figures are approximate industry ranges, not quotes. Firm them up before they
  go on a sales deck or a pricing page.

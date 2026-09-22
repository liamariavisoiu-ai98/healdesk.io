# healdesk — documentation

Working documents for a vertical AI front-desk / voice-agent service for high-ticket
elective healthcare.

## Index

| Document | What it covers |
| --- | --- |
| [handover.md](./handover.md) | **Where the build stands and what's next.** What's blocked and on what, the counsel items, and the engineering left. Start here. |
| [launch-plan.md](./launch-plan.md) | The plan of record. v1 scope, vendor decisions and their compliance conditions, the purchase flow, pricing and unit economics, and the build phases. |
| [prd.md](./prd.md) | Product requirements — the baseline service, conversion & revenue, clinical & compliance, and the differentiator worth building the company on. |
| [icp-niches.md](./icp-niches.md) | Which verticals to sell to, ranked by ROI-per-recovered-call. The six specialties the site ships with come from here. |
| [leadgen-playbook.md](./leadgen-playbook.md) | How to find and qualify target clinics — targeting signals, the Apify pipeline, and trigger events. Implemented in [`packages/leadgen`](../packages/leadgen). |
| [architecture.md](./architecture.md) | Stack decisions and why, the repo layout, and the two-deploy-target split. |
| [hipaa-compliance.md](./hipaa-compliance.md) | The PHI boundary, what needs a BAA, and the rules that keep `apps/app` portable. **Read before touching patient data.** |
| [hipaa-risk-analysis.md](./hipaa-risk-analysis.md) | The §164.308(a)(1)(ii)(A) risk analysis: where PHI lives, the threats, the controls, and the accepted risks, stated plainly. |
| [onboarding-runbook.md](./onboarding-runbook.md) | Payment to first answered call: the ordered steps, who does each, how long, and what to automate first. |
| [incident-response.md](./incident-response.md) | The BAA's two notification clocks as a procedure: classes, deadlines, who decides, what to preserve, the tabletop. |
| [on-call.md](./on-call.md) | One page: the three signals, what to check first, how to restart the worker. |
| [counsel-audit.md](./counsel-audit.md) | The six legal questions answered with the statute behind each: covered-entity status, CIPA recording, HIPAA marketing, the text-back's consent, sender identity, the public claims. |
| [baa-v1.1.0-draft.txt](./baa-v1.1.0-draft.txt) | The BAA revision rendered for counsel review. Source of truth is `packages/catalog/src/baa.ts`, template `1.1.0-draft`; not offered to anyone until approved. |
| [policies/](./policies/) | The administrative safeguards a business associate must have on paper: the named Security Official, access control, sanctions, the training/access/review log, and the AWS HIPAA Account record (the account, region, services and configuration behind the AWS BAA, which AWS does not keep for us). |
| [archive/](./archive/) | The original working doc, preserved verbatim as the source these were split from. |

## How these relate

`icp-niches.md` decides **who we sell to**. `leadgen-playbook.md` is **how we find them**.
`prd.md` is **what we sell them**. `architecture.md` and `hipaa-compliance.md` are
**how we build it without painting ourselves into a corner**.

The through-line across all four is the wedge in `prd.md`: closed-loop revenue
attribution. A standalone AI receptionist writes *into* the booking system and never
reads the money event back *out* of the POS, so it structurally cannot tell a clinic
which recovered call became collected revenue. Everything else on the roadmap is table
stakes that gets us in the door.

## Conventions

- These are living documents. Edit them directly; the archive keeps the original.
- Dollar figures are approximate industry ranges, not quotes. Firm them up before they
  go on a sales deck or a pricing page.
- Unchecked boxes in `prd.md` are the roadmap. Check them as they ship.

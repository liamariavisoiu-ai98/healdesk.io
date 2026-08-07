# healdesk — documentation

Working documents for a vertical AI front-desk / voice-agent service for high-ticket
elective healthcare.

## Index

| Document | What it covers |
| --- | --- |
| [prd.md](./prd.md) | Product requirements — the baseline service, conversion & revenue, clinical & compliance, and the differentiator worth building the company on. |
| [icp-niches.md](./icp-niches.md) | Which verticals to sell to, ranked by ROI-per-recovered-call. The six specialties the site ships with come from here. |
| [leadgen-playbook.md](./leadgen-playbook.md) | How to find and qualify target clinics — targeting signals, the Apify pipeline, and trigger events. Implemented in [`packages/leadgen`](../packages/leadgen). |
| [architecture.md](./architecture.md) | Stack decisions and why, the repo layout, and the two-deploy-target split. |
| [hipaa-compliance.md](./hipaa-compliance.md) | The PHI boundary, what needs a BAA, and the rules that keep `apps/app` portable. **Read before touching patient data.** |
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

# Archive

Material kept for the record, not for building from. Everything here is superseded by
[v1-product-spec.md](../v1-product-spec.md), which decides what the product is; the only
live task list is the
[Launch plan tab](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) of the spec's source
doc.

| File | What it is |
| --- | --- |
| [medspa-ai-frontdesk-working-doc.md](./medspa-ai-frontdesk-working-doc.md) | The original working document, preserved verbatim: the first product requirements (SMS, reminders, outbound, intake, closed-loop revenue attribution as the wedge) and the first lead-generation playbook. Split into `prd.md` and `leadgen-playbook.md` early on. Do not edit it |
| [synthflow-voice-agent-context.md](./synthflow-voice-agent-context.md) | The prompt brief for a Synthflow patient agent (8 September 2026). Synthflow was replaced by Retell on 5 October 2026 and its webhook removed from the code on 14 October; moved here then. Read it for its research on disclosure, the minimum-information rule and failure lines, not for the vendor |

## Superseded documents that stay where they are

The documents below are superseded too, but they were not moved here. The docs-site
build (`scripts/docs-site/build.mjs`) reads several of them by path and fails if a task's
source heading stops resolving, and other documents and code comments link into them.
Each one opens with a banner naming where it disagrees with the spec; their headings are
unchanged.

| Document | Superseded because |
| --- | --- |
| [launch-plan.md](../launch-plan.md) | The August plan: Synthflow, SMS and 10DLC, a front-door-only Meta channel, the attribution opt-in, no clinic login |
| [prd.md](../prd.md) | Outbound, intake and attribution as the product |
| [next-steps.md](../next-steps.md) | A mid-September sequence built on Synthflow and the revenue report |
| [onboarding-runbook.md](../onboarding-runbook.md) | An operator-run onboarding; v1 is a self-serve wizard |
| [design/booking-and-callbacks-2026-09-23.md](../design/booking-and-callbacks-2026-09-23.md) | Cal.com writes, AI callbacks, WhatsApp templates and the setup link |

Dated records that are superseded only where they conflict with the spec, and still
worth reading for their reasoning: [research-conclusions.md](../research-conclusions.md),
[blockers-runbook.md](../blockers-runbook.md), [state-of-play.md](../state-of-play.md),
[counsel-audit.md](../counsel-audit.md) and
[marketing-voice-demo-context.md](../marketing-voice-demo-context.md).

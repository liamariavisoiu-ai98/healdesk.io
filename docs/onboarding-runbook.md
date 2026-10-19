# Onboarding runbook — from Stripe payment to the first answered call

> **Superseded 2026-09-30 by [v1-product-spec.md](./v1-product-spec.md)**
> ("Onboarding principles" through "Full suite onboarding"). Kept for history;
> the live task list is the [Launch plan tab](https://claude.ai/artifact/F7bKioXheMJwn5Epc65bVQ) of the spec's source doc. What changed: the
> clinic self-serves a four-step wizard in about fifteen minutes of its own
> attention, already signed in from payment; there is no operator call. The
> voice number is allocated automatically at payment (on Retell, not
> Synthflow) and travels in the receipt email. Routing is one of three coverage
> modes (all calls; overflow and after hours, the default; after hours only),
> not "conditional or always". The build and quality audit are automatic and
> go-live follows a passed audit; a person reviews only what the audit flags.
> The attribution connect step is phase two. What stays with the operator is
> the exception path: flagged audits, assisted five-minute forwarding calls,
> the "I cannot get in" route, scrape failures, and the 14-day zero-inbound and
> 48-hour zero-interaction flags.

**Who:** the operator (you, today). **Where:** `/admin/ops` → the clinic's
"Onboarding checklist, phone, script, go-live" page. **How long:** one 45-minute
call with the clinic plus about an hour of your own work, once the vendor
accounts exist.

Every step below says whether the software does it, you do it in the
console, or you do it somewhere else. The column that matters for the next
build decision is "who", ordered by minutes spent.

| # | Step | Who / where | Minutes | Notes |
| --- | --- | --- | --- | --- |
| 1 | Stripe payment completes; provisioning creates the organisation, clinic, entitlements, default agent script and the checklist | **Software** (webhook → apps/app) | 0 | Checkout already stamps `call_routing_chosen`, `phone_type_confirmed` (unless "not sure") and `covered_entity_confirmed` (unless "not sure"). |
| 2 | Allocate the clinic's Synthflow number and build its agent in the Synthflow dashboard from the approved script | **You**, Synthflow dashboard | 20 | Paste the greeting, services and escalation number exactly as approved in the console — the console's copy is the record. |
| 3 | Enter the Synthflow number, line type and carrier in the console's phone panel | **You**, console | 2 | The forwarding codes appear once the number is in. |
| 4 | Book the onboarding call | **You**, email | 2 | Ask them to have the phone bill (carrier) and the desk phone to hand. |
| 5 | On the call: confirm opening hours by day | **You + clinic**, console | 5 | Mark `hours_confirmed`. After-hours recovery is counted only with hours on file. |
| 6 | On the call: confirm routing — does the number ring at the desk first? | **You + clinic**, console | 3 | Saving the phone panel stamps `call_routing_chosen`. This decides what the report calls recovered. |
| 7 | On the call: confirm covered-entity status if they answered "not sure" at checkout | **You + clinic**, console | 3 | The test is: any claim, eligibility check or prior auth sent electronically to a payer, by them or a billing service. Record on the clinic. |
| 8 | On the call: read the agent script back, edit prices and services with them, record who approved it | **You + clinic**, console | 10 | Saving clears approval; "Record approval" stamps `agent_script_approved`. The guard refuses clinical wording and names it. |
| 9 | On the call: walk them through dialling the forwarding codes from the desk phone | **You + clinic**, console shows the codes | 5 | Overflow and after hours (busy and no-answer, plus not reachable where the line has it) by default. All-call forwarding (*72 and the number on most landlines) only for All calls, or at closing each day for After hours only. Each step names the kind of line it is for (AT&T Phone, a traditional AT&T landline, a mobile line…): follow the clinic's own, and finish with the test call. Mark `forwarding_configured`. |
| 10 | Test call: ring the clinic's published number from your own phone with the desk not answering; confirm AYA answers, the disclosure plays, and the caller number shows in Synthflow's call log | **You**, phone + Synthflow log | 5 | Mark `test_call_passed` only if the caller ID survived. If every call shows the clinic's own number, the carrier strips caller ID on forward — ask them to enable "caller ID pass-through" (VoIP) or call the carrier. |
| 11 | Verified attribution only: send the connect link from the console and accept the platform's invitation to `hello+<slug>@healdesk.io` | **You**, console + mailbox | 10 (+ vendor lead time) | Vagaro up to 7 business days, Zenoti 1–2 days for the API package. Mark `platform_connected` when the connection is verified. |
| 12 | Go live | **You**, console | 1 | The button is enabled only when everything above is stamped; the database refuses otherwise. Records `clinic_went_live`. |
| 13 | Tell the clinic it is live, and how to undo forwarding | **You**, email | 3 | The undo steps for its carrier and kind of line are on the console page. |

## Discovery questions that must be answered before step 12

1. Landline/toll-free or cloud phone system? Who bills you for it?
2. Does the number ring at the practice first, or should AYA answer everything?
3. Opening hours by day, including lunch closures.
4. Do you, or a billing service for you, send anything electronically to an insurer or payer?
5. Where does a human pick up if AYA transfers, and when?

## What to automate first, by minutes

Step 2 (20 min, Synthflow agent build) is the largest manual block and the
`agent-vendor-provisioning` task. Step 10's verification is the
`voice-ingest` webhook: once inbound call events land in apps/app, "test call
passed" becomes a button that watches for the call instead of a phone in
your hand. Everything else is already a click.

# Shared brief: the ops automation program (read this first)

You are one of seven design agents. You are READ-ONLY on the repository: read code and docs, write
nothing under /Users/liamariavisoiu/projects/. Write your design to the path your own task names (in this
scratchpad folder). Do not run AWS, git push, deploys, workflows or any command that changes anything.
Repo to read: /Users/liamariavisoiu/projects/healdesk-db-access (a worktree at main, commit 2e258ae9).

## What the owner wants (his words, 23 October 2026)

He was offered 20 ops automations and answered each. Quote his intent exactly; do not water it down,
and do not widen it. Where his wish collides with a rule in CLAUDE.md or the spec, say so plainly and
propose the closest thing that keeps the rule, for the owner to decide.

1. MORNING HEALTH DIGEST: "We currently have an ongoing morning digest and I want it to also include
   these data points." (Find the existing digest first; extend it, do not build a second one.)
2. DEPLOY VERIFIER: "no." (Not wanted.)
3. USAGE-NEAR-CAP WATCH: must be an email to the clinic, to hello@healdesk.io AND to our Slack channel.
   For ops: the clinic's name, clinic id, links to admin "where I need to be seeing all the clinics that
   have signed with us with automated buttons to send them notifications", and "I need you to propose
   what those notifications should be (of course linked to resend, the DB and so on)".
4. STUCK-PROVISIONING FINDER: "yes, we need this as email notification as well as slack alert in time
   waves and there also needs to be an automated reachout from hello@healdesk.io to the clinic as
   reminders with every time frame. These need to be linked and admin should be able to see on the
   dashboard every time a new reminder has been sent for this to them successfully."
5. HOLIDAY AND CLOSURE LOADER: "needs to be on the clinic's dashboard, not ours, we should just receive
   an alert by slack and an indication on our ops clinic list page that the clinic has changed their
   availability and a button to run an audit to check the health of the connection now with the new
   availability against the DB as well as Retell and Calendar and everything else - basically running
   an audit to understand if the new availability has been implemented and is running without problems.
   This audit should automatically take place anyway every time there is a change initiated by the
   clinic with a status shown on our ops clinic panel. The extra button would be for us to manually
   perform extra due diligence. If anything else is needed here, add."
6. PROVIDER AND SERVICE ROSTER EDITS: "ok, also being monitored through the admin page."
7. GO-LIVE READINESS CHECK: "yes, also monitored through the admin page."
8. SETUP-DEADLINE WATCH: "an alert to ops with a manual button action instead, only if we consider that
   it is worth proposing extensions to each particular clinic. This should be part of the other function
   'stuck-provisioning finder' in a clean and efficient and effective way. Think of a perfect system."
9. CALENDAR FAILURE TRIAGE: "Up to a set number of retries, that if still fail, ops should receive mail
   and slack alerts with links to the issue that would allow for a fix. I want all of the links and
   buttons that link to the issue to also have an embedded claude comment that triggers claude to fix
   that issue. Maybe we can do this through Claude chrome extension or somehow else so that we remain on
   the subscription for any debugging and updating and fixing etc.??"
10. VOICE AGENT DRIFT CHECK: "Automatic yes, but also alerts ops through mail and slack, with proposed fixes."
11. TRANSCRIPT DELIVERY WATCH: "yes! And monitoring in admin client panel again."
12. SUPPORT: "I want to implement an automated support team just like Anthropic is offering, by mail and by
    the support chatbot that will be present on the client dashboard - which we still need to build btw.
    It needs to have the highest possible natural feel in terms of communication, keeping things very
    short and natural and diminishing stress and anxiety for the client." AND: "I want the emails to be
    prepared and for me to still approve for them to be sent prior. I should be able to edit them if
    needed and have a sent button. Also through the admin page."
13. AGREEMENT AND BAA REVIEW PACKETS: yes. 14. BAA RE-SIGN CHASE LIST: yes.
15. BILLING RETRY TRIAGE: "yes, gated again by my approval to be sent."
16. PATIENT-RIGHTS REQUEST TRACKER: yes. 17. INCIDENT RUNBOOK ASSISTANT: "yes, gated again."
18. WEEKLY COMPLIANCE PACK: yes.
19. DEMO PIPELINE REPORT: yes, AND "a page on the admin that relates to our sales efforts, kinda like
    Hubspot but it needs to be MUCH simpler and cleaner so that it is directly understandable from a
    first glance, with modern ways of advancing leads from one stage to another, advanced ways of
    creating an invoice just like Hubspot, with custom payment links if needed from Stripe, otherwise
    with normal Stripe products, etc. This is a big ask, so let's keep it under request to plan for a
    future session." (So: PLAN ONLY for the CRM. Do not design it to build now.)
20. LAUNCH-PROMISE AND COST DIGEST: "Yes, updated on the admin page."
GLOBAL: "Make sure the admin is redone in a VERY CLEAR AND EASY TO UNDERSTAND WAY, no repetitions, no
need for information that is not useful for the ops but just adding noise, etc."

## Rules you must respect (read the sources, do not rely on this summary)
- /Users/liamariavisoiu/projects/healdesk-db-access/CLAUDE.md : the PHI boundary (apps/web has NO database
  and no PHI; apps/app holds PHI and talks to apps/web only through the HMAC-signed /api/ops envelope,
  adding operations to a closed list rather than widening what crosses), "Product rules the code
  enforces" (inbound only; nothing contacts a PATIENT first; clinics are not patients), the clinic portal
  rules (six screens, and a "must never grow" list: read it against every clinic-facing idea),
  Email rules (patient-related mail is a pointer, never names/numbers/text; one Resend account sends
  product mail from hello@healdesk.io, the only address; may-carry-phi mail goes through SES only),
  Claims and copy rules, and "Keep /admin/map true".
- /Users/liamariavisoiu/projects/healdesk-db-access/docs/v1-product-spec.md : the spec wins on what the
  product does. NEVER propose editing it; if a wish needs a spec change, say exactly which section and
  that the owner must change the source doc.
- docs/design/db-access-2026-10-22.md : the read rail (db-query: healdesk_readonly, 15 tables), the write
  rail (db-apply: healdesk_writer, INSERT/UPDATE on clinic_closures, clinic_providers,
  clinic_provider_services, one clinic per run, dry-run then apply with a stated row count) and what is
  withheld and why. Do not propose widening them casually.
- The ops console: apps/web/src/app/admin/** (sections: agreements compliance crm demos host incidents
  notices ops recordings reviews seo setup site-reads support) and apps/web/src/lib/admin/ops-client.ts
  (about 60 typed read/write operations reaching apps/app through apps/app/src/lib/ops/api.ts).
- Existing machinery to REUSE before inventing: the billing_notices outbox and report_deliveries ledger
  (apps/app/src/lib/notices, reporting), ops_alerts, scheduled_jobs and the worker (apps/app/src/workers),
  Slack alerting (find where: start at apps/web/src/lib/demo/alert.ts), the setup reminders (the 30-day
  setup window, a reminder every five days, six in all: see CLAUDE.md), the portal support chat
  (stores nothing; escalates to hello@ with structured fields), the existing morning/daily summaries.
- Anything you would store in apps/web needs a Google Sheet tab (it has no database); anything with a
  clinic's data lives in apps/app. State which.
- Every new Terraform/env key needs /admin/map (apps/web/src/lib/admin/system-map.ts) updated; every
  schema change is a numbered drizzle migration and a new table must be classified in
  apps/app/scripts/readonly-tables.ts (a test fails otherwise).

## What each design must contain (max about 900 words, plain language, no filler)
1. CURRENT STATE, verified by reading code: what exists today for this area, with file paths. Say "not
   found" rather than guess.
2. WHAT TO BUILD: data (tables/columns/Sheet tabs), jobs and schedules, ops operations to add, screens,
   emails and Slack messages (draft the actual wording where the owner asked for wording).
3. REUSE VS NEW, and which of the three rails each piece uses (R1 read queries, R2 change files, R3 the
   typed ops operations).
4. GUARDRAILS and conflicts: PHI, the portal's must-never-grow list, outbound rules, spec sections, email
   transport rules. Mark each conflict "OWNER DECISION" with your recommended resolution.
5. BUILD ORDER: small independently landable steps, each with a size (S/M/L), what test proves it, and
   the files it would touch (so overlaps between designs can be found).
6. OPEN QUESTIONS: at most five, only things the owner must answer.
Finish by returning a summary of at most 250 words. The full design goes in your named file.

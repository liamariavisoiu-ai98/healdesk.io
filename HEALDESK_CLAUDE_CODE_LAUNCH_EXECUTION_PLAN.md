# Healdesk — Claude Code master launch execution plan

**Version:** 2026-10-21. **Status:** Engineering work is not presumed complete or production-verified. **Source of truth:** `docs/v1-product-spec.md` (product), `CLAUDE.md` (architecture), this file (delivery), `AGENTS.md` (current session state).

## Execution contract

1. Start with `docs/claude-session-start.md`; inspect current Git, code, tests and `apps/web/src/lib/admin/seo/launch.ts`. The live task list in the product spec's **Launch plan** tab remains authoritative; this plan must be reconciled to it, not silently substituted for it.
2. First perform **Wave 0: read-only audit**. For each workstream below, create a numbered work package (`<ID>-01`, etc.) with actual paths, missing acceptance evidence, priority, dependencies, Owner decisions and test commands. Do not assert all work is incomplete; verify.
3. Each package follows **read → plan → implement → unit/integration/security tests → review → handoff**. Do not start a new package before checkpointing the current one. Use a feature branch and draft PR when authorized.
4. Separate five states: **code implemented**, **tests passed**, **deployed**, **production verified**, **Owner approved**. Never infer later states from earlier ones. Do not mark `launch_promises` on without evidence of production behavior.
5. Do not modify `docs/v1-product-spec.md` directly. Preserve inbound-only v1, no SMS/outbound, no Meta PHI, no patient PHI in Vercel `apps/web`, hosted payments, and BAA-covered AWS `apps/app`. Never use real patient data without complete vendor coverage and authorization.
6. Do not deploy, merge, apply Terraform, change live vendor settings, enable traffic, spend funds or attest compliance without Owner approval. Never place secrets or PHI in Git, AGENTS.md or PR logs.
7. After every package, update `AGENTS.md` with task ID, Git state, changed paths, exact test outcomes, evidence, blockers, next step and Owner dependencies. Update this plan only for evidence-backed status changes.

## Workstream ownership and acceptance matrix

Each line describes Claude Code's **engineering assignment** and the **Owner-only decision or action**. An action may be blocked on external approval even if engineering is finished.

| ID | Product / feature | Claude Code: verify, implement and prove | Owner-only / approval |
| --- | --- | --- | --- |
| `ARCH` | System architecture | Audit Vercel non-PHI vs AWS PHI, server-only secrets, routing, database access and tenant isolation; fix violations; run both workspace tests and lint. | Owner approves production infrastructure and security risk. |
| `PRICE` | Plans and usage | Reconcile catalog, feature entitlements, Stripe price IDs, metering, taxes, renewals and plan transitions; add tests. | Owner approves commercial prices and live Stripe settings. |
| `CHECKOUT` | Checkout and provisioning | Test agreement signing, checkout, invoice/webhook validation, idempotent provisioning, emails and failure recovery. | Owner approves live billing and contract terms. |
| `ONBOARD` | Clinic onboarding | Test wizard, save/resume, business rules, staff permissions, knowledge ingestion, hours, services, escalation and channel activation. | Owner supplies clinic policies and signs off. |
| `VOICE` | AYA Voice | Verify inbound Retell integration, Anthropic prompts, WebSocket, tools, escalation, emergency handling, consent, recordings disabled and synthetic calls. | Owner authorizes production voice agent and real call testing. |
| `PHONE` | Phone routing and fallback | Document/test carrier forwarding, loop avoidance, unreachable fallback, backup number and outage playbook. | Owner configures carrier and approves live forwarding. |
| `BOOK` | Google Calendar booking | Verify OAuth, availability, timezones, concurrency, 60-second holds, double-book prevention, writes, retries, cancellations and manual fallback. | Owner approves scopes, clinic calendars and production OAuth. |
| `WEBCHAT` | Website chat | Test widget loading, mobile/accessibility, identity, FAQ, booking, urgent handling, transcript routing and PHI boundary. | Owner authorizes installation on clinic websites. |
| `DEPOSIT` | Patient deposits | Verify clinic-owned gateway, hosted checkout, webhook status, expiries, failed payment, retries and zero card-data exposure. | Owner connects clinic gateway and approves payment policy. |
| `META` | Instagram Messenger WhatsApp | Verify webhook signatures, permissions, 24-hour window, channel-specific flows, booking, no PHI and no direct payment in Meta; run Meta QA. | Owner handles Meta business/app/WhatsApp approvals. |
| `SAFETY` | Cross-channel AI safety | Build regression cases for urgency, never-say claims, PHI, identity, prompt injection, unsupported advice, tool errors and human escalation. | Owner approves safety policy and clinical escalation rules. |
| `ALERT` | Urgent and booking alerts | Test SES templates, delivery, retries, deduplication, dead-letter handling, failures and truthful user acknowledgment. | Owner configures operational recipients and approves alert policy. |
| `RETENTION` | Transcripts and retention | Test sealed outbox, delivery-triggered deletion, maximum retention, no audio, vendor settings and access logs. | Owner verifies vendor settings and retention obligations. |
| `PORTAL` | Clinic portal | Test Home, Settings, Knowledge, Conversations, Bookings, Billing, Support, access control, tenant isolation and mobile. | Owner performs clinic workflow acceptance. |
| `REPORT` | Clinic summaries | Test daily/weekly scheduling, accuracy, opt-out, delivery, missing-data behavior and permitted PHI. | Owner approves recipients and report contents. |
| `OPS` | AWS and operations | Review Terraform, ECS/web/worker/WebSocket, TLS, secrets, backups, alarms, monitoring, incident playbooks, restore and rollback. | Owner authorizes production changes and verifies operational access. |
| `VENDOR` | Vendor agreements | Record Owner-confirmed Retell/Anthropic agreements and database coverage; verify deployment configurations without re-requesting signatures. | Owner retains signed evidence and verifies remaining vendor coverage. |
| `LEGAL` | Legal and compliance | Implement counsel-approved notices, privacy, consent, BAA/DPA handling, security assessment, retention and breach processes. | Owner and counsel approve legal text, risk and compliance attestation. |
| `GOOGLE` | Google approval | Prepare OAuth scope evidence, verification instructions, redirect URIs and safe connection tests. | Owner completes provider identity verification and approval. |
| `METAAPP` | Meta approvals | Prepare app-review screencasts, permission descriptions, webhook proofs and QA evidence. | Owner submits and controls Meta business verification and review. |
| `SECURITY` | Security and recovery | Run authorization, tenant isolation, webhook forgery, secret scanning, backup restore, dependency, pentest remediation and incident drills. | Owner approves independent assessment and residual risk. |
| `LOCATIONS` | Additional clinic locations (later) | Keep phase-two work fenced; document architecture and test that v1 does not imply unsupported multi-location behavior. | Owner decides later rollout; not first-clinic blocker unless spec requires. |
| `SEO-TECH` | SEO/GEO technical foundation | Audit metadata, robots, sitemap, canonical, structured data, llms.txt, live content gating, IndexNow, health checks and production URL behavior. | Owner approves claims, editorial voice and publishing. |
| `SEO-OWNER` | SEO/GEO discovery and authority | Prepare GSC/Bing instructions, listing content, AI answer baseline, PostHog referral insight, source review, content/author assets, outreach drafts. | Owner verifies DNS/GSC/Bing, creates profiles, signs off copy, performs outreach and legal/trademark review. |
| `LAUNCH` | End-to-end go-live | Run synthetic clinic journeys across checkout, provisioning, voice, chat, Meta, booking, alerts, deposits, portal, security and outage; reconcile launch promises. | Owner authorizes deployment, confirms approvals and signs final launch attestation. |

## Wave sequence

**Wave 0 — Read-only inventory:** inspect code and tests, compare with the product spec and all open launch promises, record verified gaps, evidence and Owner blockers. Do not change product behavior.

**Wave 1 — Launch foundations:** ARCH, SECURITY, OPS, PRICE, CHECKOUT, ONBOARD. Close security and provisioning prerequisites before channel activation.

**Wave 2 — Patient-facing flows:** BOOK, VOICE, PHONE, WEBCHAT, DEPOSIT, META, SAFETY. Use synthetic data and authorized sandbox accounts; never activate live patient traffic without approval.

**Wave 3 — Clinic operations:** ALERT, RETENTION, PORTAL, REPORT, vendor-configuration checks. Validate tenant isolation, delivery and failure modes.

**Wave 4 — Public presence and approvals:** SEO-TECH, SEO-OWNER technical support, GOOGLE, METAAPP, LEGAL. Owner executes identity, account, editorial and legal decisions. SEO/GEO growth roadmap is ongoing and not automatically a first-clinic blocker.

**Wave 5 — End-to-end acceptance:** LAUNCH. Execute the full synthetic journey, reconcile `apps/web/src/lib/admin/seo/launch.ts`, verify recovery and vendor settings, produce a go/no-go report. Owner makes final production decision.

## Required technical verification

- Run `npm test -w @healdesk/web`, `npm test -w @healdesk/app`, `npm run lint`, and `npm run qa:meta` when relevant. Database-backed security tests may skip without `TEST_APP_URL`; explicitly report skips and use the appropriate isolated test environment.
- Audit SEO/GEO source: `apps/web/src/lib/admin/seo/{launch,steps,health,roadmap,store}.ts`, `apps/web/src/app/{robots,sitemap}.ts`, `apps/web/src/lib/{seo,structured-data}.ts`, `apps/web/src/app/llms.txt/route.ts`, content registry and tests, and IndexNow workflow.
- For production deployment, check `HEALDESK_APP_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_SITE_URL` and `turbo.json` build environment handling. Never expose internal origins in browser or email.
- Keep `/admin/map` accurate whenever adding or changing a tool, bridge, key or production status.
- Reconcile owner tasks in `apps/web/src/lib/admin/seo/steps.ts` without marking account verifications, listings, trademark review, press outreach, legal counsel, AI visibility baseline or editorial approvals complete on the Owner's behalf.
- Retell and Anthropic agreements, database coverage and signed evidence are **Owner-confirmed done**. Do not demand fresh signatures absent a specific uncovered scope; do independently verify the relevant production settings.

## Definition of done for every work package

- The actual source paths and requirements are identified; acceptance tests cover success, failure, security, tenant isolation and rollback where relevant.
- All applicable tests were run and results reported accurately, including skipped tests and unresolved defects.
- A reviewed code change or documented no-change verification exists, with safe evidence.
- Owner-only dependencies are identified with the exact required action, account, consequence and safe default.
- `AGENTS.md` is refreshed and the PR references the work package. **Production-ready** is not claimed until live evidence and Owner approval exist.

## Session continuity

At the start of every session read `docs/claude-session-start.md` and issue its proof-of-reading receipt. Before ending, update `AGENTS.md` and hand off the exact next approved action. On interruption, independently reconstruct state from Git and CI.

## First Claude Code assignment (requires Owner instruction)

Perform Wave 0 only: inspect the actual repository and launch-promise register, produce the verified work-package backlog with prioritized launch blockers, separate Claude Code from Owner actions, and update `AGENTS.md`. Do not deploy or change production. Present the first implementation package for Owner approval.

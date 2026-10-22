# Independent security assessment: brief for the assessor (22 October 2026)

This is a request-for-quote scope that the Owner can send to a firm. It is what the master plan's
`SECURITY` row calls the independent assessment and `docs/hipaa-compliance.md` lists as
"Penetration test / security review". The repository cannot supply one: it has to come from
someone outside the team. Claude Code has not contacted anyone and cannot commission it.

The Owner still has to choose the firm, agree the price, sign the engagement terms and set the
dates. Everything below is the material for those decisions, written so it can be sent as it is.

## 1. What is being assessed

healdesk sells one AI assistant to cash-pay elective clinics as three inbound-only channels: a
voice agent (Retell), a web chat widget on the clinic's own site, and a Meta bot (Instagram,
Facebook Messenger, WhatsApp). It books into the clinic's Google Calendar and answers from the
clinic's own configured prices and rules. It never contacts a patient first.

Two deployments, split by whether they handle patient health information:

| Part | Hosting | Handles patient data |
| --- | --- | --- |
| `apps/web`: marketing site, checkout, agreement signing, demos, and the operator console `/admin` | Vercel | No. It has no database client by design. |
| `apps/app`: every patient conversation, bookings, the clinic portal and onboarding wizard, background worker, voice endpoint | AWS `us-east-1`: ECS on Fargate behind one load balancer, RDS PostgreSQL 17, KMS, SES, Parameter Store | **Yes** (see section 5) |

`apps/web` asks `apps/app` for PHI-side data only through HMAC-signed requests (`/api/ops`).
The boundary between the two is the first thing to test.

## 2. Objectives, in priority order

1. **Tenant isolation.** One clinic must never read or write another's rows. It is enforced by
   PostgreSQL row-level security under a non-bypass runtime role (`healdesk_app`) distinct from a
   migrator role. Try to break it through every path that carries a clinic id.
2. **Authentication and authorization.** Clinics sign in with an email link, then a passkey per
   device with an authenticator-app backup, before any transcript or booking opens. Some actions
   need a step-up. The operator console uses a password and an authenticator code checked on
   Vercel. Test session handling, link replay, device recovery, step-up bypass, and any route
   reachable without them.
3. **Webhook and signed-request forgery and replay.** Meta, Retell, Stripe, Stripe Connect, SES
   and Resend webhooks; `/api/provision` and `/api/ops` (HMAC); cron endpoints; the voice
   WebSocket whose URL carries a shared secret and a clinic id.
4. **The AI layer.** Prompt injection and guardrail bypass on all three channels. The rules are
   enforced in code around the model, not in a prompt: no diagnosis, prescribing or outcome
   promises; no price outside the clinic's list; complication and urgent-symptom messages
   matched before the model and answered with a fixed escalation; the clinic's never-say list;
   no card numbers; no clinical content kept on Meta channels. Try to make the assistant break
   any of them, leak another caller's information, or book or take payment outside the fixed
   tool layer.
5. **Server-side request forgery and parsing.** The demo builds a profile from a clinic's public
   website (`/api/clinic-site`), and agreements render to PDF (`/api/agreement/pdf`).
6. **The widget.** A script on third-party sites that talks to `/api/widget/v1/<slug>/...`: origin
   binding, CORS, XSS and CSP, abuse and cost exhaustion, visitor-to-visitor leakage.
7. **Secrets and cloud configuration.** Review of the Terraform in `infra/aws` and the live
   account: IAM, security groups, KMS and envelope encryption of stored credentials, Parameter
   Store, CloudTrail, GuardDuty, TLS, the load balancer's split between the public host and the
   signed-only internal host.
8. **PHI in logs and email.** The only copy of a call transcript is a sealed outbox row emailed
   through SES with TLS required; check it, and check that no conversation text reaches logs,
   analytics or product email.
9. **Data lifecycle.** Retention purge, clinic offboarding, destruction after a restore.
10. **Software supply chain and CI.** Pinned workflow actions, secret scanning, dependency audit,
    CodeQL, the image build.

## 3. Entry points (from the code, 22 October 2026)

`apps/app` (public host `app.healdesk.io`; an internal host, `app-internal.healdesk.io`, serves only
the signed routes): `/api/auth/*`, `/api/billing/events`, `/api/calendar/google/{start,callback}`,
`/api/connect/stripe`, `/api/health`, `/api/meta/{login,callback,whatsapp}`, `/api/ops`,
`/api/provision`, `/api/reviews/verify`, `/api/webhooks/{meta,retell/<clinic>,ses,stripe-connect,<provider>/<clinic>}`,
`/api/widget/v1/<slug>/{start,message,end,contact}`, the portal and wizard pages under `/c/<slug>`,
the one-time `/connect/<token>` and `/booking/` links, and, once `enable_voice` is on in the
Terraform (it is off by default), a separate voice service on `/llm-websocket/<secret>/<clinic>`.
Ask the Owner whether it is on when the engagement starts.

`apps/web` (`healdesk.io`): `/admin` and `/api/admin/*`, `/api/checkout*`, `/api/agreement*`,
`/api/chat`, `/api/demo/*`, `/api/own-demo*`, `/api/voice-demo/*`, `/api/callback`,
`/api/contact`, `/api/clinic-site`, `/api/gate`, `/api/track`, `/api/reviews`, `/api/webhooks/{stripe,resend}`
and three cron routes under `/api/cron/`.

The assessor should treat this list as a starting point and find what is missing.

## 4. Rules of engagement

- **Synthetic data only.** The AWS host holds synthetic and seed data only and has no real
  patient traffic; keep it that way. Do not enter real personal or health information anywhere.
- **Target.** The live host in `active` mode with dedicated synthetic test clinics we create, or,
  if the assessor prefers an isolated copy, a second environment built from the same Terraform
  (`environment = "staging"`; the README notes the cost and trade-offs). Agree which in writing.
- **Out of scope:** the vendors' own systems (AWS, Retell, Anthropic, Meta, Stripe, Google,
  Vercel, Cloudflare, Resend), denial-of-service or load testing, phishing or social
  engineering of any person, and physical security.
- **Telephony:** the voice agent places no outbound calls. Test inbound calls only, to the demo
  line, with synthetic content, and agree the volume first (calls cost minutes).
- **No destructive tests** against production data or the host's configuration. Findings of
  severity high or critical are reported to the Owner the same day, not at the end.
- **Authorization:** the firm needs the Owner's written permission to test, and the Owner
  tells the vendors whose terms require notice (for example AWS's penetration-testing policy).

## 5. What PHI means here

Patient identity attached to health information: a caller's number plus the treatment they asked
about, a transcript, a booking. `docs/hipaa-compliance.md` is authoritative. Meta and Stripe never
sign a business associate agreement, so those channels are built to carry nothing clinical. Retell,
Anthropic and the database host are under agreements the Owner reports signed; no call audio is kept
by healdesk.

## 6. What we give the assessor

`CLAUDE.md` (architecture and the PHI boundary), `docs/v1-product-spec.md`,
`docs/hipaa-risk-analysis.md` (threat list T1 to T18, with what is open),
`docs/wave0-audit-2026-10-21.md` (the audit's findings, so effort is not spent rediscovering
them), `infra/aws/README.md`, read access to the repository (it is public), test clinic
accounts, and a named technical contact for the duration. The repository is public, so the
assessor can read all code; a source-assisted test is expected and preferred.

## 7. Known open items to disclose

- One high advisory in the production dependency tree, `GHSA-c475-qrg2-pj4r` (basic-ftp),
  excepted until 20 December 2026: it arrives only through the undeployed `packages/leadgen`.
- The restore drill has not been run (`docs/hipaa-risk-analysis.md` T9). See
  `docs/design/restore-drill-run-sheet-2026-10-22.md`.
- The Wave 0 audit's list of open items, which will change before the assessment starts.

## 8. Deliverables to require

- A report written for two readers: an executive summary, and findings each with a severity,
  evidence that can be reproduced, the affected file or route, and a fix. Mapped to the HIPAA
  Security Rule's evaluation requirement (45 CFR 164.308(a)(8)) where it applies.
- **One retest** of the fixed high and critical findings, included in the price.
- A short letter, on request, saying what was tested, when and with what result, that a clinic
  may be shown. It must not say "HIPAA compliant"; no assessment can, and the product's own
  copy never does.

## 9. Choosing the firm

Ask for: healthcare or HIPAA-regulated clients; experience with Next.js on a serverless and a
container host, PostgreSQL row-level security, AWS configuration review, and LLM application
testing (prompt injection, tool abuse); named testers; a fixed price for the scope above; the
retest included; the earliest start date; and their own insurance. Prefer a firm that has no
other relationship with healdesk, so the assessment is independent.

## 10. Before the engagement starts (Owner)

Decide the target (section 4), the dates, and who at healdesk is the technical contact; tell the
vendors that need notice; and finish what would otherwise be reported as already-known:
`billing-notices` on and the urgent alert verified end to end, the GitHub security settings from
the security-hygiene brief, and the restore drill.

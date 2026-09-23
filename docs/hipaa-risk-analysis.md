# HIPAA Security Rule risk analysis — 45 CFR §164.308(a)(1)(ii)(A)

**Status:** current as of 13 September 2026. **Review:** annually, and on any change
to where patient information lives (a new vendor, a new host, a new channel).
**Owner:** the Security Official named in [policies/security-official.md](./policies/security-official.md).

This is the document OCR asks a business associate for first. It is written to be
read by a clinic's compliance officer, a cyber insurer, or a regulator, and it says
what is true today — including the controls that are not finished. A risk analysis
that claims completeness is the finding.

## 1. Scope

healdesk is a **business associate** to each clinic it serves: the AI front desk
answers a clinic's calls and chats, books appointments, and reports which recovered
contacts became revenue. In doing so it creates, receives, maintains and transmits
protected health information (PHI) on the clinic's behalf.

Two systems, one boundary (see [hipaa-compliance.md](./hipaa-compliance.md)):

| System | Holds PHI? | Where it runs |
| --- | --- | --- |
| `apps/web` — the marketing site, demo and checkout | **No.** Business contact data only, in a Google Sheet (the lead register) whose column headers are tested against a patient-shaped denylist | Vercel; the lead register in the company Google account's Drive |
| `apps/app` — the product, its database and its worker | **Yes.** Everything below | The BAA host (AWS, single US region) |

This analysis covers `apps/app` and every vendor in its PHI path. It does not cover
the clinic's own systems, which the clinic controls.

## 2. Where PHI lives (the asset inventory)

| Asset | What PHI it holds | Form | Control today |
| --- | --- | --- | --- |
| Postgres (`contacts`, `conversations`, `appointments`, `transactions`, `consent_records`, `contact_attempts`, `suppressions`, `webhook_events.raw_payload`) | Caller name and number, treatment interest, outcome, appointment and payment tied to a person, consent wording, vendor payloads | Encrypted at rest (host), TLS in transit (`sslmode=verify-full` required in production) | Row-level security, forced, on every table with `clinic_id`; runtime role `NOBYPASSRLS`; BAA gate trigger refuses writes for a production clinic without a bound agreement (0004, 0031) |
| Transcripts (no audio is kept — 21 September 2026; `recording_uri` dropped in 0038) | The call's content tied to a number | Object storage referenced by URI from `conversations` | Encrypted at rest; URIs behind RLS; **the storage bucket and its key policy are not yet provisioned** (the host does not exist — task `app-production-host`) |
| Synthflow (voice agent) | Caller audio, transcript, number, outcome | Vendor workspace, US | BAA **pending**; retention in the vendor console must be set to the minimum the product needs and verified, not assumed |
| Anthropic (language model) | Chat messages; the clinic's public service information | API, US, zero-retention org separate from the marketing org | BAA **pending**; no training on inputs (contractual) |
| Cal.com (scheduling, for clinics with no system) | Booking name, number, time | Vendor, US | BAA **pending** |
| AWS (hosting, database, keys, storage) | Everything above | Single US region, `us-east-1`, account `865780386982` | BAA **accepted 22 September 2026** in AWS Artifact (account agreement). The record AWS does not keep — account, region, services, configuration — is [policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md) |
| `audit_log` | Who accessed which PHI row and when — ids only, never the PHI | Postgres | Append-only by grant; RLS; metadata scanned for PHI at write time |
| Application logs | **Must be none.** | Host log collector | Single logger with an allowlist and a scrubber; a test fails the build on any other `console.*` call; retention on the host must be set explicitly (handover "Logs") |
| Backups | Whatever the database holds | Host-managed snapshots | Encrypted with the database key; retention to be set to 35 days when the host exists; a restore is a PHI access and is audited by hand |
| Operator laptops | Nothing at rest by policy; production is reached through the ops console, never a database client with PHI in it | — | [policies/access-control.md](./policies/access-control.md) |

Things that deliberately hold **no** PHI, and the control that keeps it that way:
the queue (`pgboss` payloads are ids only, enforced by `assertNoPhiInPayload()`),
email (the product refuses to send patient information over email; reports are
aggregates and are scanned), the marketing lead register (a Google Sheet of
business contact data, its headers tested against the patient-shaped denylist;
`apps/web` has no database client), analytics (none in the product; on the site,
PostHog's US cloud, consent-gated and content-free), and every ad platform (no
integration exists and the site's browser policy blocks the connections).

## 3. Threats, likelihood, impact, and what stands in the way

Likelihood and impact are rated low / medium / high, honestly, for a one-person
company with no production tenants yet.

| # | Threat | Likelihood | Impact | Controls in place | Residual risk and plan |
| --- | --- | --- | --- | --- | --- |
| T1 | **Cross-tenant read** — one clinic's session reads another clinic's patients | Low | High | Forced RLS on every PHI table; the tenant id is set per transaction and cannot leak across pooled connections (tested); drift test demands a `clinic_id` policy on every table | The tenant id itself comes from `resolveTenantContext()`, which RLS trusts. **Untested** — a test of that function is on the list before the first production tenant |
| T2 | **PHI written before there is a legal basis** — a clinic marked production with no BAA | Low | High | Database trigger refuses the write; the only route to production is `app_mark_clinic_production()`, which requires a bound, in-effect agreement | Closed (0031). Go-live must also refuse while covered-entity status is undetermined (0032) |
| T3 | **PHI in logs** — a stack trace or a "helpful" log line carries a number or a transcript | Medium (it is the default failure mode of every codebase) | High | One logger, allowlisted fields, scrubber, build-failing test | Host-side retention and encryption are not yet configured; no error tracker by policy |
| T4 | **Vendor without an agreement** — a subprocessor processes PHI with no BAA | High today (four are pending) | High | The register at `/subprocessors` says which; **no clinic goes to production until all four are signed**; the BAA promises 15 days' notice before any addition | Owner action; tracked in the guide |
| T5 | **Vendor retains more than we need** — Synthflow or Anthropic keeps audio or prompts beyond the call; Synthflow's recording storage must be OFF, not merely short | Medium | Medium | Anthropic: zero-retention org; Synthflow: retention setting in console | Verify in each console and screenshot it; repeat on every plan change |
| T6 | **Credential compromise** — the app's database connection string or a vendor key leaks | Low | High | Secrets live in the host's secret store, never in the image or the repo; database role has minimum privilege (no DELETE on evidence tables, column-scoped UPDATE on the gate) | Rotation runbook not yet written; KMS-backed key wrapping for stored connector credentials exists (`lib/crypto`) |
| T7 | **Operator misuse** — the one person with production access reads PHI without need | Low | High | Every PHI read is audited with actor and ids in the same transaction; the ops console reads counts and ids, not contents | Sanction policy applies to the founder as to anyone; a second person must review audit logs monthly once one exists |
| T8 | **Lost or stolen laptop** | Low | Medium | No PHI at rest on laptops by policy; full-disk encryption required; sessions expire | Enforced by policy, not MDM; revisit at the second hire |
| T9 | **Ransomware / destruction of the database** | Low | High | Host snapshots, encrypted; append-only audit table | **No restore drill has been run** — task `backups-and-restore-drill`. Until then the recovery time is unknown, and that is the honest statement |
| T10 | **Unauthorised disclosure by the AI itself** — the agent reads back another caller's information or gives clinical advice | Low | High | The agent is stateless per call and cannot query other conversations; clinical questions are declined by prompt and tested adversarially in the QA gate | Guardrail QA gate is scheduled for the onboarding phase; until it runs no clinic is live |
| T11 | **Retention without end** — PHI accumulates for years and widens every breach | High (nothing deletes anything today) | Medium | — | Per-clinic retention windows and a nightly purge job (0032, `retention-purge`); single-patient erasure path |
| T12 | **Breach notification too slow** — we learn late, or tell the clinic late | Medium | High | BAA: five calendar days for a breach, five business days for an incident; the clock starts at discovery | Incident procedure is the `incident-response-and-breach-clock` task; the covered-entity determination decides whether the FTC Health Breach Notification Rule's clock also applies |
| T13 | **Email carries PHI** — a report or an agreement copy includes patient content | Low | Medium | Reports are aggregate and scanned by `assertNoPhiInReport()`; agreement copies carry the clinic's contract, not patient data; transport refuses PHI classes | Closed by design |
| T14 | **Availability** — the host or the voice vendor is down and calls are lost | Medium | Low–Medium (calls fall back to the clinic's line once forwarding is removed) | Health endpoint; terms promise remove-forwarding instructions | No on-call yet; single operator |

## 4. Accepted risks, stated plainly

- **No SOC 2, no third-party audit.** The trust page says so. Revisit when a
  PE-backed group asks.
- **A single operator.** Separation of duties does not exist at n=1. The
  compensating controls are the audit trail and the policies below, which bind the
  founder identically.
- **Vendor BAAs are the clinic's exposure until signed.** No production tenant is
  created before they are.
- **Restore time is unknown** until the drill is run.

## 5. Review

This document is re-read and re-dated: every 12 months; when a vendor is added or
replaced; when the host changes; after any security incident. The review is recorded
in [policies/training-log.md](./policies/training-log.md) under "Reviews".

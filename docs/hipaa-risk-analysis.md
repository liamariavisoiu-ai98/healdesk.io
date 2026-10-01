# HIPAA Security Rule risk analysis — 45 CFR §164.308(a)(1)(ii)(A)

**Status:** redrafted 1 October 2026 for the v1 product
([v1-product-spec.md](./v1-product-spec.md)), replacing the version of 13 September 2026.
Two of the review triggers below fired: the voice vendor was replaced (Synthflow by
Retell) and new channels were added (web chat; Instagram, Messenger and WhatsApp). The
redraft is pending the Security Official's read; the review is logged in
[policies/training-log.md](./policies/training-log.md). **Review:** annually, and on any
change to where patient information lives (a new vendor, a new host, a new channel).
**Owner:** the Security Official named in [policies/security-official.md](./policies/security-official.md).

This is the document OCR asks a business associate for first. It is written to be
read by a clinic's compliance officer, a cyber insurer, or a regulator, and it says
what is true today — including the controls that are not finished. A risk analysis
that claims completeness is the finding.

## 1. Scope

healdesk is a **business associate** to each clinic it serves: the assistant answers a
clinic's calls, website chats and Instagram, Messenger and WhatsApp messages, books into
the clinic's Google Calendar, and sends deposit links through the clinic's own payment
gateway. In doing so it creates, receives, maintains and transmits protected health
information (PHI) on the clinic's behalf. It is inbound only: it contacts no patient
first and sends nothing after a conversation ends.

Two systems, one boundary (see [hipaa-compliance.md](./hipaa-compliance.md)):

| System | Holds PHI? | Where it runs |
| --- | --- | --- |
| `apps/web` — the marketing site, demo, checkout and operator console | **No.** Business contact data only, in a Google Sheet (the lead register) whose column headers are tested against a patient-shaped denylist | Vercel; the lead register in the company Google account's Drive |
| `apps/app` — the product: the channel endpoints, the clinic portal, the database, the worker and the voice process | **Yes.** Everything below | The BAA host (AWS, `us-east-1`) |

This analysis covers `apps/app` and every vendor in its PHI path. It does not cover
the clinic's own systems, which the clinic controls, including the Google Calendar the
assistant writes to.

**Where the product stands.** No production tenant exists and `apps/app` is not
deployed. The Retell voice endpoint, the web chat widget, the Google Calendar write path,
the clinic portal and its sign-in are not built. Rows below that depend on them say so.

## 2. Where PHI lives (the asset inventory)

| Asset | What PHI it holds | Form | Control today |
| --- | --- | --- | --- |
| Postgres, v1 tables (`contacts`, `conversations`, `appointments`, `booking_requests`, `meta_booking_drafts`, `webhook_events.raw_payload`) | Caller or messager name and number, treatment asked about, preferred time, outcome, bookings and deposit status tied to a person, vendor payloads | Encrypted at rest (host), TLS in transit (`sslmode=verify-full` required in production) | Row-level security, forced, on every table with `clinic_id`; runtime role `NOBYPASSRLS`; BAA gate trigger refuses writes for a production clinic without a bound agreement (0004, 0031) |
| Postgres, tables v1 does not use | `transactions` (phase-two POS read-back); `consent_records`, `contact_attempts`, `suppressions`, `outbound_calls` (outbound machinery; v1 is inbound only) | As above | As above. Kept in the schema; nothing in v1 should write them |
| Transcripts, call and chat (no audio is kept — 21 September 2026; `recording_uri` dropped in 0038) | The conversation's content tied to a number or a name | Object storage referenced by URI from `conversations` | Encrypted at rest; URIs behind RLS; **the storage bucket and its key policy are not yet provisioned** (no host exists) |
| Clinic portal accounts, sessions and second factors; the transcript access log | Who at the clinic opened which conversation | Postgres | **Not built.** Required: magic-link sign-in, a second factor before any transcript opens, one access-log row per open, roles (owner, manager, billing contact; the billing contact never sees transcripts) |
| Web chat widget sessions | The visitor's messages, name and phone, collected before any slot is held | Postgres, via the widget API in `apps/app` | **Not built.** The widget script may be served anywhere; every request carrying a visitor's words goes to `apps/app` |
| Meta channel messages (Instagram, Messenger, WhatsApp) | Non-clinical by design: a name or handle, the service asked about, a preferred time | `meta_booking_drafts` while a request is assembled; nothing the person wrote is stored | Clinical content is to be detected at the boundary and never persisted, echoed or summarised (a pattern check exists in `packages/catalog`; the v1 adapter that applies it is not built) |
| Portal support chat | Must be none: a non-patient channel | Postgres | **Not built.** A permanent line in the input tells staff not to paste patient information; clinical content is detected and not persisted |
| Retell (voice telephony and speech) | Caller audio in transit, transcript, number | Vendor, US | BAA **pending — self-serve**. Per-agent retention set to the minimum, PII controls on, recording off, each verified by screenshot. The integration is not built |
| Anthropic (language model, every channel) | Conversation content, the clinic's public service information | API, US, a HIPAA-ready organisation separate from the marketing org | BAA **pending**; no training on inputs (contractual). Covered models require **30-day retention** and cannot run with zero data retention; disclosed to clinics in the agreement |
| The database provider | Everything in Postgres | AWS RDS (under the AWS agreement) or Neon on Scale (its own BAA) | **Not chosen.** Neon's Data API sits outside its agreement and must not touch patient data |
| The clinic's Google Calendar | The booking: a name, a service, a time | The clinic's own Google account | The clinic's agreement with Google, not ours; confirmed per clinic at onboarding. Healdesk holds the OAuth token, encrypted, in `apps/app` (not built) |
| Stripe and the clinic's payment gateway | Must be none: an amount, a generic descriptor, an opaque reference | Vendor | **No BAA on any tier.** Payment-processing carve-out only: no treatment name in the description, statement descriptor or metadata |
| Meta | Whatever a patient types, which we cannot stop | Vendor | **No BAA, ever.** Scoped non-clinical; see T15 |
| AWS (hosting, database, keys, storage, SES) | Everything above held by us | `us-east-1`, account `865780386982` | BAA **accepted 22 September 2026** in AWS Artifact (account agreement). The record AWS does not keep is [policies/aws-hipaa-account.md](./policies/aws-hipaa-account.md) |
| `audit_log` | Who accessed which PHI row and when — ids only, never the PHI | Postgres | Append-only by grant; RLS; metadata scanned for PHI at write time |
| Application logs | **Must be none.** | Host log collector | Single logger with an allowlist and a scrubber; a test fails the build on any other `console.*` call; retention on the host must be set explicitly |
| Backups | Whatever the database holds | Host-managed snapshots | Encrypted with the database key; retention to be set to 35 days when the host exists; a restore is a PHI access and is audited by hand |
| Operator laptops | Nothing at rest by policy; production is reached through the `/admin` console, which reads projections, never a database client with PHI in it | — | [policies/access-control.md](./policies/access-control.md) |

Things that deliberately hold **no** PHI, and the control that keeps it that way:
the queue (`pgboss` payloads are ids only, enforced by `assertNoPhiInPayload()`),
Resend (restricted to messages declared `phiClass: "none"`; any message that may carry
PHI goes only through SES with `TlsPolicy=REQUIRE`), the marketing lead register (a
Google Sheet of business contact data, its headers tested against the patient-shaped
denylist; `apps/web` has no database client), analytics (none in the product; on the
site, PostHog's US cloud, consent-gated and content-free), and every ad platform (no
integration exists and the site's browser policy blocks the connections). The demo
sandbox on `apps/web` talks to clinic owners, not patients; the spec requires anything
typed into it to be purged on a 7 to 14 day cycle whether or not the lead buys, which
must hold once the demo keeps transcripts.

## 3. Threats, likelihood, impact, and what stands in the way

Likelihood and impact are rated low / medium / high, honestly, for a one-person
company with no production tenants yet.

| # | Threat | Likelihood | Impact | Controls in place | Residual risk and plan |
| --- | --- | --- | --- | --- | --- |
| T1 | **Cross-tenant read** — one clinic's session reads another clinic's patients | Low | High | Forced RLS on every PHI table; the tenant id is set per transaction and cannot leak across pooled connections (tested); drift test demands a `clinic_id` policy on every table | The tenant id itself comes from `resolveTenantContext()`, which RLS trusts. **Untested** — a test of that function is on the list before the first production tenant. The portal adds a second source of tenant context (the signed-in user's membership), which needs the same test |
| T2 | **PHI written before there is a legal basis** — a clinic marked production with no BAA | Low | High | Database trigger refuses the write; the only route to production is `app_mark_clinic_production()`, which requires a bound, in-effect agreement | Closed (0031). Go-live must also refuse while covered-entity status is undetermined (0032) |
| T3 | **PHI in logs** — a stack trace or a "helpful" log line carries a number or a transcript | Medium (it is the default failure mode of every codebase) | High | One logger, allowlisted fields, scrubber, build-failing test | Host-side retention and encryption are not yet configured; no error tracker by policy |
| T4 | **Vendor without an agreement** — a subprocessor processes PHI with no BAA | High today (Retell, Anthropic and the database provider are pending) | High | The register at `/subprocessors` says which; **no clinic goes to production until all three are signed**; the BAA promises 15 days' notice before any addition | Owner action; tracked on the spec doc's Launch plan tab |
| T5 | **Vendor retains more than we need** — Retell keeps transcripts or audio, or Anthropic keeps prompts, beyond what the product needs | Medium | Medium | Anthropic's BAA-covered API requires 30-day retention and cannot use zero retention, so the window is disclosed in the clinic agreement (counsel to word it). Retell: per-agent retention at the minimum (1 day), PII redaction on and recording off | Verify each setting in the vendor console with a screenshot, per agent; repeat on every plan change |
| T6 | **Credential compromise** — the database connection string, a vendor key, or a clinic's Google, Meta or WhatsApp token leaks | Low | High | Secrets live in the host's secret store, never in the image or the repo; database role has minimum privilege (no DELETE on evidence tables, column-scoped UPDATE on the gate); KMS-backed envelope encryption for stored clinic credentials (`lib/crypto`) | Rotation runbook not yet written. Production refuses the local key wrapper, and the KMS client is not yet in the image (CLAUDE.md), so no clinic credential can be stored in production until that is fixed |
| T7 | **Operator misuse** — the one person with production access reads PHI without need | Low | High | Every PHI read is audited with actor and ids in the same transaction; the `/admin` console reads projections (configuration, scheduler state, contract metadata), never a patient row | Sanction policy applies to the founder as to anyone; a second person must review audit logs monthly once one exists |
| T8 | **Lost or stolen laptop** | Low | Medium | No PHI at rest on laptops by policy; full-disk encryption required; sessions expire | Enforced by policy, not MDM; revisit at the second hire |
| T9 | **Ransomware / destruction of the database** | Low | High | Host snapshots, encrypted; append-only audit table | **No restore drill has been run.** Until then the recovery time is unknown, and that is the honest statement |
| T10 | **Unauthorised disclosure or clinical advice by the AI itself** — the agent reads back another caller's information, or advises | Low | High | The agent is stateless per conversation and cannot query other conversations. Guardrails in code, not the prompt: complication and urgent-symptom patterns short-circuit before the model to a fixed response and escalation; prices only from the configured list; the never-say list injected on every channel; the clinic cannot edit the prompt | The shared pre-model guard is not built. A per-clinic pre-launch audit (nine cases) must pass every case before any channel answers, and re-runs on every knowledge change; not built |
| T11 | **Retention without end** — PHI accumulates for years and widens every breach | High (nothing deletes anything today) | Medium | Per-clinic retention windows and a nightly purge job (0032, `retention-purge`); single-patient erasure path | The purge ships switched off, like every job; enable it with the first live clinic |
| T12 | **Breach notification too slow** — we learn late, or tell the clinic late, including a breach reported to us by a vendor | Medium | High | BAA: five calendar days for a breach, five business days for an incident; the clock starts at discovery. Vendor notices from Retell, Anthropic, the database provider or AWS start our clock on arrival ([incident-response.md](./incident-response.md)) | The covered-entity determination decides whether the FTC Health Breach Notification Rule's clock also applies |
| T13 | **Email carries PHI** — an escalation alert, a handover request, the daily summary or a booking-request email names a patient or a treatment | Medium (the spec sends all of these) | Medium | The transport refuses any message not declared `phiClass: "none"` on Resend; anything that may carry PHI goes only via SES `healdesk-phi` with `TlsPolicy=REQUIRE`; aggregate reports are scanned by `assertNoPhiInReport()` | **Open design decision:** alerts that carry no patient detail and link into the 2FA-gated portal, or minimum PHI over SES only. Record it in hipaa-compliance.md before the alerts are built. The spec's "text" option for alerts conflicts with "no SMS in v1" |
| T14 | **Availability** — our endpoint, the host or a vendor is down and patients cannot reach the clinic | Medium | Medium | Every degradation path ends with calls forwarding to a direct clinic line that does not forward back to us: Pause AI, the allowance cap's "Stop and fall back", suspension, cancellation, and a failure of our endpoint or a vendor. Website chat becomes a contact form | The automatic fallbacks are not built; until they are, removing forwarding is manual. Health endpoint exists for the web tier and worker; the voice endpoint needs its own signal ([on-call.md](./on-call.md)) |
| T15 | **Clinical content on a channel with no BAA** — a patient types a diagnosis or a medication into Instagram, Messenger or WhatsApp | High (it will happen in the first week) | Medium | Meta channels are scoped non-clinical; clinical content is to be detected at the boundary before storage, never persisted, echoed or summarised, and the person moved to a call or the clinic's secure route. Treatment names never appear in a Meta message | The boundary detector for v1 is not built. What Meta itself retains from the patient's own message is outside our control and is why the scoping is by design and by contract |
| T16 | **Transcript exposure through the portal** — a clinic account is taken over, or the wrong role reads transcripts | Medium | High | Second factor before any transcript opens; one access-log row per open; the billing contact role never sees transcripts; magic links, not emailed credentials | Not built. Dunning goes to owner and billing contact, never the clinic's public inbox, which the assistant may itself be answering |
| T17 | **Staff paste patient details into the portal support chat** | Medium | Low–Medium | A permanent line in the input; clinical content detected and not persisted; the chat is retained as a non-patient channel | Not built |
| T18 | **A booking lands where it should not** — a double booking, or an event written to the wrong calendar | Low | Medium | Idempotent writes; 60-second slot holds before anything confirming is said; manual booking mode for clinics whose system does not read Google for conflicts (Mindbody, Boulevard until confirmed); a token-expiry watch flips the clinic to manual booking mode | Not built. The calendar is chosen by the clinic in the wizard and changeable only by the clinic |

## 4. Accepted risks, stated plainly

- **No SOC 2, no third-party audit.** The trust page says so. Revisit when a
  PE-backed group asks.
- **A single operator.** Separation of duties does not exist at n=1. The
  compensating controls are the audit trail and the policies below, which bind the
  founder identically.
- **Meta and Stripe sign no BAA and never will.** Handled by scoping, not paperwork:
  nothing clinical on Meta, nothing but an amount, a generic descriptor and a reference
  on Stripe or the clinic's gateway.
- **Anthropic's 30-day retention** contradicts minimum retention everywhere else. Both
  are true at once; the clinic agreement says so.
- **Vendor BAAs are the clinic's exposure until signed.** No production tenant is
  created before they are.
- **Restore time is unknown** until the drill is run.

## 5. Review

This document is re-read and re-dated: every 12 months; when a vendor is added or
replaced; when the host changes; when a channel is added; after any security incident.
The review is recorded in [policies/training-log.md](./policies/training-log.md) under
"Reviews".

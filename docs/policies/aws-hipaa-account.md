# AWS HIPAA Account record — §164.308(b) and §164.316(b)

**Effective:** 22 September 2026. **Applies to:** the AWS account designated
under the AWS Business Associate Addendum, and everything in it.

## Purpose

AWS records only the acceptance: the agreement's state and effective-start
timestamp (`aws artifact list-customer-agreements`). Which region, which
services hold PHI, how they are configured and who accepted are the customer's
to keep (§1, §4.1–4.3). This page is that record: what a reviewer, an insurer
or OCR sees beside the Artifact entry, the source for the AWS row of the
[risk analysis](../hipaa-risk-analysis.md) and of `/subprocessors`, and the
checklist the first build and every quarterly review are measured against.

## The record

| Item | Record |
| --- | --- |
| Entity bound | Viixi FZC, a UAE free zone company, trading as healdesk |
| Account | `865780386982`, account name `healdesk.io`, supplied by the owner on 23 September 2026. Not in the PDF; readable in the console under Security credentials → Account details, or with `aws sts get-caller-identity --query Account --output text` |
| Region | `us-east-1`, confirmed by the owner on 23 September 2026. The addendum is account-scoped and silent on regions; the code assumes this one. The KMS key must be the full ARN of a single-region key in it, and while KMS holds the key an `AWS_REGION` naming any other region is refused (`apps/app/src/lib/crypto/kms.ts`); SES falls back to it when `AWS_REGION` is unset or empty (`sesClientConfig()` in `apps/app/src/lib/reporting/deliver.ts`) |
| Addendum | AWS Business Associate Addendum (Online), Doc #3256920v3, form dated 20 January 2023, four pages; an addendum to the AWS Customer Agreement |
| Agreement type | Account agreement in AWS Artifact. If the account ever joins an Organization, that Organization's BAA controls instead (§8) |
| Effective date | 22 September 2026, the day the accept button was clicked, per the owner. The PDF prints no acceptance date; confirm against the `effectiveStart` timestamp |
| Accepted by | [founder's legal name — fill in], Founder and sole operator, for Viixi FZC. AWS records no name |
| Evidence filed | The executed download (MD5 `596d7ae079b99bec8727215d17091fb6`, byte-identical to the blank form) and the Artifact **Active** screenshot **[not yet taken]**, in the Security Official's compliance file at [location — fill in]. The PDF stays out of the repository: §7 makes its terms AWS Confidential Information |
| Custodian | The [Security Official](./security-official.md) |
| Runs in it today | Nothing. No infrastructure is provisioned; `apps/app` runs on local Docker Postgres with synthetic data |

## Services designated for PHI

Eligibility per the [HIPAA Eligible Services Reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/),
last updated 3 September 2026, checked 22 September 2026. The build tasks
behind each line are in the handover under "Once AWS lands".

| Service | Use | PHI | Configuration that makes it compliant |
| --- | --- | --- | --- |
| Amazon RDS for PostgreSQL | The product database, if RDS is chosen. The spec recommends RDS under this agreement or Neon on its Scale plan under Neon's own BAA; the choice is not made. If Neon is chosen, remove this row and record Neon in the risk analysis | Yes | Encrypted with our KMS key at creation; TLS forced; the certificate validated in production (`apps/app/src/db/index.ts`) |
| AWS KMS | The key behind stored credentials, RDS, S3, logs and the trail | Keys only | One customer-managed key; production refuses the local wrapper (`lib/crypto/kms.ts`) |
| Amazon SES | Any message classed `may-carry-phi`; none exists yet, today's mail is PHI-free and goes over Resend. The v1 urgent alerts and handover requests either carry no patient detail and link into the portal, or carry the minimum and go only through here; never through Resend (decision open, [hipaa-compliance.md](../hipaa-compliance.md)) | Designated | Configuration set `healdesk-phi` with `TlsPolicy=REQUIRE`; the transport refuses to send otherwise (`lib/reporting/deliver.ts`) |
| Amazon S3 | Transcript objects, referenced by URI from Postgres; none exist yet. No call audio is kept | Yes | SSE-KMS with our key; TLS-only policy; Block Public Access; lifecycle tied to the clinic's retention |
| Amazon ECS on AWS Fargate ("ECS and EKS engines only") | The web tier, the worker and the Retell voice endpoint (a long-lived WebSocket process, not built yet), all from one image | In memory and in transit | Secrets from the host's store, never the image; a task role holding only the KMS, SES and S3 permissions |
| Elastic Load Balancing | TLS termination in front of the web tier and the voice endpoint's WebSocket | In transit | HTTPS listener, HTTP redirected |
| AWS CloudTrail | Every KMS operation and management call; S3 data events for the PHI bucket | No | On, kept, encrypted with our key, log-file validation |
| Amazon CloudWatch Logs | stdout of both tasks, from the allowlisted, scrubbing logger (`lib/log.ts`) | No | Encrypted with our key; retention "Never expire" (§4.2(c)) |

**Never for PHI:** anything outside this table (§4.2(a)) and any other AWS
account (§1 and §3.1 leave every other account uncovered). AWS App Runner is
not on the list; ECS on Fargate replaces it. No patient identifier goes in a
resource name, key or tag: those land in CloudTrail and billing outside our key.

## Our obligations under §4

| Addendum | Obligation | Status |
| --- | --- | --- |
| §4.1 | Identify the account by accepting from inside it | Done 22 September 2026; account `865780386982`; the Active screenshot is outstanding |
| §4.2(a) | PHI only in eligible services | The table above is the whole list; `apps/app` is the only PHI side |
| §4.2(b) | The highest level of audit logging | Outstanding: CloudTrail, with the first RDS instance |
| §4.2(c) | Maximum retention of logs | Outstanding: trail kept indefinitely, log groups never expire; on AWS this supersedes any shorter log retention |
| §4.3.1 | Encrypt all PHI at rest and in transit per HHS guidance | In code: TLS to Postgres validated in production, SES refuses without TLS, credentials envelope-encrypted. Outstanding: every configuration above |
| §4.4 | Consents obtained before PHI is placed | No real patient data until every PHI vendor has a BAA (Retell, Anthropic and the database provider pending; Neon only if chosen) and the clinic has signed ours; the database's BAA gate refuses writes without one |
| §4.5–4.6 | Nothing that makes AWS breach the addendum or HIPAA | The clinic BAA directs nothing at AWS; counsel checks each revision |

## What AWS commits to

Reports of impermissible uses it becomes aware of (§3.4.1), of successful
security incidents at least quarterly (§3.4.2), and of a breach of unsecured
PHI within 60 days of its discovery (§3.4.3), without saying which individuals
or data were affected (§3.4, §3.8): that mapping is ours, from `audit_log`.
At least six months' notice before a service leaves the list, less under the
§1 carve-outs; 90 days if AWS terminates (§5.2). Notices go to the account's
contact addresses: [confirm they reach the Security Official]. Our clinic BAA
promises notice within five calendar days of our discovery
(`packages/catalog/src/baa.ts`); §6 makes neither party the other's agent, so
those days start when AWS's report arrives or when our own monitoring should
have caught it, whichever is earlier. Whether AWS is our agent under §164.410
is a question for counsel.

## Boundaries, term and confidentiality

Coverage attaches to this account only (§1, §3.1); a second account needs its
own acceptance or an Organizations BAA. Either party may terminate (§5.2):
ours is a button in Artifact that only the Security Official presses, never
while PHI is in the account, because AWS keeps residual PHI protected rather
than destroyed (§5.3). A new version binds nothing until accepted (§9). §7
makes the terms confidential: a clinic, reviewer or insurer gets the fact, the
date, the Active screenshot and this record, never the PDF or its clauses.

## Review and change control

1. **Before any service is added,** the Security Official re-reads the
   Reference that day and records its date and the required configuration here.
2. **Every quarter,** with the access review in
   [access-control.md](./access-control.md) rule 6: re-check the list, the
   account, the region and the AWS Config findings; log a Reviews row in
   [training-log.md](./training-log.md).
3. **Leaving a service or AWS:** a removal notice starts the move inside the
   notice period; replacing AWS is a new subprocessor with the clinic BAA's
   fifteen days' notice; PHI is deleted first, the addendum terminated last.

Signed off by the Security Official: [founder's legal name — fill in], for
Viixi FZC, on [date — fill in]. Next review by 22 December 2026. Every version
is kept six years from the later of its creation and its last day in effect
(§164.316(b)(2)); git history is the record.

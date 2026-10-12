# AWS HIPAA Account record — §164.308(b) and §164.316(b)

**Effective:** 22 September 2026. **Applies to:** the AWS account designated
under the AWS Business Associate Addendum, and everything in it.

## Purpose

AWS records only the acceptance: the agreement's state and effective-start
timestamp (`aws artifact list-customer-agreements`). Which region, which
services hold PHI, how they are configured and who accepted are the customer's
to keep (§1, §4.1–4.3). This page is that record: what a reviewer, an insurer
or OCR sees beside the Artifact entry, the source for the AWS row of the
[risk analysis](../hipaa-risk-analysis.md) and of the subprocessor register in
[hipaa-compliance.md](../hipaa-compliance.md), which a signed clinic is given on
request, and the checklist the first build and every quarterly review are
measured against.

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
| Runs in it today | Nothing yet. The host is defined in `infra/aws` and **not yet applied (12 October 2026)**: Terraform, a CloudFormation bootstrap stack and two GitHub workflows describe ECS on Fargate behind a load balancer at `app.healdesk.io`, RDS for PostgreSQL, one KMS key, Parameter Store, CloudTrail, Config, GuardDuty, WAF and alarms ([runbook](../../infra/aws/README.md)). No resource exists until the owner launches the bootstrap stack and runs `infra.yml`; until then `apps/app` runs on local Docker Postgres with synthetic data |

## Services designated for PHI

Eligibility per the [HIPAA Eligible Services Reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/),
last updated 3 September 2026: checked 22 September 2026 for the first eight
services, and on 7 October 2026, before anything was applied, for the services
the `infra/aws` build adds. Every service below is listed on it by name except
AWS Budgets, marked in its row. The Security Official confirms the added rows
against the Reference on the day of the first apply (rule 1 below). The build
is written as code in `infra/aws` and **not yet applied (12 October 2026)**;
the [runbook](../../infra/aws/README.md) has the detail, and the handover's
"Once AWS lands" marks what it covers and what is still open.

| Service | Use | PHI | Configuration that makes it compliant |
| --- | --- | --- | --- |
| Amazon RDS for PostgreSQL | The product database: one instance, `healdesk-production`, PostgreSQL 17. Chosen by the owner on 7 October 2026 (RDS under this addendum, not Neon), defined in `infra/aws/rds.tf` | Yes | Encrypted with our KMS key at creation; `rds.force_ssl=1` and TLS 1.2 minimum; production refuses a `DATABASE_URL` without `sslmode=verify-full`, and the image carries the RDS CA bundle (`apps/app/src/lib/env.ts`, `apps/app/Dockerfile`); private subnets, port 5432 from the ECS tasks only; 35-day automated backups and no snapshot kept longer (no final snapshot on deletion); the master password managed by RDS and used only to create the two roles, which receive SCRAM verifiers, never passwords |
| AWS KMS | The key behind stored credentials, RDS, the parameters, ECR, logs and the trail (`alias/healdesk-production`); a second key, `alias/healdesk-terraform-state`, only for the Terraform state bucket and the one CI parameter | Keys only | Customer-managed, single-region, automatic rotation, never replaced; production refuses the local wrapper (`lib/crypto/kms.ts`); the app's task role may only generate, decrypt and encrypt data keys as its own calls, and only with the two lock labels (`healdesk:clinic`, `healdesk:login`) and no other key in the encryption context, so it cannot decrypt what AWS services stored under the same key; the key policy names that role in no statement |
| Amazon ECS on AWS Fargate ("ECS and EKS engines only") | The web tier (with an nginx sidecar that re-encrypts the load balancer's traffic), the worker, and one-off tasks (migrations, role creation, the after-restore destruction check and the offboarding export), all from one image; the Retell voice endpoint (a long-lived WebSocket process) is not built yet | In memory and in transit | Private subnets, no public address, no ECS Exec; secrets from Parameter Store and the RDS master secret at task start, never the image, a task definition's environment or a run-task override; the app's task role holds only the KMS permissions above (S3 and SES when they are switched on); the role-creation task's role may read and write its six internal parameters and nothing else; the export task's role may put a clinic's return bundle in the export bucket and nothing else |
| Elastic Load Balancing | TLS termination for `app.healdesk.io` and `app-internal.healdesk.io` (apps/web's signed calls only) in front of the web tier, re-encrypted to the task; later the voice endpoint's WebSocket | In transit | HTTPS listener with one ACM certificate for both names and the TLS 1.3/1.2 policy `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`; HTTP redirected; invalid header fields dropped; the internal name serves only the signed routes and the public one refuses them; no access logs, because their bucket cannot use our key and URLs carry no PHI |
| AWS CloudTrail | Every management call, reads included, so every KMS operation; every read and write of an export-bucket object, and of a transcript object once that bucket is on, as S3 data events | No | One multi-region trail, log-file validation, encrypted with our key, in its own private bucket kept indefinitely |
| Amazon CloudWatch Logs | stdout of every task (web, worker, migrations, role creation, the TLS sidecar), from the allowlisted, scrubbing logger (`lib/log.ts`), and the Postgres engine log | No | Every group created first, with our key and retention "Never expire" (§4.2(c)). The engine log is terse (no DETAIL or CONTEXT lines), logs no statement as it runs, and keeps the text of a failing statement out (`log_min_error_statement=panic`), so a failed statement carrying a password or row values is logged by its ERROR line alone. What can remain is a primary error message that quotes its own input (an invalid uuid, say); the app's queries are parameterised |
| AWS Systems Manager (Parameter Store only) | Every application secret and both database URLs, as SecureString parameters under `/healdesk/production/`; and `/healdesk/production/ci/CLOUDFLARE_API_TOKEN`, which only the deploy pipeline's Terraform role reads | No (credentials to systems that hold it) | Encrypted with our key (the CI token with the state key); created by Terraform holding a placeholder, with no value ever in its state; the internal values generated inside AWS by the role-creation task, the vendor keys pasted by the owner in CloudShell through a script that never puts a value on a command line; read by the ECS agent at task start through the execution role (`app/` and `migrator/` paths only) |
| AWS Secrets Manager | The RDS master credentials only, managed and rotated every seven days by RDS | No | Encrypted with our key. Readable by the ECS execution role, whose only task definition that references it is the role-creation task's, and by the account's administrators: the Terraform role and the owner's IAM user, both AdministratorAccess. The deploy role reads no secret directly, but a task definition it registers and runs receives what that definition names, so it is as powerful as the code it deploys; its trust policy's pin to main, run by the owner, is the control. The app never uses this secret |
| Amazon Elastic Container Registry (ECR) | The three images (`healdesk/app`, `healdesk/db-admin`, `healdesk/tls-proxy`), tagged with the git commit | No | Immutable tags, scan on push, encrypted with our key, last 30 images kept |
| Amazon Virtual Private Cloud (VPC) | One VPC over two zones: the load balancer and one NAT gateway in public subnets, the tasks and RDS in private subnets; no VPC endpoints in the lean default | In transit | NAT gateways and endpoints are features of Amazon VPC, and what crosses them is the app's own TLS; the default security group stripped of rules; the database reachable only from the tasks; flow logs off by default and, when on, to an encrypted, never-expiring group |
| AWS Certificate Manager | The public certificate for `app.healdesk.io` and `app-internal.healdesk.io` | No | DNS-validated through DNS-only Cloudflare records, which stay for renewal |
| AWS Web Application Firewall (WAF) | A per-address rate limit on the load balancer, answering 429 | In transit | Counts requests by source address only; no managed rule groups, no sampled requests and no WAF logging, because samples and logs would store request headers |
| Amazon GuardDuty | Threat detection over CloudTrail, VPC flow and DNS logs, which AWS reads without us storing them | No | One detector; Runtime Monitoring off; findings read in the console |
| AWS Config | Records resource configuration and checks `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled` and `cloudwatch-log-group-encrypted` | No | Its own private, TLS-only bucket; findings read each quarter (rule 2 below) |
| Amazon Simple Notification Service (SNS) | The alarm topic `healdesk-production-alarms`, emailed to one address | No | Messages carry metric names, counts and thresholds only. The topic is not under our key, which is acceptable only because nothing in it may ever be PHI |
| AWS Budgets | One monthly cost alert | No | **Not on the Reference.** It sees cost figures only, and nothing may put PHI in it |
| AWS CloudFormation | The one-off bootstrap stack: the Terraform state bucket and its key, GitHub's sign-in provider and the role Terraform runs as | No | Refuses to launch outside this account and `us-east-1` |
| AWS CloudShell | The administrator's terminal in the console, for the one-off commands in the runbook and the owner's guide | No | Signed in as the administrator's own IAM user; never used to read patient data |
| Amazon S3 | **The export bucket, on:** a leaving clinic's return bundle, one object per export, written by the patient-export task, downloaded by an administrator in CloudShell, deleted after the handover and in any case after 7 days. **Transcripts, behind a flag, off:** transcript objects, referenced by URI from Postgres; none exist yet, and `enable_transcript_bucket` is false. No call audio is kept. Three buckets that hold no PHI are on: the Terraform state (bootstrap stack), the CloudTrail trail and AWS Config's snapshots | Yes (exports; transcripts); No (the other three) | Exports: SSE-KMS with our key and bucket keys; TLS-only policy refusing uploads under any other encryption; Block Public Access; not versioned, so a delete is final; objects expire after 7 days; CloudTrail data events. Transcripts, when switched on: SSE-KMS with our key and bucket keys; TLS-only policy; Block Public Access; versioned, superseded versions gone within 7 days; objects expiring at the longest clinic retention; CloudTrail data events. The other three: TLS-only, Block Public Access, versioned; the trail's under our key and never expiring, the state's under its own key, Config's under S3-managed keys |
| Amazon SES | **Behind a flag, off.** Any message classed `may-carry-phi`; none exists yet, today's mail is PHI-free and goes over Resend. The v1 urgent alerts and handover requests either carry no patient detail and link into the portal, or carry the minimum and go only through here; never through Resend (decision open, [hipaa-compliance.md](../hipaa-compliance.md)) | Designated | When switched on (`enable_ses`): configuration set `healdesk-production-phi` with `TlsPolicy=REQUIRE`, and the transport refuses to send otherwise (`lib/reporting/deliver.ts`); the account must also leave the SES sandbox |

**Never for PHI:** anything outside this table (§4.2(a)) and any other AWS
account (§1 and §3.1 leave every other account uncovered). AWS App Runner is
not on the list; ECS on Fargate replaces it. IAM and STS, which hold the roles,
the policies and GitHub's sign-in, are the account's control plane and are not
on the list either; nothing in them may name a patient. No patient identifier
goes in a resource name, key or tag: those land in CloudTrail and billing
outside our key.

## Our obligations under §4

| Addendum | Obligation | Status |
| --- | --- | --- |
| §4.1 | Identify the account by accepting from inside it | Done 22 September 2026; account `865780386982`; the Active screenshot is outstanding |
| §4.2(a) | PHI only in eligible services | The table above is the whole list; `apps/app` is the only PHI side |
| §4.2(b) | The highest level of audit logging | Outstanding until applied. Defined in `infra/aws/cloudtrail.tf`: one multi-region trail of management reads and writes, KMS events included, validated, under our key. Data events wait for the transcript bucket |
| §4.2(c) | Maximum retention of logs | Outstanding until applied. Defined: every log group "Never expire" (`infra/aws/logs.tf`), the trail bucket without expiry; on AWS this supersedes any shorter log retention |
| §4.3.1 | Encrypt all PHI at rest and in transit per HHS guidance | In code: TLS to Postgres verified in production (`verify-full` with the RDS CA; anything less refused), SES refuses without TLS, credentials envelope-encrypted. Defined in `infra/aws`, outstanding until applied: the database, its backups, the parameters, the images, the logs and the trail under our key; TLS 1.2 or later at the load balancer and the database; the load balancer's traffic re-encrypted to the task |
| §4.4 | Consents obtained before PHI is placed | No real patient data until every PHI vendor has a BAA (Retell and Anthropic pending; the database is RDS, under this addendum) and the clinic has signed ours; the database's BAA gate refuses writes without one |
| §4.5–4.6 | Nothing that makes AWS breach the addendum or HIPAA | The clinic BAA directs nothing at AWS; counsel checks each revision |

## What AWS commits to

Reports of impermissible uses it becomes aware of (§3.4.1), of successful
security incidents at least quarterly (§3.4.2), and of a breach of unsecured
PHI within 60 days of its discovery (§3.4.3), without saying which individuals
or data were affected (§3.4, §3.8): that mapping is ours, from `audit_log`.
At least six months' notice before a service leaves the list, less under the
§1 carve-outs; 90 days if AWS terminates (§5.2). Notices go to the account's
contact addresses: [confirm they reach the Security Official]. Our clinic BAA
(1.2.2, `packages/catalog/src/baa.ts`) promises notice without unreasonable
delay and in no case later than 60 calendar days after our discovery, and we
work to 24 hours internally ([incident-response.md](../incident-response.md));
§6 makes neither party the other's agent, so both clocks start when AWS's
report arrives or when our own monitoring should have caught it, whichever is
earlier. AWS's own §3.4.3 window is also 60 days from its discovery, so a
report that arrives late in it leaves us little or none of ours: we act on it
the day it arrives. Whether AWS is our agent under §164.410 is a question for
counsel.

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

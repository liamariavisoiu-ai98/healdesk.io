# infra/aws: the product host

`apps/app`, the PHI side of healdesk, runs on AWS in the one account designated under the AWS
Business Associate Addendum: account `865780386982`, region `us-east-1`
([docs/policies/aws-hipaa-account.md](../../docs/policies/aws-hipaa-account.md)). This directory
is that host written down as code: a Terraform root module, a CloudFormation bootstrap stack, two
helper images, four terminal scripts, and the three workflows that switch, apply and deploy it
(`.github/workflows/host.yml`, `.github/workflows/infra.yml`, `.github/workflows/deploy-app.yml`).
The website (`apps/web`, including `/admin`) stays on Vercel. healdesk.io's DNS stays at
Cloudflare.

**Status, 14 October 2026: applied and deployed.** `infra.yml` applied the module for the first
time on 14 October (the third attempt fixed what AWS and Cloudflare refused on the first two, and a
second apply followed), and `deploy-app.yml` then deployed three times that day, the first with
db-bootstrap. Checked live on 14 October: `https://app.healdesk.io/api/health` answers `ok` with
the database `ok` and a worker heartbeat minutes old. The standby switch ("Standby", below) and
`host.yml` are new on the same day; this status does not record a run of either against AWS. What
has been checked locally: `terraform fmt`,
`init -lockfile=readonly`, `validate` and `test` (39 runs against mocked providers in
`tests/stack.tftest.hcl` and `tests/restore.tftest.hcl`), actionlint with shellcheck, the plan
guard against fixture plans, and `host-apply.sh` against fake `aws` and `terraform` commands; tflint,
checkov and cfn-lint were run on the module before the standby change, not since. Until every link
of the BAA chain is in place ("What still blocks real patient data", below), the host takes
synthetic data only, like every other copy of `apps/app`.

This file is the engineer's runbook. The owner's step-by-step guide is a separate document written
from it.

---

## The request paths

```
 clinic browser, Stripe, Meta, Google ─┐
                                       │ DNS: Cloudflare answers app.healdesk.io with a CNAME to
                                       │ the load balancer. DNS only (grey cloud): no traffic
                                       │ passes through Cloudflare.
                                       ▼
 apps/web on Vercel ──HTTPS, HMAC-signed──► app-internal.healdesk.io (DNS-only CNAME, same ALB)
                                       │
                                       ▼
            ALB healdesk-production (public subnets, two AZs)
               443: one ACM certificate for both names, TLS 1.3/1.2 policy
                    rules by Host and path:
                      app-internal + a signed path  → forward
                      app-internal + anything else  → 404 from the ALB
                      app + a signed path           → 404 from the ALB
                      app + /llm-websocket/*        → forward to voice (enable_voice)
                      app + anything else           → forward
                      any other Host                → 404 from the ALB
               80:  301 to HTTPS
               WAF (enable_waf, off in the lean profile): per-IP rate limit, answers 429
                                       │ HTTPS to 8443, re-encrypted (self-signed certificate,
                                       │ not validated by the ALB; the hop is encrypted)
                                       ▼
     ECS task healdesk-production-web (private subnets, no public IP; ARM64)
        tls-proxy (nginx, 8443) ──HTTP 127.0.0.1:3001──► app (Next standalone server)
        worker (the same image, src/workers/index.ts; no port, no inbound traffic)
                                       │
                                       ├─ Postgres over TLS, verify-full ──► RDS healdesk-production
                                       └─ HTTPS out through the NAT instance ──► Stripe, Meta,
                                          Anthropic, Resend, Google; KMS, SSM, ECR, CloudWatch Logs,
                                          SES (the emailed transcripts)

 worker_placement = "separate" moves the worker to its own service, healdesk-production-worker,
 as first built; nat_mode = "gateway" puts NAT gateways back in place of the instance

 enable_voice adds ECS service healdesk-production-voice beside it: the same tls-proxy on 8443
 in front of the voice process (src/voice/server.ts, HTTP and WebSocket on 3001), behind its own
 target group, reached by Retell at wss://app.healdesk.io/llm-websocket/<secret>/<clinic id>
```

The signed routes are every `apps/app` path `apps/web` calls on `HEALDESK_APP_URL`, each
authenticated by an HMAC over the body with `HEALDESK_PROVISION_SECRET` (all POST):
`/api/provision`, `/api/billing/events`, `/api/ops` and `/api/reviews/verify` (signing, the
agreement's PDF and Pay moved to apps/web on 14 October 2026 and no longer call the host). They
are listed once, in `locals.tf` (`signed_paths`, with each
call site), and `alb.tf` builds both sets of rules from that list. **A new signed route must be
added there**, or `apps/web`'s calls to it get the internal host's 404.

Why each piece is shaped the way it is:

- **DNS only at Cloudflare.** A proxied ("orange cloud") record would make Cloudflare terminate
  TLS, so every patient message, transcript fetch, signed call and voice socket would be
  decrypted on a network with no BAA in the chain. `dns.tf` writes every record with a literal
  `proxied = false`, and the next apply flips back any record someone proxies in the dashboard.
- **Two names, one load balancer.** `app.healdesk.io` is `BETTER_AUTH_URL`: browsers, Stripe,
  Meta, Google and every link a clinic is mailed. `app-internal.healdesk.io`
  (`internal_hostname`) is `HEALDESK_APP_URL`, on Vercel and on this host's own tasks. They must
  differ: `apps/app` refuses to mail any link to `HEALDESK_APP_URL` (`lib/email/lint.ts`), so one
  origin for both would refuse every portal email. ACM cannot issue for the balancer's own
  `*.elb.amazonaws.com` name, so the TLS origin Vercel calls needs a name of ours. And a separate
  host lets the ALB keep the server-to-server routes off the origin every browser uses, and makes
  a leak of the internal name into a browser detectable.
- **Encrypted all the way to the app.** Clinics' BAA (1.2.1, 1.2.2 and 1.3.0) promises encryption
  wherever healdesk controls both ends, which includes the load balancer to the task, and 1.3.0
  makes it a release gate. Next's standalone server speaks plain HTTP, so the web task runs the
  `tls-proxy` sidecar: a fresh key and self-signed certificate at every start, written under
  `/tmp/tls-proxy` and never in the image, listening on 8443 and handing each request to the app on
  loopback, WebSocket upgrades included. `alb_to_task_tls = false` removes it and targets
  HTTP:3001; leave it on.
- **Vercel reaches the host over the internet.** Vercel has no private path into the VPC and no
  fixed egress addresses, so the load balancer is internet-facing and nothing can be allowlisted.
  The HMAC is the access control: `HEALDESK_PROVISION_SECRET` must be byte-identical on both
  sides, and the two clocks within five minutes.
- **429, never 403, and never a 4xx on a signed path from the ALB.** `apps/web`'s Stripe relay
  retries 401, 429 and 5xx and treats any other 4xx as final: it acknowledges the event to Stripe
  and drops it, leaving a paid customer without an account. So the WAF rule answers 429 with
  `Retry-After: 60`, a signed path on the internal host is always forwarded, and there are no AWS
  managed rule groups (the Core rule set blocks bodies over 8 KB; relayed Stripe events reach 1 MB
  and checkout intents 256 kB). This is also why a `HEALDESK_APP_URL` naming the public host is
  worse than an unset one: every signed call gets the ALB's 404.
- **The client's address.** The ALB appends the connecting address to `X-Forwarded-For`
  (`xff_header_processing_mode = "append"`), the sidecar passes the header through unchanged, and
  `apps/app/src/lib/client-ip.ts` takes the last entry, the one the ALB appended
  (`TRUSTED_PROXY_HOPS = 1`), never the first, which the browser writes. The signed routes read
  the first, which `apps/web` writes. Adding a proxy hop in front means changing that constant.

---

## What is here, and why

| File | What it holds | Why |
| --- | --- | --- |
| `versions.tf`, `providers.tf`, `.terraform.lock.hcl` | Terraform `~> 1.16`; aws `~> 6.67`, cloudflare `~> 5.27`, locked with hashes for linux and macOS on both architectures; no random provider. The aws provider refuses any account but `865780386982`; default tags `Project`, `Environment`, `ManagedBy` | No other account is covered by the BAA. Nothing here generates a secret, so a `random_password` added later fails the read-only inits until someone adds the provider on purpose. The Cloudflare token comes from the `CLOUDFLARE_API_TOKEN` environment variable, never a Terraform variable, so it is never written into a saved plan |
| `backend.tf` | S3 backend, key `healdesk/production/terraform.tfstate`, native locking (`use_lockfile`); bucket and KMS key passed with `-backend-config` | The state holds no secret value (below) but maps the whole account, so it lives in the bootstrap stack's private, versioned, KMS-encrypted bucket |
| `variables.tf`, `locals.tf`, `production.tfvars` | Every setting, with validation (region pinned, environment 2 to 12 characters, the two hostnames under healdesk.io and different, exact main-branch OIDC subjects, Fargate sizes for web and voice, `app_environment` refusing secrets, the stack's own names and the two counsel-gated switches); the per-task environment and secret maps; the signed paths; the never-set list | `production.tfvars` holds nothing secret and nothing personal. `alarm_email`, `healdesk_admin_email`, `healdesk_ops_email` and `cloudflare_zone_id` come from GitHub repository variables as `TF_VAR_*`, so they stay out of git |
| `network.tf` | VPC `10.40.0.0/16` over us-east-1a and 1b; public subnets for the ALB and the way out; private subnets for tasks and RDS, routed to the NAT instance (`nat_mode = "instance"`) or to `nat_gateways` NAT gateways (`"gateway"`); default security group stripped; flow logs and VPC endpoints behind variables, both off | The tasks call vendors on the internet, so NAT is needed whatever else is chosen. Endpoints only take AWS API traffic off the NAT |
| `nat.tf`, `templates/nat-instance.sh.tftpl` | The NAT instance: one `t4g.nano` (`nat_instance_type`) on the newest minimal Amazon Linux 2023 arm64 image, in the first public subnet with its own public address; source/destination check off; security group admitting 443 from the tasks only and sending 443 only; nftables forwarding new connections to 443 from the VPC and dropping everything else; IMDSv2 only, no key pair, no instance role, standard CPU credits, an encrypted root volume, automatic recovery; `dnf-automatic` security updates; alarm `nat-instance-status` | About $7 a month against about $37 for a NAT gateway, for the same job: only the app's own TLS crosses it. See "The NAT instance" below |
| `kms.tf` | One customer-managed key, `alias/healdesk-production`: symmetric, single-region, rotating, `prevent_destroy`. Key policy: account root (delegating to IAM), CloudWatch Logs for this account's log groups, CloudTrail for this trail by `aws:SourceArn` | It encrypts the credential vault (`HEALDESK_KMS_KEY_ID`), RDS storage, the master secret, Performance Insights, every SSM parameter, ECR, every log group and the trail. The app pins its ARN, so it is never replaced. The key policy names the app's task role nowhere, and must never: a statement naming it without the lock-label conditions would make them moot |
| `rds.tf` | PostgreSQL 17.11 on `db.t4g.micro` (`db_instance_class`), 20 GiB gp3, encrypted with the key, single-AZ (`db_multi_az`), private, 5432 from the tasks' security group only; 35-day backups, no final snapshot (but standby's), deletion protection (`deletion_protection`, off only for standby's first apply), no `prevent_destroy` (the plan guard instead: "Standby"); created from a standby snapshot when `restore_snapshot_identifier` names one, which it then ignores; master user `healdesk_admin` with an RDS-managed password; database `healdesk`; CA `rds-ca-rsa2048-g1`; `postgresql` log exported; Database Insights standard (free), Performance Insights under the key for 7 days. Parameter group `healdesk-production-postgres17`: `rds.force_ssl=1`, TLS 1.2 minimum, SCRAM, `log_error_verbosity=terse`, `log_statement=none`, `log_min_error_statement=panic` | Encryption at rest can only be set at creation. 35 days is the clinic agreement's backup promise (1.3.0, release gate 18): no copy of deleted data may outlive it, hence no final snapshot. Standby's snapshot is the one exception, allowed only while no clinic is in production and no agreement in effect. The engine log never expires: terse drops DETAIL and CONTEXT lines, `none` logs no statement as it runs, and `panic` keeps the text of a *failing* statement out (at the default, `error`, a failed `ALTER ROLE ... PASSWORD '...'` or an `INSERT` carrying patient values is logged in full after its ERROR line). What remains: a primary message that quotes its own input (`invalid input syntax for type uuid: "..."`) |
| `ssm.tf` | SecureString parameters under `/healdesk/production/`, all under the key, all created holding `__unset__` through the write-only `value_wo`: six internal (`db/APP_PASSWORD`, `db/MIGRATOR_PASSWORD`, `app/BETTER_AUTH_SECRET`, `app/HEALDESK_IDENTIFIER_REF_KEY`, `app/DATABASE_URL`, `migrator/MIGRATION_DATABASE_URL`) and ten external under `app/`; `prevent_destroy` on all; two `moved` blocks that retire the Synthflow pair (below) | See "Secrets and configuration". The retired `HEALDESK_VOICE_WEBHOOK_SECRET` and `HEALDESK_VOICE_TOOLS_SECRET` (14 October 2026) are moved to an address no resource declares, which Terraform destroys without the `prevent_destroy` the rest keep, since a `removed` block can name only a whole resource |
| `ecr.tf` | `healdesk/app`, `healdesk/db-admin`, `healdesk/tls-proxy`: immutable tags, scan on push, the key, last 30 images kept | A git SHA always names the same bytes, and 30 images are weeks of rollback |
| `iam.tf` | Execution role (pull our images, write our log streams, `ssm:GetParameters` on `app/*` and `migrator/*` only, the RDS master secret, decrypt only through SSM and Secrets Manager); app task role (the credential vault, below; S3 and SES statements only when their flags are on); db-admin task role (`ssm:GetParameter` and `ssm:PutParameter` on exactly the six internal parameters, the key only through SSM and only for those six); deploy role `healdesk-production-github-deploy` | The app task role may call `GenerateDataKey`, `Decrypt` and `Encrypt` on the key only as its own calls (no `kms:ViaService`), only with an encryption context of `healdesk:clinic` and `healdesk:login` and no other key, and, with `kms_require_lock_labels` (the default), with both present: statement 1 of `docs/design/google-calendar-2026-10-05.md` §5. That refuses every context an AWS service puts on its own data under the key, so the role cannot decrypt the parameters, logs or trail even with the ciphertext. The deploy role: "Who can change production", below |
| `logs.tf` | `/healdesk/production/{web,worker,voice,migrate,db-bootstrap,tls-proxy}` (and one per operator task) and `/aws/rds/instance/healdesk-production/postgresql`, each with the key, "Never expire" and `skip_destroy`; Container Insights and flow-log groups when those are on | AWS addendum §4.2(c) asks for maximum retention. A group AWS creates by itself would get neither our key nor the retention, so every group is created first |
| `alb.tf` | ALB `healdesk-production` (invalid headers dropped, deletion protection, idle timeout 120 s, WAF fail-open, XFF append); target group `healdesk-production-web-https` (HTTPS:8443, health check `/api/health?probe=liveness`, deregistration 60 s); HTTP 301; HTTPS listener with `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09` whose default is a fixed 404; rules `internal_signed` (priorities 100-102), `internal_nothing_else` (200), `public_refuses_signed` (300-302), `public` (400); with `enable_voice`, target group `healdesk-production-voice-tls` (the same protocol and port, health check `/health`, deregistration 3600 s) and rule `voice` (350: `app.healdesk.io` and `/llm-websocket/*`) | A listener made through the API otherwise defaults to a 2016 policy that allows TLS 1.0. A rule takes at most three paths, so each list is split into rules of three. No access logs: their bucket cannot use our key, and URLs carry no PHI |
| `dns.tf` | ACM certificate for `app.healdesk.io` with `app-internal.healdesk.io` as a SAN; one validation record per name and both CNAMEs at Cloudflare, all DNS only; `aws_acm_certificate_validation` with a 30-minute create timeout | One apply writes the records, waits for issuance and creates the listener. Thirty minutes rather than the provider's 75, so a stuck validation fails inside the workflow's AWS session and leaves a clean state. ACM renews by itself while the validation records stay |
| `waf.tf` | **Off in the lean profile** (`enable_waf = false`, the owner's choice of 13 October 2026). When on: web ACL `healdesk-production`, one rule `rate-limit-per-ip` (`waf_rate_limit`, 2,000 per 5 minutes per IP), custom 429; no managed groups; sampled requests off | HIPAA does not require it, and the app keeps its own in-memory rate limits, exact while there is one web task; turn it on before a second. Samples and WAF logs would store request headers, which carry session cookies and webhook bearer secrets |
| `ecs.tf` | Cluster `healdesk-production`; task definitions `healdesk-production-{web,worker,migrate,db-bootstrap}`, all on `task_cpu_architecture` (ARM64); web at `web_cpu`/`web_memory` (0.25 vCPU, 1 GB) carrying the app, the TLS sidecar and, with `worker_placement = "shared"`, the worker as an essential third container; service `healdesk-production-web` (and `-worker` only when the worker is `"separate"`) at desired 0, circuit breaker with rollback, no ECS Exec, ignoring `task_definition` and `desired_count`, the web service created only after the certificate, the listener and its rules; with `enable_voice`, task definition and service `healdesk-production-voice` ("The voice endpoint", below) | Terraform owns the shape of each task definition; the deploy workflow owns which revision runs and the first scale-up. No ECS Exec: it would put a root shell on a container holding PHI. The worker's own task definition stays in both placements, so switching back needs nothing new |
| `cloudtrail.tf` | Multi-region trail `healdesk-production`, management events read and write (KMS not excluded), log-file validation, SSE-KMS; bucket `healdesk-production-cloudtrail-865780386982`, TLS-only, versioned, no expiry; S3 data events on the transcript bucket when it exists | Every KMS `Decrypt` is a read event, and "every unwrap is a CloudTrail event" is part of the credential vault's audit story |
| `config.tf` | Recorder `healdesk-production` for all supported resources, with a role of its own; bucket `healdesk-production-config-865780386982` (SSE-S3); rules `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled`, `cloudwatch-log-group-encrypted` | The four rules the handover names; the Security Official reads the findings each quarter. A custom role, because creating Config's service-linked role fails if the console made it first |
| `guardduty.tf` | One detector (`enable_guardduty`) | Foundational threat detection; findings are read in the console |
| `alarms.tf`, `budgets.tf` | SNS topic `healdesk-production-alarms` emailed to `alarm_email`; nine alarms in the lean profile; a monthly cost budget (`monthly_budget_usd`, 250) | Alarm messages carry metric names and counts, never patient data |
| `ses.tf` | **On** (`enable_ses`): the SES configuration set `healdesk-production-phi` with `TlsPolicy=REQUIRE`, the domain identity and its DKIM records at Cloudflare, `HEALDESK_SES_CONFIGURATION_SET` on the tasks and the task role's send rights on that set only; the set's events (delivery, bounce, complaint, rejection) to the SNS topic `healdesk-production-ses-events`, signed (v2), subscribed over HTTPS at `/api/webhooks/ses` (`subscribe_ses_events`, which the workflows turn off while the app does not answer), whose ARN the web task gets as `HEALDESK_SES_EVENTS_TOPIC_ARN`. No copy of a transcript goes anywhere else: the archive copy went on 14 October 2026, and `app_environment` refuses its two names | A conversation's transcript is emailed to the clinic, never kept (the owner's decision of 13 October 2026; `apps/app/src/lib/conversations/transcript-email.ts`). That email is classed `may-carry-phi`, so the app sends it, and only it, through SES; everything else stays on Resend. The account must leave the SES sandbox before it reaches a clinic (First run, step 9) |
| `storage.tf` | The transcript bucket (`enable_transcript_bucket`). **Off, and now superseded**: transcripts are emailed, not stored | See "Deliberately not built" |
| `outputs.tf` | `standby`, `alb_dns_name`, `app_url`, `internal_url`, `github_deploy_role_arn`, `ecr_repository_urls`, `rds_endpoint`, `rds_master_secret_arn`, `kms_key_arn`, `alarm_topic_arn`, `parameters_to_fill`, `internal_parameters`, `transcript_bucket`, `ses_configuration_set`, `voice_websocket_url`, `voice_service` | What the next steps need. None is a secret. Those naming something standby removes are null in standby |
| `tests/stack.tftest.hcl`, `tests/restore.tftest.hcl` | 36 plan-only runs with both providers mocked: production defaults, lock labels off, the bucket and SES on, the shape first built, voice on (with the encrypted hop, and without it under the longest environment name), plain HTTP to tasks, public ids, an imported GuardDuty detector, standby's two applies (lean, and with every switch on), the way back from a snapshot, and 24 refusals; and, in a state of its own, a restore applied and two plans after it (another snapshot named, none named) that must keep the database | CI's `infra` job runs both; they need no credentials. The second file applies, so its mocks fill values at apply time and it targets the database alone |
| `bootstrap/bootstrap.yaml` | CloudFormation stack `healdesk-bootstrap`: state bucket `healdesk-terraform-state-865780386982` with its own key (`alias/healdesk-terraform-state`), the GitHub OIDC provider, role `healdesk-github-terraform` | What Terraform cannot create for itself. The stack refuses any other account or region; bucket and key are kept if the stack is deleted, and removed if the launch that created them rolls back (`RetainExceptOnCreate`) |
| `images/tls-proxy/` | nginx 1.30.5 (pinned by digest), an entrypoint making the key and configuration under `/tmp/tls-proxy` (or `TLS_PROXY_RUN_DIR`), keep-alive from `TLS_PROXY_KEEPALIVE_SECONDS` (`alb_idle_timeout + 10`), a health-check script | See "The request paths" |
| `images/db-admin/` | postgres 17 alpine client (pinned by digest), the AWS CLI and Python 3, the RDS CA bundle, `apps/app/scripts/provision-roles.sql`, `scram-verifier.py`, an entrypoint that takes no arguments | The app image has no psql, and the RDS master user is not a superuser. See "The database" |
| `scripts/put-external-secrets.sh` | Pastes the owner's secrets into Parameter Store from AWS CloudShell | See "Secrets and configuration" |
| `scripts/run-task.sh` | Runs the migrate or db-bootstrap task from a terminal | See "One-off tasks from a terminal" |
| `scripts/plan-guard.sh` | Reads a saved plan's JSON and refuses one that deletes the key, a parameter (but a retired one), an image repository or a bucket, or deletes or replaces the database outside standby; `--release` and `--standby` for standby's two applies | What `prevent_destroy` did for the database before standby ("Standby"). `infra.yml` and `host.yml` run it on every plan before it is shown as ready or applied |
| `scripts/host-apply.sh` | One plan, the guard and the apply, for `host.yml` | The same steps as `infra.yml`'s apply, with `-var` after `production.tfvars` |

The app-side pieces this module relies on: `apps/app/Dockerfile` copies `tsconfig.base.json`
(the worker and every tsx script crashed without it), adds the RDS us-east-1 CA bundle at
`/etc/ssl/rds/us-east-1-bundle.pem` against a pinned checksum, sets
`NPM_CONFIG_CACHE=/tmp/npm-cache`, and runs `apps/app/docker-entrypoint.sh`, which unsets any
variable whose value is exactly `__unset__`; `apps/app/src/lib/env.ts` refuses, in production, a
`DATABASE_URL` without `sslmode=verify-full`; `apps/app/scripts/provision-roles.sql` asserts the
role attributes instead of naming `SUPERUSER`, which only a superuser may do;
`apps/app/src/lib/client-ip.ts` reads the address the ALB appended.

CI's `infra` job (`.github/workflows/ci.yml`) runs `terraform fmt -check -recursive`,
`terraform init -backend=false -lockfile=readonly`, `terraform validate` and `terraform test` on
every push. No CI job builds or runs the images; `deploy-app.yml` is the first thing that does.

---

## Secrets and configuration

**No secret value is in Terraform's state or in any plan.** Terraform creates every parameter
holding the literal `__unset__` through the provider's write-only `value_wo` argument: written
once at creation, never stored, never read back. (The plain `value` argument would not do: the
provider reads a SecureString back decrypted on every refresh, so every generated or pasted secret
would land in the state at the next plan.) The real values are written inside AWS, by two writers:

| Parameter (under `/healdesk/production/`) | Written by | Read by |
| --- | --- | --- |
| `db/APP_PASSWORD`, `db/MIGRATOR_PASSWORD` | db-bootstrap, once: 48 random letters and digits | db-bootstrap, through its task role |
| `app/DATABASE_URL` | db-bootstrap: `postgresql://healdesk_app:<pw>@<endpoint>:5432/healdesk?sslmode=verify-full&sslrootcert=/etc/ssl/rds/us-east-1-bundle.pem` | web, worker |
| `migrator/MIGRATION_DATABASE_URL` | db-bootstrap, the same shape as `healdesk_migrator` | migrate only |
| `app/BETTER_AUTH_SECRET` | db-bootstrap, once: 64 random letters and digits | web, worker |
| `app/HEALDESK_IDENTIFIER_REF_KEY` | db-bootstrap, once: 64 random letters and digits. **Never replaced** | web, worker |
| `app/HEALDESK_PROVISION_SECRET` | The owner; byte-identical to Vercel's | web, worker |
| `app/STRIPE_SECRET_KEY` | The owner; the same Stripe account and mode as Vercel's | web, worker |
| `app/RESEND_API_KEY` | The owner; `apps/app`'s own sending-only key | web, worker |
| `app/GOOGLE_OAUTH_CLIENT_ID`, `app/GOOGLE_OAUTH_CLIENT_SECRET` | The owner, from the Google OAuth client whose redirect URI is `https://app.healdesk.io/api/calendar/google/callback` (the calendar's Google connection, on main since its C8). Until both are set, apps/app sends no clinic to Google: the connect page says calendar connection is not available yet | web, worker |
| `app/STRIPE_CONNECT_WEBHOOK_SECRET` | The owner, from doorbell B (Stripe's Connect endpoint at `https://app.healdesk.io/api/webhooks/stripe-connect`) | web |
| `app/META_APP_SECRET`, `app/META_VERIFY_TOKEN`, `app/ANTHROPIC_API_KEY` | The owner, only once the BAA chain allows ("What still blocks real patient data") | web |
| `app/HEALDESK_RETELL_LLM_SECRET` | The owner, before turning `enable_voice` on: a random value, at least 32 characters (letters, digits, `-` and `_` only, since it is a URL path segment: `openssl rand -hex 32`); the same value goes into each clinic's Retell agent URL ("The voice endpoint", below). It may be pasted before the agreements for a test call on the demo clinic only, which the voice process enforces until `voice_real_calls` is on ("Turning it on"). Unset (`__unset__`), the voice process refuses every call | voice (and web, which gets every `app/` parameter) |
| `ci/CLOUDFLARE_API_TOKEN` (not Terraform's) | The owner, before the first plan, under the bootstrap stack's key | `infra.yml` and `host.yml`, after they assume the Terraform role |
| RDS master secret (Secrets Manager, managed by RDS, rotated every 7 days) | RDS | db-bootstrap only, through the execution role |

With `enable_voice`, the voice task reads every `app/` parameter the web tier reads: it runs the
same conversation code.

- **`__unset__` reads as unset.** ECS refuses to start a task whose parameter does not exist, and
  a parameter cannot be empty, so every parameter exists from the first apply holding the
  placeholder. The image's entrypoint removes every variable with exactly that value and logs the
  names it removed, never a value, so a feature whose secret is still `__unset__` stays off
  instead of failing on a placeholder (`optional()` in `lib/env.ts` treats any non-empty value as
  set, which is why a blank or a space would not do). The exception to "stays off":
  `HEALDESK_PROVISION_SECRET` is required, and until it is pasted every signed route answers 503.
- **The internal six: db-bootstrap's init-secrets.** Before it creates the roles, the db-bootstrap
  task fills each of the six still `__unset__` and keeps every one that is set, so a re-run never
  rotates anything. It composes both URLs from the RDS endpoint Terraform gives it as `PGHOST`,
  writes with `--key-id` set to the product key and `--value file://` from a 0600 file, and
  prints each name with `generated` or `kept`, never a value. It refuses, before writing anything,
  a password that is `__unset__` while its URL is set (a new password needs a new URL), a kept
  password shorter than 32 characters or holding a character a URL would need escaped, and a kept
  URL that does not carry its role's password or the expected database and TLS settings. Its task
  role can get and put those six parameters and nothing else (`output internal_parameters`).
  **Never paste, edit or regenerate them by hand**; rotation is below.
- **The external ten: `scripts/put-external-secrets.sh`, in AWS CloudShell.** Upload it, then
  `bash put-external-secrets.sh` walks every key (Enter keeps one as it is),
  `bash put-external-secrets.sh STRIPE_SECRET_KEY RESEND_API_KEY` does only those, and
  `bash put-external-secrets.sh --status` lists each as `set`, `__unset__` or `missing` without
  reading a value out of the AWS CLI. It checks the account, prompts with a hidden read, refuses
  unknown names, inner whitespace, the placeholder itself and multi-line pastes, checks the shape
  of the Stripe (`sk_`/`rk_` of `STRIPE_MODE`, test unless `STRIPE_MODE=live`), Stripe webhook,
  Resend, Anthropic and Google client-id values and the Retell secret (32 to 200 URL-safe
  characters), asks for a typed `yes` before the four keys that open a patient-facing path, writes through a 0600 file under the key the parameter already has,
  and prints key names and where each value came from, never a value or its length. An app key it
  cannot find means `infra.yml` apply has not run. `CLOUDFLARE_API_TOKEN` is the one it creates,
  under `alias/healdesk-terraform-state`. Then run `deploy-app.yml` with `restart_only`: tasks
  read their parameters only when they start. Never paste with a bare
  `aws ssm put-parameter --value ...`: the value would sit on the command line and in the shell
  history, and without `--key-id` SSM re-encrypts it under the account's default `aws/ssm` key,
  outside our key policy.
- **Three rules that come with `value_wo`** (each pinned in `ssm.tf`): `ignore_changes` covers
  description, key, tier and type, because an in-place change would make the provider put the
  value it holds, which is nothing, and AWS refuses an empty value; raising `value_wo_version`
  writes `__unset__` over the live value, so never do it for an internal parameter once the
  database is provisioned; destroying a parameter destroys its value, hence `prevent_destroy`.
- **Plain environment** (in the task definitions, from `locals.tf`): `NODE_ENV=production`,
  `BETTER_AUTH_URL=https://app.healdesk.io`, `HEALDESK_APP_URL=https://app-internal.healdesk.io`,
  `HEALDESK_KMS_PROVIDER=aws-kms`, `HEALDESK_KMS_KEY_ID=<the key's full ARN>`,
  `AWS_REGION=us-east-1`, `HEALDESK_EMAIL_TRANSPORT=resend`, `HEALDESK_EMAIL_FROM`,
  `HEALDESK_ADMIN_EMAIL`, `HEALDESK_OPS_EMAIL` (when set), `NODE_EXTRA_CA_CERTS`, and anything in
  `app_environment` (such as the setup wizard's `HEALDESK_SUPPORT_PHONE` and
  `HEALDESK_CALL_BOOKING_URL`); the web tier adds `PORT=3001`, `HOSTNAME=0.0.0.0`,
  `KEEP_ALIVE_TIMEOUT` (idle timeout + 5 s, so 125000) and, when filled in `production.tfvars`,
  `META_APP_ID`, `META_LOGIN_CONFIG_ID`, `META_WHATSAPP_CONFIG_ID` and `STRIPE_CONNECT_CLIENT_ID`
  (the worker gets the Connect client id too: offboarding revokes Connect access with it), and,
  with `enable_voice`, `HEALDESK_VOICE_ENABLED=1`, which tells `/admin/map` the voice endpoint
  exists (the pasted secret cannot: the web tier holds every `app/` parameter; like any task
  change, it reaches the running web tasks with the next full deploy); the voice task
  (`enable_voice`) adds only `PORT=3001` and `HOSTNAME=0.0.0.0`. With `voice_real_calls`, both
  the web and the voice task get `HEALDESK_VOICE_REAL_CALLS=1`: the voice process answers real
  patients only with it, and `/admin/map` reads it from the web tier. An empty variable is left out,
  not set to `""`.
- **Never set on web, worker or voice**, enforced by preconditions that fail the plan and by the
  deploy workflow's shape check: `MIGRATION_DATABASE_URL`, `HEALDESK_LOCAL_KEK`,
  `HEALDESK_DIRECT_BOOKING_ENABLED`, `HEALDESK_PHASE_TWO_ATTRIBUTION`, `BETTER_AUTH_SECRETS`. The
  two switches wait for counsel and the owner, never for this stack; `app_environment` refuses
  them too, along with any secret name and any name the stack sets itself.

---

## Who can change production: the trust model

Two roles can change the account from GitHub, and AWS, not a workflow file, decides who gets them.
Both trust GitHub's OIDC provider, and both accept a token only when all four conditions hold:

| Condition | Value | What it rules out |
| --- | --- | --- |
| `token.actions.githubusercontent.com:aud` | `sts.amazonaws.com` | Tokens minted for anything else |
| `...:sub` | `repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/main` | Any other repository (owner and repository by numeric id, GitHub's immutable form for repositories created after 15 July 2026), and any job that names a GitHub environment, which gets an `:environment:` subject instead |
| `...:ref` | `refs/heads/main` | A pushed branch, a pull request, a fork, `gh workflow run --ref <branch>` |
| `...:actor_id` | `262780224` (the owner) | A run started by anyone else. A re-run keeps its original actor, but replays only its own commit and inputs |

- **`healdesk-github-terraform`** (bootstrap stack) holds AdministratorAccess, because Terraform
  writes IAM, and a role that can write IAM policies can grant itself anything. Sessions up to two
  hours; `infra.yml` and `host.yml`'s apply jobs ask for 90 minutes, their whole timeout, so an
  apply never outlives its credentials.
- **`healdesk-production-github-deploy`** (`iam.tf`) can push the three images, register the
  task-definition families, update the web, worker and voice services, run the two one-off tasks
  on this cluster,
  pass exactly the execution role and the two task roles, and never turn on ECS Exec. **It is as
  powerful as the code it deploys:** it has no direct read of a secret and no direct use of the
  key, but every task definition it registers and runs receives the execution role's secrets (any
  `app/` or `migrator/` parameter and the RDS master secret) and can carry the app's or the
  db-admin task's role, with internet egress. That power is inherent to a deploy role and cannot be
  narrowed with IAM; the main-branch pin is the control. As defence in depth, `deploy-app.yml`
  checks every task definition it starts from or rolls back to against the shape Terraform gives
  it (containers, roles, the never-set names, Secrets Manager only on db-bootstrap) and stops on
  anything else.
- **No GitHub environment, and no GitHub secret.** No job names an environment: one that did
  would get a different subject and be refused, so no environment setting is part of the control.
  The Cloudflare token (Edit zone DNS on healdesk.io, enough to repoint `app.healdesk.io`) lives
  in Parameter Store under the bootstrap stack's key, which only administrators can use; the plan
  and apply steps each read it after assuming the Terraform role, mask it, and export it to that
  step's shell alone. A repository secret would reach every branch's workflows.
- **The workflows' own checks** (main only, started by the owner) say so in plain words before
  AWS does. They live in files a branch can edit, so they are messages, not the control.
- **The residual.** Anything that reaches main, and anyone acting as the owner (the owner's GitHub
  login and every session or tool that pushes or dispatches with it), can assume both roles. On
  GitHub Free a private repository's main cannot be protected, so those credentials are the
  boundary. GitHub Pro's branch protection on main is the next step. The account's administrators
  (the Terraform role and the owner's IAM user) can read every parameter and the master secret
  directly.
- **The switch's token is one of those tools.** `HEALDESK_GITHUB_ACTIONS_TOKEN` on Vercel is a
  fine-grained token of the owner, Actions read and write on this repository only. It cannot push
  code, but it can start any workflow on main as the owner, `infra.yml` apply and `host.yml`
  standby included, and so whoever holds it can make AWS run main's workflows. In apps/web only
  `/api/admin/host` (behind the operator session, the same-origin check and apps/app's standby
  check) and the Stripe webhook's wake (mode `active`, once an hour) use it, and no response
  carries it; anyone who can read Vercel's environment can use it directly, and `host.yml`'s own
  refusal of standby (the production-clinic parameter) is then the guard. Rotate it with the
  other Vercel secrets, and give it the shortest expiry GitHub allows that you will renew.

If the first run is refused with "Not authorized to perform sts:AssumeRoleWithWebIdentity", the
subject GitHub issued differs from the trusted one. Decode only the `sub` claim of one main run,
never print the token, and compare.

---

## First run, in order

The owner's guide has the exact commands and clicks. This is the order and what each step leaves
behind.

1. **Merge to main.** `infra.yml` and `deploy-app.yml` run from main only, and
   `workflow_dispatch` only sees workflows on the default branch. `.terraform.lock.hcl` and
   `production.tfvars` are committed with the module (both inits use `-lockfile=readonly`;
   `git ls-files infra/aws/production.tfvars` must print the file).
2. **Pre-flight in the account** (read-only, from CloudShell, as the administrator):
   `aws s3api head-bucket --bucket healdesk-terraform-state-865780386982` must fail with 404
   (anything else means a bucket of that name exists, from an earlier bootstrap here or anywhere,
   and the stack would fail on it); `aws guardduty list-detectors`,
   `aws configservice describe-configuration-recorders` and
   `aws configservice describe-delivery-channels` should be empty; note whether
   `aws iam list-open-id-connect-providers` lists `token.actions.githubusercontent.com`. A region
   holds one GuardDuty detector, one Config recorder and one delivery channel: if one exists,
   import it with an `import` block applied through `infra.yml` (or set `enable_guardduty =
   false`), and read the plan, since a console-made recorder is usually named `default` and a
   rename means a replacement.
3. **Launch `bootstrap/bootstrap.yaml`** once, as stack `healdesk-bootstrap`, in us-east-1, with
   `CAPABILITY_NAMED_IAM` (add `--parameter-overrides CreateGitHubOidcProvider=false` if the
   provider exists). Outputs: `StateBucketName`, `StateKmsKeyArn`, `TerraformRoleArn`. A launch
   that fails rolls back to `ROLLBACK_COMPLETE`, which `deploy` cannot update: read the
   `CREATE_FAILED` events, `delete-stack`, `wait stack-delete-complete`, fix the cause, launch
   again (the template's header has the commands). Nothing is left behind.
4. **The Cloudflare token.** A token from Cloudflare's "Edit zone DNS" template (Zone, DNS, Edit),
   scoped to the healdesk.io zone only, pasted in CloudShell with
   `bash put-external-secrets.sh CLOUDFLARE_API_TOKEN`. If a `CLOUDFLARE_API_TOKEN` repository
   secret was ever set, delete it (`gh secret delete CLOUDFLARE_API_TOKEN`).
5. **GitHub repository variables** (none is sensitive): `TF_STATE_BUCKET`,
   `TF_STATE_KMS_KEY_ARN`, `AWS_TERRAFORM_ROLE_ARN` from the stack outputs; `ALARM_EMAIL`,
   `HEALDESK_ADMIN_EMAIL` (byte-for-byte the `HEALDESK_ADMIN_EMAIL` on Vercel; nothing checks that
   they match), `CLOUDFLARE_ZONE_ID` (healdesk.io's zone id, 32 hex characters) and, optionally,
   `HEALDESK_OPS_EMAIL`. `infra.yml` refuses to start without the first six.
6. **`infra.yml` with `plan`, read it, then `apply`** (done on 14 October 2026). The apply makes a
   fresh plan and applies exactly that saved plan in the same job; check its `Plan:` line matches
   the plan run's. The first apply creates about a hundred resources, waits for ACM to issue the
   certificate through the two Cloudflare records, then creates the listener, its rules and the
   services at 0 tasks. RDS takes the longest. The run ends by printing the outputs.
7. **No `AWS_DEPLOY_ROLE_ARN` to set any more.** `deploy-app.yml` derives the deploy role,
   `arn:aws:iam::865780386982:role/healdesk-production-github-deploy`, from
   `AWS_TERRAFORM_ROLE_ARN`'s account when the variable is unset; set it only to use another role.
8. **Confirm the SNS subscription** from the email AWS sends to `alarm_email`. Both
   below-desired alarms most likely went into ALARM before it was confirmed (missing data counts as
   breaching, and nothing runs yet), and SNS sends nothing to a pending subscription, so expect no
   alarm email until the first deploy turns them OK.
9. **Paste the external parameters** (`parameters_to_fill`): `HEALDESK_PROVISION_SECRET` (a new
   random value, set on Vercel in step 11 with the same bytes), `STRIPE_SECRET_KEY` (the test key:
   the end-to-end test runs on this host before launch), `RESEND_API_KEY`, and the two Google
   OAuth values once the client exists. Leave `META_*`, `ANTHROPIC_API_KEY` and
   `HEALDESK_RETELL_LLM_SECRET` as they are. Then ask AWS to take SES out of its sandbox (console → Amazon SES → Get
   set up → Request production access, transactional mail, from healdesk.io): until it does, SES
   sends only to addresses verified in the account, so an emailed transcript would not reach a
   clinic. The domain identity and its DKIM records are already made by the apply.
10. **`host.yml` with mode `active`**, from GitHub (Actions → Host (AWS) → Run workflow, on main):
    the first time it has to be GitHub, because `/admin` cannot be signed in to before the host
    answers (its second factor lives in this host's database). It applies (nothing to change on a
    host `infra.yml` has just applied, but what main has changed since), then calls
    `deploy-app.yml` with `bootstrap_db` and `migrate`: db-bootstrap generates the six internal
    values and creates the two roles, migrate runs the migrations and the queue install, and each
    service comes up to its `DesiredCount` tag. Once the liveness probe answers it applies once
    more, subscribing the app to SES's events, which SNS refuses before then. About half an hour
    from standby, most of it the database coming back; about fifteen minutes when the host is
    already on. A hand-started `deploy-app.yml` with `bootstrap_db` and
    `migrate` ticked does the middle step alone (a first deploy, every service at 0, is refused
    without either).
11. **Vercel**: `HEALDESK_APP_URL=https://app-internal.healdesk.io` (the `internal_url` output) and
    the same `HEALDESK_PROVISION_SECRET`, on Production and Preview, and on Production only
    `HEALDESK_GITHUB_ACTIONS_TOKEN` ("Standby": a fine-grained token of the owner, Actions read and
    write on this repository only), then redeploy Production (Vercel applies variables only to new
    deployments). Preview has the first two only while this host holds Stripe test keys and
    synthetic data, so the Stripe guide's test purchase can run from a preview; on launch day,
    take both off Preview, or every branch preview would provision against the production PHI
    host.
12. **Check**: `https://app.healdesk.io/api/health?probe=liveness` answers `{"ok":true}`;
    `https://app.healdesk.io/api/health` shows `"db":"ok"` and, within the hour, a
    `heartbeatAgeSeconds`; `https://app-internal.healdesk.io/api/health` answers 404 (the internal
    host serves only the signed routes); an unsigned `POST https://app-internal.healdesk.io/api/ops`
    answers 401 from the app (503 means the provision secret is still unset), and the same `POST`
    to `https://app.healdesk.io/api/ops` answers the ALB's 404; the worker log shows
    `credential key self-check passed`; healdesk.io/admin's Ops page loads, which proves the signed
    path end to end, and its first sign-in enrols a new authenticator, because its second factor
    lives in this host's database, which is new; `/admin/host` shows Active. Last, SES's events:
    in the console, SNS → Subscriptions, the `https://app.healdesk.io/api/webhooks/ses`
    subscription to `healdesk-production-ses-events`, which `host.yml`'s last apply made, should
    read Confirmed (the app confirms it itself when SNS asks). Until it is confirmed, a transcript
    that bounces at the clinic's mail server is not sent again (every other retry still runs).

---

## Deploying

`deploy-app.yml` runs by hand, from main, as `healdesk-production-github-deploy` over OIDC, or
called by `host.yml` (with `bootstrap_db` and `migrate`) after the apply that turns the host on. It
shares the concurrency group `healdesk-aws-production` with `infra.yml` and `host.yml`, so an apply
never runs beside a deploy. Called, it takes a group named after its caller's run instead, since
the caller already holds the shared one and a called run that asked for it would wait for its own
caller for ever; the caller's hold keeps everything else out meanwhile.

| Input | Default | Meaning |
| --- | --- | --- |
| `bootstrap_db` | false | Run db-bootstrap first: fill any internal parameter still `__unset__`, then create the two roles or re-set their passwords from Parameter Store. The first deploy must; later, only to rotate a database password |
| `migrate` | true | Run migrations and `queue:install` before the services move. The first deploy must |
| `restart_only` | false | Build and migrate nothing: start fresh tasks of the revisions already running, so they re-read their parameters |
| `rollback_to` | empty | A commit SHA (7 to 40 hex) from a past deploy's summary: put web, worker and voice back on the newest revisions that ran it (see "Rollback") |

A full run, in order:

1. Checks: the deploy role (`AWS_DEPLOY_ROLE_ARN`, or `healdesk-production-github-deploy` in
   `AWS_TERRAFORM_ROLE_ARN`'s account when that is unset, and in either case in `865780386982`),
   ref is main, started by the owner, the inputs consistent (`restart_only` and `rollback_to`
   exclusive; neither with `bootstrap_db`). No web service means the host is in standby or was
   never applied: the run stops and points at `host.yml`.
2. Reads the services: task families, desired counts, the private subnets and security group
   the one-off tasks borrow from the web service, whether a worker service exists (none means the
   worker is a container of the web task), whether the voice service exists (none means
   `enable_voice` is off, and every voice step is skipped), and the CPU architecture the web task
   definition declares. Everything at 0 means nothing has been deployed: the run must have
   `bootstrap_db` and `migrate`, and brings each service up to its `DesiredCount` tag
   (`web_desired`, `worker_desired`, `voice_desired`) after the migrations pass. A service at 0
   beside running ones (voice just switched on) is brought up the same way.
3. Builds and pushes `healdesk/app` (repo root), `healdesk/tls-proxy` and `healdesk/db-admin` for
   that architecture (`linux/arm64` by default, natively on GitHub's arm64 runner,
   `ubuntu-24.04-arm`; until 14 October 2026 it was built under QEMU on an x86 runner and took 18
   minutes), with BuildKit's layer cache kept between deploys in GitHub's cache, so a deploy that
   changes no dependency skips `npm ci`; tagged with the commit SHA. An image
   already pushed for the commit is reused, so the tag names one architecture's image: changing
   `task_cpu_architecture` needs a new commit to deploy.
4. Fetches each family's latest revision (Terraform's configuration, or the last deploy's),
   checks its shape, and registers new revisions with the new images. Runs db-bootstrap (if asked)
   then migrate as one-off Fargate tasks with no overrides, waiting up to 20 minutes each. A
   non-zero exit fails the job with the exit code, ECS's stopped reason and the log group and
   stream; the container's own output is never printed in the job.
5. Rolls the worker service (when there is one), then the web tier, each waiting for stability
   (15 minutes) and failing if the circuit breaker rolled it back. A shared worker rolls with web.
   Then the voice service, when there is one, waiting up to 15 minutes only until its new tasks
   serve: its old tasks finish their calls, for up to an hour, and stop on their own (see "The
   voice endpoint"). A service this run started from 0 whose rollout fails or is cancelled is set
   back to 0 tasks (below).
6. Smoke test: `https://app.healdesk.io/api/health?probe=liveness` until it answers 200 with
   `{"ok":true}`, from outside, through Cloudflare's DNS, the ALB and the sidecar. The summary
   names the full commit, which is what `rollback_to` takes.

Two things that are easy to get wrong:

- **A Terraform change to a task definition** (a tfvars value such as `stripe_connect_client_id`,
  a new environment variable) reaches the services on the next **full** deploy. `restart_only`
  restarts the revisions already running and does not pick it up.
- **A Parameter Store change** needs only `restart_only`: ECS resolves secrets at task start.

---

## Standby

Until the first clinic pays, the host serves synthetic data only, and nearly all of its cost is
billed by the hour whether anything uses it or not. Standby removes those pieces, after a snapshot
of the database, and keeps everything that holds data or identity, so turning the host on again
brings back the same host: the same key, secrets, images, names and database. The switch is
`/admin/host` (apps/web; it dispatches `host.yml` with the owner's token) or
`.github/workflows/host.yml` itself, run by the owner from main with mode `active` or `standby`.
Terraform's side is the `standby` variable and its three companions (`variables.tf`, "Standby").

| Standby removes | Standby keeps |
| --- | --- |
| The RDS instance, after its final snapshot `healdesk-production-standby-<UTC yyyymmddhhmmss>`, and with it its RDS-managed master secret | The KMS key, and every SSM parameter: the six internal (passwords, URLs, auth and reference keys), the ten external, `ci/CLOUDFLARE_API_TOKEN`, `host/mode` |
| The load balancer, its two listeners, its rules and target groups (web, voice) | The ECR repositories and their images |
| The NAT instance and its address (or the NAT gateways and their Elastic IPs), and the private subnets' default route | The VPC, subnets, internet gateway, every security group, the database's subnet and parameter groups |
| Every ECS service: web, worker (when separate), voice (when on) | The ECS cluster and the task definitions, but one |
| Terraform's db-bootstrap task definition, which names the instance's endpoint and master secret | Every IAM role and policy (the execution role's master-secret statement goes with the secret) |
| Every alarm: each watches the load balancer, a service, the NAT instance or the database | The alarm topic and its confirmed email subscription; the budget |
| The WAF (when on) | CloudTrail, Config, GuardDuty and their buckets; the export bucket; every log group and its logs |
| The SES events subscription, which posts to the removed host | SES's identity, configuration set, DKIM records and events topic |
| The two Cloudflare CNAMEs, `app.healdesk.io` and `app-internal.healdesk.io` | The ACM certificate and its two validation records |

**What it costs.** Active, the lean profile, about $69 a month ("Costs"). In standby, line by line
from what is left: the two KMS keys $2.00 (each adds $1 a month after its first yearly rotation);
the images in ECR $0.10 to $2.00 at $0.10 per GB-month, under $0.20 after a few deploys and up to
$2 with 30 images in each repository; the standby snapshot of a synthetic database, about 1 to 2 GB
at $0.095 per GB-month, about $0.15; the deleted instance's automated backups, kept 35 days and
billed at the same rate with no instance to make them free, about $0.20 for the first month only;
Config, with almost nothing changing, about $0.50; GuardDuty, with no traffic to read, about
$0.25; the trail, Config and state buckets and the stored logs, about $0.30. No alarm, no public
IPv4 address, no secret in Secrets Manager is left; Parameter Store standard parameters, SES's
identity, the VPC, ACM, SNS and the budget cost nothing. **About $4 a month**, an estimate: read the
first bill in standby. `/admin/host` shows both tables (`apps/web/src/lib/host/costs.ts`, kept in
step with this paragraph). Each switch bills its hours as on; turning on also spends GitHub
Actions minutes, most of them the arm64 build of a commit not built before.

**How long.** Standby takes about twenty minutes: the guard, the first apply (a minute or two),
then the second, in which the services drain (60 s), the final snapshot is taken and the
instance deleted (most of it), and the rest goes in seconds; with `enable_voice` the voice service
drains its calls first, up to an hour. Turning on takes about half an hour to forty minutes: the apply (the database
from its snapshot, 10 to 20 minutes, the NAT instance's first boot, the load balancer), the deploy
(the images, reused when this commit was built before and otherwise built on the arm64 runner; db-bootstrap;
the migrations; the rollout and its smoke test), and the last apply, which subscribes SES's events.

**How the switch runs** (`host.yml`, every apply through `scripts/host-apply.sh`, so each is a
saved plan, rendered for the log, checked by `scripts/plan-guard.sh`, then applied exactly; the
variables go on the command line after `production.tfvars`, which stays the record of the active
shape):

- **Standby.** The guard below. Then the switch is recorded in `/healdesk/production/host/mode`.
  Apply 1, targeted at the database and the load balancer (only those that exist both in AWS and
  in the state), with `deletion_protection = false` and `final_snapshot_identifier` set, and
  `plan-guard.sh --release`, which refuses anything but updates: the provider reads
  `skip_final_snapshot` and the snapshot's name from the state when it destroys, and one apply
  cannot both lift deletion protection and delete. Apply 2, `standby = true`, with
  `plan-guard.sh --standby`, which allows the database's deletion (never a replacement) and
  refuses any plain deletion outside the list above. Then, once the new snapshot is available,
  every older standby snapshot is deleted.
- **Active.** The switch is recorded. The database: if it exists it is kept (`rds.tf` ignores
  `snapshot_identifier` once it exists, so no later apply can replace it with a copy); if not,
  the newest available standby snapshot is named in `restore_snapshot_identifier`, or none, and
  the database is new and empty (a warning says so). The apply, with deletion protection back on
  and the SES subscription off unless the app already answers. Then `deploy-app.yml` with
  `bootstrap_db` and `migrate`, a first deploy since every service is new at 0 tasks. Then, once
  `https://app.healdesk.io/api/health?probe=liveness` answers, the apply that subscribes SES's
  events. The run's summary says which step did not succeed; every step is safe to run again.

**What happens to the data.** The database's final snapshot is a manual snapshot, kept until a
later standby replaces it: the clinic agreement's 35-day promise (`rds.tf`) is why that is allowed
only while nothing real is on the host. It is restored under the same identifier, so the
instance gets back the same endpoint (`<identifier>.<the account's hash>.us-east-1...`), and the
two URLs Parameter Store kept still name it; the roles in it already have the passwords Parameter
Store holds, and db-bootstrap re-asserts them. With no snapshot, db-bootstrap creates the roles in
the new database with those same passwords, and migrate builds the schema; it never generates a
value that is set, so nothing rotates either way. Point-in-time recovery starts again with the new
instance; the old instance's automated backups stay 35 days, restorable only to a new instance by
hand. RDS deletes the old master secret with the old instance and makes a new one; the apply
registers a new db-bootstrap revision naming it, and the deploy builds on that one
(`run-task.sh db-bootstrap` picks a deployed revision, so it works again after the deploy).
Logs, parameters and images are untouched. The guard keeps standby away from a transcript SES
has not taken; a sent one's sealed copy waits in the snapshot and the outbox job deletes it on its
own clock once the host is back.

**The guard on standby.** `/admin/host` asks apps/app's `hostStandbyCheck` first (signed, counts
only: clinics in production, agreements bound and in effect, transcripts SES has not taken) and
dispatches nothing unless all three are 0, saying why otherwise. `host.yml` cannot sign that call,
so, started any other way, it refuses standby while the database exists and the String parameter
`/healdesk/production/host/production-clinic` reads `yes`. **apps/app does not write that
parameter**: set it by hand in CloudShell when the first clinic goes live,
`aws ssm put-parameter --name /healdesk/production/host/production-clinic --type String --value yes --overwrite`,
and to `no` if none is left. The plan guard runs on every apply of both workflows.

**infra.yml follows the switch.** It reads `/healdesk/production/host/mode` and, while it says
`standby`, plans with `standby = true` (and `deletion_protection = false`), so a change merged in
standby is applied to the host in standby rather than turning it on half-way. The plan guard
refuses an `infra.yml` plan that deletes the database: if the mode says standby and the database
is still there, a standby stopped half-way, and `host.yml` finishes it (or brings the host back).

Things to know:

- **`/admin` cannot be signed in to while the host is in standby**: the sign-in's second factor
  lives in apps/app's database, and the session route fails closed when it cannot ask. Keep the
  session, or turn the host on from GitHub (Actions → Host (AWS) → Run workflow → `active`).
- **A first paid invoice turns it on.** The Stripe webhook's provision call finds nothing and
  answers Stripe 500 as before, so Stripe retries for about three days; `apps/web/src/lib/host/wake.ts`
  also dispatches `host.yml` with `active` and emails the administrator, at most once an hour.
  The account is made on Stripe's first retry after the host answers.
- **A standby that stopped after its first apply** leaves the database and the load balancer
  without deletion protection until `host.yml` runs again, in either mode.
- **The certificate is not renewed in standby**: ACM renews only a certificate in use. One that
  outlasts its thirteen months needs replacing (an apply with `aws_acm_certificate.app` replaced;
  it is create-before-destroy) before the host comes back.
- **A snapshot taken after an automatic minor upgrade** comes back at that minor: raise
  `postgres_version` first, or the apply plans a downgrade.
- **The NAT instance comes back on the newest image**, as a quarterly replacement does.
- **Rollback** after a return works on the revisions deployed since; a revision registered before
  14 October names the retired Synthflow parameters and would not start (none was deployed).

---

## The database: roles and migrations

Two roles, created by the db-bootstrap task and never by hand:

- `healdesk_migrator` owns every table, function and policy. A table's owner bypasses its
  row-level security unless forced, so the app must never connect as it.
- `healdesk_app` is the runtime role: no `BYPASSRLS`, owns nothing, privileges only through the
  migrations' grants. `DATABASE_URL` points here.

**db-bootstrap** (`healdesk-production-db-bootstrap`, image `healdesk/db-admin`, task role
`healdesk-production-db-admin-task`) takes no arguments. It connects as the RDS master user with
libpq's own variables: `PGUSER` and `PGPASSWORD` come from the RDS-managed secret as ECS secrets,
`PGHOST` and the rest as plain environment; it refuses any `PGSSLMODE` but `verify-full`. It runs
init-secrets (above), reads both role passwords back through its task role, turns each into a
SCRAM-SHA-256 verifier (`scram-verifier.py`), and runs `provision-roles.sql` with the verifiers, so
the server never receives a role password and a failed `ALTER ROLE` cannot put one in the engine
log. It then prints the role attributes and signs in as each role with the password Parameter
Store holds, so a run that succeeds proves both URLs will connect. Re-running it is safe: it keeps
every value and re-sets both passwords to what they already are. If a run generated a new
password, it says so: web or worker tasks already running hold the old URL and need a restart.

**Migrations** run as `healdesk_migrator` in the `healdesk-production-migrate` task, before every
rollout: `npm run db:migrate -w @healdesk/app && npm run queue:install -w @healdesk/app`. They
never run at boot and never from a laptop as routine.

- **Forward only.** There are no down migrations, so a schema change is expand, deploy, then
  contract in a later release. That is also what keeps a code rollback safe.
- **`queue:install` runs on every deploy** with `migrate`. It is idempotent and must run after any
  new queue or pg-boss upgrade. This is the Stripe guide's "Install the queues on app.healdesk.io"
  (Task 10).
- **A failed migration says little.** `drizzle-kit migrate` can exit 1 with no error text. The
  reason is in the engine log, `/aws/rds/instance/healdesk-production/postgresql`: its ERROR line,
  never the failing statement.
- **Connections.** Each web or worker process holds up to 10 (Drizzle) plus 4 (pg-boss), shared
  task or not, and each voice process up to 10 (Drizzle; its code starts no pg-boss); a
  `db.t4g.micro` allows roughly 100, a `db.t4g.small` roughly 200.

`MIGRATION_DATABASE_URL` is not checked in code the way `DATABASE_URL` is (drizzle-kit and
`install-queue.ts` read it directly); db-bootstrap writes it with `verify-full`, and nothing else
should write it.

---

## Rollback

- **Automatic.** Every service has the deployment circuit breaker with rollback: a deployment
  whose tasks never become healthy goes back to the last one that completed, and the deploy job
  fails. With one task, ECS needs three failed launches to decide, which can outlast the job's
  15-minute wait; the breaker still acts afterwards. Read the service's events before deploying
  again.
- **A failed first deploy goes back to 0 tasks, not to an earlier version.** The only completed
  deployment behind a service's first rollout is Terraform's revision at 0 tasks, whose image tag,
  `terraform-placeholder`, was never pushed. Left alone, the breaker would return there at the
  count the run set and retry a pull that cannot succeed, so `deploy-app.yml` sets such a service
  back to 0 ("Put a failed first rollout back to 0 tasks"). Fix the cause and deploy again; that
  run starts it afresh.
- **Back to an earlier commit, now:** from a terminal with `gh`,
  `gh workflow run deploy-app.yml --ref main -f rollback_to=<commit>`, with the commit a past
  deploy's summary names. It builds and migrates nothing; it moves web, worker and voice to the
  newest ACTIVE revisions whose images are that commit's and still in ECR (the last 30 per
  repository), and never to Terraform's placeholder revisions. With voice on, a commit deployed
  before voice was switched on has no voice revision, and the rollback stops: choose a later
  commit, or switch `enable_voice` off first. A rollback past a Terraform change undoes that
  change on the services until the next full deploy, because the old revisions carry the
  configuration of their day.
- **By hand, if the workflow itself is the problem** (CloudShell, as the administrator). Choose
  the revision by its image, never by its number: a Terraform change leaves an ACTIVE placeholder
  revision between two deploys, and picking it fails with `CannotPullContainerError`.

  ```bash
  for td in $(aws ecs list-task-definitions --region us-east-1 --family-prefix healdesk-production-web \
      --status ACTIVE --sort DESC --max-items 10 --query 'taskDefinitionArns[]' --output text); do
    echo "$td $(aws ecs describe-task-definition --region us-east-1 --task-definition "$td" \
      --query "taskDefinition.containerDefinitions[?name=='app'] | [0].image" --output text)"
  done
  ```

  Pick the newest revision older than the running one whose image ends in a commit SHA, then:

  ```bash
  aws ecs update-service --region us-east-1 --cluster healdesk-production \
    --service healdesk-production-web --task-definition healdesk-production-web:REVISION
  aws ecs wait services-stable --region us-east-1 --cluster healdesk-production \
    --services healdesk-production-web
  ```

  and the same for `healdesk-production-worker` and `healdesk-production-voice`, with the
  revision that ran the same commit (for voice, `services-stable` waits for the old tasks' calls,
  up to an hour).
- **Then make main match.** `git revert` the bad commit on main and run a full deploy. Until then
  the next deploy brings the bad code back.
- **Schema.** Rolling code back past a migration is safe only if that migration only added things
  (the expand step). Never write a down migration by hand against production.

---

## One-off tasks from a terminal

`scripts/run-task.sh` runs migrate or db-bootstrap outside GitHub Actions, from AWS CloudShell
signed in to `865780386982`:

```bash
bash run-task.sh migrate        # migrations, then queue:install
bash run-task.sh db-bootstrap   # init-secrets, then the two roles
bash run-task.sh destroy-due    # after a restore only: "Restoring production" below
bash run-task.sh reapply-erasures   # after a restore only, beside destroy-due
bash run-task.sh patient-export CLINIC_ID   # offboarding
bash run-task.sh patient-export CLINIC_ID CONTACT_ID WHO_ASKED   # one person's bundle
bash run-task.sh erase-person CLINIC_ID CONTACT_ID WHO_ASKED you@healdesk.io   # [RECEIVED_AT]
bash run-task.sh amend-contact CLINIC_ID CONTACT_ID FIELDS_TO_CLEAR WHO_ASKED you@healdesk.io
bash run-task.sh demo-clinic "Fictional Practice" "Your Name" you@healdesk.io   # once, ever
bash run-task.sh channels-link CLINIC_ID   # [meta|whatsapp] [days, 1 to 30]
```

`destroy-due` is the worker's container (its environment, secrets and task role) running
`scripts/destroy-due.ts`: it destroys every clinic due for destruction and exits 1 while any is
still due, so `run-task.sh` exits 1 too. Every full deploy registers a revision of it with the
commit's image once the services are running it; the deploy role may register it but not run it.
`run-task.sh` runs the revision naming the image the worker service runs, so after a rollback it
runs the rolled-back code.

`patient-export` produces a leaving clinic's return bundle (`docs/handover.md`, "Retention and
offboarding", step 2) and puts it in the export bucket (`exports.tf`), because the task's disk goes
with it. It is `scripts/patient-export.ts` with the runtime role's `DATABASE_URL` as its only
secret and its own task role, which may put `clinic-*.json` objects in that bucket and do nothing
else: not the app task role, so it cannot open a clinic's credentials, and the web tier and the
worker cannot write to the bucket. It runs with three environment overrides, which CloudTrail
records: the clinic's id, who asked (always `practice`: a whole clinic's bundle is the practice's,
and nothing typed reaches the audit row) and the object key `clinic-<id>-<UTC time>.json`. None is
secret or a patient's. One person's bundle (a patient-rights request) is the same task with the contact's id and who
asked (`practice`, `person_via_practice` or `representative_via_practice`): it exports that contact
and every contact sharing its number or address, under `clinic-<id>-patient-<UTC time>.json`, which
carries the clinic and a time, never the contact. Its phone number or email never travels in an
override; the contact's id does, and until the M5 portal nothing on AWS turns a number into one. The upload happens inside the export's transaction, so a failed upload leaves no
audit row, and the care page refuses a handover until a bundle exists. On success `run-task.sh`
prints the object's key and the next steps, in CloudShell:

```bash
KEY='the clinic-....json key run-task.sh printed'
aws s3 cp "s3://healdesk-production-exports-865780386982/$KEY" .
# Actions > Download file, hand it to the clinic over its own channel for patient data
# (docs/incident-response.md, "Patient rights requests", step 3; never a plain email attachment),
# then delete both copies here:
aws s3 rm "s3://healdesk-production-exports-865780386982/$KEY"
rm -f "$KEY"
# ...and the file you downloaded, from your own computer, once it is handed over.
```

The bucket is SSE-KMS under the product key, TLS only, private and not versioned, so the delete
is final; an object nobody deletes goes after a day (S3 counts to the next midnight UTC, so 24 to
48 hours), so a bundle made late on the destruction clock cannot outlive the data it copied by more
than that: download it straight after the run. Every read and write of an object is a
CloudTrail data event. Then record the handover on the clinic's care page.

`erase-person` and `amend-contact` are the patient-rights operator scripts
(`apps/app/scripts/ops-erase-person.ts`, `ops-amend-contact.ts`; `docs/handover.md`, "Deletion
requests" and "Amendments"). On this host the person is named by a contact's id, found in the ops
console first, never by a number, an address or a name: the scripts refuse typed patient data in
production, and `run-task.sh` passes only the clinic's and contact's ids, who asked (`practice`,
`person_via_practice` or `representative_via_practice`), the operator's work address, and for
erasure the day the request came (an ISO date), for an amendment the fields to clear (`fullName`,
`phone`, `email`; new values wait for the portal). Each has the runtime role's `DATABASE_URL`,
erasure also `HEALDESK_IDENTIFIER_REF_KEY`, and no task role: neither calls an AWS service. Their
result (the request id, counts, any deadline) is in the task's log stream, ids and numbers only.
`reapply-erasures` takes no arguments: after a restore it deletes again every person whose
deletion the restored database still remembers (`docs/handover.md`, "Restoring", step 5), with the
runtime URL and `HEALDESK_IDENTIFIER_REF_KEY`, and exits 1 if any clinic could not be done.

`demo-clinic` makes healdesk's one demo clinic (`apps/app/scripts/demo-clinic.ts`): a fictional
practice the owner allowed in production, signed and provisioned as a purchase would be but with
billing status `demo` and no Stripe ids, so it costs nothing while Stripe holds live keys. The
address must be `HEALDESK_ADMIN_EMAIL` or `HEALDESK_OPS_EMAIL`; it becomes the clinic's one
sign-in and receives the signed agreement's PDF. A second run is refused. It has the mail
settings, the runtime URL and `RESEND_API_KEY`, and no task role. `channels-link` issues a
clinic's single-use connect links (`/channels/meta/...`, `/channels/whatsapp/...`), with the
public origin and the runtime URL only. Both print to their task's log stream, and for these two
`run-task.sh` prints the `aws logs get-log-events` command that reads it. The link is a working
credential that connects the clinic's Meta accounts once, so it stays in CloudWatch: copy it from
there, and nowhere else.

It borrows the web service's private subnets and security group (refusing if the service is
missing or would give a public address), runs the family's newest ACTIVE revision that names a
deployed image (never Terraform's `terraform-placeholder` revisions, and it says which it ran and
why), passes no overrides, waits until the task stops (`RUN_TASK_TIMEOUT_MINUTES`, default 30),
prints ECS's stop code, stopped reason and the container's exit code with the log group and
stream, and exits 1 unless the exit code is 0. It never prints the task's own output. Because it
runs the last revision the deploy workflow registered, a Terraform change to that task definition
reaches it only after the next full deploy.

---

## Restore drill

Required before the first live clinic (`docs/hipaa-risk-analysis.md` T9: "No restore drill has
been run"). A restore is a PHI access: log it in `security_events` before you start
(`docs/policies/access-control.md`), and give the copy a name with no PHI in it. Point-in-time
recovery is a physical restore, so the triggers that refuse a data-only load (handover,
"Restoring") do not come into it; a `pg_dump` data-only load follows the handover's steps instead.

```bash
# CloudShell, as the administrator. Record the time now: it starts the RTO.
export AWS_REGION=us-east-1
DRILL=healdesk-restore-drill-$(date -u +%Y%m%d)
RDS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=healdesk-production-rds \
  --query 'SecurityGroups[0].GroupId' --output text)

# 1. Point-in-time restore to a NEW instance. Keep every flag: without them RDS uses the default
#    subnet group, security group and parameter group, and the copy could be public.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier healdesk-production \
  --target-db-instance-identifier "$DRILL" \
  --use-latest-restorable-time \
  --db-subnet-group-name healdesk-production \
  --vpc-security-group-ids "$RDS_SG" \
  --db-parameter-group-name healdesk-production-postgres17 \
  --ca-certificate-identifier rds-ca-rsa2048-g1 \
  --db-instance-class db.t4g.micro \
  --backup-retention-period 0 \
  --no-multi-az --no-publicly-accessible --no-deletion-protection
aws rds wait db-instance-available --db-instance-identifier "$DRILL"   # the end of the RTO

# 2. The copy: available, encrypted with alias/healdesk-production, private.
aws rds describe-db-instances --db-instance-identifier "$DRILL" --query \
  'DBInstances[0].[DBInstanceStatus,StorageEncrypted,KmsKeyId,PubliclyAccessible,Endpoint.Address]'
```

Then check inside it, without any new access path, by running db-bootstrap against the copy with
only its host overridden (a host name, not a secret, so the override is fine in CloudTrail):

```bash
TD=""
for arn in $(aws ecs list-task-definitions --family-prefix healdesk-production-db-bootstrap \
    --status ACTIVE --sort DESC --max-items 25 --query 'taskDefinitionArns[]' --output text); do
  img=$(aws ecs describe-task-definition --task-definition "$arn" \
    --query "taskDefinition.containerDefinitions[?name=='db-admin'] | [0].image" --output text)
  case "$img" in *:terraform-placeholder | None | '') continue ;; esac
  TD=$arn
  break
done
echo "running $TD"
NET=$(aws ecs describe-services --cluster healdesk-production --services healdesk-production-web \
  --query 'services[0].networkConfiguration' --output json)
HOST=$(aws rds describe-db-instances --db-instance-identifier "$DRILL" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
TASK=$(aws ecs run-task --cluster healdesk-production --task-definition "$TD" \
  --launch-type FARGATE --network-configuration "$NET" --started-by restore-drill \
  --overrides "{\"containerOverrides\":[{\"name\":\"db-admin\",\"environment\":[{\"name\":\"PGHOST\",\"value\":\"$HOST\"}]}]}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster healdesk-production --tasks "$TASK"
aws ecs describe-tasks --cluster healdesk-production --tasks "$TASK" \
  --query "tasks[0].[stopCode, stoppedReason, containers[?name=='db-admin'] | [0].exitCode]"
```

Exit code 0 means the copy accepted `verify-full` TLS, the master sign-in, the role provisioning
and both roles' sign-ins. init-secrets keeps all six values and notes that the URLs name the
production host, not the copy: that is expected while `PGHOST` is overridden, and production's
URLs must not follow it. The master sign-in uses the RDS-managed secret, whose value the copy
shares unless RDS rotated it since the restore point. The output is in
`/healdesk/production/db-bootstrap`.

For catalog figures (never rows), this build deliberately has no operator path into the VPC (no
bastion, no ECS Exec): create a temporary CloudShell VPC environment in a private subnet with the
`healdesk-production-tasks` security group, install a client (`sudo dnf install -y postgresql16`),
download the RDS bundle, connect as `healdesk_migrator` with `sslmode=verify-full`, and read
`select count(*) from drizzle.__drizzle_migrations;` and
`select relname, reltuples::bigint from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;`.
The migrator's password is the one in `migrator/MIGRATION_DATABASE_URL`; type it at psql's
prompt, never on a command line. Delete the VPC environment afterwards.

Finish the same day, and in any case within 35 days (the clinic agreement's backup promise):

```bash
aws rds delete-db-instance --db-instance-identifier "$DRILL" --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$DRILL"
aws rds describe-db-snapshots --db-instance-identifier "$DRILL"                    # expect none
aws rds describe-db-instance-automated-backups --db-instance-identifier "$DRILL"   # expect none
```

Never take a manual snapshot of the copy. Record the RTO (restore command to available), the RPO
(latest restorable time, normally within five minutes of the last write), the closing
`security_events` entry, a Reviews row in `docs/policies/training-log.md`, and the result in T9.
The copy costs a few cents an hour while it exists.

---

## Restoring production

The drill proves a backup can be read. Putting a restored copy in production's place is **not
designed in full or rehearsed**: do both before the first live clinic, with the drill. What is
fixed is the order, set by `docs/handover.md` ("Restoring"): a restore brings back every clinic
destroyed since the point restored to, with its patients, so destruction runs again before
anything reads the data.

1. Log the restore in `security_events`, as for the drill.
2. Stop the service, so nothing serves or writes the restored data before step 6:

   ```bash
   # With the worker in the web task (the lean default) there is only the web service; add
   # healdesk-production-worker to both lists when worker_placement is "separate", and
   # healdesk-production-voice when enable_voice is on (its calls drain first, up to an hour).
   for s in healdesk-production-web; do
     aws ecs update-service --cluster healdesk-production --service "$s" --desired-count 0 \
       --query 'service.desiredCount' --output text
   done
   aws ecs wait services-stable --cluster healdesk-production \
     --services healdesk-production-web
   ```

3. Restore, and make the copy production's database. **This is the open part.** What is known:
   RDS names the endpoint after the instance identifier, so renaming production away
   (`modify-db-instance --new-db-instance-identifier`) and then the copy to
   `healdesk-production` keeps every URL in Parameter Store right; the restore call needs
   production's settings, not the drill's (35 days of backups, deletion protection, the
   `postgresql` log export, the master password managed by RDS); and Terraform's state still
   names the old instance until it is re-pointed by a commit with an `import` block, so no
   `infra.yml` apply may run between the swap and that commit.
4. Put back, as `healdesk_migrator`, any destruction dates the restore lost (handover
   "Restoring", step 2), from the CloudShell VPC environment the drill describes.
5. Bring the schema up to the code, destroy what is due, and delete again everyone deleted since
   the point restored to (handover "Restoring", step 5):

   ```bash
   bash run-task.sh migrate
   bash run-task.sh destroy-due
   bash run-task.sh reapply-erasures
   ```

   `destroy-due` uses the runtime role's `DATABASE_URL` from Parameter Store, which names
   production's endpoint: it runs against the copy only once step 3 has given the copy that name.
   Do not go on until it exits 0. A clinic still due is named, by id only, in
   `/healdesk/production/destroy-due`. `reapply-erasures` is the same for people: it exits 1 while
   any clinic's deletions could not be done again.
6. Reopen: `deploy-app.yml` with `bootstrap_db` and `migrate` ticked. With every service at 0 the
   workflow treats it as a first deploy and asks for both; db-bootstrap keeps every parameter that
   is set and only re-asserts the roles.

Step 4 uses the CloudShell VPC environment as the migrator, typing the password at psql's
prompt. That works, but it is the only write path into the database outside the code, so log
each use in `security_events`. Offboarding's return bundle, the other handover step that needed a
file, is `run-task.sh patient-export` (above).

---

## State-lock recovery

Terraform locks the state with an S3 object beside it,
`s3://healdesk-terraform-state-865780386982/healdesk/production/terraform.tfstate.tflock`, and
removes it at the end of every run. A run killed mid-apply (a cancelled job, a runner lost, a
session that expired) leaves it behind, and every later run waits five minutes on the lock and
fails. The session is sized against that (90 minutes for a 90-minute job, under the role's two
hours; the certificate validation gives up after 30), but a stale lock can still happen.

1. Make sure nothing holds it legitimately: no `infra.yml` run in progress or queued
   (`gh run list --workflow infra.yml --status in_progress` and `--status queued`).
2. As the administrator, in CloudShell:

   ```bash
   aws s3api head-object --bucket healdesk-terraform-state-865780386982 \
     --key healdesk/production/terraform.tfstate.tflock --query LastModified
   aws s3 rm s3://healdesk-terraform-state-865780386982/healdesk/production/terraform.tfstate.tflock
   ```

3. Run `infra.yml` with `plan`. Terraform saves state snapshots as it goes, so only resources
   created in the last moments before the failure can be missing from the state; the plan then
   wants to create them again, and the apply fails on "already exists". Import each one with an
   `import` block applied through `infra.yml`, then remove the block.

The bucket keeps 90 days of earlier state versions. Restoring one is a last resort, done with the
reasons written down, never to undo an apply that worked.

---

## Rotating secrets

Tasks read secrets only when they start, so every rotation ends with a deploy or a restart. The
internal values are rotated by setting them back to `__unset__` and letting db-bootstrap generate
new ones; nothing else ever writes them. Set them in CloudShell with the product key, the value
being the placeholder, never a secret:

```bash
KEY=$(aws kms describe-key --region us-east-1 --key-id alias/healdesk-production --query KeyMetadata.Arn --output text)
for p in db/APP_PASSWORD app/DATABASE_URL; do
  aws ssm put-parameter --region us-east-1 --name "/healdesk/production/$p" --type SecureString \
    --key-id "$KEY" --overwrite --value __unset__ --query Version --output text
done
```

then straight away run `deploy-app.yml` with `bootstrap_db` (and `migrate`), which generates both,
re-sets the role's password and rolls the services onto the new URL.

| Secret | How to rotate | What to know |
| --- | --- | --- |
| RDS master password | Nothing: RDS rotates it every 7 days | Used only by db-bootstrap, which reads it at start |
| `healdesk_app` password (`db/APP_PASSWORD` with `app/DATABASE_URL`) | Both to `__unset__` as above, then a full deploy with `bootstrap_db` | Always the pair: db-bootstrap refuses a new password under an old URL. Between the new role password and the new tasks, the old tasks' new connections fail: do it in a quiet hour |
| `healdesk_migrator` password (`db/MIGRATOR_PASSWORD` with `migrator/MIGRATION_DATABASE_URL`) | The same, with that pair | No service impact: only the migrate task uses it |
| `BETTER_AUTH_SECRET` | `app/BETTER_AUTH_SECRET` to `__unset__`, then at once a full deploy with `bootstrap_db` | Signs every clinic out and voids stop links and pending authenticator enrolments. A web task that starts while it is `__unset__` has no auth secret, hence "at once" |
| `HEALDESK_IDENTIFIER_REF_KEY` | **Never.** Never set it to `__unset__`, never paste or edit it | Every stored identifier reference was made under it: a new key would orphan every open conversation and count every caller again. db-bootstrap never replaces a set value, Terraform never holds it, and `prevent_destroy` stops a plan from deleting it. Rotating it needs a re-key plan first |
| The KMS key | **Never replaced.** Automatic yearly rotation keeps the same ARN and the old key material | The app sends this exact ARN as `KeyId` on every `Decrypt` (`apps/app/src/lib/crypto/kms.ts`), and `rewrap()` cannot bridge two keys, so a new key would orphan every sealed clinic credential. `prevent_destroy`, 30-day deletion window |
| `HEALDESK_PROVISION_SECRET` | `bash put-external-secrets.sh HEALDESK_PROVISION_SECRET` **and** Vercel (Production, and Preview while it points here), then `restart_only` and a Vercel redeploy together | Signed calls answer 401 in between: the Stripe relay retries, checkout shows an error, `/admin` is briefly unavailable |
| `STRIPE_SECRET_KEY` | Roll in Stripe, paste here and on Vercel, `restart_only`, redeploy Vercel | Same account and mode on both sides. Stripe can keep the old key alive for a while when it rolls; use that window |
| `RESEND_API_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET`, `META_APP_SECRET`, `ANTHROPIC_API_KEY` | Vendor console, `bash put-external-secrets.sh <KEY>`, `restart_only` | The Anthropic key is always the HIPAA organisation's, never the marketing one |
| `CLOUDFLARE_API_TOKEN` | Roll in Cloudflare, `bash put-external-secrets.sh CLOUDFLARE_API_TOKEN` | Only `infra.yml` and `host.yml` use it, from their next run |
| `HEALDESK_GITHUB_ACTIONS_TOKEN` (Vercel, not this host) | A new fine-grained token of the owner (Actions read and write, this repository only), set on Vercel's Production, redeploy, then revoke the old one in GitHub | In between `/admin/host` and the first-invoice wake cannot dispatch; `host.yml` from GitHub's page still works |
| ACM certificate | Nothing: ACM renews while the validation records stay in Cloudflare | Terraform keeps those records; never delete them by hand |
| tls-proxy certificate | Nothing: a new key at every task start | Never stored |
| GitHub to AWS | Nothing stored: OIDC, sessions of two hours at most | Revoke by editing the trust policies |

---

## Alarms and monitoring

Nine alarms in the lean profile, all to `healdesk-production-alarms`, each prefixed
`healdesk-production-`: `alb-5xx` and `target-5xx` (five or more in five minutes),
`web-unhealthy-hosts`, `web-below-desired` (healthy targets below `web_desired`),
`nat-instance-status` (the NAT instance failing its EC2 status checks for three minutes),
`rds-cpu` (above 80% for 15 minutes), `rds-free-storage` (below 10%), `rds-freeable-memory`
(below an eighth of the instance's memory: 128 MiB on the micro) and `rds-idle-in-transaction`
(below). With `worker_placement = "separate"` there is a tenth, `worker-below-desired` (no worker
CPU samples for five minutes); a shared worker is an essential container, so its loss stops the
task and `web-below-desired` fires, and a worker that runs but has stalled shows in the
heartbeat the external uptime check reads. With `enable_voice` there is `voice-below-desired`
(healthy voice targets below `voice_desired` for five minutes), in ALARM from the apply that turns
voice on until the next deploy brings its service up. With `nat_mode = "gateway"` there is no
`nat-instance-status`. The budget emails `alarm_email` at 80% and 100% of `monthly_budget_usd`
and when the forecast passes it. The below-desired alarms are in ALARM from the first apply until
the first deploy, by design; alarms email only when their state changes, so the first emails are
usually the OKs after the first deploy.

**The open-transaction alarm is half built.** The handover asks for an alert on any transaction
open longer than five minutes, because one held open is the way around the record clock's day and
offboarding's thirty days. `rds-idle-in-transaction` covers a session idle inside a transaction
for more than 300 seconds, through Performance Insights' `db.state.idle_in_transaction_max_time`
read by CloudWatch's `DB_PERF_INSIGHTS` (no query text, no right on our key). It cannot see a
transaction kept open by one statement running longer than five minutes: Performance Insights
has no counter for the age of an active transaction. That half needs a check run inside the
database and is **open**. No timeout setting stands in for it: one would kill the runtime role's
transactions. Neither half has been seen working against AWS.

What AWS alarms cannot see, and `docs/on-call.md` asks for: an external uptime check on the plain
`GET https://app.healdesk.io/api/health`, hosted outside AWS, alerting on a non-200, on
`heartbeatAgeSeconds` over 7200, and on `db` not `"ok"`. After every deploy, the worker's start-up
line `credential key self-check passed` (or `FAILED`) confirms the task role reaches the key with
lock labels:

```bash
aws logs filter-log-events --region us-east-1 --log-group-name /healdesk/production/worker \
  --filter-pattern '"credential key self-check"' --query 'events[-1].message' --output text
```

GuardDuty findings and AWS Config's rule results are read in the console, and the Config findings
are part of the quarterly review in the account record.

---

## Costs

Figures for us-east-1, on-demand, 730 hours. The original lines were read on 6 October 2026; the
lean lines (Graviton Fargate, the micro database, the nano instance) are AWS's list prices,
checked against third-party price tables on 13 October 2026 rather than AWS's own page, so read
the first bill. This is what the module builds with `production.tfvars` as committed, the lean
profile the owner chose on 13 October 2026:

| Line | $ a month |
| --- | --- |
| ALB: hours 16.43, about 0.25 LCU 1.46, two public IPv4 addresses 7.30 (eight listener rules, inside the ten that are free per request) | 25.19 |
| One web task, ARM64, 0.25 vCPU and 1 GB, carrying the app, the sidecar and the worker | 8.51 |
| RDS `db.t4g.micro` single-AZ 11.68, 20 GiB gp3 2.30; backups free up to the storage size | 13.98 |
| NAT instance: `t4g.nano` 3.07, its public IPv4 address 3.65, its root volume about 0.64; no per-GB processing charge | 7.36 |
| KMS: the product key and the state key, plus requests | 2.20 |
| CloudTrail (S3 storage), CloudWatch Logs and nine alarms | 2.90 |
| Secrets Manager: the RDS master secret only (Parameter Store standard parameters are free) | 0.40 |
| ECR, up to 30 images per repository (the db-admin image is about 680 MB unpacked) | 1.00-2.00 |
| AWS Config, small | 3.00 |
| GuardDuty, foundational | 4.00 |
| SES: the transcript emails, $0.10 per 1,000 (more on SES's newer bundled plans) | under 0.10 |
| **Total, running** | **≈ 70** |

In standby ("Standby") the account costs **about $4 a month**: the two KMS keys, the images, the
database's snapshot and, for 35 days, its automated backups, and a little Config, GuardDuty and
storage; every line above but those is gone.

Between the first apply and the first deploy the service runs no task, so the account costs about
$61.50 a month until then. Fixed-rate lines are exact; usage lines are low-traffic guesses. The
idle-in-transaction alarm reads Performance Insights once a minute; whether that read carries a
charge beyond the alarm's $0.10 has not been measured, so check the first bill. Each KMS key's first
two yearly rotations add $1 a month each. The bootstrap stack alone is about $1 a month. Data
transfer out is expected to stay inside AWS's free 100 GB a month. Not applying the module at all
costs nothing: nothing in the account runs until `infra.yml` applies it.

Nobody has measured the product under load on a quarter vCPU or on the micro database. Watch the
web task's CPU and memory and the database's CPU, freeable memory and connections in the first
weeks; the next step up for each is one variable.

| Lever | Change |
| --- | --- |
| `enable_waf = true` (the per-IP rate limit at the edge; do this before a second web task) | +6.00 |
| `web_cpu = 512` (half a vCPU per web task) | +5.91 |
| `worker_placement = "separate"` (the worker in its own 0.5 vCPU / 1 GB task) | +14.42 on ARM64 |
| `task_cpu_architecture = "X86_64"` (the build then runs under QEMU on the arm64 runner; every task about 25% dearer) | +2.12 for the web task as sized |
| `db_instance_class = "db.t4g.small"` (2 GiB) | +11.68 |
| `nat_mode = "gateway"` (AWS's managed NAT; `nat_gateways = 2` survives losing an AZ) | +29.59 for one, +66.09 for two, plus $0.045 a GB |
| `db_multi_az = true` | +the instance again (+11.68 on the micro) |
| `web_desired = 2` (multiplies the in-memory rate limits; turn the WAF on first) | +8.51 |
| `vpc_endpoints = true` (six interface endpoints in two AZs, plus S3) | +87.60, plus $0.01 a GB |
| `enable_flow_logs = true` | CloudWatch ingestion, by traffic |
| `enable_voice = true` (one voice task, 0.25 vCPU and 1 GB on ARM64, and its alarm; "The voice endpoint") | +8.61 |
| `voice_desired = 2` (a second voice task, so losing one mid-call drops only its own calls) | +8.51 more |
| `container_insights = true`, Database Insights advanced | extra CloudWatch charges |

The shape first built (worker as its own service, NAT gateway, WAF, X86_64, half-vCPU tasks, the
small database) came to about $143.50 a month running and $107 before the first deploy.

`monthly_budget_usd` is 250, so the first alert comes at $200.

---

## The NAT instance

With `nat_mode = "instance"` the private subnets reach the internet through one `t4g.nano`
(`nat.tf`) rather than a NAT gateway. It sees only the app's own TLS, so, like a gateway, it never
holds patient data in the clear; unlike a gateway, it is an instance to look after:

- **Updates.** Its first boot points dnf at the newest Amazon Linux 2023 release and turns on
  `dnf-automatic`, which installs security updates daily. A new kernel needs a reboot, and a new
  image a new instance, which Terraform does not do by itself (it ignores later changes of the
  image). Replace it every quarter, with the access review, and whenever AWS announces a kernel
  fix that matters: add one to `nat_instance_generation` in `production.tfvars`, merge, and run
  `infra.yml` with `plan` (it shows the instance replaced and both private routes moved to the
  new interface) and then `apply`. The new instance boots the newest image. Egress stops for the
  minute or two it takes to boot and fetch its two packages; requests in flight then fail and are
  retried by their callers.
- **Failure.** EC2's automatic recovery moves it to new hardware, with the same addresses, when
  its host fails, and `nat-instance-status` emails the owner. A stopped instance does not come
  back by itself: start it from the console. Until it is back the tasks cannot reach Stripe,
  Google, Anthropic or AWS's APIs (pulling an image included), and calls fall back to the
  clinic's line.
- **Checking it.** It has no key pair, no role and no agent, so there is no shell on it. Its
  console output (EC2 → the instance → Monitor and troubleshoot → Get system log) ends with
  `healdesk-nat: forwarding 443 from 10.40.0.0/16 out of ens5` when the first boot finished.
- **Going back.** `nat_mode = "gateway"` builds the NAT gateway(s), points the private routes at
  them and removes the instance in one apply.

---

## The voice endpoint

`enable_voice` (off in `production.tfvars`) runs the Retell custom-LLM endpoint,
`apps/app/src/voice/server.ts`: a plain Node HTTP and WebSocket server from the app image, one
WebSocket per call, held for the whole call. A Next route handler cannot accept the upgrade, so it
is a process and a service of its own. Turning it on creates:

- **Task definition `healdesk-production-voice`** (`voice_cpu`/`voice_memory`, 0.25 vCPU and 1 GB
  by default, on `task_cpu_architecture`). The process is container `app`: `node --import tsx
  src/voice/server.ts` in `/repo/apps/app` under ECS's init, `stopTimeout` 120, health check
  `GET http://127.0.0.1:3001/health`. It gets the web tier's plain environment without the
  web-only names (`KEEP_ALIVE_TIMEOUT`, the SES events topic, the Meta and Connect ids,
  `HEALDESK_VOICE_ENABLED`), on
  `PORT=3001` and `HOSTNAME=0.0.0.0`, with `HEALDESK_VOICE_REAL_CALLS=1` only under
  `voice_real_calls`; the web tier's secrets, `HEALDESK_RETELL_LLM_SECRET` among
  them; the app task role; log group `/healdesk/production/voice`. Beside it, the `tls-proxy`
  sidecar exactly as in the web task, except its health check, which asks for `/health`: the
  image's own check asks for the web tier's liveness path, which the voice process answers 404.
- **Target group `healdesk-production-voice-tls`** (HTTPS:8443 to the sidecar, HTTP/1.1, health
  check `/health`, deregistration delay 3600 s) and **listener rule `voice`** (priority 350):
  `app.healdesk.io` with `/llm-websocket/*`, after the public host's refusals of the signed paths
  and before its catch-all. The internal host never serves it.
- **Service `healdesk-production-voice`** at 0 tasks, its `DesiredCount` tag from `voice_desired`
  (1), with the web service's circuit breaker, subnets and security group, and no ECS Exec.
- **Alarm `voice-below-desired`**, and the outputs `voice_websocket_url` and `voice_service`.

The deploy role names the voice family and service whether or not voice is on (`iam.tf`): the
workflow reads all three services in one call to learn which exist. The voice log group exists
either way.

**Calls and deploys.** When ECS replaces a voice task it deregisters the target first and stops the
task only once it has drained: the load balancer sends the old task no new call and keeps every
open one until it ends or the hour of `deregistration_delay` runs out. That, not `stopTimeout`
(120 s at most on Fargate), lets a call in progress finish during a deploy. So every deploy,
restart and rollback runs old and new voice tasks side by side for up to an hour, and
`deploy-app.yml` waits only until the new ones serve: their deployment runs all its tasks and the
old one has been told to stop, which ECS does only once the new tasks pass the load balancer's
checks. On SIGTERM the process stops taking calls and records any still open. With
`voice_desired = 1`, losing the task mid-call (a host failure, an out-of-memory kill) drops the
calls on it and leaves Retell nothing to reach until ECS replaces it; with 2, only that task's
calls drop and the other answers the next.

**Turning it on**, in order:

1. The rule (owner, 19 October 2026): the secret may be pasted, and `enable_voice` turned on,
   before the business associate agreements are signed, for a test call on a made-up clinic and
   nothing else. The code holds it, not this page: until `voice_real_calls` is on, the voice
   process answers only the demo clinic, the one `scripts/demo-clinic.ts` makes and
   `app_clinic_is_demo()` names (entitlements `demo`, no Stripe ids, synthetic data). A call for
   any other clinic is put through to that clinic's direct line, or closed with a fixed line where
   it has none, before the assistant says a word, and nothing of it is recorded
   (`apps/app/src/lib/voice/test-calls.ts`); Retell is not asked for the caller's number. That
   protects healdesk's side only: Retell still carries any call its agent is given, and has no
   agreement yet, so no real clinic's Retell agent or call forwarding may point at Retell before
   its agreement is signed. Real patients' calls wait for every link of the BAA
   chain, Retell's included ("What still blocks real patient data"), and then step 6.
2. Generate the secret and paste it, in CloudShell: `openssl rand -hex 32`, then
   `bash put-external-secrets.sh HEALDESK_RETELL_LLM_SECRET`. The script asks for a typed answer:
   `test` for a test call on the demo clinic only, while the agreements are not signed, or `yes`
   once every agreement in the chain is; either saves the same parameter, and the script prints
   what the answer allows. It refuses anything under 32 characters or holding a character a URL
   path would need escaped. Keep the value for step 4, and nowhere else (no ticket, no chat).
3. `enable_voice = true` in `production.tfvars`, merge, run `infra.yml` with `plan` and then
   `apply`, then a full `deploy-app.yml`: it finds the voice service at 0 and brings it up to
   `voice_desired`. `voice-below-desired` is in ALARM in between.
4. In each clinic's Retell agent (in test mode, the demo clinic's only), configure a custom LLM whose WebSocket URL is the
   `voice_websocket_url` output with its placeholders filled:
   `wss://app.healdesk.io/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>`, where the clinic
   id is the clinic's UUID in lower case. Retell appends the call id. The secret is the same for
   every clinic; the path is the only thing that admits Retell's socket, and neither the load
   balancer, the sidecar nor the process logs it.
5. Check: a test call hears the assistant's opening line, and `/healdesk/production/voice` shows
   `voice endpoint ready` (and no `every call is refused` warning, which means the secret is still
   unset). In test mode it also shows `voice endpoint in test mode`, and a call for any clinic but
   the demo clinic logs `retell call refused`. Without `ANTHROPIC_API_KEY`, which still waits for
   Anthropic's agreement, AYA has no model, so after the opening line the test call hears only the
   fixed fallback lines; that is enough to check Retell's protocol fields.
6. Real calls, only once every agreement in the chain is signed: `voice_real_calls = true` in
   `production.tfvars`, merge, run `infra.yml` with `apply`, then a full `deploy-app.yml` (not
   `restart_only`: the flag is in the task definition). Then each real clinic's agent may get the
   address. Turning it back off is the same three steps with `false`.

**Rotating the secret**: paste a new value, run `restart_only`, then update every agent's URL;
calls to an agent not yet updated are refused in between, so do it in a quiet hour.

**Turning it off**: point each clinic's forwarding back to its own line, set `enable_voice = false`
and apply. The apply waits while the voice tasks drain, up to an hour (the service's delete
timeout is 65 minutes, inside `infra.yml`'s 90), so do it in a quiet hour. Then run a full
`deploy-app.yml` (not `restart_only`): the web tasks keep the revision the last deploy registered,
so until then they still carry `HEALDESK_VOICE_ENABLED` and `/admin/map` still shows voice as on.
The log group and its logs stay.

**Cost**, on Fargate ARM64 in us-east-1 at $0.03238 per vCPU-hour and $0.00356 per GB-hour, 730
hours a month: one task of 0.25 vCPU and 1 GB is 5.91 + 2.60 = $8.51 a month, plus $0.10 for its
alarm; `voice_desired = 2` doubles the task line, to $17.02. The load balancer is already paid
for: the voice rule is the ninth, still inside the ten evaluated free per request, and a clinic's
calls add next to nothing in LCUs. Each rollout keeps the old tasks up to an hour longer, about a
cent a task.

---

## Deliberately not built

- **The active-transaction half of the open-transaction alarm.** Above.
- **The transcript bucket, built but off and now superseded.** Since the owner's decision of 13
  October 2026 a transcript is emailed to the clinic through SES when its conversation ends and
  kept nowhere, so nothing will write to S3. `enable_transcript_bucket` still creates the bucket
  (SSE-KMS under the key with bucket keys, TLS only, Block Public Access, versioned, noncurrent
  versions gone in 7 days, objects expiring at `transcript_retention_days`, CloudTrail data
  events) and the task role's statements for it; leave it off. SES is on for the transcript email
  (`ses.tf`); it leaves `HEALDESK_EMAIL_TRANSPORT=resend` for everything else.
- **VPC endpoints.** A variable, off: about $88 a month, and the NAT (instance or gateway) is
  still needed for the vendor APIs.
- **ALB access logs.** Their bucket cannot use our key (ALB delivery supports SSE-S3 only), and
  URLs carry no PHI. **WAF logs and sampled requests**, because they store headers.
- **Staging.** `environment` makes a second state possible (`app.staging.healdesk.io`, its own
  `-backend-config="key=healdesk/staging/terraform.tfstate"`), but a second copy in this account
  would collide on the account-wide pieces (the Config recorder and delivery channel, the trail,
  the GuardDuty detector). Before launch, the Stripe guide's end-to-end test runs against this host
  while it holds test keys.
- **Also left out on purpose:** ECS Exec (a root shell on a PHI container); Enhanced Monitoring
  (it writes to `RDSOSMetrics`, which AWS creates without our key); IAM database authentication
  (15-minute tokens against long-lived pools); AWS Backup (35 days of point-in-time recovery
  already, and nothing may be kept longer); Multi-AZ, Container Insights and flow logs (variables,
  off); read-only root filesystems (the sidecar works with a writable `/tmp` volume; the app needs
  writable mounts first); Fargate ephemeral storage under our key (it needs a
  `fargate.amazonaws.com` grant in the key policy); GuardDuty findings routed to the alarm topic;
  the external uptime check (`docs/on-call.md`).

---

## What still blocks real patient data

A running host unblocks no real patient data by itself. The rule in `CLAUDE.md` stands: synthetic
data only until every link of the chain is in place.

| Link or gate | State |
| --- | --- |
| Clinic to healdesk | Built: accepted inline at checkout (BAA 1.3.0, released and the floor since 12 October 2026) |
| healdesk to Retell | **Not done.** Self-sign the BAA and DPA; per-agent retention at the minimum, PII controls on, recording off, each screenshotted; Retell's US region and encryption at rest confirmed in writing (release gate 15). The product's Retell endpoint is defined ("The voice endpoint", `enable_voice` off) and has never run on AWS |
| healdesk to Anthropic | **Not done.** A separate HIPAA-ready organisation (the setting is organisation-wide and one-way); 30-day retention disclosed, no zero-retention request (gate 17). Only that organisation's key ever goes into `app/ANTHROPIC_API_KEY` |
| healdesk to the database | RDS under the AWS BAA, once this module is applied with the settings above |
| healdesk to AWS | Done 22 September 2026; the Artifact "Active" screenshot is outstanding |
| Clinic to Google | The clinic's own calendar under its own Google agreement; confirmed per clinic |

Nothing in the code checks vendor BAAs, so configuration holds the chain: leave
`META_APP_SECRET`, `META_VERIFY_TOKEN` and `ANTHROPIC_API_KEY` `__unset__`, and
`voice_real_calls` off, until it is complete (`put-external-secrets.sh` asks for a typed `yes`
before each key). With them unset, the Meta webhook answers 503 and the front door has no model
to call. The one exception is the voice line, for a test call on the demo clinic (owner,
19 October 2026): `HEALDESK_RETELL_LLM_SECRET` may be pasted with the answer `test` and
`enable_voice` turned on before the chain is complete, because while `voice_real_calls` is off
the voice endpoint itself answers no clinic but the demo clinic and records nothing of any other
call ("The voice endpoint", "Turning it on"). Retell still carries whatever reaches it, so only the
demo clinic's agent may hold the address until Retell's agreement is signed. With the secret unset, it refuses every call. (The
Synthflow routes' two secrets were retired on 14 October 2026, `ssm.tf`.)

Records and drills still open (the compliance map's §4): this module's first apply and deploy;
the restore drill (T9); the rotation runbook (T6; the table above is its draft, not yet adopted or
exercised); the tabletop exercise; the Security Official's name and sign-off; attorney review, a
penetration test and the access review; the automatic fall-through to the clinic's line (T14), and
until it exists, a check that Retell's own failure behaviour forwards to the clinic's direct line;
and every v1 surface the spec still lists as unbuilt.

---

## Changing this module

- **Run Terraform through `infra.yml`, not from a laptop.** A local `plan` or `apply` needs the
  production state and the administrator's credentials, and leaves `.terraform/`, plan and state
  files behind; `infra/aws/.gitignore` keeps them out of git, but a saved plan is not redacted the
  way a rendered one is. Imports go in as `import` blocks, applied through the workflow, then
  removed.
- **Check locally in Docker** (nothing to install):

  ```bash
  docker run --rm -v "$PWD/infra/aws:/w:ro" -w /w -e TF_DATA_DIR=/tmp/tf --entrypoint sh \
    hashicorp/terraform:1.16.5 -c 'terraform fmt -check -recursive &&
      terraform init -backend=false -input=false -lockfile=readonly >/dev/null &&
      terraform validate && terraform test'
  docker run --rm -v "$PWD/infra/aws:/w:ro" bridgecrew/checkov:3.3.26 -d /w --framework terraform --quiet
  docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.12 \
    .github/workflows/host.yml .github/workflows/infra.yml .github/workflows/deploy-app.yml
  docker run --rm -v "$PWD/infra/aws/bootstrap:/w:ro" python:3.13-slim \
    sh -c 'pip install -q cfn-lint && cfn-lint /w/bootstrap.yaml'
  ```

  Every accepted checkov finding is a `#checkov:skip` with its reason next to the resource. Under
  heavy load `terraform test` can time out starting the AWS provider; run it again.
- **Read every plan for replacements.** `aws_kms_key.main`, every `aws_ssm_parameter` and the
  transcript and export buckets carry `prevent_destroy`, so a plan that would replace them fails.
  `aws_db_instance.main` cannot (standby removes it): `scripts/plan-guard.sh` refuses, in both
  workflows, a plan that deletes or replaces it outside standby's second apply, and AWS's deletion
  protection refuses the delete in any other apply. Anything else marked "must be replaced"
  deserves a second look before apply.
- **A resource standby should remove** gets `count = var.standby ? 0 : 1` (or joins its
  condition), every reference to it an index or a `one()`/`try()`, an entry in
  `plan-guard.sh`'s standby list, and an assertion in the `standby` test run.
- **Retiring a parameter** is a `moved` block from its `aws_ssm_parameter.external[...]` instance
  to `aws_ssm_parameter.retired[...]` (`ssm.tf`), never a bare removal from the list, which every
  plan would refuse.
- **A new signed route** goes into `signed_paths` in `locals.tf`, or the internal host answers it
  404.
- **`postgres_version`** will show an attempted downgrade after AWS's automatic minor upgrade:
  raise it to the running minor, or set it to `"17"`.
- **Flipping `alb_to_task_tls`** on a running service changes its load-balancer container and
  port while the service ignores task-definition changes: plan it, apply, and run a full deploy
  straight after. With voice on, the same holds for the voice service.
- **Turning `enable_voice` off** makes the apply wait up to an hour while the voice tasks drain
  their calls ("The voice endpoint").
- **Raising `alb_idle_timeout`** carries into `KEEP_ALIVE_TIMEOUT` and the sidecar's keep-alive
  automatically; both have to outlast it.
- **`kms_require_lock_labels`** stays true: every sealer sends both labels since the calendar
  build's C6b. Turn it off only to run an older image or to open an envelope sealed without labels
  before resealing it; it shapes IAM alone.
- **Never join an AWS Organization** (IAM Identity Center's organization instance and Control
  Tower create one): an Organization's BAA would then control instead of this account's.
- **Adding an AWS service** means a row in `docs/policies/aws-hipaa-account.md` first, with the
  date the HIPAA Eligible Services Reference was read.

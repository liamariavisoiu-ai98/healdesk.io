# infra/aws: the product host

`apps/app`, the PHI side of healdesk, runs on AWS in the one account designated under the AWS
Business Associate Addendum: account `865780386982`, region `us-east-1`
([docs/policies/aws-hipaa-account.md](../../docs/policies/aws-hipaa-account.md)). This directory
is that host written down as code: a Terraform root module, a CloudFormation bootstrap stack, two
helper images, and the two workflows that apply and deploy it
(`.github/workflows/infra.yml`, `.github/workflows/deploy-app.yml`). The website (`apps/web`,
including `/admin`) stays on Vercel. healdesk.io's DNS stays at Cloudflare.

**Status, 7 October 2026: defined and checked locally, not applied.** No AWS resource exists
until the owner launches the bootstrap stack and runs `infra.yml`. Until every link of the BAA
chain is in place ("What still blocks real patient data", below), the host takes synthetic data
only, like every other copy of `apps/app`.

This file is the engineer's runbook. The owner's step-by-step guide is a separate document written
from it.

---

## The request path

```
 clinic browser, Stripe, Meta ─┐
                               │  1. DNS: Cloudflare answers app.healdesk.io with a CNAME to the
                               │     load balancer. DNS only (grey cloud): no traffic passes
                               │     through Cloudflare.
                               ▼
              ALB healdesk-production (public subnets, two AZs)
                 443: ACM certificate for app.healdesk.io, TLS 1.3/1.2 policy
                 80:  301 to HTTPS
                 WAF: per-IP rate limit, answers 429
                               │  2. HTTPS to 8443, re-encrypted (self-signed certificate,
                               │     not validated by the ALB; the hop is encrypted)
                               ▼
     ECS task healdesk-production-web (private subnets, no public IP)
        tls-proxy (nginx, 8443) ──HTTP 127.0.0.1:3001──► app (Next standalone server)
                               │
                               ├─ 3. Postgres over TLS, verify-full ──► RDS healdesk-production
                               └─ 4. HTTPS out through the NAT gateway ──► Stripe, Meta, Anthropic,
                                     Resend, Google; KMS, SSM, ECR, CloudWatch Logs

 apps/web on Vercel ──HTTPS, HMAC-signed──► the same ALB and host (HEALDESK_APP_URL)

 worker service healdesk-production-worker: no inbound traffic, same database and egress
```

Why each piece is shaped the way it is:

- **DNS only at Cloudflare.** A proxied ("orange cloud") record would make Cloudflare terminate
  TLS, so every patient message, transcript fetch and, later, every voice socket would be
  decrypted on a network with no BAA in the chain. `dns.tf` writes both records with a literal
  `proxied = false`, and the next apply flips back any record someone proxies in the dashboard.
- **Encrypted all the way to the app.** Clinics' BAA promises encryption wherever healdesk
  controls both ends, and that includes the load balancer to the task. Next's standalone server
  speaks plain HTTP, so the web task runs a `tls-proxy` sidecar that makes a fresh key and
  self-signed certificate at every start (never in the image), listens on 8443 and hands each
  request to the app on loopback. `alb_to_task_tls = false` removes the sidecar and targets
  HTTP:3001 instead.
- **Vercel reaches the host over the internet.** Vercel has no private path into the VPC and no
  fixed egress addresses, so the load balancer is internet-facing and nothing can be
  allowlisted. Every server-to-server route (provisioning, agreements and their PDFs, checkout
  intents, relayed billing events, review checks and `/api/ops`) checks an HMAC signature made
  with `HEALDESK_PROVISION_SECRET`, which must be byte-identical on both sides, with the two
  clocks within five minutes. On Vercel `HEALDESK_APP_URL` is `https://app.healdesk.io` (the
  `app_url` output). On this host `HEALDESK_APP_URL` is never set: in `apps/app` it is a
  deny-list for email links, and it would refuse every portal link.
- **429, never 403.** apps/web's Stripe relay retries 401, 429 and 5xx and treats any other 4xx as
  final: it acknowledges the event to Stripe and drops it. So the WAF rule answers 429 with
  `Retry-After: 60`, and there are no AWS managed rule groups (the Core rule set blocks bodies
  over 8 KB; relayed Stripe events reach 1 MB and checkout intents 256 kB).
- **The client's address.** The ALB appends the connecting address to `X-Forwarded-For`
  (`xff_header_processing_mode = "append"`), the sidecar passes the header through unchanged, and
  `apps/app/src/lib/client-ip.ts` takes the last entry, the one the ALB appended
  (`TRUSTED_PROXY_HOPS = 1`), never the first, which the browser writes. Adding a proxy hop in
  front means changing that constant.

---

## What is here, and why

| File | What it holds | Why |
| --- | --- | --- |
| `versions.tf`, `providers.tf`, `.terraform.lock.hcl` | Terraform `~> 1.16`; aws `~> 6.67`, cloudflare `~> 5.27`, random `~> 3.9`, locked with hashes for linux and macOS on both architectures. The aws provider refuses any account but `865780386982`; default tags `Project`, `Environment`, `ManagedBy` | No other account is covered by the BAA. The Cloudflare token comes from the `CLOUDFLARE_API_TOKEN` environment variable, never a Terraform variable, so it is never written into a saved plan |
| `backend.tf` | S3 backend, key `healdesk/production/terraform.tfstate`, native locking (`use_lockfile`); bucket and KMS key passed with `-backend-config` | The state holds every secret Terraform generates, so it lives in the bootstrap stack's private, versioned, KMS-encrypted bucket |
| `variables.tf`, `locals.tf`, `production.tfvars` | Every setting, with validation (region pinned, environment name 2 to 12 characters, exact OIDC subjects, `enable_voice` must stay false); the per-task environment and secret maps; the never-set list | `production.tfvars` holds no secrets. Three values in it must be filled before the first plan (below) |
| `network.tf` | VPC `10.40.0.0/16` over us-east-1a and 1b; public subnets for the ALB and `nat_gateways` NAT gateways (1); private subnets for tasks and RDS; default security group stripped; flow logs and VPC endpoints behind variables, both off | The tasks call vendors on the internet, so NAT is needed whatever else is chosen. Endpoints only take AWS API traffic off the NAT |
| `kms.tf` | One customer-managed key, `alias/healdesk-production`: symmetric, single-region, rotating, `prevent_destroy`. Key policy: account root, CloudWatch Logs for this account's log groups, CloudTrail for this trail | It encrypts the credential vault (`HEALDESK_KMS_KEY_ID`), RDS storage, the master secret, Performance Insights, every SSM parameter, ECR, every log group and the trail. The app pins its ARN, so it is never replaced (see "Rotating secrets") |
| `rds.tf` | PostgreSQL 17.11 on `db.t4g.small`, 20 GiB gp3, encrypted with the key, single-AZ (`db_multi_az`), private, 5432 from the tasks' security group only; 35-day backups, no final snapshot, deletion protection, `prevent_destroy`; master user `healdesk_admin` with an RDS-managed password; database `healdesk`; CA `rds-ca-rsa2048-g1`; `postgresql` log exported; Database Insights standard (free). Parameter group `healdesk-production-postgres17`: `rds.force_ssl=1`, TLS 1.2 minimum, SCRAM, `log_error_verbosity=terse`, `log_statement=none` | Encryption at rest can only be set at creation. 35 days is the clinic agreement's backup promise (1.3.0, release gate 18): no copy of deleted data may outlive it, hence no final snapshot. The engine log is where a failed migration explains itself, and terse verbosity keeps row values and passwords out of it |
| `ssm.tf` | SecureString parameters under `/healdesk/production/`, all under the key. Generated: `db/APP_PASSWORD`, `db/MIGRATOR_PASSWORD`, `app/BETTER_AUTH_SECRET`, `app/HEALDESK_IDENTIFIER_REF_KEY`, `app/DATABASE_URL`, `migrator/MIGRATION_DATABASE_URL`. Pasted by the owner, created as `__unset__`: nine under `app/` | Secrets reach containers only through task-definition `secrets`, resolved at task start. Never in `environment` and never in a run-task override, because CloudTrail records both |
| `ecr.tf` | `healdesk/app`, `healdesk/db-admin`, `healdesk/tls-proxy`: immutable tags, scan on push, the key, last 30 images kept | A git SHA always names the same bytes, and 30 images are weeks of rollback |
| `iam.tf` | Execution role (pull, write our log streams, read our parameters and the master secret, decrypt only through SSM and Secrets Manager); app task role (exactly `GenerateDataKey`, `Decrypt`, `Encrypt` on the key, with no encryption context); db-admin task role (nothing); deploy role `healdesk-production-github-deploy` | The deploy role can push three images, register four task-definition families, update two services, run the two one-off tasks and pass exactly the task roles. It cannot read a secret, use the key, touch RDS or turn on ECS Exec |
| `logs.tf` | `/healdesk/production/{web,worker,migrate,db-bootstrap,tls-proxy}` and `/aws/rds/instance/healdesk-production/postgresql`, each with the key, "Never expire" and `skip_destroy` | AWS addendum §4.2(c) asks for maximum retention. A group AWS creates by itself would get neither our key nor the retention, so every group is created first |
| `alb.tf` | ALB `healdesk-production` (invalid headers dropped, deletion protection, idle timeout 120 s, WAF fail-open); target group `healdesk-production-web-https` (HTTPS:8443, health check `/api/health?probe=liveness`, deregistration 60 s); HTTP 301; HTTPS listener with `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09` | A listener made through the API otherwise defaults to a 2016 policy that allows TLS 1.0. No access logs: their bucket cannot use our key, and URLs carry no PHI |
| `dns.tf` | ACM certificate for `app.healdesk.io`; Cloudflare validation record and the `app` CNAME, both DNS only; `aws_acm_certificate_validation` before the listener | One apply writes the record, waits for issuance and creates the listener. ACM renews by itself while the validation record stays |
| `waf.tf` | Web ACL `healdesk-production`, one rule `rate-limit-per-ip` (`waf_rate_limit`, 2,000 per 5 minutes per IP), custom 429; no managed groups; sampled requests off | Samples and WAF logs would store request headers, which carry session cookies and webhook bearer secrets |
| `ecs.tf` | Cluster `healdesk-production`; task definitions `healdesk-production-{web,worker,migrate,db-bootstrap}`; services `healdesk-production-web` and `-worker` at desired 0, circuit breaker with rollback, no ECS Exec, ignoring `task_definition` and `desired_count`; the disabled voice placeholder | Terraform owns the shape of each task definition; the deploy workflow owns which revision runs and the first scale-up. No ECS Exec: it would put a root shell on a container holding PHI |
| `cloudtrail.tf` | Multi-region trail `healdesk-production`, management events read and write (KMS not excluded), log-file validation, SSE-KMS; bucket `healdesk-production-cloudtrail-865780386982`, TLS-only, versioned, no expiry | Every KMS `Decrypt` is a read event, and "every unwrap is a CloudTrail event" is part of the credential vault's audit story |
| `config.tf` | Recorder for all supported resources; bucket `healdesk-production-config-865780386982` (SSE-S3); rules `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled`, `cloudwatch-log-group-encrypted` | The four rules the handover names; the Security Official reads the findings each quarter |
| `guardduty.tf` | One detector (`enable_guardduty`) | Foundational threat detection; findings are read in the console |
| `alarms.tf`, `budgets.tf` | SNS topic `healdesk-production-alarms` emailed to `alarm_email`; eight alarms; a monthly cost budget (`monthly_budget_usd`, 250) | Alarm messages carry metric names and counts, never patient data |
| `outputs.tf` | `alb_dns_name`, `app_url`, `github_deploy_role_arn`, `ecr_repository_urls`, `rds_endpoint`, `rds_master_secret_arn`, `kms_key_arn`, `alarm_topic_arn`, `parameters_to_fill` | What the next steps need. None is a secret |
| `bootstrap/bootstrap.yaml` | CloudFormation stack `healdesk-bootstrap`: state bucket `healdesk-terraform-state-865780386982` (its own key, `alias/healdesk-terraform-state`), the GitHub OIDC provider, role `healdesk-github-terraform` | What Terraform cannot create for itself. The stack refuses any other account or region; bucket and key are retained if the stack is deleted |
| `images/tls-proxy/` | nginx 1.30.5 (pinned by digest), entrypoint making the key in `/dev/shm`, health-check script | See "The request path" |
| `images/db-admin/` | postgres 17.11 client (pinned by digest), the RDS CA bundle, `apps/app/scripts/provision-roles.sql`, an entrypoint that takes no arguments | The app image has no psql, and the RDS master user is not a superuser |

The app-side changes that came with this module: `apps/app/Dockerfile` copies
`tsconfig.base.json` (the worker and every tsx script crashed without it), adds the RDS us-east-1
CA bundle at `/etc/ssl/rds/us-east-1-bundle.pem` against a pinned checksum, and runs
`apps/app/docker-entrypoint.sh`, which unsets any variable whose value is exactly `__unset__`;
`apps/app/src/lib/env.ts` refuses, in production, a `DATABASE_URL` without
`sslmode=verify-full`; `apps/app/scripts/provision-roles.sql` asserts the role attributes instead
of naming `SUPERUSER`, which only a superuser may do; `apps/app/src/lib/client-ip.ts` reads the
address the ALB appended.

CI's `infra` job (`.github/workflows/ci.yml`) runs `terraform fmt -check -recursive`,
`terraform init -backend=false -lockfile=readonly` and `terraform validate` on every push. No CI
job builds or runs the images; `deploy-app.yml` is the first thing that does.

---

## Secrets and configuration

| Parameter (under `/healdesk/production/`) | Made by | Read by |
| --- | --- | --- |
| `app/DATABASE_URL` | Terraform: `postgresql://healdesk_app:<pw>@<endpoint>:5432/healdesk?sslmode=verify-full&sslrootcert=/etc/ssl/rds/us-east-1-bundle.pem` | web, worker |
| `migrator/MIGRATION_DATABASE_URL` | Terraform, same shape as `healdesk_migrator` | migrate only |
| `db/APP_PASSWORD`, `db/MIGRATOR_PASSWORD` | Terraform (40 alphanumeric characters) | db-bootstrap only |
| `app/BETTER_AUTH_SECRET` | Terraform | web, worker |
| `app/HEALDESK_IDENTIFIER_REF_KEY` | Terraform, `prevent_destroy` | web, worker |
| `app/HEALDESK_PROVISION_SECRET` | The owner; byte-identical to Vercel's | web, worker |
| `app/STRIPE_SECRET_KEY` | The owner; same Stripe account and mode as Vercel's | web, worker |
| `app/RESEND_API_KEY` | The owner; apps/app's own sending-only key | web, worker |
| `app/STRIPE_CONNECT_WEBHOOK_SECRET` | The owner, from doorbell B | web |
| `app/META_APP_SECRET`, `app/META_VERIFY_TOKEN`, `app/ANTHROPIC_API_KEY` | The owner, once the BAA chain allows | web |
| `app/HEALDESK_VOICE_WEBHOOK_SECRET`, `app/HEALDESK_VOICE_TOOLS_SECRET` | Leave unset: these are the Synthflow routes, which must never carry a real call | web |
| RDS master secret (Secrets Manager, managed by RDS, rotated every 7 days) | RDS | db-bootstrap only |

- **`__unset__`.** ECS refuses to start a task whose parameter does not exist, so Terraform
  creates the owner's nine parameters holding the literal `__unset__` (with
  `ignore_changes = [value]`, so Terraform never overwrites a pasted value). The image's
  entrypoint removes every variable with exactly that value and logs the names it removed, never
  a value. A feature whose secret is still `__unset__` stays off instead of failing on a
  placeholder. The one exception to "stays off": `HEALDESK_PROVISION_SECRET` is required, and
  until it is pasted every signed route answers 500.
- **Pasting a value.** Use the customer key, not the account default: `aws ssm put-parameter
  --name /healdesk/production/app/<NAME> --type SecureString --key-id <kms_key_arn> --overwrite
  --value=...`. Without `--key-id`, SSM re-encrypts the value with the account's default
  `aws/ssm` key, outside our key policy, and Terraform sees the key change as drift. Then run
  `deploy-app.yml` with `restart_only`: tasks read their parameters only when they start.
- **Plain environment** (in the task definitions, from `locals.tf`): `NODE_ENV=production`,
  `BETTER_AUTH_URL=https://app.healdesk.io`, `HEALDESK_KMS_PROVIDER=aws-kms`,
  `HEALDESK_KMS_KEY_ID=<the key's full ARN>`, `AWS_REGION=us-east-1`,
  `HEALDESK_EMAIL_TRANSPORT=resend`, `HEALDESK_EMAIL_FROM`, `HEALDESK_ADMIN_EMAIL`,
  `HEALDESK_OPS_EMAIL` (when set), `NODE_EXTRA_CA_CERTS`; the web tier adds `PORT=3001`,
  `HOSTNAME=0.0.0.0`, `KEEP_ALIVE_TIMEOUT` (idle timeout + 5 s, so 125000) and, when filled in
  `production.tfvars`, `META_APP_ID`, `META_LOGIN_CONFIG_ID`, `META_WHATSAPP_CONFIG_ID` and
  `STRIPE_CONNECT_CLIENT_ID` (the worker gets the Connect client id too: offboarding revokes
  Connect access with it). An empty variable is left out, not set to `""`.
- **Never set on web or worker**, enforced by a precondition that fails the plan:
  `HEALDESK_APP_URL`, `MIGRATION_DATABASE_URL`, `HEALDESK_LOCAL_KEK`,
  `HEALDESK_DIRECT_BOOKING_ENABLED`, `HEALDESK_PHASE_TWO_ATTRIBUTION`, `BETTER_AUTH_SECRETS`.
- **The state holds secrets.** Every generated value is in the Terraform state, and Terraform
  reads SecureString parameters back decrypted when it refreshes, so after the first plan that
  follows a paste the state holds the pasted values too. That is why the state bucket has its own
  key, no public access and TLS-only access, and why `infra.yml` uploads the rendered plan (which
  redacts sensitive values) and never the plan file.

---

## First run, in order

Every step that needs the owner's sign-in is in the founder's guide, with the exact commands and
clicks. This is the order and what each step leaves behind.

1. **Merge to main, with three values filled.** `infra.yml` and `deploy-app.yml` run from main
   only, and `workflow_dispatch` only sees workflows on the default branch. Commit
   `.terraform.lock.hcl` with the module: both inits use `-lockfile=readonly` and fail without it.
   Fill `cloudflare_zone_id` (Cloudflare, healdesk.io, Overview, API, "Zone ID"), `alarm_email`
   and `healdesk_admin_email` (byte-for-byte the `HEALDESK_ADMIN_EMAIL` on Vercel; nothing checks
   that they match) in `production.tfvars`. The plan refuses while any is blank.
2. **Pre-flight in the account** (read-only, from CloudShell): `aws guardduty list-detectors`,
   `aws configservice describe-configuration-recorders`,
   `aws iam list-open-id-connect-providers`. A region holds one GuardDuty detector and one Config
   recorder: if either exists, import it (an `import` block in `guardduty.tf` or `config.tf`,
   applied through `infra.yml`) or set `enable_guardduty = false`; otherwise the apply fails on the
   duplicate. If the GitHub provider exists, launch the stack with
   `CreateGitHubOidcProvider=false`.
3. **Launch `bootstrap/bootstrap.yaml`** once, as stack `healdesk-bootstrap`, in us-east-1, with
   the IAM acknowledgement (`CAPABILITY_NAMED_IAM`). Outputs: `StateBucketName`,
   `StateKmsKeyArn`, `TerraformRoleArn`.
4. **GitHub.** Repository variables (not secrets; none is sensitive): `TF_STATE_BUCKET`,
   `TF_STATE_KMS_KEY_ARN`, `AWS_TERRAFORM_ROLE_ARN` from the stack outputs. Repository secret
   `CLOUDFLARE_API_TOKEN`: a Cloudflare API token from the "Edit zone DNS" template, scoped to the
   healdesk.io zone only. Environment `production`: deployment branches limited to `main`, and the
   owner as required reviewer where the plan allows it. GitHub ignores the case of environment
   names, so this is the `Production` environment the repository already has (most likely made
   by Vercel's deployments); both trust policies list both spellings because the token may carry
   either. Deployment-branch rules on a private repository need GitHub Pro or Team, and required
   reviewers need Enterprise. The branch rule is what actually keeps a branch from assuming the
   roles: both roles trust every job in that environment, and a branch can edit a workflow, so
   the workflows' own "main only" checks are a message, not a control.
5. **`infra.yml` with `plan`, read it, then `apply`.** The apply makes a fresh plan and applies
   exactly that saved plan in the same job; read a `plan` run first and check the apply's plan
   matches. The first apply creates about a hundred resources, waits for ACM to issue the
   certificate through the Cloudflare record, then creates the listener and the services at 0
   tasks. RDS takes the longest. The run ends by printing the outputs.
6. **Set `AWS_DEPLOY_ROLE_ARN`** (a GitHub variable) to the `github_deploy_role_arn` output.
7. **Confirm the SNS subscription** from the email AWS sends to `alarm_email`. Until the first
   deploy, `healdesk-production-web-below-desired` and `-worker-below-desired` are in ALARM by
   design (missing data counts as breaching).
8. **Paste the external parameters** (`parameters_to_fill`): `HEALDESK_PROVISION_SECRET` (a new
   random value, `openssl rand -base64 32`, set on Vercel in step 10 with the same bytes),
   `STRIPE_SECRET_KEY` (the test key first: the end-to-end test runs on this host before launch),
   `RESEND_API_KEY`. Leave `META_*`, `ANTHROPIC_API_KEY` and the two voice secrets as they are.
9. **`deploy-app.yml` with `bootstrap_db` ticked** (and `migrate`, the default). It creates the two
   roles, migrates, installs the queues, and brings both services from 0 to their `DesiredCount`
   tags.
10. **Vercel**: `HEALDESK_APP_URL=https://app.healdesk.io` and the same
    `HEALDESK_PROVISION_SECRET`, then redeploy (Vercel applies variables only to new deployments).
    Production gets them now. Preview gets them too while this host holds Stripe test keys and
    synthetic data, so the Stripe guide's Task 9 can run from a preview; on launch day, when this
    host moves to live keys, take both off Preview, or every branch preview would provision
    against the production PHI host.
11. **Check**: `https://app.healdesk.io/api/health?probe=liveness` answers `{"ok":true}`;
    `https://app.healdesk.io/api/health` shows `"db":"ok"` and, within the hour, a
    `heartbeatAgeSeconds`; the worker log shows `credential key self-check passed`; the first
    sign-in at healdesk.io/admin enrols a new authenticator, because its second factor lives in
    this host's database, which is new.

---

## Deploying

`deploy-app.yml` runs by hand, from main, in the `production` environment, as
`healdesk-production-github-deploy` over OIDC. It shares the concurrency group
`healdesk-aws-production` with `infra.yml`, so an apply never runs beside a deploy.

| Input | Default | Meaning |
| --- | --- | --- |
| `bootstrap_db` | false | Run db-bootstrap before migrating. Once, on a new database; again only to re-set the two role passwords |
| `migrate` | true | Run migrations and `queue:install` before the services move. A first deploy must |
| `restart_only` | false | Build and migrate nothing: start fresh tasks of the revisions already running, so they re-read their parameters |

A full run, in order:

1. Checks: `AWS_DEPLOY_ROLE_ARN` set, ref is main, `restart_only` without `bootstrap_db`.
2. Reads both services: task families, desired counts, and the private subnets and security group
   the one-off tasks borrow from the web service. A service still at 0 has never been deployed;
   such a run must migrate, and afterwards brings it to its `DesiredCount` tag (`web_desired`,
   `worker_desired`).
3. Builds and pushes `healdesk/app` (repo root), `healdesk/tls-proxy` and `healdesk/db-admin`,
   `linux/amd64`, tagged with the commit SHA. An image already pushed for the commit is reused,
   so a re-run never rebuilds or double-pushes.
4. Registers new revisions from each family's latest one (Terraform's configuration, or the last
   deploy's) with the new images, then runs db-bootstrap (if asked) and migrate as one-off Fargate
   tasks with no overrides, waiting up to 20 minutes each. A non-zero exit fails the job with the
   exit code, ECS's stopped reason and the log group and stream. The container's own output is
   never printed in the job: migration errors can quote SQL and row values.
5. Rolls the worker, then the web tier, each waiting for stability (15 minutes) and failing if the
   circuit breaker rolled it back.
6. Smoke test: `https://app.healdesk.io/api/health?probe=liveness` until it answers 200 with
   `{"ok":true}`, from outside, through Cloudflare's DNS, the ALB and the sidecar.

Two things that are easy to get wrong:

- **A Terraform change to a task definition** (a tfvars value such as `stripe_connect_client_id`,
  a new environment variable) reaches the services on the next **full** deploy. `restart_only`
  restarts the revisions already running and does not pick it up.
- **A Parameter Store change** needs only `restart_only`: ECS resolves secrets at task start.

---

## The database: roles and migrations

Two roles, created once by the db-bootstrap task and then never by hand:

- `healdesk_migrator` owns every table, function and policy. A table's owner bypasses its
  row-level security unless forced, so the app must never connect as it.
- `healdesk_app` is the runtime role: no `BYPASSRLS`, owns nothing, privileges only through the
  migrations' grants. `DATABASE_URL` points here.

**db-bootstrap** (`healdesk-production-db-bootstrap`, image `healdesk/db-admin`) connects as the RDS
master user with libpq's own variables: `PGUSER` and `PGPASSWORD` come from the RDS-managed secret
as ECS secrets, the two role passwords from `db/APP_PASSWORD` and `db/MIGRATOR_PASSWORD`. It
refuses any `PGSSLMODE` but `verify-full` and takes no arguments, so nothing sensitive is ever in a
command. It runs `provision-roles.sql`, then prints the role attributes (both roles `f` for super,
bypassrls, createrole and createdb, `t` for login), the `public` schema ACL and the database ACL
to `/healdesk/production/db-bootstrap`. Re-running it is safe: it re-sets both passwords from
Parameter Store and re-checks everything.

**Migrations** run as `healdesk_migrator` in the `healdesk-production-migrate` task, before every
rollout: `npm run db:migrate -w @healdesk/app && npm run queue:install -w @healdesk/app`. They
never run at boot and never from a laptop as routine.

- **Forward only.** There are no down migrations, so a schema change is expand, deploy, then
  contract in a later release. That is also what keeps a code rollback safe (below).
- **`queue:install` runs on every deploy.** It is idempotent and must run after any new queue or
  pg-boss upgrade. This is the Stripe guide's "Install the queues on app.healdesk.io" (Task 10):
  every deploy with `migrate` does it.
- **A failed migration says nothing.** `drizzle-kit migrate` exits 1 with no error text. The
  reason is in the engine log, `/aws/rds/instance/healdesk-production/postgresql` (terse, so no
  row values). On a first deploy, the usual cause is a run without `bootstrap_db`: the migrator
  role does not exist yet, and the job says so.
- **Wrong credentials fail safely.** The migrate task gets only the migrator URL; if it ever fell
  back to the runtime role, that role cannot create anything.
- **Connections.** Each web or worker process holds up to 10 (Drizzle) plus 4 (pg-boss); a
  `db.t4g.small` allows roughly 200.

`MIGRATION_DATABASE_URL` is not checked in code the way `DATABASE_URL` is (drizzle-kit and
`install-queue.ts` read it directly); Terraform writes it with `verify-full`, and nothing else
should write it.

---

## Rollback

- **Automatic.** Both services have the deployment circuit breaker with rollback: a deployment
  whose tasks never become healthy is rolled back to the last one that completed, and the deploy
  job fails. With one task, ECS needs three failed task launches to decide, which can take longer
  than the job's 15-minute wait: the job then fails on the timeout, and the breaker still rolls
  the service back afterwards. Check the service's events before deploying again.
- **Back to the previous commit, now.** The previous task-definition revision still names the
  previous commit's image (tags are immutable and the last 30 images are kept). As an
  administrator, from CloudShell:

  ```sh
  aws ecs list-task-definitions --family-prefix healdesk-production-web --sort DESC --max-items 3
  # put the number of the revision before the one running in place of PREVIOUS_REVISION
  aws ecs update-service --cluster healdesk-production --service healdesk-production-web \
    --task-definition healdesk-production-web:PREVIOUS_REVISION
  # and the same for healdesk-production-worker if the worker changed
  aws ecs wait services-stable --cluster healdesk-production --services healdesk-production-web
  ```

  The deploy role cannot do this (it registers revisions from the latest one), and
  `deploy-app.yml` has no input for an older commit: it always builds the head of main.
- **Then make main match.** `git revert` the bad commit on main and run `deploy-app.yml`, which
  builds an image of the reverted tree. Until then the next deploy would bring the bad code back.
- **Schema.** Rolling code back past a migration is safe only if that migration only added things
  (the expand step). Never write a down migration by hand against production.

---

## Restore drill

Required before the first live clinic (`docs/hipaa-risk-analysis.md` T9: "No restore drill has
been run"). A restore is a PHI access: log it by hand in `security_events` before you start
(`docs/policies/access-control.md`), and give the copy a name with no PHI in it.

```sh
# From CloudShell, as an administrator. Record the time now: it is the start of the RTO.
DRILL=healdesk-restore-drill-$(date -u +%Y%m%d)
RDS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=healdesk-production-rds \
  --query 'SecurityGroups[0].GroupId' --output text)

# 1. Point-in-time restore to a NEW instance. Keep every flag: without them RDS uses the default
#    subnet group, the default security group and the default parameter group, and in a default
#    VPC with an internet gateway the copy would be publicly accessible.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier healdesk-production \
  --target-db-instance-identifier "$DRILL" \
  --use-latest-restorable-time \
  --db-subnet-group-name healdesk-production \
  --vpc-security-group-ids "$RDS_SG" \
  --db-parameter-group-name healdesk-production-postgres17 \
  --ca-certificate-identifier rds-ca-rsa2048-g1 \
  --db-instance-class db.t4g.small \
  --backup-retention-period 0 \
  --no-multi-az --no-publicly-accessible --no-deletion-protection
aws rds wait db-instance-available --db-instance-identifier "$DRILL"   # end of the RTO

# 2. Check the copy: available, encrypted with alias/healdesk-production, private.
aws rds describe-db-instances --db-instance-identifier "$DRILL" --query \
  'DBInstances[0].[DBInstanceStatus,StorageEncrypted,KmsKeyId,PubliclyAccessible,Endpoint.Address]'
```

Then check inside it:

- **Without any new access path:** run db-bootstrap against the copy, overriding only the host
  (not a secret, so the override is fine in CloudTrail). It connects with `verify-full`, re-sets
  the two passwords to the values they already have, and prints the roles and grants:

  ```sh
  NET=$(aws ecs describe-services --cluster healdesk-production --services healdesk-production-web \
    --query 'services[0].networkConfiguration' --output json)
  HOST=$(aws rds describe-db-instances --db-instance-identifier "$DRILL" \
    --query 'DBInstances[0].Endpoint.Address' --output text)
  aws ecs run-task --cluster healdesk-production --task-definition healdesk-production-db-bootstrap \
    --launch-type FARGATE --network-configuration "$NET" \
    --overrides "{\"containerOverrides\":[{\"name\":\"db-admin\",\"environment\":[{\"name\":\"PGHOST\",\"value\":\"$HOST\"}]}]}"
  ```

  It signs in with the RDS-managed master secret, whose value the copy shares as long as RDS has
  not rotated it since the restore point. Wait for it (`aws ecs wait tasks-stopped --cluster
  healdesk-production --tasks <task arn from the output>`), check its exit code with
  `aws ecs describe-tasks`, and read the roles and grants in `/healdesk/production/db-bootstrap`.
- **Table counts:** this build deliberately has no operator path into the VPC (no bastion, no ECS
  Exec). For a count, create a temporary CloudShell VPC environment in a private subnet with the
  `healdesk-production-tasks` security group, install a client (`sudo dnf install -y postgresql16`),
  download the RDS bundle, connect as `healdesk_migrator` with `sslmode=verify-full`, and read
  catalog figures, never rows: `select count(*) from drizzle.__drizzle_migrations;` and
  `select relname, reltuples::bigint from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;`.
  Row counts as the migrator would read 0 anyway: most tables force row-level security even for
  their owner. Delete the VPC environment afterwards.

Finish the same day, and in any case within 35 days (the clinic agreement's backup promise):

```sh
aws rds delete-db-instance --db-instance-identifier "$DRILL" --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$DRILL"
aws rds describe-db-snapshots --db-instance-identifier "$DRILL"                # expect none
aws rds describe-db-instance-automated-backups --db-instance-identifier "$DRILL"  # expect none
```

Never take a manual snapshot of the copy. Record the RTO (restore command to available), the RPO
(latest restorable time, normally within five minutes of the last write), the closing
`security_events` entry, a Reviews row in `docs/policies/training-log.md`, and the result in T9.
The copy costs a few cents an hour while it exists.

---

## Rotating secrets

Tasks read secrets only when they start, so every rotation ends with a deploy. Generated values
rotate through a reviewed change: add or bump `keepers = { rotated = "<date>" }` on the
`random_password` in `ssm.tf`, merge, and run `infra.yml` apply, which rewrites the parameter and
every URL built from it.

| Secret | How to rotate | What to know |
| --- | --- | --- |
| RDS master password | Nothing: RDS rotates it every 7 days | Used only by db-bootstrap, which reads it at start |
| `healdesk_app` password (`db/APP_PASSWORD`, inside `app/DATABASE_URL`) | `keepers` on `random_password.db_app`, apply, then `deploy-app.yml` with `bootstrap_db` | db-bootstrap sets the new password in Postgres before the services roll. Between that and the new web tasks, the old tasks' new connections fail: do it in a quiet hour |
| `healdesk_migrator` password | `keepers` on `random_password.db_migrator`, apply, then `deploy-app.yml` with `bootstrap_db` | No service impact: only the migrate task uses it |
| `BETTER_AUTH_SECRET` | `keepers` on `random_password.better_auth_secret`, apply, then `restart_only` | Signs every clinic out, and voids stop links and pending authenticator enrolments |
| `HEALDESK_IDENTIFIER_REF_KEY` | **Never.** `prevent_destroy` fails any plan that would replace it | Every stored identifier reference was made under it (`apps/app/src/lib/env.ts`): a new key would orphan every open conversation and count every caller again. Rotating it needs a re-key plan first |
| The KMS key | **Never replaced.** Automatic yearly rotation keeps the same ARN and the old key material | The app sends this exact ARN as `KeyId` on every `Decrypt` (`apps/app/src/lib/crypto/kms.ts`), and `rewrap()` cannot bridge two keys, so a new key would orphan every sealed clinic credential. `prevent_destroy`, 30-day deletion window |
| `HEALDESK_PROVISION_SECRET` | New value into Parameter Store **and** Vercel (Production, and Preview while it points here), then `restart_only` and a Vercel redeploy together | Signed calls answer 401 in between: the Stripe relay retries, checkout shows an error, `/admin` is briefly unavailable. Voids an `/admin` authenticator enrolment in progress |
| `STRIPE_SECRET_KEY` | Roll in Stripe, paste into Parameter Store and Vercel, `restart_only`, redeploy Vercel | Same account and mode on both sides. Stripe can keep the old key alive for a while when it rolls; use that window |
| `RESEND_API_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `META_APP_SECRET`, `ANTHROPIC_API_KEY` | Vendor console, Parameter Store, `restart_only` | The Anthropic key is always the HIPAA organisation's, never the marketing one |
| `CLOUDFLARE_API_TOKEN` | Roll in Cloudflare, `gh secret set CLOUDFLARE_API_TOKEN` | Only `infra.yml` uses it |
| ACM certificate | Nothing: ACM renews while the validation record stays in Cloudflare | Terraform keeps that record; never delete it by hand |
| tls-proxy certificate | Nothing: a new key at every task start | Never stored |
| GitHub to AWS | Nothing stored: OIDC, sessions of an hour at most | Revoke by editing the trust policies |

---

## Alarms and monitoring

The eight alarms, all to `healdesk-production-alarms`: `alb-5xx` and `target-5xx` (five or more in
five minutes), `web-unhealthy-hosts`, `web-below-desired` (healthy targets below `web_desired`),
`worker-below-desired` (no worker CPU samples for five minutes), `rds-cpu` (above 80% for 15
minutes), `rds-free-storage` (below 10%) and `rds-freeable-memory` (below 256 MiB). Each is
prefixed `healdesk-production-`. The budget emails `alarm_email` at 80% and 100% of
`monthly_budget_usd` and when the forecast passes it.

What AWS alarms cannot see, and `docs/on-call.md` asks for: an external uptime check on the plain
`GET /api/health`, hosted outside AWS, alerting on a non-200, on `heartbeatAgeSeconds` over 7200,
and on `db` not `"ok"` (a database outage still answers 200 with `"db":"unreachable"`). After
every deploy, the worker's start-up line `credential key self-check passed` (or `FAILED`) in
`/healdesk/production/worker` confirms the task role reaches the key:

```sh
aws logs filter-log-events --log-group-name /healdesk/production/worker \
  --filter-pattern '"credential key self-check"' --query 'events[-1].message' --output text
```

GuardDuty findings and AWS Config's rule results are read in the console, and the Config findings
are part of the quarterly review in the account record.

---

## Costs

The lean figures from the AWS map (us-east-1, on-demand, 730 hours, prices of 6 October 2026),
adjusted to what this module builds:

| Line | $ a month |
| --- | --- |
| ALB: hours 16.43, about 0.25 LCU 1.46, two public IPv4 addresses 7.30 | 25.19 |
| Fargate web task, 0.5 vCPU and 1 GB (the sidecar shares it) | 18.02 |
| Fargate worker task, 0.5 vCPU and 1 GB | 18.02 |
| RDS `db.t4g.small` single-AZ 23.36, 20 GiB gp3 2.30 | 25.66 |
| One NAT gateway, its address, about 10 GB processed | 36.95 |
| KMS: the product key and the state key, plus requests | 2.20 |
| CloudTrail (S3 storage), CloudWatch Logs and eight alarms | 2.80 |
| Secrets Manager: the RDS master secret only (Parameter Store standard parameters are free) | 0.40 |
| ECR, up to 30 images per repository | 1.00 |
| AWS Config, small | 3.00 |
| GuardDuty, foundational | 4.00 |
| WAF: one ACL, one rule, low traffic | 6.00 |
| **Total** | **≈ 143** |

Against the map's ≈ $132: the worker is 0.5 vCPU and 1 GB rather than 0.25 and 0.5 (+9.01), one
secret instead of fifteen (-5.60), the WAF (+6.00), the state key (+1.00), and three more alarms
and a larger image store (+0.60). Fixed-rate lines are exact; usage lines are low-traffic
guesses. Until the first deploy the services run no tasks, so the account costs about $107 a
month between the first apply and the first deploy. Each KMS key's first two yearly rotations add
$1 a month each. Data transfer out is expected to stay inside AWS's free 100 GB a month.

| Lever | Change |
| --- | --- |
| `nat_gateways = 2` (egress survives losing an AZ) | +36.50, plus processing |
| `db_multi_az = true` | +26.39 |
| `web_desired = 2` (multiplies the in-memory rate limits) | +18.02 |
| `vpc_endpoints = true` (six interface endpoints in two AZs, plus S3) | +87.60, plus $0.01 a GB |
| The voice service, later (at least two tasks) | +36.04 |
| `container_insights = true`, Database Insights advanced | extra CloudWatch charges |

`monthly_budget_usd` is 250, so the first alert comes at $200.

---

## Deliberately not built

- **The S3 bucket for transcripts.** No code uses S3 yet. When it comes: SSE-KMS with the key and a
  bucket key, TLS-only policy, Block Public Access, versioning with noncurrent versions expiring
  within 35 days, no Object Lock (it would block the deletions the agreement promises), a lifecycle
  tied to `clinics.retention_media_days`, no patient identifier in any key, CloudTrail data events
  on the bucket, and `s3:GetObject`/`PutObject`/`DeleteObject` on the app task role. Add the
  bucket row in the account record first.
- **SES.** v1 sends nothing classed `may-carry-phi`, and all mail goes over Resend
  (`HEALDESK_EMAIL_TRANSPORT=resend`; `ses` would break every outbox email today). When the
  urgent-alert decision needs it: a domain identity with DKIM (the records DNS only at
  Cloudflare, a MAIL FROM other than Resend's `send.`), the configuration set `healdesk-phi` with
  `TlsPolicy=REQUIRE`, production access out of the sandbox, and `ses:SendEmail`,
  `ses:SendRawEmail` and `ses:GetConfigurationSet` on the task role.
- **Staging.** `environment` makes a second state possible (`app.staging.healdesk.io`, its own
  `-backend-config="key=healdesk/staging/terraform.tfstate"`), but a second copy in this account
  would collide on the account-wide pieces: the Config recorder and delivery channel, the trail and
  the GuardDuty detector need switches first. Before launch, the Stripe guide's end-to-end test
  runs against this host while it holds test keys.
- **VPC endpoints.** A variable, off: about $88 a month for six interface endpoints, and the NAT
  gateway is still needed for the vendor APIs.
- **The voice endpoint.** Retell holds one WebSocket per call, which a Next route cannot accept.
  `ecs.tf` ends with a disabled placeholder listing what it needs: its own service of at least two
  tasks from this image, its own target group with an HTTP health path and a deregistration delay
  up to 3600 s (ECS waits for draining before it stops a task, and that, not `stopTimeout`, lets a
  call finish), a listener rule such as `/llm-websocket/*`, and an alarm on its liveness.
- **Also left out on purpose:** ALB access logs (their bucket cannot use our key); WAF logs and
  sampled requests (they store headers); ECS Exec (a root shell on a PHI container); Enhanced
  Monitoring (it writes to `RDSOSMetrics`, which AWS creates without our key); IAM database
  authentication (15-minute tokens against long-lived pools); AWS Backup (35 days of
  point-in-time recovery already, and nothing may be kept longer); Multi-AZ and Container
  Insights (variables, off); read-only root filesystems (the sidecar is built for it: switch it on
  once the first deploy's tls-proxy log line shows `/dev/shm` is writable on Fargate; the app
  needs writable mounts first); Fargate ephemeral storage under our key (it needs a
  `fargate.amazonaws.com` grant in the key policy).

---

## What still blocks real patient data

A running host unblocks no real patient data by itself. The rule in `CLAUDE.md` stands: synthetic
data only until every link of the chain is in place.

| Link or gate | State |
| --- | --- |
| Clinic to healdesk | Built: accepted inline at checkout (BAA 1.2.1; 1.3.0 drafted, not released) |
| healdesk to Retell | **Not done.** Self-sign the BAA and DPA; per-agent retention at the minimum, PII controls on, recording off, each screenshotted; Retell's US region and encryption at rest confirmed in writing (release gate 15) |
| healdesk to Anthropic | **Not done.** A separate HIPAA-ready organisation (the setting is organisation-wide and one-way); 30-day retention disclosed, no zero-retention request (gate 17). Only that organisation's key ever goes into `app/ANTHROPIC_API_KEY` |
| healdesk to the database | RDS under the AWS BAA, once this module is applied with the settings above |
| healdesk to AWS | Done 22 September 2026; the Artifact "Active" screenshot is outstanding |
| Clinic to Google | The clinic's own calendar under its own Google agreement; confirmed per clinic |

Nothing in the code checks vendor BAAs, so configuration holds the chain: leave
`META_APP_SECRET`, `META_VERIFY_TOKEN`, `ANTHROPIC_API_KEY` and both voice secrets `__unset__`
until it is complete. With them unset, the Meta webhook answers 503, the front door has no model
to call and the Synthflow routes answer 503.

Records and drills still open (the compliance map's §4): the restore drill (T9) and the rotation
runbook (T6; the table above is its draft); the tabletop exercise; the Security Official's name,
sign-off and the account's alternate contacts reaching them; attorney review, a penetration test
and the access review; the automatic fall-through to the clinic's line (T14), and until it exists,
a check that Retell's own failure behaviour forwards to the clinic's direct line; and the v1
surfaces not built yet (the Retell endpoint, web chat, Google Calendar, the portal's second factor
and access log, the Meta clinical-content boundary, the pre-model guard).

---

## Changing this module

- **Run Terraform through `infra.yml`, not from a laptop.** A local `terraform plan` or `apply`
  needs the production state, writes `.terraform/`, and may leave state or plan files that carry
  the generated secrets in clear; the root `.gitignore` has no Terraform entries yet. Imports go
  in as `import` blocks, applied through the workflow, then removed.
- **Check locally in Docker** (nothing to install):

  ```sh
  docker run --rm -v "$PWD/infra/aws:/w:ro" -w /w -e TF_DATA_DIR=/tmp/tf --entrypoint sh \
    hashicorp/terraform:1.16.5 -c 'terraform fmt -check -recursive &&
      terraform init -backend=false -input=false -lockfile=readonly >/dev/null && terraform validate'
  docker run --rm -v "$PWD/infra/aws:/w:ro" bridgecrew/checkov:3.3.26 -d /w --framework terraform --quiet
  docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.12 \
    .github/workflows/infra.yml .github/workflows/deploy-app.yml
  docker run --rm -v "$PWD/infra/aws/bootstrap:/w:ro" python:3.13-slim \
    sh -c 'pip install -q cfn-lint && cfn-lint /w/bootstrap.yaml'
  ```

  Every accepted checkov finding is a `#checkov:skip` with its reason next to the resource.
- **Read every plan for replacements.** `aws_db_instance.main`, `aws_kms_key.main` and
  `random_password.identifier_ref_key` carry `prevent_destroy`, so a plan that would replace them
  fails; anything else marked "must be replaced" deserves a second look before apply.
- **`postgres_version`** will show an attempted downgrade after AWS's automatic minor upgrade:
  raise it to the running minor, or set it to `"17"`.
- **Flipping `alb_to_task_tls`** on a running service changes its load-balancer container and
  port while the service ignores task-definition changes: plan it, apply, and run a full deploy
  straight after (ECS may need the new revision before it accepts the change).
- **Raising `alb_idle_timeout`** carries into `KEEP_ALIVE_TIMEOUT` and the sidecar's keep-alive
  automatically; both have to outlast it.
- **Never join an AWS Organization** (IAM Identity Center's organization instance and Control
  Tower create one): an Organization's BAA would then control instead of this account's.
- **Adding an AWS service** means a row in `docs/policies/aws-hipaa-account.md` first, with the
  date the HIPAA Eligible Services Reference was read.

# infra/aws: the product host

`apps/app`, the PHI side of healdesk, runs on AWS in the one account designated under the AWS
Business Associate Addendum: account `865780386982`, region `us-east-1`
([docs/policies/aws-hipaa-account.md](../../docs/policies/aws-hipaa-account.md)). This directory
is that host written down as code: a Terraform root module, a CloudFormation bootstrap stack, two
helper images, two terminal scripts, and the two workflows that apply and deploy it
(`.github/workflows/infra.yml`, `.github/workflows/deploy-app.yml`). The website (`apps/web`,
including `/admin`) stays on Vercel. healdesk.io's DNS stays at Cloudflare.

**Status, 12 October 2026: defined and checked locally, not applied.** No AWS resource exists
until the owner launches the bootstrap stack and runs `infra.yml`, and nothing here has run
against AWS. What has been checked: `terraform fmt`, `init -lockfile=readonly`, `validate` and
`test` (22 runs against mocked providers, `tests/stack.tftest.hcl`), tflint, checkov, cfn-lint,
actionlint, and the workflows' scripts against fake AWS commands. Until every link of the BAA
chain is in place ("What still blocks real patient data", below), the host takes synthetic data
only, like every other copy of `apps/app`.

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
                      app + anything else           → forward
                      any other Host                → 404 from the ALB
               80:  301 to HTTPS
               WAF: per-IP rate limit, answers 429
                                       │ HTTPS to 8443, re-encrypted (self-signed certificate,
                                       │ not validated by the ALB; the hop is encrypted)
                                       ▼
     ECS task healdesk-production-web (private subnets, no public IP)
        tls-proxy (nginx, 8443) ──HTTP 127.0.0.1:3001──► app (Next standalone server)
                                       │
                                       ├─ Postgres over TLS, verify-full ──► RDS healdesk-production
                                       └─ HTTPS out through the NAT gateway ──► Stripe, Meta,
                                          Anthropic, Resend, Google; KMS, SSM, ECR, CloudWatch Logs

 worker service healdesk-production-worker: no inbound traffic, same database and egress
```

The signed routes are every `apps/app` path `apps/web` calls on `HEALDESK_APP_URL`, each
authenticated by an HMAC over the body with `HEALDESK_PROVISION_SECRET` (all POST):
`/api/provision`, `/api/billing/events`, `/api/ops`, `/api/agreements`,
`/api/agreements/<id>/pdf`, `/api/reviews/verify`, `/api/checkout/intents` and
`/api/checkout/intents/session`. They are listed once, in `locals.tf` (`signed_paths`, with each
call site), and `alb.tf` builds both sets of rules from that list. **A new signed route must be
added there**, or `apps/web`'s calls to it get the internal host's 404.

Why each piece is shaped the way it is:

- **DNS only at Cloudflare.** A proxied ("orange cloud") record would make Cloudflare terminate
  TLS, so every patient message, transcript fetch, signed call and, later, voice socket would be
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
- **Encrypted all the way to the app.** Clinics' BAA (1.2.1 and 1.3.0) promises encryption
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
| `variables.tf`, `locals.tf`, `production.tfvars` | Every setting, with validation (region pinned, environment 2 to 12 characters, the two hostnames under healdesk.io and different, exact main-branch OIDC subjects, `enable_voice` must stay false, `app_environment` refusing secrets, the stack's own names and the two counsel-gated switches); the per-task environment and secret maps; the signed paths; the never-set list | `production.tfvars` holds nothing secret and nothing personal. `alarm_email`, `healdesk_admin_email`, `healdesk_ops_email` and `cloudflare_zone_id` come from GitHub repository variables as `TF_VAR_*`, so they stay out of git |
| `network.tf` | VPC `10.40.0.0/16` over us-east-1a and 1b; public subnets for the ALB and `nat_gateways` NAT gateways (1); private subnets for tasks and RDS; default security group stripped; flow logs and VPC endpoints behind variables, both off | The tasks call vendors on the internet, so NAT is needed whatever else is chosen. Endpoints only take AWS API traffic off the NAT |
| `kms.tf` | One customer-managed key, `alias/healdesk-production`: symmetric, single-region, rotating, `prevent_destroy`. Key policy: account root (delegating to IAM), CloudWatch Logs for this account's log groups, CloudTrail for this trail by `aws:SourceArn` | It encrypts the credential vault (`HEALDESK_KMS_KEY_ID`), RDS storage, the master secret, Performance Insights, every SSM parameter, ECR, every log group and the trail. The app pins its ARN, so it is never replaced. The key policy names the app's task role nowhere, and must never: a statement naming it without the lock-label conditions would make them moot |
| `rds.tf` | PostgreSQL 17.11 on `db.t4g.small`, 20 GiB gp3, encrypted with the key, single-AZ (`db_multi_az`), private, 5432 from the tasks' security group only; 35-day backups, no final snapshot, deletion protection, `prevent_destroy`; master user `healdesk_admin` with an RDS-managed password; database `healdesk`; CA `rds-ca-rsa2048-g1`; `postgresql` log exported; Database Insights standard (free), Performance Insights under the key for 7 days. Parameter group `healdesk-production-postgres17`: `rds.force_ssl=1`, TLS 1.2 minimum, SCRAM, `log_error_verbosity=terse`, `log_statement=none`, `log_min_error_statement=panic` | Encryption at rest can only be set at creation. 35 days is the clinic agreement's backup promise (1.3.0, release gate 18): no copy of deleted data may outlive it, hence no final snapshot. The engine log never expires: terse drops DETAIL and CONTEXT lines, `none` logs no statement as it runs, and `panic` keeps the text of a *failing* statement out (at the default, `error`, a failed `ALTER ROLE ... PASSWORD '...'` or an `INSERT` carrying patient values is logged in full after its ERROR line). What remains: a primary message that quotes its own input (`invalid input syntax for type uuid: "..."`) |
| `ssm.tf` | SecureString parameters under `/healdesk/production/`, all under the key, all created holding `__unset__` through the write-only `value_wo`: six internal (`db/APP_PASSWORD`, `db/MIGRATOR_PASSWORD`, `app/BETTER_AUTH_SECRET`, `app/HEALDESK_IDENTIFIER_REF_KEY`, `app/DATABASE_URL`, `migrator/MIGRATION_DATABASE_URL`) and eleven external under `app/`; `prevent_destroy` on all | See "Secrets and configuration" |
| `ecr.tf` | `healdesk/app`, `healdesk/db-admin`, `healdesk/tls-proxy`: immutable tags, scan on push, the key, last 30 images kept | A git SHA always names the same bytes, and 30 images are weeks of rollback |
| `iam.tf` | Execution role (pull our images, write our log streams, `ssm:GetParameters` on `app/*` and `migrator/*` only, the RDS master secret, decrypt only through SSM and Secrets Manager); app task role (the credential vault, below; S3 and SES statements only when their flags are on); db-admin task role (`ssm:GetParameter` and `ssm:PutParameter` on exactly the six internal parameters, the key only through SSM and only for those six); deploy role `healdesk-production-github-deploy` | The app task role may call `GenerateDataKey`, `Decrypt` and `Encrypt` on the key only as its own calls (no `kms:ViaService`), only with an encryption context of `healdesk:clinic` and `healdesk:login` and no other key, and, with `kms_require_lock_labels` (the default), with both present: statement 1 of `docs/design/google-calendar-2026-10-05.md` §5. That refuses every context an AWS service puts on its own data under the key, so the role cannot decrypt the parameters, logs or trail even with the ciphertext. The deploy role: "Who can change production", below |
| `logs.tf` | `/healdesk/production/{web,worker,migrate,db-bootstrap,tls-proxy}` and `/aws/rds/instance/healdesk-production/postgresql`, each with the key, "Never expire" and `skip_destroy`; Container Insights and flow-log groups when those are on | AWS addendum §4.2(c) asks for maximum retention. A group AWS creates by itself would get neither our key nor the retention, so every group is created first |
| `alb.tf` | ALB `healdesk-production` (invalid headers dropped, deletion protection, idle timeout 120 s, WAF fail-open, XFF append); target group `healdesk-production-web-https` (HTTPS:8443, health check `/api/health?probe=liveness`, deregistration 60 s); HTTP 301; HTTPS listener with `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09` whose default is a fixed 404; rules `internal_signed` (priorities 100-102), `internal_nothing_else` (200), `public_refuses_signed` (300-302), `public` (400) | A listener made through the API otherwise defaults to a 2016 policy that allows TLS 1.0. A rule takes at most three paths, so each list is split into rules of three. No access logs: their bucket cannot use our key, and URLs carry no PHI |
| `dns.tf` | ACM certificate for `app.healdesk.io` with `app-internal.healdesk.io` as a SAN; one validation record per name and both CNAMEs at Cloudflare, all DNS only; `aws_acm_certificate_validation` with a 30-minute create timeout | One apply writes the records, waits for issuance and creates the listener. Thirty minutes rather than the provider's 75, so a stuck validation fails inside the workflow's AWS session and leaves a clean state. ACM renews by itself while the validation records stay |
| `waf.tf` | Web ACL `healdesk-production`, one rule `rate-limit-per-ip` (`waf_rate_limit`, 2,000 per 5 minutes per IP), custom 429; no managed groups; sampled requests off | Samples and WAF logs would store request headers, which carry session cookies and webhook bearer secrets |
| `ecs.tf` | Cluster `healdesk-production`; task definitions `healdesk-production-{web,worker,migrate,db-bootstrap}`; services `healdesk-production-web` and `-worker` at desired 0, circuit breaker with rollback, no ECS Exec, ignoring `task_definition` and `desired_count`, the web service created only after the certificate, the listener and its rules; the disabled voice placeholder | Terraform owns the shape of each task definition; the deploy workflow owns which revision runs and the first scale-up. No ECS Exec: it would put a root shell on a container holding PHI |
| `cloudtrail.tf` | Multi-region trail `healdesk-production`, management events read and write (KMS not excluded), log-file validation, SSE-KMS; bucket `healdesk-production-cloudtrail-865780386982`, TLS-only, versioned, no expiry; S3 data events on the transcript bucket when it exists | Every KMS `Decrypt` is a read event, and "every unwrap is a CloudTrail event" is part of the credential vault's audit story |
| `config.tf` | Recorder `healdesk-production` for all supported resources, with a role of its own; bucket `healdesk-production-config-865780386982` (SSE-S3); rules `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled`, `cloudwatch-log-group-encrypted` | The four rules the handover names; the Security Official reads the findings each quarter. A custom role, because creating Config's service-linked role fails if the console made it first |
| `guardduty.tf` | One detector (`enable_guardduty`) | Foundational threat detection; findings are read in the console |
| `alarms.tf`, `budgets.tf` | SNS topic `healdesk-production-alarms` emailed to `alarm_email`; nine alarms; a monthly cost budget (`monthly_budget_usd`, 250) | Alarm messages carry metric names and counts, never patient data |
| `storage.tf`, `ses.tf` | The transcript bucket (`enable_transcript_bucket`) and the SES configuration set `healdesk-production-phi` with its domain identity and DKIM records (`enable_ses`). **Both off**: no code uses them yet | See "Deliberately not built" |
| `outputs.tf` | `alb_dns_name`, `app_url`, `internal_url`, `github_deploy_role_arn`, `ecr_repository_urls`, `rds_endpoint`, `rds_master_secret_arn`, `kms_key_arn`, `alarm_topic_arn`, `parameters_to_fill`, `internal_parameters`, `transcript_bucket`, `ses_configuration_set` | What the next steps need. None is a secret |
| `tests/stack.tftest.hcl` | 22 plan-only runs with both providers mocked: production defaults, lock labels off, the bucket and SES on, plain HTTP to tasks, public ids, an imported GuardDuty detector, and 16 refusals | CI's `infra` job runs it; it needs no credentials |
| `bootstrap/bootstrap.yaml` | CloudFormation stack `healdesk-bootstrap`: state bucket `healdesk-terraform-state-865780386982` with its own key (`alias/healdesk-terraform-state`), the GitHub OIDC provider, role `healdesk-github-terraform` | What Terraform cannot create for itself. The stack refuses any other account or region; bucket and key are kept if the stack is deleted, and removed if the launch that created them rolls back (`RetainExceptOnCreate`) |
| `images/tls-proxy/` | nginx 1.30.5 (pinned by digest), an entrypoint making the key and configuration under `/tmp/tls-proxy` (or `TLS_PROXY_RUN_DIR`), keep-alive from `TLS_PROXY_KEEPALIVE_SECONDS` (`alb_idle_timeout + 10`), a health-check script | See "The request paths" |
| `images/db-admin/` | postgres 17 alpine client (pinned by digest), the AWS CLI and Python 3, the RDS CA bundle, `apps/app/scripts/provision-roles.sql`, `scram-verifier.py`, an entrypoint that takes no arguments | The app image has no psql, and the RDS master user is not a superuser. See "The database" |
| `scripts/put-external-secrets.sh` | Pastes the owner's secrets into Parameter Store from AWS CloudShell | See "Secrets and configuration" |
| `scripts/run-task.sh` | Runs the migrate or db-bootstrap task from a terminal | See "One-off tasks from a terminal" |

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
| `app/HEALDESK_VOICE_WEBHOOK_SECRET`, `app/HEALDESK_VOICE_TOOLS_SECRET` | Leave `__unset__`: these are the Synthflow routes, which must never carry a real call | web |
| `ci/CLOUDFLARE_API_TOKEN` (not Terraform's) | The owner, before the first plan, under the bootstrap stack's key | `infra.yml`, after it assumes the Terraform role |
| RDS master secret (Secrets Manager, managed by RDS, rotated every 7 days) | RDS | db-bootstrap only, through the execution role |

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
- **The external eleven: `scripts/put-external-secrets.sh`, in AWS CloudShell.** Upload it, then
  `bash put-external-secrets.sh` walks every key (Enter keeps one as it is),
  `bash put-external-secrets.sh STRIPE_SECRET_KEY RESEND_API_KEY` does only those, and
  `bash put-external-secrets.sh --status` lists each as `set`, `__unset__` or `missing` without
  reading a value out of the AWS CLI. It checks the account, prompts with a hidden read, refuses
  unknown names, inner whitespace, the placeholder itself and multi-line pastes, checks the shape
  of the Stripe (`sk_`/`rk_` of `STRIPE_MODE`, test unless `STRIPE_MODE=live`), Stripe webhook,
  Resend, Anthropic and Google client-id values, asks for a typed `yes` before the five keys that
  open a patient-facing path, writes through a 0600 file under the key the parameter already has,
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
  (the worker gets the Connect client id too: offboarding revokes Connect access with it). An
  empty variable is left out, not set to `""`.
- **Never set on web or worker**, enforced by preconditions that fail the plan and by the deploy
  workflow's shape check: `MIGRATION_DATABASE_URL`, `HEALDESK_LOCAL_KEK`,
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
  hours; `infra.yml` asks for 90 minutes, its whole timeout, so an apply never outlives its
  credentials.
- **`healdesk-production-github-deploy`** (`iam.tf`) can push the three images, register the four
  task-definition families, update the two services, run the two one-off tasks on this cluster,
  pass exactly the execution role and the two task roles, and never turn on ECS Exec. **It is as
  powerful as the code it deploys:** it has no direct read of a secret and no direct use of the
  key, but every task definition it registers and runs receives the execution role's secrets (any
  `app/` or `migrator/` parameter and the RDS master secret) and can carry the app's or the
  db-admin task's role, with internet egress. That power is inherent to a deploy role and cannot be
  narrowed with IAM; the main-branch pin is the control. As defence in depth, `deploy-app.yml`
  checks every task definition it starts from or rolls back to against the shape Terraform gives
  it (containers, roles, the never-set names, Secrets Manager only on db-bootstrap) and stops on
  anything else.
- **No GitHub environment, and no GitHub secret.** Neither job names an environment: one that did
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
6. **`infra.yml` with `plan`, read it, then `apply`.** The apply makes a fresh plan and applies
   exactly that saved plan in the same job; check its `Plan:` line matches the plan run's. The
   first apply creates about a hundred resources, waits for ACM to issue the certificate through
   the two Cloudflare records, then creates the listener, its rules and the services at 0 tasks.
   RDS takes the longest. The run ends by printing the outputs.
7. **Set `AWS_DEPLOY_ROLE_ARN`** to the `github_deploy_role_arn` output
   (`arn:aws:iam::865780386982:role/healdesk-production-github-deploy`).
8. **Confirm the SNS subscription** from the email AWS sends to `alarm_email`. Both
   below-desired alarms most likely went into ALARM before it was confirmed (missing data counts as
   breaching, and nothing runs yet), and SNS sends nothing to a pending subscription, so expect no
   alarm email until the first deploy turns them OK.
9. **Paste the external parameters** (`parameters_to_fill`): `HEALDESK_PROVISION_SECRET` (a new
   random value, set on Vercel in step 11 with the same bytes), `STRIPE_SECRET_KEY` (the test key:
   the end-to-end test runs on this host before launch), `RESEND_API_KEY`, and the two Google
   OAuth values once the client exists. Leave `META_*`, `ANTHROPIC_API_KEY` and the two voice
   secrets as they are.
10. **`deploy-app.yml` with `bootstrap_db` and `migrate` ticked.** A first deploy (both services at
    0) is refused without either. db-bootstrap generates the six internal values and creates the
    two roles, migrate runs the migrations and the queue install, and both services come up to
    their `DesiredCount` tags.
11. **Vercel**: `HEALDESK_APP_URL=https://app-internal.healdesk.io` (the `internal_url` output) and
    the same `HEALDESK_PROVISION_SECRET`, on Production and Preview, then redeploy Production
    (Vercel applies variables only to new deployments). Preview has them only while this host
    holds Stripe test keys and synthetic data, so the Stripe guide's test purchase can run from a
    preview; on launch day, take both off Preview, or every branch preview would provision against
    the production PHI host.
12. **Check**: `https://app.healdesk.io/api/health?probe=liveness` answers `{"ok":true}`;
    `https://app.healdesk.io/api/health` shows `"db":"ok"` and, within the hour, a
    `heartbeatAgeSeconds`; `https://app-internal.healdesk.io/api/health` answers 404 (the internal
    host serves only the signed routes); an unsigned `POST https://app-internal.healdesk.io/api/ops`
    answers 401 from the app (503 means the provision secret is still unset), and the same `POST`
    to `https://app.healdesk.io/api/ops` answers the ALB's 404; the worker log shows
    `credential key self-check passed`; healdesk.io/admin's Ops page loads, which proves the signed
    path end to end, and its first sign-in enrols a new authenticator, because its second factor
    lives in this host's database, which is new.

---

## Deploying

`deploy-app.yml` runs by hand, from main, as `healdesk-production-github-deploy` over OIDC. It
shares the concurrency group `healdesk-aws-production` with `infra.yml`, so an apply never runs
beside a deploy.

| Input | Default | Meaning |
| --- | --- | --- |
| `bootstrap_db` | false | Run db-bootstrap first: fill any internal parameter still `__unset__`, then create the two roles or re-set their passwords from Parameter Store. The first deploy must; later, only to rotate a database password |
| `migrate` | true | Run migrations and `queue:install` before the services move. The first deploy must |
| `restart_only` | false | Build and migrate nothing: start fresh tasks of the revisions already running, so they re-read their parameters |
| `rollback_to` | empty | A commit SHA (7 to 40 hex) from a past deploy's summary: put web and worker back on the newest revisions that ran it (see "Rollback") |

A full run, in order:

1. Checks: `AWS_DEPLOY_ROLE_ARN` set, ref is main, started by the owner, the inputs consistent
   (`restart_only` and `rollback_to` exclusive; neither with `bootstrap_db`).
2. Reads both services: task families, desired counts, and the private subnets and security group
   the one-off tasks borrow from the web service. Both at 0 means nothing has been deployed: the
   run must have `bootstrap_db` and `migrate`, and brings each service up to its `DesiredCount`
   tag (`web_desired`, `worker_desired`) after the migrations pass.
3. Builds and pushes `healdesk/app` (repo root), `healdesk/tls-proxy` and `healdesk/db-admin`,
   `linux/amd64`, tagged with the commit SHA. An image already pushed for the commit is reused.
4. Fetches each family's latest revision (Terraform's configuration, or the last deploy's),
   checks its shape, and registers new revisions with the new images. Runs db-bootstrap (if asked)
   then migrate as one-off Fargate tasks with no overrides, waiting up to 20 minutes each. A
   non-zero exit fails the job with the exit code, ECS's stopped reason and the log group and
   stream; the container's own output is never printed in the job.
5. Rolls the worker, then the web tier, each waiting for stability (15 minutes) and failing if the
   circuit breaker rolled it back. A service this run started from 0 whose rollout fails or is
   cancelled is set back to 0 tasks (below).
6. Smoke test: `https://app.healdesk.io/api/health?probe=liveness` until it answers 200 with
   `{"ok":true}`, from outside, through Cloudflare's DNS, the ALB and the sidecar. The summary
   names the full commit, which is what `rollback_to` takes.

Two things that are easy to get wrong:

- **A Terraform change to a task definition** (a tfvars value such as `stripe_connect_client_id`,
  a new environment variable) reaches the services on the next **full** deploy. `restart_only`
  restarts the revisions already running and does not pick it up.
- **A Parameter Store change** needs only `restart_only`: ECS resolves secrets at task start.

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
- **Connections.** Each web or worker process holds up to 10 (Drizzle) plus 4 (pg-boss); a
  `db.t4g.small` allows roughly 200.

`MIGRATION_DATABASE_URL` is not checked in code the way `DATABASE_URL` is (drizzle-kit and
`install-queue.ts` read it directly); db-bootstrap writes it with `verify-full`, and nothing else
should write it.

---

## Rollback

- **Automatic.** Both services have the deployment circuit breaker with rollback: a deployment
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
  deploy's summary names. It builds and migrates nothing; it moves web and worker to the newest
  ACTIVE revisions whose images are that commit's and still in ECR (the last 30 per repository),
  and never to Terraform's placeholder revisions. A rollback past a Terraform change undoes that
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

  and the same for `healdesk-production-worker`, with the revision that ran the same commit.
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
```

`destroy-due` is the worker's container (its environment, secrets and task role) running
`scripts/destroy-due.ts`: it destroys every clinic due for destruction and exits 1 while any is
still due, so `run-task.sh` exits 1 too. Every full deploy registers a revision of it with the
commit's image once both services are running it; the deploy role may register it but not run it.
`run-task.sh` runs the revision naming the image the worker service runs, so after a rollback it
runs the rolled-back code.

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
  --db-instance-class db.t4g.small \
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
   for s in healdesk-production-web healdesk-production-worker; do
     aws ecs update-service --cluster healdesk-production --service "$s" --desired-count 0 \
       --query 'service.desiredCount' --output text
   done
   aws ecs wait services-stable --cluster healdesk-production \
     --services healdesk-production-web healdesk-production-worker
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
5. Bring the schema up to the code, then destroy what is due:

   ```bash
   bash run-task.sh migrate
   bash run-task.sh destroy-due
   ```

   `destroy-due` uses the runtime role's `DATABASE_URL` from Parameter Store, which names
   production's endpoint: it runs against the copy only once step 3 has given the copy that name.
   Do not go on until it exits 0. A clinic still due is named, by id only, in
   `/healdesk/production/destroy-due`.
6. Reopen: `deploy-app.yml` with `bootstrap_db` and `migrate` ticked. With both services at 0 the
   workflow treats it as a first deploy and asks for both; db-bootstrap keeps every parameter that
   is set and only re-asserts the roles.

Two more operator steps in the handover need a file or a shell this build does not give an
operator yet:

- **Offboarding's return bundle** (`npm run patient-export`) writes a file to the disk of
  whatever runs it. On this host that is a task's disk, gone when the task stops, so there is no
  way to hand the bundle over. It needs a design (most likely the transcript bucket's pattern: SSE-KMS,
  a short-lived presigned link) before the first clinic leaves. It does not block launch.
- **Step 4 above** uses the CloudShell VPC environment as the migrator, typing the password at
  psql's prompt. That works, but it is the only write path into the database outside the code,
  so log each use in `security_events`.

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
| `CLOUDFLARE_API_TOKEN` | Roll in Cloudflare, `bash put-external-secrets.sh CLOUDFLARE_API_TOKEN` | Only `infra.yml` uses it, from its next run |
| ACM certificate | Nothing: ACM renews while the validation records stay in Cloudflare | Terraform keeps those records; never delete them by hand |
| tls-proxy certificate | Nothing: a new key at every task start | Never stored |
| GitHub to AWS | Nothing stored: OIDC, sessions of two hours at most | Revoke by editing the trust policies |

---

## Alarms and monitoring

Nine alarms, all to `healdesk-production-alarms`, each prefixed `healdesk-production-`: `alb-5xx`
and `target-5xx` (five or more in five minutes), `web-unhealthy-hosts`, `web-below-desired`
(healthy targets below `web_desired`), `worker-below-desired` (no worker CPU samples for five
minutes), `rds-cpu` (above 80% for 15 minutes), `rds-free-storage` (below 10%),
`rds-freeable-memory` (below 256 MiB) and `rds-idle-in-transaction` (below). The budget emails
`alarm_email` at 80% and 100% of `monthly_budget_usd` and when the forecast passes it. Both
below-desired alarms are in ALARM from the first apply until the first deploy, by design; alarms
email only when their state changes, so the first emails are usually the two OKs after the first
deploy.

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

Lean figures (us-east-1, on-demand, 730 hours, prices read on 6 October 2026), for what this module
builds with `production.tfvars` as committed:

| Line | $ a month |
| --- | --- |
| ALB: hours 16.43, about 0.25 LCU 1.46, two public IPv4 addresses 7.30 (eight listener rules, inside the ten that are free per request) | 25.19 |
| Fargate web task, 0.5 vCPU and 1 GB (the sidecar shares it) | 18.02 |
| Fargate worker task, 0.5 vCPU and 1 GB | 18.02 |
| RDS `db.t4g.small` single-AZ 23.36, 20 GiB gp3 2.30; backups free up to the storage size | 25.66 |
| One NAT gateway, its address, about 10 GB processed | 36.95 |
| KMS: the product key and the state key, plus requests | 2.20 |
| CloudTrail (S3 storage), CloudWatch Logs and nine alarms | 2.90 |
| Secrets Manager: the RDS master secret only (Parameter Store standard parameters are free) | 0.40 |
| ECR, up to 30 images per repository (the db-admin image is about 680 MB unpacked) | 1.00-2.00 |
| AWS Config, small | 3.00 |
| GuardDuty, foundational | 4.00 |
| WAF: one ACL, one rule, low traffic | 6.00 |
| **Total** | **≈ 143-144** |

Fixed-rate lines are exact; usage lines are low-traffic guesses. The idle-in-transaction alarm
reads Performance Insights once a minute; whether that read carries a charge beyond the alarm's
$0.10 has not been measured, so check the first bill. Between the first apply and the first deploy
the services run no tasks, so the account costs about $107 a month until then. Each KMS key's first
two yearly rotations add $1 a month each. The bootstrap stack alone is about $1 a month. Data
transfer out is expected to stay inside AWS's free 100 GB a month.

| Lever | Change |
| --- | --- |
| `nat_gateways = 2` (egress survives losing an AZ) | +36.50, plus processing |
| `db_multi_az = true` | +26.39 |
| `web_desired = 2` (multiplies the in-memory rate limits) | +18.02 |
| `vpc_endpoints = true` (six interface endpoints in two AZs, plus S3) | +87.60, plus $0.01 a GB |
| `enable_flow_logs = true` | CloudWatch ingestion, by traffic |
| The voice service, later (at least two tasks) | +36.04 |
| `container_insights = true`, Database Insights advanced | extra CloudWatch charges |

`monthly_budget_usd` is 250, so the first alert comes at $200.

---

## Deliberately not built

- **The active-transaction half of the open-transaction alarm.** Above.
- **The voice endpoint.** Retell holds one WebSocket per call, which a Next route cannot accept.
  `ecs.tf` ends with a disabled placeholder (`enable_voice` must stay false) listing what it needs:
  its own service of at least two tasks from this image, its own target group with an HTTP health
  path and a deregistration delay up to 3600 s (ECS waits for draining before it stops a task, and
  that, not `stopTimeout`, lets a call finish), a listener rule such as `/llm-websocket/*`, and an
  alarm on its liveness.
- **The transcript bucket and SES, built but off.** No code writes transcripts to S3 and no v1
  message is classed `may-carry-phi`. `enable_transcript_bucket` creates the bucket (SSE-KMS under
  the key with bucket keys, TLS only, Block Public Access, versioned, noncurrent versions gone in
  7 days, objects expiring at `transcript_retention_days`, CloudTrail data events) and the task
  role's statements for it; once on it cannot be switched off without emptying it by hand.
  `enable_ses` creates the configuration set `healdesk-production-phi` with `TlsPolicy=REQUIRE`,
  the domain identity with its DKIM records at Cloudflare, `HEALDESK_SES_CONFIGURATION_SET` on the
  tasks and the task role's send rights; it leaves `HEALDESK_EMAIL_TRANSPORT=resend`, and the
  account still has to leave the SES sandbox. Add or confirm the account record's rows before
  turning either on.
- **VPC endpoints.** A variable, off: about $88 a month, and the NAT gateway is still needed for
  the vendor APIs.
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
| Clinic to healdesk | Built: accepted inline at checkout (BAA 1.2.1; 1.3.0 drafted, not released) |
| healdesk to Retell | **Not done.** Self-sign the BAA and DPA; per-agent retention at the minimum, PII controls on, recording off, each screenshotted; Retell's US region and encryption at rest confirmed in writing (release gate 15). The product's Retell endpoint is not built either |
| healdesk to Anthropic | **Not done.** A separate HIPAA-ready organisation (the setting is organisation-wide and one-way); 30-day retention disclosed, no zero-retention request (gate 17). Only that organisation's key ever goes into `app/ANTHROPIC_API_KEY` |
| healdesk to the database | RDS under the AWS BAA, once this module is applied with the settings above |
| healdesk to AWS | Done 22 September 2026; the Artifact "Active" screenshot is outstanding |
| Clinic to Google | The clinic's own calendar under its own Google agreement; confirmed per clinic |

Nothing in the code checks vendor BAAs, so configuration holds the chain: leave
`META_APP_SECRET`, `META_VERIFY_TOKEN`, `ANTHROPIC_API_KEY` and both voice secrets `__unset__`
until it is complete (`put-external-secrets.sh` asks for a typed `yes` before each). With them
unset, the Meta webhook answers 503, the front door has no model to call and the Synthflow routes
answer 503.

Records and drills still open (the compliance map's §4): this module's first apply and deploy;
the restore drill (T9); the rotation runbook (T6; the table above is its draft, not yet adopted or
exercised); the tabletop exercise; the Security Official's name, sign-off and the account's
alternate contacts reaching them; attorney review, a penetration test and the access review; the
automatic fall-through to the clinic's line (T14), and until it exists, a check that Retell's own
failure behaviour forwards to the clinic's direct line; and every v1 surface the spec still lists
as unbuilt.

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
    .github/workflows/infra.yml .github/workflows/deploy-app.yml
  docker run --rm -v "$PWD/infra/aws/bootstrap:/w:ro" python:3.13-slim \
    sh -c 'pip install -q cfn-lint && cfn-lint /w/bootstrap.yaml'
  ```

  Every accepted checkov finding is a `#checkov:skip` with its reason next to the resource. Under
  heavy load `terraform test` can time out starting the AWS provider; run it again.
- **Read every plan for replacements.** `aws_db_instance.main`, `aws_kms_key.main`, every
  `aws_ssm_parameter` and the transcript bucket carry `prevent_destroy`, so a plan that would
  replace them fails; anything else marked "must be replaced" deserves a second look before apply.
- **A new signed route** goes into `signed_paths` in `locals.tf`, or the internal host answers it
  404.
- **`postgres_version`** will show an attempted downgrade after AWS's automatic minor upgrade:
  raise it to the running minor, or set it to `"17"`.
- **Flipping `alb_to_task_tls`** on a running service changes its load-balancer container and
  port while the service ignores task-definition changes: plan it, apply, and run a full deploy
  straight after.
- **Raising `alb_idle_timeout`** carries into `KEEP_ALIVE_TIMEOUT` and the sidecar's keep-alive
  automatically; both have to outlast it.
- **`kms_require_lock_labels`** stays true: every sealer sends both labels since the calendar
  build's C6b. Turn it off only to run an older image or to open an envelope sealed without labels
  before resealing it; it shapes IAM alone.
- **Never join an AWS Organization** (IAM Identity Center's organization instance and Control
  Tower create one): an Organization's BAA would then control instead of this account's.
- **Adding an AWS service** means a row in `docs/policies/aws-hipaa-account.md` first, with the
  date the HIPAA Eligible Services Reference was read.

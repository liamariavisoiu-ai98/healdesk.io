# apps/app on AWS

Terraform for the PHI side of healdesk: `apps/app`'s web tier, its worker and
its database, in the AWS account designated under the AWS BAA (`865780386982`,
`us-east-1`). What may run here, and how each service must be configured, is
decided by [docs/policies/aws-hipaa-account.md](../../docs/policies/aws-hipaa-account.md);
this directory builds that list, from the checklist in
[docs/handover.md](../../docs/handover.md) under "Once AWS lands".

**Synthetic data only until the whole BAA chain is signed.** AWS's agreement is
in place. Anthropic's, Retell's and the clinic's are separate, and until every
one is executed `apps/app` must not receive a real patient's data, however
finished this stack looks (CLAUDE.md, "Until BAA coverage is in place").

## What it builds

| Piece | What | File |
| --- | --- | --- |
| Network | VPC across two zones; load balancer and one NAT gateway public, everything else private; S3 gateway endpoint | `network.tf` |
| Key | One customer-managed KMS key for credentials, RDS, transcripts, logs, the trail and the secrets; rotation on | `kms.tf` |
| Database | RDS Postgres 17, encrypted with the key, TLS forced, private, **35-day automated backups**, deletion protection, master password managed by RDS | `rds.tf` |
| Transcripts | S3 bucket, SSE-KMS with the key, TLS-only, versioned, previous versions expire after 7 days so a delete is a delete | `storage.tf` |
| Audit | CloudTrail in every region, encrypted, validated, with S3 data events on the transcript bucket; log groups encrypted and never expiring | `audit.tf` |
| Secrets | Two Secrets Manager secrets (runtime; admin), created empty, written by `scripts/put-secrets.py` | `secrets.tf` |
| Image | ECR repository, immutable tags, scan on push | `ecr.tf` |
| Compute | ECS on Fargate: `web` and `worker` services; `db-admin`, `migrate` and `queue-install` one-off tasks | `ecs.tf`, `iam.tf` |
| Entry | Load balancer, ACM certificate for both hostnames, HTTP→HTTPS, unknown hosts get 404 | `alb.tf` |
| Mail | SES domain identity and the `healdesk-phi` configuration set with TLS required | `ses.tf` |
| Checks | AWS Config with `rds-storage-encrypted`, `s3-bucket-ssl-requests-only`, `cloud-trail-encryption-enabled`, `cloudwatch-log-group-encrypted` | `config.tf` |

Two hostnames, on purpose: `app.healdesk.io` is the public origin
(`BETTER_AUTH_URL`, every link a clinic is mailed), and `app-internal.healdesk.io`
is the one `apps/web` calls with signed requests (`HEALDESK_APP_URL` on
Vercel). They must differ: `apps/app` refuses to mail any link to
`HEALDESK_APP_URL` (`lib/email/lint.ts`).

Roughly $110–150 a month at idle, mostly the NAT gateway, the load balancer,
the database and two small ARM tasks. Traffic adds to it.

## Not in it yet

- **The Retell voice endpoint.** It is a long-lived WebSocket process that does
  not exist in `apps/app`. When it does, it gets a third service and its own
  target group here.
- **Alarms.** None yet: load balancer 5xx and unhealthy targets, the plain
  `/api/health` answering 503 while a critical email is late, and a
  transaction open longer than five minutes (handover, "RDS").
- **Rate limiting** on the host (AWS WAF), **VPC flow logs**, **ALB access logs**.
- **SES production access.** The account starts in SES's sandbox; leaving it
  is a support request, and nothing needs SES yet.
- **The Google OAuth client** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).
  It joins `runtime_secret_keys` in `secrets.tf` with the calendar build's C8.
- **The KMS lock-label rule** (`kms_require_lock_labels`) is on: the calendar
  build's C6b ("Lock every sealed credential's data key to its clinic and
  login") is on `main`, so every image now sends the labels. Turn it off only to
  deploy an image from before C6b, whose seals and opens it would refuse.

## First deploy

Run from a clean checkout of `main`. Every step is the owner's or is run under
the owner's AWS sign-in; nothing here needs a key pasted anywhere.

**0. Tools and sign-in.** Install the AWS CLI and Terraform 1.10 or later
(`brew install awscli hashicorp/tap/terraform`). Sign in through IAM Identity
Center as an administrator of `865780386982` (`aws configure sso`, then
`export AWS_PROFILE=<the profile name>`). Check:
`aws sts get-caller-identity --query Account --output text` prints `865780386982`.

**1. The state bucket, once.**

```sh
terraform -chdir=infra/aws/bootstrap init
terraform -chdir=infra/aws/bootstrap apply
```

**2. Initialise the stack.**

```sh
terraform -chdir=infra/aws init
```

**3. First apply.** Builds everything except HTTPS and the web service, which
wait for the certificate. Takes about fifteen minutes, mostly RDS.

```sh
terraform -chdir=infra/aws apply
terraform -chdir=infra/aws output certificate_validation_records
terraform -chdir=infra/aws output ses_dkim_records
```

**4. DNS in Cloudflare.** Add the certificate's validation CNAMEs and the three
SES DKIM CNAMEs, every one **DNS only (grey cloud), never proxied**: a proxied
record would put Cloudflare, which has signed no BAA, in the path of patient
traffic. Then turn HTTPS on:

```sh
terraform -chdir=infra/aws apply -var certificate_dns_ready=true
terraform -chdir=infra/aws output app_dns_records
```

and add those two CNAMEs (`app` and `app-internal` → the load balancer), also
DNS only.

**5. Secrets.** Write an env file **outside the repository** with at least
`HEALDESK_PROVISION_SECRET` (the same value as `apps/web`'s on Vercel) and
`ANTHROPIC_API_KEY` (from the Anthropic organisation covered by its BAA), plus
whichever of `RESEND_API_KEY`, `STRIPE_*`, `META_*` and the voice secrets are
in use. The database passwords, `BETTER_AUTH_SECRET` and
`HEALDESK_IDENTIFIER_REF_KEY` are generated. Then:

```sh
python3 infra/aws/scripts/put-secrets.py --env-file ~/healdesk-private/apps-app.env
```

It prints where each key's value came from, never a value. Run it again
whenever a value changes; what the file leaves out is kept.

**6. The image.**

```sh
infra/aws/scripts/push-image.sh
```

**7. Register the tasks with that image.** With every variable a later apply
needs from now on, which a `terraform.tfvars` in `infra/aws` (gitignored)
saves retyping:

```hcl
certificate_dns_ready = true
image_tag             = "<the tag push-image.sh printed>"
```

```sh
terraform -chdir=infra/aws apply
```

**8. The database, once.**

```sh
infra/aws/scripts/run-task.sh db-admin        # roles, as RDS's master user
infra/aws/scripts/run-task.sh migrate         # schema, as healdesk_migrator
infra/aws/scripts/run-task.sh queue-install   # pg-boss, as healdesk_migrator
```

**9. Start it.** Add `web_desired_count = 1` and `worker_desired_count = 1` to
the tfvars and apply. Check:

- `curl -sS https://app.healdesk.io/api/health?probe=liveness` answers 200;
- the worker's log (`/healdesk/apps-app/worker`) says the credential key
  self-check passed.

**10. Point `apps/web` at it,** last: `HEALDESK_APP_URL` on Vercel becomes
`https://app-internal.healdesk.io`, the value `terraform output internal_url`
prints.

## Each release

```sh
infra/aws/scripts/push-image.sh                                   # prints the tag
terraform -chdir=infra/aws apply -target=aws_ecs_task_definition.migrate -var image_tag=<tag>
infra/aws/scripts/run-task.sh migrate                             # schema first
terraform -chdir=infra/aws apply -var image_tag=<tag>             # then the services move
```

Set the tag in `terraform.tfvars` afterwards so a later apply does not roll
back. The web service rolls back on its own if the new tasks never pass the
health check.

## Tests

`terraform test` applies the whole stack against a mocked AWS provider, with no
credentials and no calls to AWS, for both phases of the first deploy, and
holds the rules an edit could break: 35-day backups, a private encrypted
database, distinct origins, no booking switch, no migrator credentials in the
web tier.

```sh
terraform -chdir=infra/aws init -backend=false
terraform -chdir=infra/aws test
```

## Restoring

Point-in-time restore makes a **new** instance; it never rewinds this one.
Restore to a time within the last 35 days with
`aws rds restore-db-instance-to-point-in-time`, into the same subnet group and
security group, check it, then either repoint the secrets at it
(`put-secrets.py` builds the URLs from `db_endpoint`) or delete it. A restore
drill is on the handover's list and has not been done.

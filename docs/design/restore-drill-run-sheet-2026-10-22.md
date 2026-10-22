# Restore drill: run sheet for the Owner (22 October 2026)

`docs/hipaa-risk-analysis.md` T9 says it plainly: "No restore drill has been run", so the
recovery time is unknown. The drill is required before the first live clinic. The runbook
already exists and is complete: **`infra/aws/README.md`, "Restore drill"**. This sheet is what
surrounds it: who runs it, what has to be true first, and what to write down after.

Claude Code cannot run it. It needs AWS administrator access in CloudShell, which no session
here has, and the repository's stopping rules reserve AWS actions to the Owner.

## Checked on 22 October 2026 (from the Terraform, not from memory)

Every AWS name the runbook uses resolves in `infra/aws`, so the commands need no edit:

| Runbook uses | Defined by |
| --- | --- |
| source instance `healdesk-production` | `rds.tf`: `identifier = local.name`, `local.name = "healdesk-${var.environment}"` |
| subnet group `healdesk-production` | `rds.tf`: `aws_db_subnet_group`, `name = local.name` |
| security group `healdesk-production-rds` | `rds.tf`: `"${local.name}-rds"` |
| parameter group `healdesk-production-postgres17` | `rds.tf`: `"${local.name}-postgres${major}"` with `postgres_version` 17 |
| CA `rds-ca-rsa2048-g1` | `rds.tf`: `ca_cert_identifier` |
| KMS alias `alias/healdesk-production` | `kms.tf`: `"alias/${local.name}"` |
| point-in-time recovery possible | `rds.tf`: `backup_retention_period = 35` |
| copy private and encrypted | `rds.tf`: `publicly_accessible = false`, `storage_encrypted = true` |
| `healdesk-production-tasks` security group | `ecs.tf`: `"${local.name}-tasks"` |
| `healdesk-production-web` service | `ecs.tf`: `name = "${local.name}-web"` |
| `healdesk-production-db-bootstrap` task family | `iam.tf`: `task_families.db_bootstrap` |

Not checked: that these exist in the live account today (that needs AWS), and the CloudShell
commands themselves, which are as the runbook gives them.

## Before you start

1. **The host must be `active`.** `host.yml` in `standby` removes the database, so there is
   nothing to restore from except the manual standby snapshot, which is outside the 35-day
   backup promise and is not what this drill tests. Check `/admin/host` or run `host.yml` with
   `active`.
2. **Log the restore as a PHI access** in `security_events` before you start, as the runbook
   says (`docs/policies/access-control.md`), and name the copy with no PHI in it. The database
   holds synthetic data only today, but the drill is meant to rehearse the real procedure.
3. **Pick a window of about an hour.** The instance restore is the slow part. The copy costs a
   few cents an hour while it exists; the runbook says to delete it the same day and in any
   case within 35 days.
4. **Do not follow "Restoring production".** The drill proves a backup can be read. Putting a
   restored copy in production's place is a separate procedure with its own order of steps.

## Run it

Follow "Restore drill" in `infra/aws/README.md` from the first `export` to the last
`describe-db-instance-automated-backups` (expect none). Keep every flag on the restore
command: without them RDS uses the default subnet group, security group and parameter group,
and the copy could be public.

## Write down afterwards

Fill this in, and copy it into T9:

| Field | Value |
| --- | --- |
| Date and operator | |
| Restore point (latest restorable time) and the time of the last write | |
| RPO (last write to restore point; normally within five minutes) | |
| RTO (restore command issued to `db-instance-available`) | |
| Copy encrypted with `alias/healdesk-production`, private, not public | yes / no |
| db-bootstrap exit code against the copy (0 expected) | |
| Migration count and table counts read from the copy (counts only, never rows) | |
| Copy deleted; no snapshot or automated backup left | yes / no |
| Closing `security_events` entry | |

Then: add a Reviews row to `docs/policies/training-log.md`, and replace T9's "No restore drill
has been run" in `docs/hipaa-risk-analysis.md` with the measured RTO and RPO. (`docs/hipaa-compliance.md`
has no restore item to tick; its checklist only has "Penetration test / security review".)

## If it fails

A failed drill is the drill working. Record what failed and the time, leave the copy in place
long enough to see why, delete it within the same 35 days, and open a package for the cause.
Do not take a manual snapshot of the copy.

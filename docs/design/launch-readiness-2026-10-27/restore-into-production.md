# Restoring the production database into production's place

Lane OPS-1, 27 October 2026. Design and runbook, **not rehearsed**. Nothing here has been run
against AWS: every command below was checked against the repository's names (the table in
"Where every name comes from"), not against a live account. The rehearsal plan at the end is what
turns this into a tested procedure, and it must be run before the first live clinic
(`docs/hipaa-risk-analysis.md` T9).

What this replaces: `infra/aws/README.md`, "Restoring production", said putting a restored copy in
production's place was "not designed in full or rehearsed" and named the open part (step 3). This
document designs that part and the steps around it. The order it keeps is the one
`docs/handover.md`, "Restoring", sets: after any restore, destruction and every deletion request run
again **before the service reopens**.

## When this applies, and when it does not

| Situation                                                                                                      | What to use                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The host is in standby (`/healdesk/production/host/mode` reads `standby`)                                      | Not this. `host.yml` with `active` already brings the database back from its standby snapshot (README, "Standby").            |
| The host is active and the data is wrong: rows deleted or corrupted by a bug, an operator mistake, an incident | **This runbook**, with a point-in-time restore.                                                                               |
| The host is active and the RDS instance itself is gone                                                         | This runbook, with the variant in step B1 (restore from the retained automated backups).                                      |
| The trouble is a migration that went wrong                                                                     | **Stop.** Not designed: see gap G10. `run-task.sh migrate` runs the newest registered migrate revision, which is the bad one. |
| A drill, to prove a backup can be read                                                                         | README, "Restore drill", or the rehearsal plan below.                                                                         |

## Decisions this design makes

1. **Point-in-time restore to a new instance, then swap names.** RDS cannot restore into an existing
   instance; every restore makes a new one. RDS builds an instance's endpoint from its identifier
   (`<identifier>.<the account's hash>.us-east-1.rds.amazonaws.com`, `rds.tf`'s comment above
   `aws_db_instance.main`), so renaming production away and the copy to `healdesk-production` gives
   the copy the endpoint every URL in Parameter Store already names. Nothing in Parameter Store
   changes, no task definition changes for the web, worker, voice and one-off tasks, and the
   CloudWatch log group `/aws/rds/instance/healdesk-production/postgresql` (`logs.tf`) receives the
   copy's engine log once its export is turned on.
   - _Rejected: repointing._ Restoring under a new name and rewriting `app/DATABASE_URL`,
     `migrator/MIGRATION_DATABASE_URL`, `readonly/READONLY_DATABASE_URL` and
     `writer/WRITER_DATABASE_URL` would leave Terraform managing an instance named
     `healdesk-production` that is no longer the database, its alarms (`alarms.tf`, dimension
     `DBInstanceIdentifier`) watching the wrong instance, and the db-bootstrap task definition's
     `PGHOST` (`ecs.tf`) naming the old one. Every later `host.yml` and `infra.yml` would be
     reasoning about the wrong database.
   - _Rejected: a logical reload into the same instance_ (`pg_dump` of the copy, `pg_restore` into
     production). It keeps the instance and its point-in-time chain, but it moves every row of
     patient data through a client in the VPC, needs the trigger handling `docs/handover.md`
     describes for a data-only load, and is slower. Keep it for the narrow case of one table, where
     the handover's steps already apply.
2. **The old instance is kept, renamed and stopped, for at most seven days.** It is the only place
   the deletion requests and amendments made after the point restored to still exist
   (`docs/handover.md`, "Restoring", steps 4 and 6), and it is the rollback. It is deleted with
   `--skip-final-snapshot` and its automated backups left to expire on their 35-day clock, as
   `rds.tf` does for any deletion (`delete_automated_backups = false`).
3. **Terraform adopts the copy by a state removal and an import**, after the data has been cleaned
   and before the service reopens. Until then, nothing may plan or apply against production
   (the freeze, step A3). This is the step with no workflow behind it today (gap G1).
4. **The restored instance's master password becomes RDS-managed again, under the product key**, as
   `rds.tf` has it (`manage_master_user_password = true`, `master_user_secret_kms_key_id`). The
   Terraform import then gives the db-bootstrap task definition and the execution role
   (`iam.tf`, statement `ReadRdsMasterSecret`) the new secret's ARN.
5. **The app's own roles keep their passwords.** `healdesk_app`, `healdesk_migrator`,
   `healdesk_readonly` and `healdesk_writer` are cluster roles inside the restored data, with the
   passwords Parameter Store holds (db-bootstrap generates a value only when it is unset,
   `images/db-admin/entrypoint.sh`), so `migrate`, `destroy-due`, `reapply-erasures` and `db-query`
   connect to the copy as soon as it carries the production name, before Terraform knows about it.
   (Exception: a role password rotated after the point restored to. The copy has the old one. Run
   db-bootstrap at reopen, which this runbook does anyway, and it re-sets every role's password from
   Parameter Store.)
6. **The KMS key does not change.** A restored instance is encrypted with its source's key, and the
   key of an encrypted instance cannot be changed (`rds.tf`'s header). Every sealed value in the
   data (transcripts in the outbox, clinic credentials) was sealed under `alias/healdesk-production`
   (`kms.tf`) and opens as before.

## Who does what

Everything in AWS is the **owner, in AWS CloudShell** in `us-east-1`, signed in to `865780386982` as
the administrator. Everything in GitHub is the owner. The Retell dashboard step is the owner.
Claude may prepare the temporary import commit as a branch and pull request for the owner to merge;
it runs nothing in AWS and merges nothing.

## How long it takes (estimates, to be replaced by the rehearsal's numbers)

| Phase                             | Estimate                 | What dominates                                                                           |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| A. Freeze and stop                | 10 to 15 min             | Voice tasks drain at once when no call is open (Retell in outage mode)                   |
| B. Restore the copy and set it up | 25 to 45 min             | The point-in-time restore of a 20 GiB gp3 instance; then one modify                      |
| C. Swap the names                 | 15 to 30 min             | Two renames, each a reboot and a new DNS name                                            |
| D. Clean the data                 | 30 to 60 min             | The CloudShell VPC environment, the date and deletion copies by hand                     |
| E. Terraform adopts the copy      | 30 to 45 min             | A pull request through CI, an `infra.yml` plan and apply                                 |
| F. Reopen                         | 30 to 45 min             | `deploy-app.yml` first deploy (build reused if this commit was built), `infra.yml` again |
| **Patient-facing outage**         | **about 2.5 to 4 hours** | Calls go to each clinic's direct line throughout (Retell outage mode)                    |
| G. Retire the old instance        | within 7 days            |                                                                                          |

RPO: the point restored to. RDS keeps `LatestRestorableTime` within about five minutes of the last
write (README, "Restore drill"), but the point chosen is usually before the damage, so everything
written after it is lost unless copied over (step D, and the reconciliation in step F6).

---

## The runbook

Set these once at the top of the CloudShell session and keep the session open; every later block
uses them.

```bash
export AWS_REGION=us-east-1 AWS_PAGER=""
STAMP=$(date -u +%Y%m%d%H%M)
PROD=healdesk-production
COPY=healdesk-production-restore-$STAMP     # the copy, until it takes PROD's name
OLD=healdesk-production-old-$STAMP          # production, once renamed away
KEY_ARN=$(aws kms describe-key --key-id alias/healdesk-production --query KeyMetadata.Arn --output text)
RDS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=healdesk-production-rds \
  --query 'SecurityGroups[0].GroupId' --output text)
echo "$STAMP $COPY $OLD $KEY_ARN $RDS_SG"
```

Write `STAMP` down: if CloudShell times out, set `STAMP` to the same value again before going on.

### A. Decide, freeze, stop

**A1. Choose the point restored to (T).** From the incident timeline, a moment before the damage, in
UTC, and no later than RDS allows:

```bash
aws rds describe-db-instances --db-instance-identifier "$PROD" \
  --query 'DBInstances[0].[LatestRestorableTime, BackupRetentionPeriod, DBInstanceClass, AllocatedStorage, MultiAZ, EngineVersion]'
T=2026-10-27T09:40:00Z     # the point chosen; write it in the incident record
```

Record T, the reason, and the names above in the incident record (`docs/incident-response.md`)
now. The `security_events` row the README asks for is written in step D7, inside the restored
database: a row written in production now would be lost if T is earlier than it (gap G6).

**A2. Retell outage mode on** (owner, Retell dashboard; `docs/on-call.md`, "Voice endpoint down").
Every inbound call to the workspace's numbers then goes to its number's fallback, the clinic's
direct line, for the whole restore. Web chat, the Meta channels, the portal and provisioning are
down until F3 (`docs/on-call.md`, the process table: the web tier carries them). Stripe's events
reach apps/web, whose relay to apps/app fails, so Stripe retries them for about three days
(`apps/web/src/lib/host/wake.ts`): they are processed after reopening, which is what is wanted.

**A3. Freeze every workflow that could touch production.** Three things could undo the restore
half-way:

- `host.yml` can be dispatched without anyone choosing to: `apps/web/src/lib/host/wake.ts`
  dispatches it with `active` when a paid invoice's provision call finds no host (a 502, 503 or 504,
  which is what the load balancer answers with the web service at 0). Its turn-on runs
  `deploy-app.yml`, which starts the services before `destroy-due` has run.
- `infra.yml` would plan against a state that still names the old instance (by its RDS resource id,
  aws provider 6.67, `versions.tf`) and propose renaming it back to `healdesk-production`. The plan
  guard does not refuse that: it reads only deletions and replacements
  (`infra/aws/scripts/plan-guard.sh`), and a rename is an in-place update (gap G2).
- `deploy-app.yml` treats every service at 0 as a first deploy and brings them all up.

So, as the owner:

```bash
# In CloudShell. infra.yml refuses to plan while the mode reads anything but active or standby
# (.github/workflows/infra.yml, step "Read the host's switch"). host.yml and deploy-app.yml do not
# read it, so they are disabled in GitHub below.
aws ssm put-parameter --name /healdesk/production/host/mode --type String --overwrite \
  --value restoring --description "A restore into production is in progress: docs/design/launch-readiness-2026-10-27/restore-into-production.md"
```

On GitHub (Actions → each workflow → "..." → Disable workflow, or from a terminal signed in as
the owner): disable **Host (AWS)** (`host.yml`), **Deploy apps/app (AWS)** (`deploy-app.yml`) and
**Infra (AWS)** (`infra.yml`).

```bash
gh workflow disable host.yml
gh workflow disable deploy-app.yml
gh workflow disable infra.yml
gh run list --workflow host.yml --status in_progress; gh run list --workflow deploy-app.yml --status in_progress
gh run list --workflow infra.yml --status in_progress   # all three empty before going on
```

`/admin/host` dispatches with the owner's token and fails while `host.yml` is disabled, which is
intended.

**A4. Stop the services.** Production's shape has the worker inside the web task
(`worker_placement = "shared"`) and voice on (`enable_voice = true`, both in
`infra/aws/production.tfvars`); the loop reads which services exist, so it is right for either
shape. With Retell in outage mode no call is open, so the voice target group's one-hour
deregistration delay (`alb.tf`) ends at once.

```bash
SERVICES=$(aws ecs describe-services --cluster healdesk-production \
  --services healdesk-production-web healdesk-production-worker healdesk-production-voice \
  --query "services[?status=='ACTIVE'].serviceName" --output text)
for s in $SERVICES; do
  aws ecs update-service --cluster healdesk-production --service "$s" --desired-count 0 \
    --query 'service.[serviceName,desiredCount]' --output text
done
aws ecs wait services-stable --cluster healdesk-production --services $SERVICES
aws ecs describe-services --cluster healdesk-production --services $SERVICES \
  --query 'services[].[serviceName,runningCount]' --output text     # every runningCount 0
```

Stopping the worker also stops the hourly expiry of deletion records, which `docs/handover.md`
("Restoring", step 1) needs.

### B. Restore the copy, with production's settings

**B1. Point-in-time restore to a new instance.** Every network and parameter flag is needed:
without them RDS uses the default subnet group, security group and parameter group, and the copy
could be public (README, "Restore drill"). The instance class and Multi-AZ setting follow what A1
printed (production: `db.t4g.micro`, single-AZ). Deletion protection is on from the start, unlike
the drill's copy.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$PROD" \
  --target-db-instance-identifier "$COPY" \
  --restore-time "$T" \
  --db-subnet-group-name healdesk-production \
  --vpc-security-group-ids "$RDS_SG" \
  --db-parameter-group-name healdesk-production-postgres17 \
  --ca-certificate-identifier rds-ca-rsa2048-g1 \
  --db-instance-class db.t4g.micro \
  --storage-type gp3 \
  --no-multi-az --no-publicly-accessible --deletion-protection \
  --copy-tags-to-snapshot --auto-minor-version-upgrade \
  --tags Key=Project,Value=healdesk Key=Environment,Value=production Key=ManagedBy,Value=terraform
aws rds wait db-instance-available --db-instance-identifier "$COPY"
```

_The instance is gone_ (the only case where production's instance does not exist): restore from
its retained automated backups instead, by resource id, straight to the production name, and skip
step C:

```bash
aws rds describe-db-instance-automated-backups --db-instance-identifier "$PROD" \
  --query 'DBInstanceAutomatedBackups[].[DbiResourceId,RestoreWindow.EarliestTime,RestoreWindow.LatestTime,Status]'
# then the same command as above with
#   --source-dbi-resource-id <DbiResourceId>  in place of  --source-db-instance-identifier "$PROD"
#   --target-db-instance-identifier "$PROD"   in place of  "$COPY"
# and every later "$COPY" in steps B2 and B3 read as "$PROD".
```

**B2. Check that the restore did not open a second engine-log group.** `logs.tf` pre-creates the
one group RDS exports into, `/aws/rds/instance/healdesk-production/postgresql`, with the product
key and no expiry; a group RDS creates for any other identifier gets neither. The copy's export
stays off until it carries the production name (C4).

```bash
aws rds describe-db-instances --db-instance-identifier "$COPY" --query \
  'DBInstances[0].[DBInstanceStatus,StorageEncrypted,KmsKeyId,PubliclyAccessible,EnabledCloudwatchLogsExports,PerformanceInsightsEnabled,BackupRetentionPeriod]'
# KmsKeyId must be $KEY_ARN; PubliclyAccessible false; EnabledCloudwatchLogsExports empty or null.
# If the export is on, turn it off and delete the group RDS made:
#   aws rds modify-db-instance --db-instance-identifier "$COPY" --apply-immediately \
#     --cloudwatch-logs-export-configuration '{"DisableLogTypes":["postgresql"]}'
#   aws logs delete-log-group --log-group-name "/aws/rds/instance/$COPY/postgresql"
```

**B3. Give the copy the rest of production's settings** (`rds.tf`, `aws_db_instance.main`; the
windows are `variables.tf`'s defaults, which `production.tfvars` does not override). This also hands
the master password to RDS under the product key, which ends the copy's dependence on the old
instance's secret.

```bash
aws rds modify-db-instance --db-instance-identifier "$COPY" --apply-immediately \
  --backup-retention-period 35 \
  --preferred-backup-window 08:00-08:30 \
  --preferred-maintenance-window sun:08:45-sun:09:45 \
  --manage-master-user-password --master-user-secret-kms-key-id "$KEY_ARN" \
  --enable-performance-insights --performance-insights-kms-key-id "$KEY_ARN" \
  --performance-insights-retention-period 7 --database-insights-mode standard \
  --monitoring-interval 0 --deletion-protection
aws rds wait db-instance-available --db-instance-identifier "$COPY"
aws rds describe-db-instances --db-instance-identifier "$COPY" --query \
  'DBInstances[0].[BackupRetentionPeriod,MasterUserSecret.SecretStatus,MasterUserSecret.KmsKeyId,PerformanceInsightsEnabled,DeletionProtection]'
```

If RDS refuses the Performance Insights flags because the copy already has them on under the same
key, run the command again without them. If it refuses `--database-insights-mode`, leave it for the
Terraform import's plan (E4) to set.

### C. Swap the names

**C1. Take production's engine-log export off before it is renamed**, or RDS opens
`/aws/rds/instance/$OLD/postgresql` without the product key (B2's reason):

```bash
aws rds modify-db-instance --db-instance-identifier "$PROD" --apply-immediately \
  --cloudwatch-logs-export-configuration '{"DisableLogTypes":["postgresql"]}'
aws rds wait db-instance-available --db-instance-identifier "$PROD"
```

**C2. Rename production away.** Deletion protection does not stop a rename, and stays on.

```bash
aws rds modify-db-instance --db-instance-identifier "$PROD" \
  --new-db-instance-identifier "$OLD" --apply-immediately
# The old name is released when the rename completes; wait until it is.
until aws rds describe-db-instances --db-instance-identifier "$OLD" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null | grep -qx available; do sleep 20; done
aws rds describe-db-instances --db-instance-identifier "$PROD" 2>&1 | grep -q DBInstanceNotFound && echo "the name is free"
```

**C3. Give the copy the production name.**

```bash
aws rds modify-db-instance --db-instance-identifier "$COPY" \
  --new-db-instance-identifier "$PROD" --apply-immediately
until aws rds describe-db-instances --db-instance-identifier "$PROD" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null | grep -qx available; do sleep 20; done
aws rds describe-db-instances --db-instance-identifier "$PROD" \
  --query 'DBInstances[0].[Endpoint.Address,DbiResourceId,MasterUserSecret.SecretArn]' --output text
```

The address printed must be the one every database URL names: compare it with the host part of
`terraform output db_address` from the last `infra.yml` apply's summary (`outputs.tf`), or, without
printing any password, with:

```bash
aws ssm get-parameter --name /healdesk/production/app/DATABASE_URL --with-decryption \
  --query Parameter.Value --output text | sed -E 's#^[^@]*@([^:/]+).*#\1#'
```

Write down the new `DbiResourceId` and `MasterUserSecret.SecretArn`: step E checks them.

**C4. Turn the engine-log export on for the copy**, now that it writes into the pre-created group:

```bash
aws rds modify-db-instance --db-instance-identifier "$PROD" --apply-immediately \
  --cloudwatch-logs-export-configuration '{"EnableLogTypes":["postgresql"]}'
aws rds wait db-instance-available --db-instance-identifier "$PROD"
```

Leave the old instance running: D4 and D6 read it. It is stopped at the end of D7.

### D. Clean the data, before anything serves it

Steps D1, D4, D6 and D7 need a SQL client inside the VPC. This build has no bastion and no ECS
Exec on purpose (README, "Restore drill"): create a temporary **CloudShell VPC environment** in a
private subnet of `healdesk-production` with the `healdesk-production-tasks` security group (the
one `healdesk-production-rds` admits, `rds.tf`), then in it:

```bash
sudo dnf install -y postgresql16
curl -fsSo ~/rds.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem
HOST=$(aws rds describe-db-instances --db-instance-identifier healdesk-production \
  --query 'DBInstances[0].Endpoint.Address' --output text)
NEW="host=$HOST dbname=healdesk user=healdesk_migrator sslmode=verify-full sslrootcert=$HOME/rds.pem"
psql "$NEW"     # type the migrator's password at the prompt: the one in migrator/MIGRATION_DATABASE_URL
```

Never type a password on a command line. Each use of this environment is a write path outside the
code: it goes in the `security_events` row of D7. Delete the VPC environment at the end of D.

**D1. Put back the destruction dates the restore lost** (`docs/handover.md`, "Restoring", step 2).
Find the `clinic data destroyed` lines written after T. Run in ordinary CloudShell:

```bash
START=$(date -u -d "$T" +%s); END=$(date -u +%s)
Q=$(aws logs start-query --start-time "$START" --end-time "$END" --log-group-names \
  /healdesk/production/worker /healdesk/production/destroy-due /healdesk/production/web \
  /healdesk/production/erase-person /healdesk/production/amend-contact \
  --query-string 'fields @timestamp, @message
    | filter @message like /\[healdesk\] (clinic data destroyed|person data erased|record amended|contact corrected) \{/
    | sort @timestamp asc | limit 10000' --query queryId --output text)
sleep 30; aws logs get-query-results --query-id "$Q" --output text
```

The lines carry ids, counts and dates only (`lib/offboarding/offboarding.ts`,
`lib/ops/patient-entry.ts`). Keep the result for D4 and D6. For each `clinic data destroyed` line
whose clinic comes back without `destroyed_at`, in psql as the migrator (clinics is not FORCEd, so
its owner sees every row):

```sql
BEGIN;
SELECT id, offboarding_started_at, destroy_after, export_delivered_at, destroyed_at
  FROM clinics WHERE id = '<clinicId>';
UPDATE clinics
   SET offboarding_started_at = coalesce(offboarding_started_at, '<serviceEndedAt>'::timestamptz),
       destroy_after          = coalesce(destroy_after, '<serviceEndedAt>'::timestamptz + interval '30 days'),
       export_delivered_at    = coalesce(export_delivered_at, <'<exportDeliveredAt>'::timestamptz, or NULL when the line has null>)
 WHERE id = '<clinicId>' AND destroyed_at IS NULL;
COMMIT;
```

**D2. Bring the schema up to the deployed code.** Ordinary CloudShell, with the script from the repo
(`infra/aws/scripts/run-task.sh`; upload it, or `git clone` the repository). It runs the newest
migrate revision naming a deployed image, with the migrator URL, which now names the copy.

```bash
bash run-task.sh migrate
```

Exit 0 also proves the copy answers `verify-full` TLS under the production name and accepts the
migrator's password.

**D3. Destroy what is due** (`docs/handover.md`, "Restoring", step 3):

```bash
bash run-task.sh destroy-due
```

It runs the destroy-due revision naming the image the web task's worker container last ran
(`run-task.sh`, "the image the worker runs"), with the runtime URL. It exits 1 while any clinic is
still due, and names such a clinic by id in `/healdesk/production/destroy-due`. Do not go on until
it exits 0.

**D4. Put back the deletion requests the restore lost** (handover step 4). For each
`person data erased` line from D1, by clinic, copy that clinic's rows erased after T from the old
instance into the copy, inside the clinic's tenant (`erasure_requests` is FORCEd, `drizzle/0063`),
with `erasure_requests_guard` disabled so each keeps its `erased_at`. In the VPC environment, with
the old instance started:

```bash
OLD_HOST=$(aws rds describe-db-instances --db-instance-identifier "$OLD" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
OLDC="host=$OLD_HOST dbname=healdesk user=healdesk_migrator sslmode=verify-full sslrootcert=$HOME/rds.pem"
# One password file for the two connections, so neither psql prompts mid-pipe; deleted below.
read -rs -p "migrator password: " PW; echo
umask 077; printf '*:5432:healdesk:healdesk_migrator:%s\n' "$PW" >~/.pgpass; unset PW
C='<clinicId>'
psql "$OLDC" -X -1 -v ON_ERROR_STOP=1 -c "SET LOCAL app.clinic_id = '$C'" \
  -c "\copy (SELECT * FROM erasure_requests WHERE clinic_id = '$C' AND erased_at > '$T') TO STDOUT WITH (FORMAT csv)" |
psql "$NEW" -X -1 -v ON_ERROR_STOP=1 -c "SET LOCAL app.clinic_id = '$C'" \
  -c "ALTER TABLE erasure_requests DISABLE TRIGGER erasure_requests_guard" \
  -c "\copy erasure_requests FROM STDIN WITH (FORMAT csv)" \
  -c "ALTER TABLE erasure_requests ENABLE TRIGGER erasure_requests_guard"
```

Nothing is written to disk: the rows go from one psql to the other. Both run as single
transactions (`-1`), so a failure leaves the trigger enabled and nothing loaded. `SELECT *` relies
on both sides having the same columns in the same order, which holds once D2 has brought the copy to
the migrations the old instance already ran (both are then on the deployed commit's); if D7's first
query gives a different count on the two, name the columns in both `\copy` statements. If the old instance is gone,
run each deletion again from the practice's request, as the handover says.

**D5. Delete again everyone deleted since T** (handover step 5):

```bash
bash run-task.sh reapply-erasures
```

Exit 1 means some clinic could not be done; its log stream (`/healdesk/production/reapply-erasures`)
says which, by id.

**D6. Amendments and corrections** (handover step 6). For each `record amended` line, either copy
that clinic's `record_amendments` rows recorded after T from the old instance, as in D4 with
`record_amendments` and `record_amendments_guard`, or ask the practice again. Every
`contact corrected` line is asked again, always: the restored row is the old one.

**D7. Record the restore, then verify.** In psql as the migrator, in the restored database, with no
patient data in the metadata (`lib/audit.ts`, `recordSecurityEvent`, refuses PHI in code; here it is
your care):

```sql
INSERT INTO security_events (actor_label, event, metadata)
VALUES ('<your work address>', 'database_restored',
        jsonb_build_object('restoredTo', '<T>', 'copy', '<COPY>', 'oldInstance', '<OLD>',
                           'incident', '<incident id>', 'vpcEnvironmentUses', '<n>'));
```

Then, counts and names only:

```sql
SELECT count(*) AS applied FROM drizzle.__drizzle_migrations;    -- = ls apps/app/drizzle/*.sql | wc -l on the deployed commit
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN (
  'clinics_insert_guard','booking_requests_keys_once','erasure_requests_guard','record_amendments_guard',
  'handovers_guard','patient_requests_guard','device_recoveries_guard','clinics_main_location',
  'clinic_locations_guard','location_acknowledgements_guard','clinics_record_clock') ORDER BY 1;   -- all 'O'
SELECT name, enabled FROM scheduled_jobs ORDER BY 1;               -- the switches the worker reopens with
SELECT name, state, count(*) FROM pgboss.job GROUP BY 1, 2 ORDER BY 1, 2;   -- queued work that replays at reopen (F6)
```

and in ordinary CloudShell, as `healdesk_readonly` (`apps/app/scripts/db-queries/`):

```bash
bash run-task.sh db-query migration-state
bash run-task.sh db-query role-settings
```

Then `rm -f ~/.pgpass`, delete the VPC environment, and stop the old instance, which is kept only
for rollback from here (a stopped instance must be started again, `aws rds start-db-instance`, to be
read or modified, and RDS starts it by itself after seven days):

```bash
aws rds stop-db-instance --db-instance-identifier "$OLD"
```

### E. Terraform adopts the copy

The state still holds the old instance under `aws_db_instance.main[0]`, keyed by its RDS resource
id, so a plan now would propose renaming `$OLD` back to `healdesk-production` (gap G2). The entry is
removed by hand and the copy imported through `infra.yml`, so the import is a saved plan the plan
guard reads like any other.

**E1. Remove the old instance from the state** (owner, CloudShell; the only step that writes the
state outside a workflow; gap G1 proposes the workflow that replaces it). Terraform is not in
CloudShell; install the version the workflows pin (1.16.5, `infra.yml`), and give it only the
backend and the provider pins, from the repository: `infra/aws/backend.tf`, `infra/aws/versions.tf`
and `infra/aws/.terraform.lock.hcl` (upload them through Actions → Upload file).

```bash
mkdir -p ~/tf-adopt ~/bin && cd ~/tf-adopt
V=1.16.5
curl -fsSLO "https://releases.hashicorp.com/terraform/$V/terraform_${V}_linux_amd64.zip"
curl -fsSLO "https://releases.hashicorp.com/terraform/$V/terraform_${V}_SHA256SUMS"
sha256sum --ignore-missing -c "terraform_${V}_SHA256SUMS" && unzip -o "terraform_${V}_linux_amd64.zip" -d ~/bin
mv ~/backend.tf ~/versions.tf ~/.terraform.lock.hcl .
BUCKET=$(aws cloudformation describe-stacks --stack-name healdesk-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='StateBucketName'].OutputValue" --output text)
STATE_KEY=$(aws cloudformation describe-stacks --stack-name healdesk-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='StateKmsKeyArn'].OutputValue" --output text)
~/bin/terraform init -input=false -lockfile=readonly \
  -backend-config="bucket=$BUCKET" -backend-config="kms_key_id=$STATE_KEY"
~/bin/terraform state show -no-color 'aws_db_instance.main[0]' | grep -E '^ +(id|identifier|resource_id) +='
# Expect identifier = the OLD name, and id/resource_id = the OLD instance's DbiResourceId, not the copy's.
~/bin/terraform state rm -lock-timeout=5m 'aws_db_instance.main[0]'
```

From here until E4 no plan may run: one would try to create a new `healdesk-production` (AWS
refuses the name, which is in use, but do not rely on it). `host/mode` still reads `restoring`, and
`infra.yml` is still disabled.

**E2. The import commit.** A pull request adding one file, `infra/aws/restore-adopt.tf`:

```hcl
# Temporary: adopts the database restored on <date> into the state
# (docs/design/launch-readiness-2026-10-27/restore-into-production.md, step E).
# Remove in the next commit once infra.yml has applied it.
import {
  to = aws_db_instance.main[0]
  id = "healdesk-production"
}
```

The aws provider imports a DB instance by its identifier. If the plan in E4 says the id is not
found, use the `DbiResourceId` from C3 instead. CI's `infra` job runs `terraform test` with mocked
providers (`tests/*.tftest.hcl`); if the import block fails those runs, it cannot merge as it is,
and G1's variable-gated form is needed: that is a code change, not a step to improvise. The owner
merges it (the standing rule: nothing lands on main without the owner's yes).

**E3. Lift the freeze for `infra.yml` only.**

```bash
aws ssm put-parameter --name /healdesk/production/host/mode --type String --overwrite --value active
gh workflow enable infra.yml
```

**E4. `infra.yml` with `plan`, read it, then `apply`.** What the plan should show, and nothing
else:

- `aws_db_instance.main[0]` will be **imported**, with at most in-place updates (tags, a setting B3
  could not make). It must not show a replacement, and the plan guard refuses one anyway.
- `aws_ecs_task_definition.db_bootstrap[0]` replaced: its `PGPASSWORD` and `PGUSER` name the new
  master secret's ARN (`ecs.tf`), the one C3 printed.
- The execution role's policy updated: `ReadRdsMasterSecret` names that ARN (`iam.tf`).
- `aws_sns_topic_subscription.ses_events_app[0]` and the inbound mail subscription destroyed: the
  app does not answer its liveness probe, so `infra.yml` passes `subscribe_ses_events=false` and
  `subscribe_inbound_mail=false` (step "Read the host's switch"). F4 puts them back.

Anything else (in particular any change to a parameter, the key, a bucket or the RDS parameter
group) stops here: find out why before applying.

### F. Reopen

**F1. Enable `deploy-app.yml` and run a full deploy with `bootstrap_db` and `migrate` ticked.**
Every service is at 0, so the workflow treats it as a first deploy and requires both
(`deploy-app.yml`, step "Read the services"). db-bootstrap signs in with the new master secret
through the revision E4 registered, keeps every parameter that is set, and re-sets every role's
password from Parameter Store; the migrations find nothing to do; the services come up to their
`DesiredCount` tags and the smoke test runs.

```bash
gh workflow enable deploy-app.yml
gh workflow run deploy-app.yml -f bootstrap_db=true -f migrate=true
```

**F2. Retell outage mode off**, then a test call to the demo clinic (`docs/on-call.md`, "Voice
endpoint down", step 2).

**F3. Check the app answers:** `https://app.healdesk.io/api/health?probe=liveness`, then `/api/health`
for `heartbeatAgeSeconds` and `queue` (`docs/on-call.md`, the health table).

**F4. `infra.yml` with `apply` again**, now that the liveness probe answers, to subscribe SES's
events and the inbound mail topic again. Do this straight after F1: a transcript the reopened worker
sends before it has no delivery event, and its sealed copy is deleted only by the 72-hour
`unconfirmed` rule (`lib/conversations/transcript-outbox.ts`).

**F5. Remove the import block** in a follow-up commit, and enable `host.yml` again:
`gh workflow enable host.yml`. `/healdesk/production/host/production-clinic` is untouched by all of
this and still says what it said.

**F6. Reconcile what happened between T and the restore.** The restore brings back the database as
it was at T; the world outside did not go back. None of this has a tool yet (gap G7); each item says
what is known from the code.

| What                                           | What the restore does                                                                                                                                                                                                                                                                                                                                                                                    | What to do                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript outbox (`transcript_emails`)        | A row pending or open at T comes back with its sealed copy and is sent again: the clinic gets a second copy. A row sent before T and delivered after comes back `sent`, with its copy, and the 72-hour `unconfirmed` rule deletes it (`transcript-outbox.ts`). A transcript queued after T and not yet delivered is lost. `drizzle/0072` holds both clocks in the database, so no copy outlives 30 days. | Tell each affected clinic, by its notice address, that it may receive a transcript twice and that any conversation after T may be missing; read the receipts with the ops operation `transcriptDeliveries`.                                           |
| Queued background work (`pgboss.job`)          | Jobs that ran after T come back queued and run again at reopen (D7 lists them by name and count).                                                                                                                                                                                                                                                                                                        | Read D7's list before F1. Each handler is meant to be idempotent against the database's ledger, but that ledger is also at T: a write to an outside system (Google Calendar, Stripe, Meta, Retell) may be made twice. Not reviewed under replay (G7). |
| Job switches (`scheduled_jobs`)                | Back to their state at T.                                                                                                                                                                                                                                                                                                                                                                                | Compare D7's list with what the console showed before the incident; set them from `/admin` after F3.                                                                                                                                                  |
| Stripe (provisioning, cancellations, invoices) | Everything recorded from Stripe's events after T is gone. A clinic provisioned after T has no account; a cancellation after T has no offboarding start, so its destruction clock is gone. The checkout records are still in the marketing Sheet (`apps/web/src/lib/checkout/records.ts`), which keeps every row.                                                                                         | Owner, Stripe dashboard: resend every event since T to the apps/web endpoint, oldest first, once F3 passes. Stripe lists events for 30 days. Not read under replay for a clinic whose Stripe objects already exist (G7).                              |
| Bookings (Google Calendar)                     | Events written after T stay in the clinic's calendar; their booking rows are gone. Availability is read from Google, so no slot is offered twice; the portal's Bookings screen does not show them.                                                                                                                                                                                                       | Tell each affected clinic.                                                                                                                                                                                                                            |
| Agreements and the BAA register                | An agreement signed or answered after T is gone from the register; an agreement in effect at T but terminated after comes back in effect.                                                                                                                                                                                                                                                                | Resent Stripe events re-provision from the sealed records. A termination after T must be recorded again by the operator. Not designed further (G7).                                                                                                   |
| Deletions, destructions, amendments            | Handled in D1 to D6.                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                                                       |

### G. Retire the old instance (within seven days)

The old instance holds every patient row up to the incident, including people deleted in production
after the reopen, so it goes as soon as D4 and D6 are done and production has run for a day, and in
any case before RDS restarts it at seven days.

```bash
aws rds modify-db-instance --db-instance-identifier "$OLD" --no-deletion-protection --apply-immediately
aws rds wait db-instance-available --db-instance-identifier "$OLD"
aws rds delete-db-instance --db-instance-identifier "$OLD" --skip-final-snapshot --no-delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$OLD"
aws rds describe-db-snapshots --db-instance-identifier "$OLD" --snapshot-type manual   # expect none
```

Its automated backups stay restorable by `--source-dbi-resource-id` until each expires at 35 days,
as for any deletion (`rds.tf`: `delete_automated_backups = false`). Its RDS-managed master secret
goes with it. D7 stopped it, and a stopped instance cannot be modified: before the block above, run
`aws rds start-db-instance --db-instance-identifier "$OLD"` and
`aws rds wait db-instance-available --db-instance-identifier "$OLD"`.

Close the incident record with T, the RTO, the RPO and each step's time; a Reviews row in
`docs/policies/training-log.md`.

## Rollback

| Where it went wrong                              | How to go back                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| During B (the copy is bad or the restore failed) | Delete the copy (`modify-db-instance --no-deletion-protection`, then `delete-db-instance --skip-final-snapshot --delete-automated-backups`). Production was never touched: set `host/mode` to `active`, enable the three workflows, run `deploy-app.yml` with `bootstrap_db` and `migrate` (a first deploy, as F1), Retell outage mode off.                                            |
| After C, before E1                               | Swap back: rename `$PROD` (the copy) to `healdesk-production-failed-$STAMP`, wait, rename `$OLD` to `healdesk-production`, wait, turn its log export back on (C4 with the names reversed). The state still names the old instance's resource id, so Terraform is consistent again. Then reopen as in the row above, and delete the failed copy. D's destructions ran in the copy only. |
| After E1, before F1                              | As above, then remove the state entry again (E1) and import the old instance (E2 to E4: the id is still `healdesk-production`, now naming the old one).                                                                                                                                                                                                                                |
| After F1                                         | The restored database has taken new writes. Going back is a new restore, from the old instance's retained automated backups (B1's variant), with this whole runbook again.                                                                                                                                                                                                             |

## Where every name comes from

| Command or name                                                                                                                                                                                                                                                                                                | Proven by                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account `865780386982`, region `us-east-1`                                                                                                                                                                                                                                                                     | `infra/aws/scripts/run-task.sh` (`ACCOUNT`, `REGION`), `.github/workflows/infra.yml` (`allowed-account-ids`)                                                |
| Instance `healdesk-production`, database `healdesk`, master user `healdesk_admin`                                                                                                                                                                                                                              | `infra/aws/locals.tf` (`name`, `db_name`, `db_username`), `infra/aws/rds.tf` (`identifier = local.name`)                                                    |
| Subnet group `healdesk-production`, parameter group `healdesk-production-postgres17`, security group `healdesk-production-rds`, CA `rds-ca-rsa2048-g1`, gp3, 35-day backups, deletion protection, Performance Insights 7 days under the key, Database Insights standard, monitoring 0, `postgresql` log export | `infra/aws/rds.tf`                                                                                                                                          |
| `db.t4g.micro`, 20 GiB, single-AZ, PostgreSQL 17.11                                                                                                                                                                                                                                                            | `infra/aws/production.tfvars`                                                                                                                               |
| Backup window `08:00-08:30`, maintenance `sun:08:45-sun:09:45`                                                                                                                                                                                                                                                 | `infra/aws/variables.tf` (`db_backup_window`, `db_maintenance_window` defaults)                                                                             |
| Key `alias/healdesk-production`                                                                                                                                                                                                                                                                                | `infra/aws/kms.tf` (`aws_kms_alias.main`)                                                                                                                   |
| Tags `Project`, `Environment`, `ManagedBy`                                                                                                                                                                                                                                                                     | `infra/aws/providers.tf` (`default_tags`)                                                                                                                   |
| Engine-log group `/aws/rds/instance/healdesk-production/postgresql`; app groups `/healdesk/production/<name>`                                                                                                                                                                                                  | `infra/aws/logs.tf`                                                                                                                                         |
| Tasks security group `healdesk-production-tasks`                                                                                                                                                                                                                                                               | `infra/aws/ecs.tf` (`aws_security_group.tasks`)                                                                                                             |
| Cluster `healdesk-production`; services `healdesk-production-web`, `-worker`, `-voice`                                                                                                                                                                                                                         | `infra/aws/scripts/run-task.sh`, `.github/workflows/deploy-app.yml` (`env`)                                                                                 |
| Worker shared, voice on                                                                                                                                                                                                                                                                                        | `infra/aws/production.tfvars` (`worker_placement`, `enable_voice`)                                                                                          |
| Voice deregistration delay one hour                                                                                                                                                                                                                                                                            | `infra/aws/alb.tf`, README "Rolling back"                                                                                                                   |
| `run-task.sh migrate`, `destroy-due`, `reapply-erasures`, `db-query <name>`                                                                                                                                                                                                                                    | `infra/aws/scripts/run-task.sh` (the `case "$1"` families)                                                                                                  |
| `db-query migration-state`, `role-settings`                                                                                                                                                                                                                                                                    | `apps/app/scripts/db-queries/*.sql`                                                                                                                         |
| `destroy-due` exits 1 while a clinic is due; output group `/healdesk/production/destroy-due`                                                                                                                                                                                                                   | `apps/app/scripts/destroy-due.ts`, README "One-off tasks from a terminal"                                                                                   |
| Parameters `app/DATABASE_URL`, `migrator/MIGRATION_DATABASE_URL`, `readonly/READONLY_DATABASE_URL`, `writer/WRITER_DATABASE_URL` under `/healdesk/production`                                                                                                                                                  | `infra/aws/ssm.tf`, `infra/aws/locals.tf` (`param_prefix`)                                                                                                  |
| Four app roles, passwords kept when set                                                                                                                                                                                                                                                                        | `infra/aws/images/db-admin/entrypoint.sh`                                                                                                                   |
| `/healdesk/production/host/mode`; `infra.yml` refuses any value but `active` or `standby`                                                                                                                                                                                                                      | `.github/workflows/infra.yml` (step "Read the host's switch"); `host.yml` writes it without reading it                                                      |
| `host.yml` dispatched by a paid invoice when no host answers                                                                                                                                                                                                                                                   | `apps/web/src/lib/host/wake.ts`                                                                                                                             |
| `deploy-app.yml` inputs `bootstrap_db`, `migrate`; all services at 0 is a first deploy                                                                                                                                                                                                                         | `.github/workflows/deploy-app.yml`                                                                                                                          |
| Plan guard reads deletions and replacements only                                                                                                                                                                                                                                                               | `infra/aws/scripts/plan-guard.sh`                                                                                                                           |
| State in the bootstrap stack's bucket; outputs `StateBucketName`, `StateKmsKeyArn`; stack `healdesk-bootstrap`                                                                                                                                                                                                 | `infra/aws/bootstrap/bootstrap.yaml`, `infra/aws/backend.tf`, README's file table                                                                           |
| Terraform 1.16.5, aws provider 6.67                                                                                                                                                                                                                                                                            | `.github/workflows/infra.yml` (`setup-terraform`), `infra/aws/versions.tf`, `.terraform.lock.hcl`                                                           |
| The db-bootstrap task names the instance's address and master secret                                                                                                                                                                                                                                           | `infra/aws/ecs.tf` (`PGHOST`, `PGPASSWORD`, `PGUSER`), `infra/aws/iam.tf` (`ReadRdsMasterSecret`)                                                           |
| SES and inbound subscriptions follow the liveness probe                                                                                                                                                                                                                                                        | `infra/aws/ses.tf`, `infra/aws/ses-inbound.tf`, `.github/workflows/infra.yml`                                                                               |
| The log lines D1 reads                                                                                                                                                                                                                                                                                         | `apps/app/src/lib/offboarding/offboarding.ts`, `apps/app/src/lib/ops/patient-entry.ts`, `apps/app/src/lib/log.ts` (the `[healdesk] <message> {json}` shape) |
| `erasure_requests` FORCEd; the ten guard triggers                                                                                                                                                                                                                                                              | `apps/app/drizzle/0063_erasure_requests.sql`; `docs/handover.md`, "Restoring"                                                                               |
| Clinic offboarding columns                                                                                                                                                                                                                                                                                     | `apps/app/src/db/schema.ts` (`clinics`)                                                                                                                     |
| `security_events` columns                                                                                                                                                                                                                                                                                      | `apps/app/src/db/schema.ts` (`securityEvents`)                                                                                                              |
| pg-boss schema `pgboss`                                                                                                                                                                                                                                                                                        | `apps/app/src/lib/queue/boss.ts`                                                                                                                            |
| Retell outage mode                                                                                                                                                                                                                                                                                             | `docs/on-call.md`, "Voice endpoint down"                                                                                                                    |

The AWS CLI flags themselves (`restore-db-instance-to-point-in-time`, `modify-db-instance`,
`--new-db-instance-identifier`, `--cloudwatch-logs-export-configuration`,
`--manage-master-user-password`, `--source-dbi-resource-id`) are AWS's, not the repository's; the
rehearsal is what proves each one is accepted as written.

## Gaps, with proposed changes (none made in this lane)

- **G1. No workflow adopts a restored instance into the state.** E1 is a hand `terraform state rm`
  in CloudShell, and E2 a temporary commit. _Proposal:_ an `infra.yml` input `adopt_database`
  that, only when the live `healdesk-production`'s `DbiResourceId` differs from the state's
  `resource_id`, runs `terraform state rm 'aws_db_instance.main[0]'`, and a permanent import block
  gated by a variable (`import { for_each = var.adopt_database ? toset(["x"]) : toset([]) ... }`),
  with a `tests/restore.tftest.hcl` run for it.
- **G2. The plan guard lets a rename of the database through.** A plan that changes
  `aws_db_instance.main[0].identifier` is an in-place update and passes. _Proposal:_ refuse any plan
  in which the database's `before.identifier` differs from `after.identifier`, or whose
  `before.resource_id` is not the live instance's.
- **G3. Nothing in the workflows knows a restore is in progress.** The freeze in A3 is the existing
  `infra.yml` refusal plus disabling two workflows by hand. _Proposal:_ `host.yml` and
  `deploy-app.yml` refuse while `host/mode` reads `restoring`, `wake.ts`'s dispatch skips it, and
  `/admin/host` shows it.
- **G4. The rehearsal cannot run `migrate`, `destroy-due`, `reapply-erasures` or `db-query` against
  a side instance**: their URLs are secrets naming production, and overriding a secret would put a
  password in CloudTrail. _Proposal:_ an optional, non-secret `HEALDESK_DB_HOST_OVERRIDE` read by
  those four scripts only, refused unless it ends in the account's RDS suffix and names an instance
  other than `healdesk-production`.
- **G5. No reviewed query checks a restore.** D7 reads the triggers, switches and queue by hand as
  the migrator. _Proposal:_ `apps/app/scripts/db-queries/restore-check.sql`, catalogue-only
  (triggers, migration count), runnable as `healdesk_readonly`; per-clinic counts need the tenant.
- **G6. No operator path writes a `security_events` row**, and one written before a restore is lost
  if T precedes it. D7 inserts it by hand as the migrator. _Proposal:_ a `run-task.sh
security-event` one-off with a closed list of events.
- **G7. What happened outside the database between T and the restore has no reconciliation tool**
  (F6): Stripe events replayed into a database at T, queued jobs that write to Google, Stripe, Meta
  or Retell again, terminations recorded after T. _Proposal:_ a review of each webhook handler and
  each queued job under replay against a database restored to before it, and an ops operation that
  lists, by id, clinics whose Stripe subscription state differs from the database's.
- **G8. The old instance's data after T is not carried over**, except deletions and amendments
  (D4, D6). That is the restore's definition, but any other row (a booking, a contact) the owner
  wants back is a data-only load under `docs/handover.md`'s trigger rules, not designed here.
- **G9. Retell outage mode is unconfirmed** for the workspace's plan (`docs/on-call.md` says so).
  Until it is, A2 cannot be relied on, and callers hear about 27 seconds of nothing during the
  restore.
- **G10. A restore because of a bad migration is not designed.** `run-task.sh migrate` runs the
  newest migrate revision naming a deployed image, the bad one, and the only way to register a
  fixed one is `deploy-app.yml`, which starts the services first. _Proposal:_ a `deploy-app.yml`
  input that registers the one-off revisions for a commit without moving any service.
- **G11. Terraform permissions.** None missing for CloudShell: the administrator holds every
  permission these commands use. The Terraform role (`healdesk-github-terraform`, AdministratorAccess,
  `bootstrap.yaml`) covers the import. No `.tf` change is needed beyond G1 and G2.

---

## Rehearsal plan (a drill on SIDE instances, production untouched)

It extends the drill the owner already has (`docs/design/restore-drill-run-sheet-2026-10-22.md`, which
runs README "Restore drill"; R1 to R3 below are that drill with production's flags), and its times
go in that run sheet's table. What it proves: the restore and modify flags are accepted; how long each RDS step takes; that a
renamed instance answers `verify-full` TLS under its new name; that the D4 copy pipeline works;
that Terraform runs in CloudShell against the real state, read-only. What it cannot prove: the
swap of production's own name, the state removal and import (G1), and running `migrate`,
`destroy-due` and `reapply-erasures` against a copy (G4). Run it now, while the host holds synthetic
data only, and again before the first live clinic. It costs a few cents an hour per side instance.

A restore drill is a PHI access once real data exists: log it in `security_events` first (the
README's rule), from the CloudShell VPC environment, as in D7, against production, with event
`restore_drill`.

```bash
# R0. CloudShell, as the administrator. The clock starts here.
export AWS_REGION=us-east-1 AWS_PAGER=""
STAMP=$(date -u +%Y%m%d%H%M)
A=healdesk-rehearsal-a-$STAMP
B=healdesk-rehearsal-b-$STAMP
KEY_ARN=$(aws kms describe-key --key-id alias/healdesk-production --query KeyMetadata.Arn --output text)
RDS_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=healdesk-production-rds \
  --query 'SecurityGroups[0].GroupId' --output text)
T=$(aws rds describe-db-instances --db-instance-identifier healdesk-production \
  --query 'DBInstances[0].LatestRestorableTime' --output text)
date -u +%FT%TZ; echo "T=$T"

# R1. Step B1 exactly, to side name A, with deletion protection OFF (so cleanup is one call)
#     and backups off (the copy keeps none).
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier healdesk-production --target-db-instance-identifier "$A" \
  --restore-time "$T" \
  --db-subnet-group-name healdesk-production --vpc-security-group-ids "$RDS_SG" \
  --db-parameter-group-name healdesk-production-postgres17 --ca-certificate-identifier rds-ca-rsa2048-g1 \
  --db-instance-class db.t4g.micro --storage-type gp3 \
  --no-multi-az --no-publicly-accessible --no-deletion-protection \
  --copy-tags-to-snapshot --auto-minor-version-upgrade --backup-retention-period 0 \
  --tags Key=Project,Value=healdesk Key=Environment,Value=production Key=ManagedBy,Value=terraform
aws rds wait db-instance-available --db-instance-identifier "$A"; date -u +%FT%TZ    # B1's time

# R2. Step B2's check.
aws rds describe-db-instances --db-instance-identifier "$A" --query \
  'DBInstances[0].[StorageEncrypted,KmsKeyId,PubliclyAccessible,EnabledCloudwatchLogsExports,PerformanceInsightsEnabled]'
```

**R3. The copy answers, under its own name, with production's master password** (the README
drill's db-bootstrap check, before R5 hands the copy its own secret). Use the README's "Restore
drill" block from `TD=""` to the `describe-tasks` call, with `DRILL=$A`. Exit code 0.

```bash
# R4. Rename A to B (rehearses C2 and C3: the time a rename takes, and the name being released).
aws rds modify-db-instance --db-instance-identifier "$A" --new-db-instance-identifier "$B" --apply-immediately
until aws rds describe-db-instances --db-instance-identifier "$B" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null | grep -qx available; do sleep 20; done
aws rds describe-db-instances --db-instance-identifier "$A" 2>&1 | grep -q DBInstanceNotFound && echo "A is free"
date -u +%FT%TZ                                                                           # C2's time
```

Run R3 again with `DRILL=$B`: exit 0 proves `verify-full` TLS holds under a renamed instance's
endpoint.

```bash
# R5. Step B3's modify, minus the backup retention (the side copy keeps none) and deletion protection.
aws rds modify-db-instance --db-instance-identifier "$B" --apply-immediately \
  --preferred-backup-window 08:00-08:30 --preferred-maintenance-window sun:08:45-sun:09:45 \
  --manage-master-user-password --master-user-secret-kms-key-id "$KEY_ARN" \
  --enable-performance-insights --performance-insights-kms-key-id "$KEY_ARN" \
  --performance-insights-retention-period 7 --database-insights-mode standard --monitoring-interval 0
aws rds wait db-instance-available --db-instance-identifier "$B"; date -u +%FT%TZ         # B3's time
aws rds describe-db-instances --db-instance-identifier "$B" --query \
  'DBInstances[0].[MasterUserSecret.SecretStatus,MasterUserSecret.KmsKeyId,PerformanceInsightsEnabled]'

# R6. C4's log export, then its removal: proves the flag, and that RDS opens an unkeyed group for
#     any name but production's (the reason for C1 and C4).
aws rds modify-db-instance --db-instance-identifier "$B" --apply-immediately \
  --cloudwatch-logs-export-configuration '{"EnableLogTypes":["postgresql"]}'
aws rds wait db-instance-available --db-instance-identifier "$B"
aws logs describe-log-groups --log-group-name-prefix "/aws/rds/instance/$B" \
  --query 'logGroups[].[logGroupName,kmsKeyId,retentionInDays]'
aws rds modify-db-instance --db-instance-identifier "$B" --apply-immediately \
  --cloudwatch-logs-export-configuration '{"DisableLogTypes":["postgresql"]}'
aws rds wait db-instance-available --db-instance-identifier "$B"
aws logs delete-log-group --log-group-name "/aws/rds/instance/$B/postgresql" || true
```

**R7. The D4 pipeline, from production (read only) into B**, in a CloudShell VPC environment set up
as in D, with `NEW` pointing at B's endpoint and `OLDC` at production's: run D4's block for one
clinic with T set to an early date, so rows exist to copy. With synthetic data, the demo clinic
(the one `run-task.sh demo-clinic` made) will do; if no clinic has an `erasure_requests` row, the
pipeline still proves the commands with zero rows. Then in psql against B:
`SELECT tgenabled FROM pg_trigger WHERE tgname = 'erasure_requests_guard';` reads `O`. Also run D7's
verification queries against B. `rm -f ~/.pgpass`; delete the VPC environment.

**R8. Terraform in CloudShell, read-only.** E1's block up to and including `state show`, **without
`state rm`**. It proves the install, the backend and the lock file work in CloudShell, and shows
whether the state's `id` is the resource id (which is what makes G2 a live risk). `terraform state
show` takes no lock; nothing is written.

```bash
# R9. Clean up the same day.
aws rds delete-db-instance --db-instance-identifier "$B" --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$B"
aws rds describe-db-snapshots --db-instance-identifier "$B"                       # expect none
aws rds describe-db-instance-automated-backups --db-instance-identifier "$B"      # expect none
aws logs describe-log-groups --log-group-name-prefix /aws/rds/instance/healdesk-rehearsal \
  --query 'logGroups[].logGroupName'                                              # expect none
rm -rf ~/tf-adopt ~/bin/terraform
```

Never take a manual snapshot of a side copy. Record in T9 and the training log: each step's time
(R1 restore, R4 rename, R5 modify), the RPO (`T` against the last write), whether every flag was
accepted as written (correct this document where one was not), and R8's `id`. Replace the
estimates in "How long it takes" with these numbers.

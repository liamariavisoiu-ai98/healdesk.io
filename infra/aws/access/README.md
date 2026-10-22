# Giving Claude Code a narrow window into AWS

Read `docs/design/db-access-2026-10-22.md` first: it says what this gives, what
it withholds and why. Nothing here has been applied. Every step below is the
owner's.

Two files, two permission sets. Make the first; the second is optional.

| File | What it lets the session do | Make it? |
| --- | --- | --- |
| `observer.policy.json` | Look: the cluster, services and tasks, the database instance's state, the names (never the values) of parameters, and the **db-query log group only**. Never a secret, never a patient bundle, never another task's logs, never change anything. | Yes |
| `db-query-addon.policy.json`, or `observer-and-db-query.policy.json` (both together) | Add to the observer: start the `db-query` task directly, with no approval click. Safe because the task's database role can read only business and configuration tables. | Only if the approval click on every query gets in the way |

The default way to run a query is **not** this: it is the `db-query` workflow on
GitHub, which waits for your approval. The observer set is for reading the
result.

## One-time set-up, in the AWS console

Menu names change now and then; the idea is stable. Use the account
`865780386982`, region `us-east-1`.

1. Open **IAM Identity Center** (search for it at the top). If it says it is not
   enabled, stop and tell Claude: the other route is an IAM role you assume from
   your own user with a one-time code, and Claude will write that instead.
2. **Permission sets** → **Create permission set** → **Custom permission set**.
   Name it `HealdeskObserver`. Session duration: **1 hour**.
3. Under **Inline policy**, paste the whole of `observer.policy.json`. Save.
4. **AWS accounts** → tick the account → **Assign users or groups** → choose
   yourself → choose `HealdeskObserver` → finish.
5. Only if you want the add-on: make the permission set from
   `observer-and-db-query.policy.json` instead (the observer's statements and the
   add-on's in one file; it is generated from the other two, so change those
   and regenerate it, never edit it alone). Name it `HealdeskObserverQuery`.

## One-time set-up, on this Mac

In a terminal, once:

```bash
aws configure sso
```

It asks for the start URL (Identity Center's "AWS access portal URL"), the
region (`us-east-1`), the account and the permission set, then a profile name:
use `healdesk-observer`.

Each time you want Claude to look, you sign in (this opens a browser and asks
for your second factor), and the session lasts an hour:

```bash
aws sso login --profile healdesk-observer
```

Then tell Claude, in the chat, to use the profile `healdesk-observer`. Claude
Code will still ask you to approve each AWS command the first time, and a block
on reading anything under `~/.aws` is correct and stays: Claude uses the
profile by name and never reads the credential files.

## What to check after you have made it

Ask Claude to run these three. The first should work, the other two must be
refused; if either of the other two works, the policy was pasted wrongly and the
permission set should be removed until it is fixed.

```bash
aws sts get-caller-identity --profile healdesk-observer
aws ssm get-parameter --name /healdesk/production/app/DATABASE_URL --with-decryption --profile healdesk-observer
aws logs filter-log-events --log-group-name /healdesk/production/web --profile healdesk-observer
```

## Taking it away

Remove yourself from the assignment in IAM Identity Center, or delete the
permission set. Nothing else depends on it.

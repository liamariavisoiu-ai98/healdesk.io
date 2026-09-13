# Access control policy — §164.308(a)(3), (a)(4) and §164.312(a)

**Effective:** 13 September 2026. **Applies to:** everyone with any access to
production systems, including the founder.

## Who may reach production

| Access | Who | How | Revoked by |
| --- | --- | --- | --- |
| The ops console (`apps/app`, internal org) | Internal staff only, listed in `org_healdesk_internal` | Invitation + sign-in + TOTP second factor | Removing the membership row; sessions expire |
| The production database, as a person | Nobody, routinely | A break-glass connection as `healdesk_migrator` from a named laptop, for a migration or an incident, recorded in the audit log by hand before and after | Rotating the migrator password |
| The host console (AWS) | The Security Official | Root account locked with hardware MFA; day-to-day through an IAM user with MFA and least privilege | Deleting the IAM user |
| Vendor consoles (Synthflow, Anthropic, Stripe, Cal.com, Resend) | The Security Official | Unique password + MFA, in a password manager | Vendor-side removal |

## Rules

1. **Minimum necessary.** The application reads and writes through the tenant
   context; the console shows counts and ids; nobody opens a patient record
   without a reason that would survive being read back in an audit review.
2. **No PHI on laptops.** No database dumps, no exported CSVs of patient rows,
   no recordings downloaded for "a quick listen". A restore or export is done on
   the host and audited.
3. **No shared accounts, no shared secrets.** Every credential is personal or is a
   service secret held by the host's secret store.
4. **Every PHI access is logged** by the application (`audit_log`, same
   transaction as the access). Break-glass access is logged by hand in
   `security_events` with the reason.
5. **Granting access** is an entry in the [training log](./training-log.md)
   (person, date, what, why) after the person has completed the training below.
6. **Revoking access** happens the same day a person leaves or a role changes,
   and is logged the same way. The Security Official checks the membership table
   and vendor user lists quarterly.
7. **Workstations** that touch production: full-disk encryption, screen lock,
   automatic updates, no PHI at rest.

## Emergency access — §164.312(a)(2)(ii)

If the console is down and a clinic's data must be reached to meet a legal
obligation, the Security Official connects as `healdesk_migrator` from a named
laptop, records the reason in `security_events` first, does the minimum, and
records what was done. There is no other emergency path.

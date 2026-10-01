# Access control policy — §164.308(a)(3), (a)(4) and §164.312(a)

**Effective:** 13 September 2026; amended 1 October 2026 for the v1 product
(the operator console's location, the vendor list, and clinic portal access).
**Applies to:** everyone with any access to production systems, including the
founder, and, for the clinic portal section, every clinic user.

## Who may reach production

| Access | Who | How | Revoked by |
| --- | --- | --- | --- |
| The operator console (`/admin` on `apps/web`) | Internal staff only | Password (scrypt hash) + TOTP second factor. It holds no database client: it reaches `apps/app` only through the HMAC-signed ops API, which returns projections (clinic configuration, scheduler state, contract metadata), never a patient row | Removing the operator's credentials; sessions expire |
| The production database, as a person | Nobody, routinely | A break-glass connection as `healdesk_migrator` from a named laptop, for a migration or an incident, recorded in the audit log by hand before and after | Rotating the migrator password |
| The host console (AWS) | The Security Official | Root account locked with hardware MFA; day-to-day through an IAM user with MFA and least privilege | Deleting the IAM user |
| Vendor consoles (Retell, Anthropic, Stripe, the database provider, Meta Business Manager and the Meta app, Google Cloud (the calendar OAuth app), Resend) | The Security Official | Unique password + MFA, in a password manager. Every clinic's Page and WhatsApp tokens are issued to Healdesk's Meta app, and every clinic's calendar token to Healdesk's Google Cloud OAuth client, so both consoles are production access | Vendor-side removal |

## Clinic portal access

The clinic portal (`apps/app`) is how a clinic's own staff reach their
conversations, bookings and settings. It is not built yet; these are the rules
it must enforce, from [v1-product-spec.md](../v1-product-spec.md) ("Account
access and credentials"), and the risk analysis (T16) assumes them.

| Rule | What it means |
| --- | --- |
| Sign-in by magic link | Payment creates the account against the billing email and lands the buyer in the wizard, already signed in through a one-time link. The welcome email carries a sign-in link, never credentials. A password is optional; the magic link alone is enough |
| A second factor before any transcript opens | Transcripts are where patient information sits. Toggles, billing and knowledge edits do not need it |
| Every transcript open is logged | One access-log row per open: who, which conversation, when. Part of the accounting of disclosures |
| Three roles | **Owner**: everything, including billing and cancellation. **Manager**: everything except billing. **Billing contact**: invoices and payment method only, never transcripts |
| Invites | Adding a team member is an email invite from the portal |
| Where account mail goes | Dunning and payment warnings go to the owner and the billing contact, never the clinic's public inbox, which the assistant may itself be answering |
| "I cannot get in" | One route on the sign-in page. It verifies the request against the billing details on file and hands it to a person at Healdesk; it never resets access automatically |
| Support chat | Carries a permanent line telling staff not to paste patient information, and is retained as a non-patient channel |

Healdesk staff do not use the clinic portal to read a clinic's patients. An
operator who needs a conversation for an incident or a patient-rights request
follows the procedure in [incident-response.md](../incident-response.md), and the
read is audited like any other.

## Rules

1. **Minimum necessary.** The application reads and writes through the tenant
   context; the operator console shows counts and ids; nobody opens a patient
   record without a reason that would survive being read back in an audit
   review.
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

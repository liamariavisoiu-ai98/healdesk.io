# Designation of Security Official — 45 CFR §164.308(a)(2)

**Effective:** 13 September 2026.

The **Security Official** responsible for developing and implementing the policies
and procedures required by the HIPAA Security Rule for healdesk is:

> **Name:** [founder's legal name — fill in]
> **Role:** Founder and sole operator
> **Contact:** the address in `apps/web/src/lib/legal.ts` (`privacyEmail`)

The same person is the **Privacy Official** for the purposes of the Privacy Rule
as it applies to a business associate, and the contact named in the Business
Associate Agreement for breach and security-incident notices.

Responsibilities, in order of importance:

1. Keep the [risk analysis](../hipaa-risk-analysis.md) true, and re-date it on review.
2. Hold the executed vendor BAAs (see the handover for where) and keep
   `apps/web/src/lib/subprocessors.ts` matching them.
3. Run the breach and incident procedure when it is needed, on the BAA's clock.
4. Grant and revoke production access under [access-control.md](./access-control.md),
   and apply [sanctions.md](./sanctions.md) — to themselves as to anyone.
5. Keep the [training log](./training-log.md).
6. Keep the [AWS HIPAA Account record](./aws-hipaa-account.md) true: re-read the
   HIPAA Eligible Services Reference before any service is added and every quarter,
   and fill in what the account still lacks.

This designation is amended by editing this file; the git history is the record of
who held the role and when.

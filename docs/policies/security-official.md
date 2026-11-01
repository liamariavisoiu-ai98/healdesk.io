# Designation of Security Official — 45 CFR §164.308(a)(2)

**Effective:** 13 September 2026.

The **Security Official** responsible for developing and implementing the policies
and procedures required by the HIPAA Security Rule for healdesk is:

> **Name:** [founder's legal name — fill in]
> **Role:** Founder and sole operator
> **Contact:** the address in `apps/web/src/lib/legal.ts` (`privacyEmail`)

The name is still to be filled in by the founder, and must be before the first
clinic agreement is signed: [v1-product-spec.md](../v1-product-spec.md) lists a
named privacy and security contact among the obligations that cannot be bought
from a vendor. The breach procedure and the template clinic notice in
[incident-response.md](../incident-response.md) name this person.

The same person is the **Privacy Official** for the purposes of the Privacy Rule
as it applies to a business associate, and the contact named in the Business
Associate Agreement for breach and security-incident notices.

Responsibilities, in order of importance:

1. Keep the [risk analysis](../hipaa-risk-analysis.md) true, and re-date it on review.
2. Hold the executed vendor BAAs (Retell, Anthropic and the database provider
   once signed; AWS per the [AWS HIPAA Account record](./aws-hipaa-account.md))
   in the compliance file, and keep the subprocessor table in
   [hipaa-compliance.md](../hipaa-compliance.md), which is the internal
   register, matching them. There is no public subprocessor page: answer a
   signed clinic's written request for the current list from that table, and
   send each clinic its notice before a new subcontractor handles PHI, as far
   ahead as the version it signed promises: 24 hours under BAA 1.3.0 to 1.6.0,
   DPA 1.0.0 and DPA 1.1.0, fifteen days under 1.2.1 and 1.2.2, and fifteen days under
   BAA 1.7.0 and DPA 1.2.0, released 30 October 2026 (the console's notices read each clinic's rule from
   `apps/app/src/lib/incidents/reporting-rules.ts`). Make sure every vendor's notice address reaches you
   (incident-response.md, "Notices from our vendors"), and that
   hello@healdesk.io, the only address the agreements name, does too.
3. Run the breach and incident procedure when it is needed, on the BAA's clock.
4. Grant and revoke production access under [access-control.md](./access-control.md),
   and apply [sanctions.md](./sanctions.md) — to themselves as to anyone.
5. Keep the [training log](./training-log.md).
6. Keep the [AWS HIPAA Account record](./aws-hipaa-account.md) true: re-read the
   HIPAA Eligible Services Reference before any service is added and every quarter,
   and fill in what the account still lacks.

This designation is amended by editing this file; the git history is the record of
who held the role and when.

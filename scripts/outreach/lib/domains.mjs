/**
 * Single source of truth for the cold-sending fleet.
 * Mirrors the `infrastructure` block of docs/outreach/coldemail-infra-runbook.md.
 *
 * If a domain is unavailable at registration time and gets substituted, change it HERE and
 * nowhere else — every script reads this list.
 */

export const GOOGLE_DOMAINS = [
  'gethealdesk.com',
  'tryhealdesk.com',
  'usehealdesk.com',
  'healdeskapp.com',
  'joinhealdesk.com',
  // The fleet is deliberately 6 Google / 4 Microsoft. This file said 5/5 —
  // the runbook's original plan — long after the decision changed, and
  // docs/outreach/coldemail-infra-runbook.md still says 5/5 today.
  //
  // That staleness had a real cost. DKIM has no discovery mechanism, so
  // verify-dns-auth.mjs picks its selectors from providerFor(). With this
  // domain listed as Microsoft it looked for selector1/selector2, found
  // nothing, and reported NO_DKIM against a domain that is correctly set up
  // and safe to send from. Verified in public DNS on 7 Sep 2026: MX
  // smtp.google.com, SPF include:_spf.google.com, a valid key on the `google`
  // selector, and the strictest DMARC in the fleet (p=reject, aspf=s, adkim=s).
  'healdeskusa.com',
]

export const MICROSOFT_DOMAINS = [
  'healdeskpro.com',
  'healdeskteam.com',
  'healdeskco.com',
  'healdeskhub.com',
]

export const ALL_DOMAINS = [...GOOGLE_DOMAINS, ...MICROSOFT_DOMAINS]

export const MAILBOXES_PER_DOMAIN = 3

/** The brand domain. Never a cold sender — see runbook §9. */
export const BRAND_DOMAIN = 'healdesk.io'

export function providerFor(domain) {
  if (GOOGLE_DOMAINS.includes(domain)) return 'google_workspace'
  if (MICROSOFT_DOMAINS.includes(domain)) return 'microsoft_365'
  throw new Error(`Unknown domain, not in the fleet: ${domain}`)
}

/** Fail fast on a malformed fleet rather than half-provisioning it. */
export function assertFleetSane() {
  const errs = []
  // Ten domains is the invariant that matters. The provider split is a
  // decision that can change — it is 6/4 today — so asserting a specific
  // split here just means a future change to it surfaces as a crash in an
  // unrelated script rather than as an edit to this list.
  if (ALL_DOMAINS.length !== 10) errs.push(`Expected 10 domains, got ${ALL_DOMAINS.length}`)
  if (!GOOGLE_DOMAINS.length) errs.push('No Google domains configured')
  if (!MICROSOFT_DOMAINS.length) errs.push('No Microsoft domains configured')
  const dupes = ALL_DOMAINS.filter((d, i) => ALL_DOMAINS.indexOf(d) !== i)
  if (dupes.length) errs.push(`Duplicate domains: ${dupes.join(', ')}`)
  if (ALL_DOMAINS.includes(BRAND_DOMAIN)) errs.push(`${BRAND_DOMAIN} must never be a cold sender`)
  if (errs.length) throw new Error(`Fleet config invalid:\n  - ${errs.join('\n  - ')}`)
  return true
}

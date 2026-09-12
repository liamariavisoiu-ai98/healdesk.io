#!/usr/bin/env node
/**
 * Phase 2, step 7 — verify SPF / DKIM / DMARC / MX on every fleet domain.
 *
 * This resolves against PUBLIC DNS, deliberately. InboxKit's own DNS-verify endpoint and the
 * Cloudflare zone records both describe what *should* be published; only a public resolver
 * shows what a receiving mail server will actually see. When the runbook says "both must
 * agree", this is the independent half of that comparison.
 *
 * Usage:
 *   node scripts/outreach/verify-dns-auth.mjs
 *   node scripts/outreach/verify-dns-auth.mjs --json
 *   node scripts/outreach/verify-dns-auth.mjs --domain gethealdesk.com
 *
 * Exit code 0 = every domain passed. 1 = at least one failed; that domain must be held back
 * from sending, not shipped and watched.
 */

import { Resolver } from 'node:dns/promises'
import { ALL_DOMAINS, providerFor } from './lib/domains.mjs'

// Public resolvers rather than the system one: a local/VPN resolver can serve stale or split
// -horizon answers, which is exactly how a "verified" domain ships broken.
const RESOLVERS = ['1.1.1.1', '8.8.8.8']

/**
 * DKIM has no discovery mechanism — you must know the selector. These are the defaults each
 * provider publishes on setup. A domain can legitimately use a custom selector; if one shows
 * NO_DKIM here but InboxKit reports DKIM valid, find the real selector before assuming failure.
 */
const DKIM_SELECTORS = {
  google_workspace: ['google'],
  microsoft_365: ['selector1', 'selector2'],
}

async function resolveWith(fn) {
  let lastErr
  for (const ip of RESOLVERS) {
    const r = new Resolver({ timeout: 5000, tries: 2 })
    r.setServers([ip])
    try {
      return await fn(r)
    } catch (e) {
      // ENODATA/NXDOMAIN are real answers ("nothing published"), not resolver failures.
      if (e.code === 'ENODATA' || e.code === 'ENOTFOUND' || e.code === 'NXDOMAIN') return null
      lastErr = e
    }
  }
  throw lastErr ?? new Error('All resolvers failed')
}

const txt = async (name) => {
  const recs = await resolveWith((r) => r.resolveTxt(name))
  return (recs ?? []).map((chunks) => chunks.join(''))
}

const mx = async (name) => (await resolveWith((r) => r.resolveMx(name))) ?? []

function checkSpf(records) {
  const spf = records.filter((r) => /^v=spf1\b/i.test(r))
  if (spf.length === 0) return { ok: false, code: 'NO_SPF', detail: 'No v=spf1 record published' }
  // More than one SPF record is a hard PermError under RFC 7208 — receivers stop evaluating.
  if (spf.length > 1) return { ok: false, code: 'MULTIPLE_SPF', detail: `${spf.length} SPF records; RFC 7208 requires exactly one` }
  const value = spf[0]
  const all = value.match(/([~\-+?])all\s*$/)
  if (!all) return { ok: false, code: 'SPF_NO_ALL', detail: `Missing terminal "all" mechanism: ${value}` }
  if (all[1] === '+') return { ok: false, code: 'SPF_PASS_ALL', detail: '"+all" authorises the entire internet to send as you' }
  return { ok: true, code: all[1] === '-' ? 'SPF_HARDFAIL' : 'SPF_SOFTFAIL', detail: value }
}

function checkDmarc(records) {
  const d = records.filter((r) => /^v=DMARC1\b/i.test(r))
  if (d.length === 0) return { ok: false, code: 'NO_DMARC', detail: 'No _dmarc TXT record' }
  if (d.length > 1) return { ok: false, code: 'MULTIPLE_DMARC', detail: `${d.length} DMARC records; must be exactly one` }
  const value = d[0]
  const p = value.match(/\bp\s*=\s*(none|quarantine|reject)\b/i)
  if (!p) return { ok: false, code: 'DMARC_NO_POLICY', detail: `No p= tag: ${value}` }
  const policy = p[1].toLowerCase()
  const ruaAddrs = [...value.matchAll(/\brua\s*=\s*([^;]+)/gi)].flatMap((m) =>
    m[1].split(',').map((a) => a.trim().replace(/^mailto:/i, '')),
  )

  // InboxKit's documented default DMARC points rua/ruf at its own domain
  // (reports@inboxsetup.com). That is workable, but it means the aggregate reports go to
  // the vendor and not to you — so you cannot independently see auth failures, which is
  // precisely the blind spot this whole build exists to close.
  const foreignRua = ruaAddrs.filter((a) => {
    const host = a.split('@')[1]?.toLowerCase() ?? ''
    return host && !host.endsWith('healdesk.io') && !host.includes('healdesk')
  })

  let ruaAdvisory = null
  if (ruaAddrs.length === 0) {
    ruaAdvisory = 'No rua= aggregate reporting address; you are blind to auth failures'
  } else if (foreignRua.length === ruaAddrs.length) {
    ruaAdvisory = `DMARC reports go only to third-party address(es): ${foreignRua.join(', ')} — add an address you control`
  }

  return {
    ok: true,
    code: `DMARC_${policy.toUpperCase()}`,
    detail: value,
    // p=none publishes nothing enforceable. Fine while warming, weak once sending at volume.
    advisory: policy === 'none' ? 'p=none does not enforce; plan to move to quarantine/reject' : null,
    ruaAdvisory,
  }
}

function checkDkim(found) {
  const hits = found.filter((f) => f.records.some((r) => /v=DKIM1/i.test(r) || /\bp=[A-Za-z0-9+/]/.test(r)))
  if (hits.length === 0) return { ok: false, code: 'NO_DKIM', detail: 'No DKIM key on any known selector' }
  return { ok: true, code: 'DKIM_OK', detail: `selector(s): ${hits.map((h) => h.selector).join(', ')}` }
}

function checkMx(records, provider) {
  if (records.length === 0) return { ok: false, code: 'NO_MX', detail: 'No MX records; the domain cannot receive replies' }
  const hosts = records.map((r) => r.exchange.toLowerCase()).join(' ')
  // Google publishes two valid shapes: the legacy 5-record ASPMX set, and the single
  // `smtp.google.com` record used for newer setups — which is what InboxKit's own
  // /dns/verify documents as the expected value. Accepting only ASPMX false-fails the
  // entire Google half of the fleet.
  const expected =
    provider === 'google_workspace'
      ? /smtp\.google\.com|aspmx\.l\.google\.com|googlemail\.com/
      : /mail\.protection\.outlook\.com/
  if (!expected.test(hosts)) {
    return {
      ok: false,
      code: 'MX_PROVIDER_MISMATCH',
      detail: `Expected ${provider} MX, saw: ${records.map((r) => `${r.priority} ${r.exchange}`).join(', ')}`,
    }
  }
  return { ok: true, code: 'MX_OK', detail: records.map((r) => `${r.priority} ${r.exchange}`).join(', ') }
}

async function auditDomain(domain, providerOverride = null) {
  // Override exists so any domain can be spot-checked ad hoc, and so a fleet domain using a
  // non-default DKIM selector can still be audited without editing this file.
  const provider = providerOverride ?? providerFor(domain)
  const [root, dmarcTxt, mxRecs] = await Promise.all([
    txt(domain).catch(() => []),
    txt(`_dmarc.${domain}`).catch(() => []),
    mx(domain).catch(() => []),
  ])

  const dkimFound = await Promise.all(
    DKIM_SELECTORS[provider].map(async (selector) => ({
      selector,
      records: await txt(`${selector}._domainkey.${domain}`).catch(() => []),
    })),
  )

  const checks = {
    spf: checkSpf(root),
    dkim: checkDkim(dkimFound),
    dmarc: checkDmarc(dmarcTxt),
    mx: checkMx(mxRecs, provider),
  }
  return { domain, provider, checks, pass: Object.values(checks).every((c) => c.ok) }
}

const args = process.argv.slice(2)
const only = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : null
const providerOverride = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null
const targets = only ? [only] : ALL_DOMAINS

const results = []
for (const d of targets) {
  results.push(await auditDomain(d, providerOverride))
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ results, allPass: results.every((r) => r.pass) }, null, 2))
} else {
  const mark = (ok) => (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m')
  for (const r of results) {
    console.log(`\n${r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.domain}  (${r.provider})`)
    for (const [name, c] of Object.entries(r.checks)) {
      console.log(`    ${mark(c.ok)}  ${name.toUpperCase().padEnd(5)} ${c.code.padEnd(22)} ${c.detail}`)
      if (c.advisory) console.log(`          \x1b[33m! ${c.advisory}\x1b[0m`)
      if (c.ruaAdvisory) console.log(`          \x1b[33m! ${c.ruaAdvisory}\x1b[0m`)
    }
  }
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'-'.repeat(70)}`)
  console.log(`${results.length - failed.length}/${results.length} domains passed authentication.`)
  if (failed.length) {
    console.log(`\x1b[31mHOLD BACK from sending: ${failed.map((f) => f.domain).join(', ')}\x1b[0m`)
    console.log('Runbook §3 gate: "do not proceed on any domain that fails this."')
  }
}

process.exit(results.every((r) => r.pass) ? 0 : 1)

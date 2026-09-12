#!/usr/bin/env node
/**
 * Phase 2, step 2 — generate the 30 sender identities for the InboxKit provisioning order.
 *
 * Deterministic by design: re-running produces byte-identical output, so the CSV can be
 * regenerated and diffed rather than treated as a one-shot artifact. No randomness.
 *
 * Usage:
 *   node scripts/outreach/gen-identities.mjs            # write docs/outreach/sender-identities.csv
 *   node scripts/outreach/gen-identities.mjs --stdout   # print instead
 *
 * Rules encoded here (from the runbook Config):
 *   - 10 domains, 3 mailboxes each = 30
 *   - 5 domains Google Workspace, 5 domains Microsoft 365; one provider per domain
 *   - username patterns limited to `firstname@` and `firstname.lastname@`
 *   - no digits, no role accounts (info@, sales@, hello@) — those read as bulk senders
 *   - every local-part unique across the whole fleet, so a reply never lands ambiguously
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')

const GOOGLE_DOMAINS = [
  'gethealdesk.com',
  'tryhealdesk.com',
  'usehealdesk.com',
  'healdeskapp.com',
  'joinhealdesk.com',
]

const MICROSOFT_DOMAINS = [
  'healdeskpro.com',
  'healdeskusa.com',
  'healdeskteam.com',
  'healdeskco.com',
  'healdeskhub.com',
]

/**
 * 30 identities, ordered. Plain US-typical names: the recipient is a US medspa owner, and a
 * name that reads as ordinary is doing its job. Deliberately unremarkable — no alliteration,
 * no names shared with well-known public figures.
 */
const PEOPLE = [
  ['Sarah', 'Whitfield'],
  ['Daniel', 'Reyes'],
  ['Megan', 'Callahan'],
  ['Peter', 'Lindqvist'],
  ['Alyssa', 'Moreau'],
  ['Jordan', 'Ashby'],
  ['Nicole', 'Vandermeer'],
  ['Marcus', 'Delaney'],
  ['Rachel', 'Okonkwo'],
  ['Trevor', 'Blackwood'],
  ['Priya', 'Raghavan'],
  ['Colin', 'Mercer'],
  ['Danielle', 'Fontaine'],
  ['Andre', 'Kowalski'],
  ['Bethany', 'Sinclair'],
  ['Ethan', 'Bergstrom'],
  ['Camille', 'Duarte'],
  ['Nathan', 'Holloway'],
  ['Simone', 'Achterberg'],
  ['Gregory', 'Tanaka'],
  ['Vanessa', 'Kirkland'],
  ['Julian', 'Abernathy'],
  ['Kendra', 'Solberg'],
  ['Miles', 'Pettigrew'],
  ['Laura', 'Castellano'],
  ['Dominic', 'Fairbanks'],
  ['Anika', 'Bhattacharya'],
  ['Russell', 'Thornbury'],
  ['Elena', 'Vasquez'],
  ['Grant', 'Ellsworth'],
]

/**
 * Per-domain local-part pattern. Mixing `firstname@` and `firstname.lastname@` within a
 * domain is what a real small company's mail looks like; three identical patterns in a row
 * is a fingerprint. Index is position within the domain (0..2).
 */
const PATTERN_BY_SLOT = ['first', 'first.last', 'first']

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '')

function localPart(first, last, pattern) {
  return pattern === 'first' ? slug(first) : `${slug(first)}.${slug(last)}`
}

function build() {
  const domains = [
    ...GOOGLE_DOMAINS.map((d) => ({ domain: d, provider: 'google_workspace', group: 'Google' })),
    ...MICROSOFT_DOMAINS.map((d) => ({ domain: d, provider: 'microsoft_365', group: 'Microsoft' })),
  ]

  const rows = []
  const seenLocal = new Set()
  let i = 0

  for (const { domain, provider, group } of domains) {
    for (let slot = 0; slot < 3; slot++) {
      const [first, last] = PEOPLE[i]
      let pattern = PATTERN_BY_SLOT[slot]
      let local = localPart(first, last, pattern)

      // Uniqueness across the whole fleet, not just within a domain: two `sarah@` on
      // different domains is survivable but muddies reply routing and warmup attribution.
      if (seenLocal.has(local)) {
        pattern = 'first.last'
        local = localPart(first, last, pattern)
      }
      if (seenLocal.has(local)) {
        throw new Error(`Duplicate local-part after fallback: ${local}`)
      }
      seenLocal.add(local)

      rows.push({
        email: `${local}@${domain}`,
        first_name: first,
        last_name: last,
        display_name: `${first} ${last}`,
        domain,
        provider,
        provider_group: group,
        username_pattern: pattern,
        slot: slot + 1,
      })
      i++
    }
  }

  if (rows.length !== 30) throw new Error(`Expected 30 mailboxes, built ${rows.length}`)
  return rows
}

const COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'display_name',
  'domain',
  'provider',
  'provider_group',
  'username_pattern',
  'slot',
]

function toCsv(rows) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(','))].join('\n') + '\n'
}

const rows = build()
const csv = toCsv(rows)

if (process.argv.includes('--stdout')) {
  process.stdout.write(csv)
} else {
  const out = resolve(REPO_ROOT, 'docs/outreach/sender-identities.csv')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, csv)
  console.error(`Wrote ${rows.length} identities -> ${out}`)
  const byGroup = rows.reduce((a, r) => ({ ...a, [r.provider_group]: (a[r.provider_group] || 0) + 1 }), {})
  console.error(`  Google: ${byGroup.Google}   Microsoft: ${byGroup.Microsoft}`)
  console.error(`  Unique local-parts: ${new Set(rows.map((r) => r.email.split('@')[0])).size}/30`)
}

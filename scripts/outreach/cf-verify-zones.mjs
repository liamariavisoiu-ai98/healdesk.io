#!/usr/bin/env node
/**
 * Phase 1, steps 3 and 5 — validate the Cloudflare token, then assert all 10 fleet domains
 * exist as active zones in the account.
 *
 * Writes docs/outreach/zone-ids.json, which later phases read instead of re-querying.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node scripts/outreach/cf-verify-zones.mjs
 *   CLOUDFLARE_API_TOKEN=... node scripts/outreach/cf-verify-zones.mjs --json
 *
 * Exit 0 = token valid and all 10 zones active. Exit 1 = gate not met.
 *
 * The token is read from the environment and never printed. If you need to prove which token
 * is loaded, compare the fingerprint this prints (first 4 chars of a SHA-256) — not the value.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_DOMAINS, assertFleetSane, providerFor } from './lib/domains.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
const API = 'https://api.cloudflare.com/client/v4'

const TOKEN = process.env.CLOUDFLARE_API_TOKEN
if (!TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN is not set.')
  console.error('Create a scoped token (Zone.Zone:Read + Zone.DNS:Edit on the 10 fleet zones)')
  console.error('at dash.cloudflare.com > My Profile > API Tokens. Do not use the Global API Key.')
  process.exit(1)
}

const fingerprint = createHash('sha256').update(TOKEN).digest('hex').slice(0, 8)

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    const errs = (body.errors || []).map((e) => `[${e.code}] ${e.message}`).join('; ')
    throw new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status}. ${errs || 'no error detail'}`)
  }
  return body
}

/** Cloudflare paginates zones at 50/page by default; the fleet fits but do it properly. */
async function listAllZones() {
  const zones = []
  let page = 1
  for (;;) {
    const body = await cf(`/zones?per_page=50&page=${page}`)
    zones.push(...body.result)
    const info = body.result_info
    if (!info || page >= info.total_pages || body.result.length === 0) break
    page++
  }
  return zones
}

const json = process.argv.includes('--json')
const say = (...a) => { if (!json) console.log(...a) }

assertFleetSane()

say(`Cloudflare token fingerprint: ${fingerprint}`)
say('')

// --- Step 5: token validity -------------------------------------------------------------
let tokenStatus
try {
  const v = await cf('/user/tokens/verify')
  tokenStatus = v.result?.status
  say(`Token verify: ${tokenStatus === 'active' ? '\x1b[32mactive\x1b[0m' : `\x1b[31m${tokenStatus}\x1b[0m`}`)
  if (tokenStatus !== 'active') {
    console.error(`Token is "${tokenStatus}", not active. Fix before continuing.`)
    process.exit(1)
  }
} catch (e) {
  console.error(`Token verification failed: ${e.message}`)
  console.error('A 6003/9109 here usually means a malformed token or the Global API Key pasted by mistake.')
  process.exit(1)
}

// --- Step 3: zones present and active ---------------------------------------------------
let zones
try {
  zones = await listAllZones()
} catch (e) {
  console.error(`Could not list zones: ${e.message}`)
  console.error('The token likely lacks Zone.Zone:Read. Re-scope it and retry.')
  process.exit(1)
}

const byName = new Map(zones.map((z) => [z.name.toLowerCase(), z]))

const rows = ALL_DOMAINS.map((d) => {
  const z = byName.get(d.toLowerCase())
  return {
    domain: d,
    provider: providerFor(d),
    present: Boolean(z),
    zone_id: z?.id ?? null,
    status: z?.status ?? null,
    // "partial" = CNAME setup, "pending" = nameservers not yet propagated to Cloudflare.
    // Only "active" means Cloudflare is authoritative and InboxKit can write records.
    ok: Boolean(z) && z.status === 'active',
    plan: z?.plan?.name ?? null,
    paused: z?.paused ?? null,
  }
})

const failures = rows.filter((r) => !r.ok)

if (json) {
  console.log(JSON.stringify({ tokenStatus, fingerprint, zones: rows, allOk: failures.length === 0 }, null, 2))
} else {
  for (const r of rows) {
    const badge = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    const state = !r.present ? 'NOT IN ACCOUNT' : r.status.toUpperCase()
    console.log(`  ${badge} ${r.domain.padEnd(22)} ${state.padEnd(16)} ${r.zone_id ?? ''}`)
  }
  console.log(`\n${'-'.repeat(70)}`)
  console.log(`${rows.length - failures.length}/${rows.length} zones active.`)
  if (failures.length) {
    console.log('\x1b[31mGate not met.\x1b[0m Missing or inactive:')
    for (const f of failures) {
      console.log(`  - ${f.domain}: ${f.present ? `status=${f.status}` : 'not registered / not in this account'}`)
    }
  }
}

// Persist zone IDs even on partial success — a later phase can work the domains that passed.
const out = resolve(REPO_ROOT, 'docs/outreach/zone-ids.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify(
    { generated_by: 'scripts/outreach/cf-verify-zones.mjs', token_fingerprint: fingerprint, zones: rows },
    null,
    2,
  ) + '\n',
)
say(`\nWrote zone map -> ${out}`)

process.exit(failures.length === 0 ? 0 : 1)

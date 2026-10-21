#!/usr/bin/env node
// Documentation-hygiene check. Cannot prove an agent actually read a file.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const required = [
  'CLAUDE.md', 'AGENTS.md', 'HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md',
  'docs/claude-session-start.md', '.github/pull_request_template.md',
];
const errors = [];
for (const file of required) if (!existsSync(file)) errors.push(`Missing ${file}`);
if (existsSync('AGENTS.md')) {
  const handoff = readFileSync('AGENTS.md', 'utf8');
  for (const heading of ['# Agent instructions', '# Continuously maintained session handoff', '## Handoff snapshot', '## Next actions — ordered', '## Owner approvals and restrictions']) {
    if (!handoff.includes(heading)) errors.push(`AGENTS.md missing: ${heading}`);
  }
}
if (existsSync('CLAUDE.md') && !readFileSync('CLAUDE.md','utf8').includes('## Mandatory Delivery Plan and Session Continuity')) errors.push('CLAUDE.md missing mandatory continuity rule');

const base = process.env.DELIVERY_DIFF_BASE;
if (base) {
  try {
    const changed = execFileSync('git', ['diff','--name-only', `${base}...HEAD`], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
    const isDelivery = (p) => /^(apps\/|packages\/|infra\/|terraform\/|scripts\/|\.github\/workflows\/)/.test(p) && !p.endsWith('.md');
    const exempt = process.env.DELIVERY_HANDOFF_EXEMPT === 'true';
    if (changed.some(isDelivery) && !changed.includes('AGENTS.md') && !exempt) {
      errors.push('Delivery-related changes require an AGENTS.md handoff update or an explicitly documented DELIVERY_HANDOFF_EXEMPT=true CI exemption.');
    }
  } catch (e) { errors.push(`Could not compare delivery changes: ${e.message}`); }
}
if (errors.length) {
  for (const e of errors) console.error('ERROR:',e);
  process.exit(1);
}
console.log('Delivery documentation check passed (not proof of reading or production readiness).');

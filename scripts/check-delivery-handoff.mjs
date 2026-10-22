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
    // Paths whose change on its own needs no handoff line (Owner's decision, 22 October 2026;
    // CLAUDE.md allows "a narrowly documented exemption"). Exact shapes, not directories: a
    // test snapshot is regenerated output, and the three IAM permission-set documents in
    // infra/aws/access are pasted into the AWS console by the Owner (infra/aws/access/README.md),
    // who reads them before they take effect. A change that also touches anything else under
    // the delivery paths still needs the AGENTS.md line.
    const exemptPath = (p) =>
      /(^|\/)__snapshots__\/[^/]+\.snap$/.test(p) || /^infra\/aws\/access\/[^/]+\.policy\.json$/.test(p);
    const isDelivery = (p) => /^(apps\/|packages\/|infra\/|terraform\/|scripts\/|\.github\/workflows\/)/.test(p) && !p.endsWith('.md') && !exemptPath(p);
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

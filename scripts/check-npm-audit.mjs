#!/usr/bin/env node
// Gate on `npm audit --omit=dev --json`: fail on any high or critical advisory
// in the production tree that is not listed, with a reason and an expiry date,
// in audit-exceptions.json.
//
// Why a script and not `npm audit --audit-level=high` alone: the bare command
// can only be silenced by deleting the job, and a deleted job leaves no trace
// of who accepted the risk or until when. An exception here is a reviewed
// line in the repository naming one advisory, why it does not apply or why it
// waits, and the day it stops being acceptable. When that day passes the job
// fails again by itself.
//
// Usage: node scripts/check-npm-audit.mjs <audit.json> [exceptions.json]
//   TODAY=YYYY-MM-DD overrides the date (tests only).
//
// Exceptions are per advisory (the GHSA id), never per package, so a second
// advisory against a package that already has an exception still fails.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GATED = new Set(["high", "critical"]);
/** An exception may not run longer than this from today. Re-review is the point. */
export const MAX_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

/** The high and critical advisories in an npm audit report, keyed by id. */
export function advisoriesOf(audit) {
  if (!audit || typeof audit !== "object" || audit.error || !audit.vulnerabilities || !audit.metadata) {
    throw new Error("the audit report is not npm's audit JSON (npm failed to audit, or the report is empty)");
  }
  const found = new Map();
  for (const vuln of Object.values(audit.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !GATED.has(via.severity)) continue;
      const id = String(via.url ?? "").split("/").pop() || `npm-${via.source}`;
      if (!found.has(id)) {
        // The title comes from the registry. Without the line breaks it cannot
        // start a workflow command of its own in the job log.
        const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");
        found.set(id, { id, package: via.name ?? vuln.name, severity: via.severity, title: oneLine(via.title), url: oneLine(via.url) });
      }
    }
  }
  // A report that counts high or critical entries yet yields no advisory is a
  // shape this parser does not understand. Failing is safe; passing is not.
  const counted = (audit.metadata.vulnerabilities?.high ?? 0) + (audit.metadata.vulnerabilities?.critical ?? 0);
  if (counted > 0 && found.size === 0) {
    throw new Error(`the report counts ${counted} high or critical entries but lists no advisory this script can read`);
  }
  return found;
}

/** Validate the exceptions file; returns the usable exceptions and the problems found. */
export function exceptionsOf(file, today) {
  const problems = [];
  const live = new Map();
  const list = file?.exceptions;
  if (!Array.isArray(list)) return { live, problems: ['audit-exceptions.json needs an "exceptions" array'] };
  const horizon = today.getTime() + MAX_DAYS * DAY;
  for (const [i, e] of list.entries()) {
    const label = `exceptions[${i}] (${e?.id ?? "no id"})`;
    if (!e || typeof e.id !== "string" || !/^GHSA(-[a-z0-9]{4}){3}$/.test(e.id)) {
      problems.push(`${label}: "id" must be a GHSA id such as GHSA-xxxx-xxxx-xxxx`);
      continue;
    }
    if (typeof e.reason !== "string" || e.reason.trim().length < 30) {
      problems.push(`${label}: "reason" must say in a sentence why this is accepted`);
      continue;
    }
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "") ? new Date(`${e.expires}T23:59:59Z`) : null;
    if (!expires || Number.isNaN(expires.getTime())) {
      problems.push(`${label}: "expires" must be a date, YYYY-MM-DD`);
      continue;
    }
    if (expires.getTime() < today.getTime()) {
      problems.push(`${label}: expired on ${e.expires}; fix the dependency or re-review and renew it`);
      continue;
    }
    if (expires.getTime() > horizon) {
      problems.push(`${label}: expires ${e.expires}, more than ${MAX_DAYS} days away`);
      continue;
    }
    live.set(e.id, e);
  }
  return { live, problems };
}

/** The whole decision: what fails, what is excepted, what is stale. */
export function judge(audit, exceptionsFile, today) {
  const found = advisoriesOf(audit);
  const { live, problems } = exceptionsOf(exceptionsFile, today);
  const unexcepted = [...found.values()].filter((a) => !live.has(a.id));
  const excepted = [...found.values()].filter((a) => live.has(a.id));
  const stale = [...live.keys()].filter((id) => !found.has(id));
  return { unexcepted, excepted, stale, problems, total: found.size };
}

function main() {
  const [auditPath, exceptionsPath = "audit-exceptions.json"] = process.argv.slice(2);
  if (!auditPath) {
    console.error("usage: check-npm-audit.mjs <audit.json> [exceptions.json]");
    process.exit(2);
  }
  const today = process.env.TODAY ? new Date(`${process.env.TODAY}T00:00:00Z`) : new Date();
  let verdict;
  try {
    verdict = judge(
      JSON.parse(readFileSync(auditPath, "utf8")),
      JSON.parse(readFileSync(exceptionsPath, "utf8")),
      today,
    );
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
  const { unexcepted, excepted, stale, problems, total } = verdict;
  console.log(`${total} high or critical production advisories: ${excepted.length} excepted, ${unexcepted.length} not.`);
  for (const a of excepted) console.log(`  excepted  ${a.id}  ${a.package}  ${a.severity}`);
  for (const id of stale) console.log(`::warning::${id} is excepted but no longer reported; remove it from audit-exceptions.json.`);
  for (const p of problems) console.log(`::error::${p}`);
  for (const a of unexcepted) {
    console.log(`::error::${a.severity} ${a.id} in ${a.package}: ${a.title} (${a.url})`);
  }
  if (unexcepted.length || problems.length) {
    console.log("::error::Production dependencies carry high or critical advisories. Upgrade the package, or add the advisory to audit-exceptions.json with a reason and an expiry date.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

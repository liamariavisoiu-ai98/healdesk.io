import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "compliance-pack" section of docs/on-call.md's alert runbook (ops
 * automation lane P6h; design E6 item 18; owner decision D20): the weekly
 * pack, stored once each Monday from 07:00 New York by the compliance-pack
 * job (lib/compliance-pack/job.ts), for the owner only.
 *
 * Both alerts are about no clinic and open the Compliance page (./tabs.ts
 * NO_CLINIC_PAGE). The pack's own printable page is lane P6j's, at
 * /admin/compliance/pack/<week>, named "Compliance pack"; until it lands it
 * is not in ./places.ts, so no step names it. When P6j lands, the lead adds
 * the place and points step 1 of compliance_pack_ready at it.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The pointer, once per week (key compliance_pack_ready:<week>), emailed to
  // the ops address: the week's Monday and the five headline numbers. A
  // number whose section could not be read is not sent, so its clause drops
  // and unreadCount says how many sections are missing: never a zero for a
  // read that failed. Each number is the pack's headline
  // (lib/compliance-pack/build.ts headlineOf).
  compliance_pack_ready: {
    title: "The weekly compliance pack is stored",
    headline: "Compliance pack for the week of {windowStart} is stored, with five numbers",
    whatHappened:
      "The compliance pack for the week of {windowStart}, Monday to Sunday in New York, is stored and can no longer change.[ Incidents still open when the week ended: {incidentsOpenCount}.][ Patient-rights requests past their day: {rightsOverdueCount}.][ Re-signs still unsigned: {resignsOpenCount}.][ Vendor agreements lapsed, withdrawn, missing or ending within 30 days: {vendorsCount}.][ Transcript copies held more than 30 days: {transcriptCopiesCount}.][?unreadCount>0: {unreadCount:section} could not be read, so their numbers are left out rather than shown as zero.]",
    whyItMatters:
      "Each number is a promise we make in our agreements or our policies. Any number above zero needs a person this week.",
    steps: [
      "Open the Compliance page and check Business associate agreements in the chain for each vendor that is lapsed, missing or ending soon.",
      "Open Incidents on the Compliance page for each incident still open, and send its report or mark it not reportable.",
      "Open Patient rights for each request past its day, and finish it or mark it done.",
      "Check the Jobs page if a section could not be read: the compliance pack job's last run says which week. You are done when each number above is zero or has a person on it.",
    ],
  },
  // The same week failed twice in a row (lib/compliance-pack/job.ts), once
  // per week (key compliance_pack_failed:<week>), emailed. The job keeps
  // trying every hour; nothing is stored until a run succeeds.
  compliance_pack_failed: {
    title: "The weekly compliance pack could not be made",
    headline: "Compliance pack for the week of {windowStart} failed twice and is not stored",
    whatHappened:
      "The compliance pack for the week of {windowStart} failed twice in a row, so it is not stored yet. The job tries again every hour.",
    whyItMatters:
      "Until it is stored, there is no record of this week's numbers to print or to show an auditor.",
    steps: [
      "Open the Jobs page and read the compliance pack job's last run: it names the week that failed.",
      "Check Requires your attention on the System page: a database that cannot be reached shows there first.",
      "Wait for the next hourly run once the cause is fixed. You are done when the Jobs page shows the job's last run as ok for that week.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

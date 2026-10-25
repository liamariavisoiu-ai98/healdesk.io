import type {
  CompliancePackHeadline,
  CompliancePackView,
  PACK_ACCESS_EVENTS,
  PACK_FAILURE_EVENTS,
  PACK_INCIDENT_CLASSES,
  PACK_LIFECYCLE_JOBS,
  PACK_SECTIONS,
  PACK_SUBJECTS,
  PACK_VENDOR_STATES,
} from "@/lib/admin/ops-client";

/**
 * The plain words the printable Compliance pack page puts on apps/app's
 * weekly pack (ops automation lane P6j; the pack is lane P6h's, apps/app
 * lib/compliance-pack/build.ts, whose header says where each number comes
 * from and which are as of the week, the week's end, or the build). Every
 * code here is a closed list of apps/app's, mirrored by ops-client and read
 * in apps/app's source by `pack-words.test.ts`. Each number carries its
 * label, what it measures and when it is measured, so a reader who is not
 * us can read the page without the code. Types only from ops-client.
 */

type Subject = (typeof PACK_SUBJECTS)[number];
type VendorState = (typeof PACK_VENDOR_STATES)[number];
type AccessEvent = (typeof PACK_ACCESS_EVENTS)[number];
type LifecycleJob = (typeof PACK_LIFECYCLE_JOBS)[number];
type FailureEvent = (typeof PACK_FAILURE_EVENTS)[number];
type IncidentClass = (typeof PACK_INCIDENT_CLASSES)[number];
export type PackSectionName = (typeof PACK_SECTIONS)[number];

/** When a number is measured (build.ts header): the three labels, each explained once at the top of the page. */
export type When = "this week" | "at week end" | "now";

export const WHEN_WORDS: Record<When, string> = {
  "this week": "events whose own time fell inside the week, Monday 00:00 to the next Monday 00:00 in New York",
  "at week end": "the state at the week's last instant, worked out from each row's own times, so a pack made late reads the same",
  now: "as the database stood when the pack was made, where no history is kept",
};

export const SECTION_WORDS: Record<PackSectionName, string> = {
  agreements: "Agreements",
  vendors: "Vendors and readiness",
  incidents: "Incidents",
  rights: "Patient rights",
  dataLifecycle: "Data lifecycle",
  access: "Access and security events",
  approvals: "The approval inbox",
};

/** A section that could not be read: its numbers are missing, never zero (build.ts: a failed read is never stored as a zero). */
export function couldNotReadWords(unreadClinics?: number): string {
  return `This section could not be read when the pack was made${unreadClinics !== undefined ? ` (${unreadClinics} ${unreadClinics === 1 ? "clinic" : "clinics"} could not be read)` : ""}. Its numbers are missing, not zero.`;
}

/** The banner over a pack stored with sections missing (job.ts: only after the week's due time plus 48 hours of hourly tries). */
export function partialWords(unread: readonly PackSectionName[]): string {
  const names = unread.map((s) => SECTION_WORDS[s]);
  return `Incomplete: ${names.length === 1 ? `the ${names[0]} section` : `${names.length} sections (${names.join(", ")})`} could not be read for two days after the week was due, so the pack was stored with ${names.length === 1 ? "it" : "them"} missing. ${names.length === 1 ? "Its" : "Their"} numbers are missing, not zero.`;
}

/** The banner over a pack made after its due hour (job.ts LATE_AFTER_MS: an hour's grace). */
export function lateWords(lateDays: number): string {
  return `Made ${lateDays} ${lateDays === 1 ? "day" : "days"} late: the pack is due at 07:00 New York on the Monday after the week, and the job did not run then. Its numbers are read as of the week's end all the same, except those marked now.`;
}

/** Who stored the pack (lib/compliance-pack/job.ts PACK_SERVICE; lib/ops/pack-ops.ts CONSOLE_SERVICE). */
export function generatedByWords(service: string): string {
  if (service === "compliance-pack") return "the weekly compliance-pack job";
  if (service === "ops-console") return "the console, by hand";
  return service;
}

export const HEADLINE_WORDS: Record<keyof CompliancePackHeadline, { label: string; measures: string; when: When }> = {
  incidentsOpen: { label: "Incidents open", measures: "incidents not resolved when the week ended, less service complaints, which no agreement reports", when: "at week end" },
  rightsOverdue: { label: "Patient-rights requests overdue", measures: "open requests past the day the agreement gives them, in UTC days", when: "at week end" },
  resignsOpen: { label: "Re-signs open", measures: "agreements asked to be signed again and not yet signed or withdrawn", when: "at week end" },
  vendorsNeedingAttention: { label: "Vendor agreements needing attention", measures: "vendors not attested, lapsed or withdrawn, or in force but ending within 30 days of the week's end", when: "at week end" },
  transcriptCopiesPast30Days: { label: "Transcript copies held past 30 days", measures: "sealed transcript copies queued more than 30 days before the week's end and still held; the promise is none", when: "now" },
};

/** A section's numbers: field by field, what each measures and when. */
export type NumberWords = { label: string; measures: string; when: When };

export const AGREEMENT_WORDS = {
  resigns: {
    openedThisWeek: { label: "Re-signs opened", measures: "practices asked to sign again this week", when: "this week" },
    signedThisWeek: { label: "Re-signs signed", measures: "re-signs completed this week", when: "this week" },
    withdrawnThisWeek: { label: "Re-signs withdrawn", measures: "re-signs withdrawn this week", when: "this week" },
    openAtWeekEnd: { label: "Re-signs open", measures: "neither signed nor withdrawn when the week ended", when: "at week end" },
    openAtWeekEndBelowFloorNow: {
      label: "Of them, below the floor",
      measures: "open re-signs whose version in force is one go-live no longer accepts, by the floor as it stands now",
      when: "now",
    },
  },
  reviews: {
    openedThisWeek: { label: "Agreement checks opened", measures: "reviews of which agreement a practice needs, opened this week", when: "this week" },
    decidedThisWeek: { label: "Agreement checks decided", measures: "reviews decided this week", when: "this week" },
    openAtWeekEndNow: { label: "Agreement checks open", measures: "undecided when the week ended, less any since superseded (that status keeps no date)", when: "now" },
  },
} satisfies Record<string, Record<string, NumberWords>>;

export const INCIDENT_WORDS = {
  openedThisWeek: { label: "Opened", measures: "incidents discovered this week", when: "this week" },
  notifiedThisWeek: { label: "Practices told", measures: "incidents whose practice was recorded as told this week", when: "this week" },
  reportedThisWeek: { label: "Reports sent", measures: "incidents whose report went this week", when: "this week" },
  notReportableThisWeek: { label: "Recorded not reportable", measures: "incidents recorded not reportable this week", when: "this week" },
  resolvedThisWeek: { label: "Resolved", measures: "incidents resolved this week", when: "this week" },
  openAtWeekEnd: { label: "Open", measures: "incidents not resolved when the week ended", when: "at week end" },
  reportableOpenAtWeekEnd: { label: "Of them, reportable", measures: "open incidents less service complaints, which no agreement reports", when: "at week end" },
} satisfies Record<string, NumberWords>;

export const RIGHTS_WORDS = {
  receivedThisWeek: { label: "Received", measures: "requests received this week, by the day they reached us", when: "this week" },
  closedThisWeek: { label: "Closed", measures: "requests closed this week", when: "this week" },
  closedOnTimeThisWeek: { label: "Of them, on time", measures: "closed on or before the day the agreement gives", when: "this week" },
  closedLateThisWeek: { label: "Of them, late", measures: "closed after that day", when: "this week" },
  openAtWeekEnd: { label: "Open", measures: "received and not closed when the week ended", when: "at week end" },
  overdueAtWeekEnd: { label: "Of them, overdue", measures: "past the day the agreement gives, in UTC days", when: "at week end" },
  dueSoonAtWeekEnd: { label: "Of them, due soon", measures: "within the tracker's due-soon window", when: "at week end" },
  blockedNow: { label: "Blocked", measures: "open requests with no route to run on the host yet", when: "now" },
  doneWithNoClosingDayNow: { label: "Done with no closing day", measures: "done at a time the record does not keep, so neither open nor closed this week", when: "now" },
} satisfies Record<string, NumberWords>;

export const TRANSCRIPT_WORDS = {
  queuedThisWeek: { label: "Transcript copies queued", measures: "conversation transcripts queued to email to their clinic this week", when: "this week" },
  deliveredThisWeek: { label: "Transcript copies delivered", measures: "copies SES reported delivered this week, after which the copy is deleted", when: "this week" },
  copiesPast30DaysNow: { label: "Copies held past 30 days", measures: "sealed copies queued more than 30 days before the week's end and still held; the promise is none", when: "now" },
} satisfies Record<string, NumberWords>;

export const FRESH_CODE_WORDS = {
  approvalDecisions: { label: "Approval decisions with a fresh code", measures: "approvals and rejections recorded with the authenticator's code", when: "this week" },
  platformAttestations: { label: "Platform attestations", measures: "attestations and withdrawals recorded on the Compliance page", when: "this week" },
  deviceRecoveriesIssued: { label: "Device recovery links issued", measures: "links sent to a clinic that lost every device", when: "this week" },
} satisfies Record<string, NumberWords>;

export const APPROVAL_INBOX_WORDS = {
  approvedThisWeek: { label: "Approved", measures: "items approved this week", when: "this week" },
  rejectedThisWeek: { label: "Rejected", measures: "items rejected this week", when: "this week" },
  executedThisWeek: { label: "Went through", measures: "approved items whose operation went through this week", when: "this week" },
  failedThisWeek: { label: "Failed", measures: "approved items whose operation did not go through this week", when: "this week" },
  expiredThisWeek: { label: "Left the list unrun", measures: "items that passed their window undecided this week", when: "this week" },
  waitingAtWeekEnd: { label: "Waiting", measures: "items proposed and not decided when the week ended", when: "at week end" },
} satisfies Record<string, NumberWords>;

export const MEDIAN_WORDS: NumberWords = { label: "Median time to decide", measures: "minutes from proposal to the owner's decision, over this week's decisions", when: "this week" };

/** The platform subjects (apps/app lib/compliance/subjects.ts): the four vendors of the BAA chain, and Gate B's readiness flags. */
export const SUBJECT_WORDS: Record<Subject, string> = {
  anthropic: "Anthropic (the AI model provider)",
  database_host: "the database host",
  aws: "AWS (our host)",
  retell: "Retell (the voice provider)",
  launch_promises: "Launch promises: none that blocks go-live is open",
  runtime_web: "Website chat runtime deployed and tested",
  runtime_meta: "Meta runtime deployed and tested",
  runtime_voice: "Phone runtime deployed and tested",
  voice_pass_through: "Phone pass-through tested: calls reach the direct line when AYA is off",
};

export const VENDOR_STATE_WORDS: Record<VendorState, string> = {
  in_force: "in force",
  lapsed: "lapsed",
  withdrawn: "withdrawn",
  not_attested: "not attested",
};

/** The incident classes the pack counts (build.ts, from the register's rows). */
export const PACK_CLASS_WORDS: Record<IncidentClass, string> = {
  security_incident: "security incident",
  improper_use_or_disclosure: "use or disclosure the agreement does not permit",
  breach: "breach of unsecured PHI",
  service_complaint: "service complaint",
};

/** The three data-lifecycle jobs the pack reads as they stand (build.ts LIFECYCLE_JOBS). */
export const LIFECYCLE_JOB_WORDS: Record<LifecycleJob, string> = {
  "retention-purge": "Retention purge",
  "transcript-emails": "Transcript emails",
  "offboarding-destroy": "Offboarding destruction",
};

/** The ops alerts a failed data-lifecycle run raises (build.ts LIFECYCLE_FAILURE_EVENTS). */
export const FAILURE_EVENT_WORDS: Record<FailureEvent, string> = {
  retention_purge_failed: "a retention purge failed",
  transcript_undelivered: "a transcript copy was not delivered",
  export_undelivered_before_destruction: "an export was not delivered before destruction",
};

/** The security events the access section counts (build.ts ACCESS_EVENTS). */
export const ACCESS_EVENT_WORDS: Record<AccessEvent, string> = {
  approval_approved: "an approval approved",
  approval_rejected: "an approval rejected",
  device_recovery_issued: "a device recovery link issued",
  device_recovery_claimed: "a device recovery link claimed",
  device_recovery_used: "a device recovery link used",
  device_recovery_refused: "a device recovery link refused",
  device_recovery_revoked: "a device recovery link revoked",
  passkey_added: "a passkey added",
  passkey_removed: "a passkey removed",
  totp_enrolled: "an authenticator app enrolled",
  backup_codes_generated: "backup codes generated",
  factor_locked_out: "a sign-in factor locked out",
  step_up_granted: "a step-up granted",
  sign_in_help_link_sent: "a sign-in help link sent",
  sign_in_address_changed: "a sign-in address changed",
  operator_signed_out: "an operator signed out",
};

/** The one line the access section says of operator sign-ins (build.ts operatorSignIns). */
export const SIGN_INS_WORDS = "Operator sign-ins are not recorded on the host: the console's sign-in is checked on Vercel (CLAUDE.md, case 3).";

/** The launch promises are apps/web's list, read when the page is drawn, never stored in the pack (build.ts launchPromises). */
export const LAUNCH_PROMISES_WORDS = "Read from the console now, not stored with the pack: the list lives in this app, which the host cannot read.";

/** A pack's week in words: "Monday 26 Oct to Sunday 1 Nov 2026, New York". */
export function weekWords(week: CompliancePackView["week"]): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  const year = week.lastDay.slice(0, 4);
  return `Monday ${day.format(new Date(week.start))} to Sunday ${day.format(new Date(week.lastDay))} ${year}, New York`;
}

/** A number of minutes as a reader reads it. */
export function minutesWords(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

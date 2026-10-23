import type {
  AgreementReview,
  ClinicHealth,
  HealthFlag,
  OpsClinics,
  OpsResult,
  PracticeReview,
  RecordingAlerts,
  SiteReadFailureRow,
  SupportRequests,
} from "@/lib/admin/ops-client";
import type { LaunchPromise } from "@/lib/admin/seo/launch";
import type { InboxRow, OpsInbox, Tone } from "@/lib/admin/strip-types";

/**
 * Home's list, "what needs me today, in order" (E1 §2), composed from the
 * reads this app already makes while lane A2's `opsInbox` is not read yet,
 * and the ordering both share. apps/app's inbox will know things this one
 * cannot (open alerts, undelivered transcripts, clinics ready to go live,
 * the digest's state); what this one knows is every queue's count, every
 * blocked clinic and every first-weeks flag, which is the half of the list
 * that exists today. A read that failed is an `unreadable` entry, printed as
 * "Could not read X", never a zero.
 *
 * Each row is one count, one sentence, the clinic when there is one, and one
 * button. Ids, counts, dates, enums and the clinic's name: nothing else
 * crosses, and nothing here is a patient. Pure: the test feeds fixtures.
 */

export type InboxReads = {
  clinics: OpsResult<OpsClinics>;
  health: OpsResult<ClinicHealth[]>;
  reviews: OpsResult<PracticeReview[]>;
  agreementChecks: OpsResult<AgreementReview[]>;
  support: OpsResult<SupportRequests>;
  recordings: OpsResult<RecordingAlerts>;
  siteReads: OpsResult<{ failures: SiteReadFailureRow[]; limit: number }>;
  launch: readonly LaunchPromise[];
  /** Setup requests still owed a link, or null when the Sheet is not configured. */
  setupRequestsWaiting: number | null | { failed: string };
};

const SEVERITY: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3, muted: 4 };

/** Earliest deadline first, then the worst tone; rows with no deadline after those with one. */
export function sortInboxRows(rows: InboxRow[]): InboxRow[] {
  return [...rows].sort((a, b) => {
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt < b.dueAt ? -1 : 1;
    }
    return SEVERITY[a.tone] - SEVERITY[b.tone] || a.id.localeCompare(b.id);
  });
}

/** The first-weeks flags as one sentence each: the two human moments the product cannot replace, and two checks. */
const FLAG_ROW: Record<HealthFlag, { sentence: string; tone: Tone; tab: "setup" | "billing" | "care"; label: string }> = {
  no_calls_after_day_7: { sentence: "Past day 7 with no calls: the phone was never forwarded. Phone them.", tone: "warn", tab: "setup", label: "Open Setup" },
  first_win: { sentence: "First booking by AYA, and nobody has called them since. Call and say so.", tone: "ok", tab: "care", label: "Open Care" },
  quiet_week: { sentence: "Nothing this week after earlier calls: check the forwarding still holds.", tone: "warn", tab: "setup", label: "Open Setup" },
  near_allowance: { sentence: "At 90% or more of an allowance: the step-up conversation is due.", tone: "warn", tab: "billing", label: "Open Billing" },
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function earliest(days: (string | null)[]): string | null {
  const sorted = days.filter((d): d is string => d !== null).sort();
  return sorted[0] ?? null;
}

export function composeInbox(reads: InboxReads, now: Date): OpsInbox {
  const rows: InboxRow[] = [];
  const unreadable: OpsInbox["unreadable"] = [];
  const failed = (source: string, result: OpsResult<unknown>): boolean => {
    if (result.ok) return false;
    unreadable.push({ source, reason: result.message });
    return true;
  };

  if (!failed("the clinic list", reads.clinics) && reads.clinics.ok) {
    for (const clinic of reads.clinics.data.clinics) {
      const blocked = clinic.blockers.find((b) => b.level === "blocked");
      if (!blocked || clinic.dataClassification === "synthetic") continue;
      rows.push({
        id: `blocked:${clinic.id}`,
        kind: "clinic_blocked",
        count: 1,
        sentence: blocked.message,
        clinic: { id: clinic.id, name: clinic.name },
        button: { label: "Open Setup", kind: "link", href: `/admin/clinics/${clinic.id}/setup` },
        tone: "bad",
        dueAt: null,
      });
    }
  }

  if (!failed("the first-weeks list", reads.health) && reads.health.ok) {
    for (const clinic of reads.health.data) {
      for (const flag of clinic.flags) {
        const row = FLAG_ROW[flag];
        rows.push({
          id: `health:${flag}:${clinic.clinicId}`,
          kind: `health_${flag}`,
          count: 1,
          sentence: row.sentence,
          clinic: { id: clinic.clinicId, name: clinic.name },
          button: { label: row.label, kind: "link", href: `/admin/clinics/${clinic.clinicId}/${row.tab}` },
          tone: row.tone,
          dueAt: null,
        });
      }
    }
  }

  if (!failed("the review queue", reads.reviews) && reads.reviews.ok) {
    const open = reads.reviews.data.filter((r) => r.status === "open");
    if (open.length > 0) {
      rows.push({
        id: "queue:reviews",
        kind: "reviews_owed",
        count: open.length,
        sentence: `${plural(open.length, "practice-question run waits", "practice-question runs wait")} for a decision${open.some((r) => r.pastDue) ? ", one past its day" : ""}.`,
        clinic: null,
        button: { label: "Open Queues › Reviews", kind: "link", href: "/admin/queues#reviews" },
        tone: open.some((r) => r.pastDue) ? "bad" : "warn",
        dueAt: earliest(open.map((r) => r.dueOn)),
      });
    }
  }

  if (!failed("the agreement checks", reads.agreementChecks) && reads.agreementChecks.ok) {
    const open = reads.agreementChecks.data.filter((r) => r.status === "open");
    if (open.length > 0) {
      rows.push({
        id: "queue:agreement-checks",
        kind: "agreement_checks_owed",
        count: open.length,
        sentence: `${plural(open.length, "practice signed the DPA while its", "practices signed the DPA while their")} website says insurance: ask, then record the answer.`,
        clinic: null,
        button: { label: "Open Queues › Agreement checks", kind: "link", href: "/admin/queues#agreement-checks" },
        tone: "warn",
        dueAt: null,
      });
    }
  }

  if (!failed("the support requests", reads.support) && reads.support.ok) {
    const owed = reads.support.data.requests.filter((r) => !r.repliedAt);
    if (owed.length > 0) {
      const late = owed.filter((r) => r.pastDue).length;
      rows.push({
        id: "queue:support",
        kind: "support_owed",
        count: owed.length,
        sentence: `${plural(owed.length, "support request is", "support requests are")} owed a reply from hello@${late > 0 ? `, ${late} past ${plural(late, "its", "their")} day` : ""}.`,
        clinic: null,
        button: { label: "Open Queues › Support", kind: "link", href: "/admin/queues#support" },
        tone: late > 0 ? "bad" : "warn",
        dueAt: earliest(owed.map((r) => r.replyByOn)),
      });
    }
  }

  if (!failed("the Retell deletions", reads.recordings) && reads.recordings.ok) {
    const open = reads.recordings.data.alerts.filter((a) => !a.resolvedAt);
    if (open.length > 0) {
      rows.push({
        id: "queue:retell-deletions",
        kind: "retell_deletions_owed",
        count: open.length,
        sentence: `${plural(open.length, "call is", "calls are")} still held at Retell past the deletion window: delete ${plural(open.length, "it", "each")} there.`,
        clinic: null,
        button: { label: "Open Queues › Retell deletions", kind: "link", href: "/admin/queues#retell-deletions" },
        tone: "warn",
        dueAt: null,
      });
    }
  }

  if (!failed("the site reads", reads.siteReads) && reads.siteReads.ok) {
    const open = reads.siteReads.data.failures.filter((f) => f.clinicId !== null && !f.profileSince);
    if (open.length > 0) {
      rows.push({
        id: "queue:site-reads",
        kind: "site_reads_failed",
        count: open.length,
        sentence: `${plural(open.length, "clinic's website", "clinics' websites")} could not be read at checkout and ${plural(open.length, "has", "have")} no profile yet.`,
        clinic: null,
        button: { label: "Open Queues › Site reads", kind: "link", href: "/admin/queues#site-reads" },
        tone: "info",
        dueAt: null,
      });
    }
  }

  if (typeof reads.setupRequestsWaiting === "object" && reads.setupRequestsWaiting !== null) {
    unreadable.push({ source: "the setup requests", reason: reads.setupRequestsWaiting.failed });
  } else if (typeof reads.setupRequestsWaiting === "number" && reads.setupRequestsWaiting > 0) {
    const n = reads.setupRequestsWaiting;
    rows.push({
      id: "queue:setup-requests",
      kind: "setup_requests_waiting",
      count: n,
      sentence: `${plural(n, "clinic asked", "clinics asked")} to be set up and ${plural(n, "has", "have")} no link yet: reply by the next business day.`,
      clinic: null,
      button: { label: "Open Queues › Setup requests", kind: "link", href: "/admin/queues#setup-requests" },
      tone: "warn",
      dueAt: null,
    });
  }

  const open = reads.launch.filter((p) => p.status !== "on");
  const blocking = open.filter((p) => p.blocksGoLive).length;
  if (open.length > 0) {
    rows.push({
      id: "launch",
      kind: "launch_promises_open",
      count: open.length,
      sentence: `${plural(open.length, "promise the site makes is", "promises the site makes are")} not on in production, ${blocking} blocking go-live.`,
      clinic: null,
      button: { label: "Open Compliance › Launch", kind: "link", href: "/admin/compliance#launch" },
      tone: blocking > 0 ? "warn" : "info",
      dueAt: null,
    });
  }

  return { rows: sortInboxRows(rows), checkedAt: now.toISOString(), unreadable };
}

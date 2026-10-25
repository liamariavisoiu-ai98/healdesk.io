import { and, desc, gte, ne } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import { opsAlertTitle } from "@/lib/email/templates/ops_alert";

import { readIgnoredClinicIds } from "@/lib/lifecycle/ignore";
import { LIFECYCLE_EVENTS } from "@/lib/lifecycle/waves";

import { FLAG_ALERT_EVENT } from "../flag-alert";
import { OPS_EVENTS, opsConsolePath, type OpsEvent } from "../notify";

import type { InboxRow, InboxSource, Tone } from "./types";

/**
 * The ops log's alerts raised (or raised again) in the last 24 hours, one
 * row per event and clinic, worded by the alert's own title (the email's
 * subject and the Slack copy's first line), linked to the page the alert's
 * own link opens.
 *
 * The ops log has no "resolved" column: an alert is a notice that something
 * happened, and what fixes it lives in its own table. So "open" here means
 * recent: an alert still being raised stays on Home, and one nobody has
 * raised for a day leaves it. Left out: the digest's own row, good news
 * (calendar_recovered, location_quantity_agrees), and the alerts another
 * inbox source already lists from its own table (support replies, practice
 * question reviews), so nothing is said twice.
 */

export const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_READ = 500;

const LEFT_OUT: ReadonlySet<string> = new Set<OpsEvent>([
  "calendar_recovered",
  "location_quantity_agrees",
  "support_reply_past_due",
  "practice_question_failed",
  "practice_question_review_past_due",
  // Lane A4: the same issues have their own rows, read from their own
  // tables, so Home says each once. A clinic's availability change is the
  // availability row (lib/ops/inbox/availability.ts); a decision owed and a
  // clinic waiting on us are the "Needs a decision" row (./decisions.ts).
  "clinic_availability_changed",
  "lifecycle_decision_due",
  "lifecycle_waiting_on_us",
  "lifecycle_waiting_on_us_long",
  "lifecycle_closing_waiting_on_us",
  // Phase 6: the approvals source lists each kind waiting for the owner's yes
  // (./approvals.ts), and the rights source the requests due soon and past
  // their day (./rights.ts), so their alerts would say each twice. A blocked
  // request has no row of its own, so its alert stays.
  "approval_waiting",
  "clinic_email_waiting",
  "rights_request_due_soon",
  "rights_request_overdue",
  // The weekly compliance pack's pointer is for the owner's inbox only (owner
  // decision D20): Home would repeat a weekly email as a row for a day.
  "compliance_pack_ready",
  // The incident assistant's items have the approvals source's row too (lane P6i).
  "incident_step_waiting",
]);

/** Alerts about a patient who may not reach the clinic, or a paid buyer with no account. */
const BAD: ReadonlySet<string> = new Set<OpsEvent>([
  "provisioning_rejected",
  "provisioning_dead_lettered",
  "paid_intent_without_clinic",
  "voice_fallback_no_direct_line",
  "voice_direct_line_loops",
  "voice_call_start_failed",
  "calendar_broken",
  "connection_broken",
  "urgent_alert_not_queued",
  "critical_notice_undelivered",
  "patient_request_past_due",
  "incident_notice_overdue",
]);

/** The lifecycle watch's wave events, every one (lib/lifecycle/waves.ts). */
const WAVE_EVENTS: ReadonlySet<string> = new Set(LIFECYCLE_EVENTS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOpsEvent(event: string): event is OpsEvent {
  return (OPS_EVENTS as readonly string[]).includes(event);
}

export const opsAlertsSource: InboxSource = {
  name: "ops alerts",
  async read(ctx) {
    const since = new Date(ctx.now.getTime() - ALERT_WINDOW_MS);
    const raised = await unsafeDb
      .select({ id: opsAlerts.id, event: opsAlerts.event, fields: opsAlerts.fields })
      .from(opsAlerts)
      .where(and(gte(opsAlerts.lastRaisedAt, since), ne(opsAlerts.event, "ops_digest")))
      .orderBy(desc(opsAlerts.lastRaisedAt))
      .limit(MAX_READ);

    const groups = new Map<
      string,
      {
        event: string;
        clinicId: string | null;
        count: number;
        alertId: string;
        fields: Record<string, string | number | boolean | null>;
      }
    >();
    // The lifecycle watch's waves for an account on its ignore list (healdesk's
    // own test accounts): raised before it was ignored, they are about
    // nothing the operator must do. Read only when there is such a wave.
    const waveClinics = raised.some((r) => WAVE_EVENTS.has(r.event) && typeof r.fields?.clinicId === "string");
    const { ignored, unread: unreadMarks, listUnread } = waveClinics
      ? await readIgnoredClinicIds({ actor: ctx.actor, request: ctx.request })
      : { ignored: new Set<string>(), unread: new Set<string>(), listUnread: false };
    for (const { id: alertId, event, fields } of raised) {
      if (LEFT_OUT.has(event)) continue;
      if (
        WAVE_EVENTS.has(event) &&
        typeof fields?.clinicId === "string" &&
        ignored.has(fields.clinicId.toLowerCase())
      ) {
        continue;
      }
      if (!isOpsEvent(event) && event !== FLAG_ALERT_EVENT) continue;
      const raw = fields?.clinicId;
      const clinicId = typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
      const key = `${event}:${clinicId ?? "all"}`;
      // Rows come newest first, so a group keeps its newest alert's fields
      // for the title and its id for the link's anchor.
      const seen = groups.get(key) ?? { event, clinicId, count: 0, alertId, fields: fields ?? {} };
      seen.count += 1;
      groups.set(key, seen);
    }
    const partial =
      [
        raised.length >= MAX_READ ? `Only the newest ${MAX_READ} alerts of the last day were read.` : null,
        listUnread
          ? "The lifecycle ignore list could not be read, so every clinic's setup alerts are shown."
          : unreadMarks.size > 0
            ? `The ignore list of ${unreadMarks.size} clinic(s) could not be read.`
            : null,
      ]
        .filter((p): p is string => p !== null)
        .join(" ") || undefined;
    if (groups.size === 0) return { rows: [], partial };

    const names = await ctx.clinicNames();
    const rows: InboxRow[] = [];
    for (const [key, { event, clinicId, count, alertId, fields }] of groups) {
      const name = clinicId ? names.get(clinicId) : undefined;
      rows.push({
        id: `alert:${key}`,
        kind: "ops_alert",
        count,
        sentence: sentenceFor(event, fields),
        clinic: clinicId && name !== undefined ? { id: clinicId, name } : null,
        button: { label: clinicId ? "Open clinic" : "Open console", kind: "link", href: hrefFor(event, clinicId, alertId) },
        tone: toneFor(event),
        dueAt: null,
      });
    }
    return { rows, partial };
  },
};

function sentenceFor(event: string, fields: Record<string, string | number | boolean | null>): string {
  if (event === FLAG_ALERT_EVENT) return "A clinic flagged one of AYA's answers.";
  const title = opsAlertTitle({ ...fields, event: event as OpsEvent });
  return /[.!?]$/.test(title) ? title : `${title}.`;
}

/**
 * The alert's own page (opsConsolePath, the link its email and Slack copy
 * print), at the newest alert's anchor so the tab scrolls to it. A flag is
 * not an OpsEvent and has no anchor: it opens the clinic's Care tab, where
 * flags are read. An alert with no page of its own opens the Clinics list,
 * where the retired /admin/ops landed.
 */
function hrefFor(event: string, clinicId: string | null, alertId: string): string {
  if (event === FLAG_ALERT_EVENT) return clinicId ? `/admin/clinics/${clinicId}/care` : CLINICS_PAGE;
  return opsConsolePath(event as OpsEvent, clinicId ? { clinicId } : {}, alertId) ?? CLINICS_PAGE;
}

const CLINICS_PAGE = "/admin/clinics";

function toneFor(event: string): Tone {
  return BAD.has(event) ? "bad" : "warn";
}

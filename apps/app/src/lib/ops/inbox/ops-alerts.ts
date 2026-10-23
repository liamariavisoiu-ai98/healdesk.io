import { and, desc, gte, ne } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import { opsAlertTitle } from "@/lib/email/templates/ops_alert";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOpsEvent(event: string): event is OpsEvent {
  return (OPS_EVENTS as readonly string[]).includes(event);
}

export const opsAlertsSource: InboxSource = {
  name: "ops alerts",
  async read(ctx) {
    const since = new Date(ctx.now.getTime() - ALERT_WINDOW_MS);
    const raised = await unsafeDb
      .select({ event: opsAlerts.event, fields: opsAlerts.fields })
      .from(opsAlerts)
      .where(and(gte(opsAlerts.lastRaisedAt, since), ne(opsAlerts.event, "ops_digest")))
      .orderBy(desc(opsAlerts.lastRaisedAt))
      .limit(MAX_READ);

    const groups = new Map<
      string,
      { event: string; clinicId: string | null; count: number; fields: Record<string, string | number | boolean | null> }
    >();
    for (const { event, fields } of raised) {
      if (LEFT_OUT.has(event)) continue;
      if (!isOpsEvent(event) && event !== FLAG_ALERT_EVENT) continue;
      const raw = fields?.clinicId;
      const clinicId = typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null;
      const key = `${event}:${clinicId ?? "all"}`;
      // Rows come newest first, so a group keeps its newest alert's fields for the title.
      const seen = groups.get(key) ?? { event, clinicId, count: 0, fields: fields ?? {} };
      seen.count += 1;
      groups.set(key, seen);
    }
    const partial =
      raised.length >= MAX_READ ? `Only the newest ${MAX_READ} alerts of the last day were read.` : undefined;
    if (groups.size === 0) return { rows: [], partial };

    const names = await ctx.clinicNames();
    const rows: InboxRow[] = [];
    for (const [key, { event, clinicId, count, fields }] of groups) {
      const name = clinicId ? names.get(clinicId) : undefined;
      rows.push({
        id: `alert:${key}`,
        kind: "ops_alert",
        count,
        sentence: sentenceFor(event, fields),
        clinic: clinicId && name !== undefined ? { id: clinicId, name } : null,
        button: { label: clinicId ? "Open clinic" : "Open console", kind: "link", href: hrefFor(event, clinicId) },
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

function hrefFor(event: string, clinicId: string | null): string {
  if (event === FLAG_ALERT_EVENT) return clinicId ? `/admin/ops/${clinicId}/care` : "/admin/ops";
  return opsConsolePath(event as OpsEvent, clinicId ? { clinicId } : {}) ?? "/admin/ops";
}

function toneFor(event: string): Tone {
  return BAD.has(event) ? "bad" : "warn";
}

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { clinics, conversations, retellRecordingAlerts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { RETELL_API_ORIGIN, retellApiKey } from "./retell-api";

/** Retell's call ids, as the backstop takes them (./backstop.ts, isRetellCallId; not imported, which would make a cycle). */
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRetellCallId(value: unknown): value is string {
  return typeof value === "string" && CALL_ID.test(value);
}

/**
 * The backstop for "no call audio is kept" (NOAUDIO-01; the owner's design
 * of 21 October 2026).
 *
 * Every clinic's Retell agent is set to keep no recording
 * (lib/voice/retell-agent.ts), but a setting can be changed in Retell's
 * console, or not honoured. So each call Retell tells us about is checked:
 * a call object carrying any recording URL is a recording Retell kept, and
 * becomes one opaque alert row (retell_recording_alerts, drizzle/0105): the
 * clinic, Retell's call id, when. Never the URL, never the transcript, never
 * a number, and the recording itself is never fetched.
 *
 * /admin/recordings (apps/web) lists the alerts through the ops API
 * (listRecordingAlerts) and its button asks apps/app, which alone holds
 * HEALDESK_RETELL_API_KEY, to delete the call at Retell
 * (deleteRecordedCall). Retell's delete-call (DELETE /v2/delete-call/<id>,
 * 204 on success) deletes the call record as a whole: its recording, its
 * transcript and its logs. Nothing of ours depends on Retell's copy once the
 * call is recorded on our side, since the clinic's transcript is our own,
 * sealed in the outbox; the one reader of it is the backstop
 * (lib/voice/backstop.ts), which reads a call the live socket never recorded
 * BACKSTOP_DELAY_SECONDS after it ends and retries for about an hour. So a
 * delete waits until the call has a conversation here, or until the
 * backstop's last retry is over (DELETE_NOT_BEFORE_MS after the alert).
 */

/** The fields of Retell's call object that hold a recording (Retell's get-call reference). */
export const RECORDING_URL_FIELDS = [
  "recording_url",
  "recording_multi_channel_url",
  "scrubbed_recording_url",
  "scrubbed_recording_multi_channel_url",
] as const;

/** Pure: whether Retell's call object says it kept a recording. Reads presence only. */
export function retellCallHasRecording(call: unknown): boolean {
  if (!call || typeof call !== "object") return false;
  const c = call as Record<string, unknown>;
  return RECORDING_URL_FIELDS.some((field) => typeof c[field] === "string" && (c[field] as string).trim().length > 0);
}

const ACTOR: ActorContext = { type: "agent", serviceName: "retell-recording-alerts" };

/**
 * Record that Retell kept a recording of this call, once per call: a second
 * webhook (call_analyzed after call_ended, Retell's retries, the backstop's
 * read) finds the row and adds nothing. Returns whether this call wrote it.
 * A clinic id that names no clinic writes nothing. Throws only when the
 * database does, so the webhook can answer 503 and Retell retries.
 */
export async function recordRecordingAlert(clinicId: string, callId: string): Promise<boolean> {
  if (!isRetellCallId(callId)) return false;
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [clinic] = await tx.db.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
    if (!clinic) return false;
    const inserted = await tx.db
      .insert(retellRecordingAlerts)
      .values({ clinicId, retellCallId: callId })
      .onConflictDoNothing({ target: [retellRecordingAlerts.clinicId, retellRecordingAlerts.retellCallId] })
      .returning({ id: retellRecordingAlerts.id });
    if (inserted.length === 0) return false;
    tx.audit.record({ action: "create", resourceType: "retell_recording_alert", resourceId: inserted[0]!.id });
    log.warn("retell kept a call recording", { clinicId, callId });
    return true;
  });
}

/** One alert, as /admin/recordings shows it: ids and times only. */
export type RecordingAlertView = {
  alertId: string;
  clinicId: string;
  clinicSlug: string;
  callId: string;
  detectedAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  /** Our own words for why the last delete did not go; never Retell's body. */
  lastError: string | null;
  resolvedAt: string | null;
};

/** At most this many alerts are listed: each is a fault to fix, not a feed. */
export const MAX_LISTED_ALERTS = 200;

/** Every clinic's alerts, open first then newest, with a count of clinics that could not be read. */
export async function listRecordingAlerts(
  actor: ActorContext,
  request: RequestContext,
): Promise<{ alerts: RecordingAlertView[]; unreadClinics: number }> {
  const alerts: RecordingAlertView[] = [];
  let unreadClinics = 0;
  for (const clinic of await listClinics()) {
    try {
      const rows = await withTenant({ clinicId: clinic.id, actor, request }, async (tx) => {
        const found = await tx.db
          .select()
          .from(retellRecordingAlerts)
          .where(eq(retellRecordingAlerts.clinicId, tx.clinicId))
          .orderBy(desc(retellRecordingAlerts.detectedAt))
          .limit(MAX_LISTED_ALERTS);
        if (found.length > 0) {
          tx.audit.record({ action: "read", resourceType: "retell_recording_alert", resultCount: found.length });
        }
        return found;
      });
      for (const row of rows) {
        alerts.push({
          alertId: row.id,
          clinicId: row.clinicId,
          clinicSlug: clinic.slug,
          callId: row.retellCallId,
          detectedAt: row.detectedAt.toISOString(),
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
          lastError: row.lastError,
          resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        });
      }
    } catch (error) {
      unreadClinics += 1;
      log.error("recording alerts not read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  alerts.sort((a, b) =>
    (a.resolvedAt === null) !== (b.resolvedAt === null) ? (a.resolvedAt === null ? -1 : 1) : b.detectedAt.localeCompare(a.detectedAt),
  );
  return { alerts: alerts.slice(0, MAX_LISTED_ALERTS), unreadClinics };
}

/**
 * Long enough that the backstop has read the call, or given up: its first
 * read is BACKSTOP_DELAY_SECONDS (ten minutes) after the call, and five
 * retries with doubling delays from a minute take about another hour. Two
 * hours, pinned against those numbers by tests/recording-alerts.test.ts.
 */
export const DELETE_NOT_BEFORE_MS = 2 * 60 * 60_000;

export type DeleteRecordedCallOutcome =
  /** Retell deleted the call (204), or had no such call (404): resolved now. */
  | { status: "deleted"; resolvedAt: string }
  /** Resolved before: Retell was not asked again. */
  | { status: "already"; resolvedAt: string }
  /** Too soon: the backstop may still need Retell's copy. */
  | { status: "too_soon"; notBefore: string }
  /** Retell did not delete it; the alert stays open with the reason. */
  | { status: "failed"; reason: string }
  | { status: "not_found" };

export type DeleteDeps = {
  apiKey?: string | null;
  fetch?: typeof fetch;
  now?: Date;
};

/** Retell's delete for one call. Our own words come back, never Retell's body. */
async function deleteAtRetell(callId: string, deps: DeleteDeps): Promise<{ gone: true } | { gone: false; reason: string }> {
  const key = deps.apiKey === undefined ? retellApiKey() : deps.apiKey;
  if (!key) return { gone: false, reason: "HEALDESK_RETELL_API_KEY is not set on apps/app" };
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${RETELL_API_ORIGIN}/v2/delete-call/${encodeURIComponent(callId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    return { gone: false, reason: name === "TimeoutError" ? "Retell did not answer within 10 seconds" : "Retell could not be reached" };
  }
  // 204: deleted. 404: Retell has no such call, which is what deleting wanted.
  if (response.status === 204 || response.status === 200 || response.status === 404) return { gone: true };
  return { gone: false, reason: `Retell answered ${response.status}` };
}

/**
 * The operator's delete: ask Retell to delete one alerted call, and resolve
 * the alert when it does. Idempotent: a resolved alert answers `already`
 * without asking Retell, and a call Retell no longer has resolves too. A
 * failure leaves the alert open, with our reason and one more attempt
 * counted. Each attempt is audited in the clinic's log; the caller records
 * the operator's own security event.
 */
export async function deleteRecordedCall(
  clinicId: string,
  alertId: string,
  actor: ActorContext,
  request: RequestContext,
  deps: DeleteDeps = {},
): Promise<DeleteRecordedCallOutcome> {
  const now = deps.now ?? new Date();
  const alert = await withTenant({ clinicId, actor, request }, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(retellRecordingAlerts)
      .where(and(eq(retellRecordingAlerts.clinicId, tx.clinicId), eq(retellRecordingAlerts.id, alertId)))
      .limit(1);
    if (!row) return null;
    const [recorded] = await tx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clinicId, tx.clinicId), eq(conversations.externalCallId, row.retellCallId)))
      .limit(1);
    return { row, recorded: Boolean(recorded) };
  });
  if (!alert) return { status: "not_found" };
  if (alert.row.resolvedAt) return { status: "already", resolvedAt: alert.row.resolvedAt.toISOString() };
  const notBefore = new Date(alert.row.detectedAt.getTime() + DELETE_NOT_BEFORE_MS);
  if (!alert.recorded && now.getTime() < notBefore.getTime()) return { status: "too_soon", notBefore: notBefore.toISOString() };

  const result = await deleteAtRetell(alert.row.retellCallId, deps);

  return withTenant({ clinicId, actor, request }, async (tx) => {
    const unresolved = and(
      eq(retellRecordingAlerts.clinicId, tx.clinicId),
      eq(retellRecordingAlerts.id, alertId),
      isNull(retellRecordingAlerts.resolvedAt),
    );
    if (result.gone) {
      const [updated] = await tx.db
        .update(retellRecordingAlerts)
        .set({ resolvedAt: now, lastError: null, lastAttemptAt: now, attempts: sql`${retellRecordingAlerts.attempts} + 1` })
        .where(unresolved)
        .returning({ resolvedAt: retellRecordingAlerts.resolvedAt });
      tx.audit.record({ action: "delete", resourceType: "retell_call", resourceId: alertId, metadata: { outcome: "deleted" } });
      // Resolved by a second press meanwhile: theirs stands.
      const resolvedAt = updated?.resolvedAt ?? now;
      return { status: "deleted", resolvedAt: resolvedAt.toISOString() } as const;
    }
    await tx.db
      .update(retellRecordingAlerts)
      .set({ lastError: result.reason.slice(0, 200), lastAttemptAt: now, attempts: sql`${retellRecordingAlerts.attempts} + 1` })
      .where(unresolved);
    tx.audit.record({ action: "delete", resourceType: "retell_call", resourceId: alertId, metadata: { outcome: "failed" } });
    log.error("retell call not deleted", { clinicId, callId: alert.row.retellCallId, code: result.reason });
    return { status: "failed", reason: result.reason } as const;
  });
}

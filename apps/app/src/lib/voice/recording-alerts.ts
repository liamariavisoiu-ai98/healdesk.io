import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { clinics, conversations, retellRecordingAlerts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { isRetellNotFound, RETELL_API_ORIGIN, retellApiKey } from "./retell-api";

/** Retell's call ids, as the backstop takes them (./backstop.ts, isRetellCallId; not imported, which would make a cycle). */
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRetellCallId(value: unknown): value is string {
  return typeof value === "string" && CALL_ID.test(value);
}

/**
 * Retell's copy of a call, deleted once ours is safe (the owner's decision of
 * 21 October 2026, reversing NOAUDIO-01's "nothing kept at Retell").
 *
 * Every clinic's agent keeps Retell's default storage, `everything`
 * (lib/voice/retell-agent.ts): the transcript, and unavoidably the
 * recording, stay at Retell until the call has ended, so the crash backstop
 * (lib/voice/backstop.ts) can read the words of a call whose voice task
 * died. Then, once the call is recorded here (the conversation and its
 * sealed transcript outbox row commit in one transaction, ./ingest.ts), the
 * backstop job deletes the call at Retell (deleteRetellCallAfterIngest).
 * Retell's delete-call (DELETE /v2/delete-call/<id>, 204 on success) removes
 * the call record as a whole: its recording, its transcript and its logs.
 * It does not wait for SES to deliver the transcript: our sealed copy is the
 * source from then on. A call never recorded here is never deleted by code;
 * the agent's data_storage_retention_days (1) is Retell's own backstop for
 * that and for anything else we fail to delete.
 *
 * A recording URL on a call is therefore expected for a while, and is not
 * an alert. The alert is a call whose data is still at Retell
 * RETELL_DELETION_WINDOW_MS after it ended: the job's delete failed past the
 * window, and one opaque row is written for the call
 * (retell_recording_alerts, drizzle/0105; the table's name is older than
 * its meaning): the clinic, Retell's call id, when, our own reason. Never
 * the URL, the transcript or a number, and the recording is never fetched.
 *
 * /admin/recordings (apps/web) lists the alerts through the ops API
 * (listRecordingAlerts) and its button asks apps/app, which alone holds
 * HEALDESK_RETELL_API_KEY, to delete the call at Retell
 * (deleteRecordedCall): the manual backstop. A later automatic delete that
 * goes through resolves the alert too.
 */

/**
 * How long after a call ends its data may stay at Retell before that is an
 * alert. The backstop job first runs BACKSTOP_DELAY_SECONDS (ten minutes)
 * after Retell's call-ended webhook and retries with doubling delays, its
 * last try at least 41 minutes after the webhook, so a delete that fails on
 * every try is always alerted (pinned by tests/recording-alerts.test.ts).
 */
export const RETELL_DELETION_WINDOW_MS = 30 * 60_000;

const ACTOR: ActorContext = { type: "agent", serviceName: "retell-call-deletion" };

/**
 * Record that the call's data is still at Retell past the window, once per
 * call: a later failure finds the row and only adds to its bookkeeping (one
 * more attempt, the newest reason) while it is open. Returns whether this
 * call wrote the row. A clinic id that names no clinic writes nothing.
 * Throws only when the database does.
 */
export async function recordRecordingAlert(
  clinicId: string,
  callId: string,
  failure?: { reason: string; at: Date },
): Promise<boolean> {
  if (!isRetellCallId(callId)) return false;
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [clinic] = await tx.db.select({ id: clinics.id }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
    if (!clinic) return false;
    const bookkeeping = failure
      ? { attempts: 1, lastAttemptAt: failure.at, lastError: failure.reason.slice(0, 200) }
      : {};
    const inserted = await tx.db
      .insert(retellRecordingAlerts)
      .values({ clinicId, retellCallId: callId, ...bookkeeping })
      .onConflictDoNothing({ target: [retellRecordingAlerts.clinicId, retellRecordingAlerts.retellCallId] })
      .returning({ id: retellRecordingAlerts.id });
    if (inserted.length === 0) {
      if (failure) {
        await tx.db
          .update(retellRecordingAlerts)
          .set({ attempts: sql`${retellRecordingAlerts.attempts} + 1`, lastAttemptAt: failure.at, lastError: failure.reason.slice(0, 200) })
          .where(
            and(
              eq(retellRecordingAlerts.clinicId, tx.clinicId),
              eq(retellRecordingAlerts.retellCallId, callId),
              isNull(retellRecordingAlerts.resolvedAt),
            ),
          );
      }
      return false;
    }
    tx.audit.record({ action: "create", resourceType: "retell_recording_alert", resourceId: inserted[0]!.id });
    log.warn("retell still holds a call past the deletion window", { clinicId, callId });
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
      log.error("retell deletion alerts not read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  alerts.sort((a, b) =>
    (a.resolvedAt === null) !== (b.resolvedAt === null) ? (a.resolvedAt === null ? -1 : 1) : b.detectedAt.localeCompare(a.detectedAt),
  );
  return { alerts: alerts.slice(0, MAX_LISTED_ALERTS), unreadClinics };
}

/**
 * The manual delete of a call not recorded here waits this long after the
 * alert, so the backstop has read the call or given up: its first read is
 * BACKSTOP_DELAY_SECONDS (ten minutes) after the call, and five retries
 * with doubling delays from a minute take at most about another hour. Two
 * hours, pinned against those numbers by tests/recording-alerts.test.ts.
 * Alerts are raised only for recorded calls, so this guards an alert whose
 * conversation has since gone (a patient's erasure, say).
 */
export const DELETE_NOT_BEFORE_MS = 2 * 60 * 60_000;

export type DeleteRecordedCallOutcome =
  /** Retell deleted the call (204), or answered its own JSON 404 for a call it does not have: resolved now. */
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

/**
 * Retell's delete for one call. Idempotent: 204 (deleted) and Retell's own
 * "no such call" 404 are both gone; any other answer leaves it to be tried
 * again. Our own words come back, never Retell's body.
 *
 * What live Retell answers to DELETE /v2/delete-call/<id> (checked 22 October
 * 2026):
 *   - 404 with a JSON body {"status":"error","message":"Not Found"}: a call
 *     that does not exist, on the right route. This alone counts as gone.
 *   - 404 with an HTML page ("Cannot DELETE /..."): a wrong route. It is a
 *     failure, never "already deleted": a path typo would otherwise report
 *     every delete as done while Retell kept every recording.
 *   - 400 {"status":"error","message":"Cannot delete a live call. Please
 *     wait until the call is completed."}: the call is still in progress.
 *     Not a failure of ours: `retryLater`, so the job's retries (and the
 *     alert only once the window has passed) apply without an error log.
 */
export async function deleteAtRetell(
  callId: string,
  deps: DeleteDeps,
): Promise<{ gone: true } | { gone: false; reason: string; retryLater?: boolean }> {
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
  if (response.status === 204 || response.status === 200) return { gone: true };
  if (response.status === 404) {
    if (await isRetellNotFound(response)) return { gone: true };
    return { gone: false, reason: "Retell answered 404 without its not-found body" };
  }
  if (response.status === 400 && (await isLiveCallRefusal(response))) {
    return { gone: false, reason: "Retell says the call is still live", retryLater: true };
  }
  return { gone: false, reason: `Retell answered ${response.status}` };
}

/** Retell's 400 for deleting a call that has not ended: {"status":"error","message":"Cannot delete a live call. ..."}. */
async function isLiveCallRefusal(response: Response): Promise<boolean> {
  try {
    const body = JSON.parse(await response.clone().text()) as { status?: unknown; message?: unknown } | null;
    return body?.status === "error" && typeof body.message === "string" && /cannot delete a live call/i.test(body.message);
  } catch {
    return false;
  }
}

export type RetellCallDeletion =
  /** Retell no longer has the call. */
  | { status: "deleted" }
  /** No conversation for the call here: our copy is not committed, so Retell's is kept. */
  | { status: "not_recorded" }
  /** Retell did not delete it; `alerted` when the window had passed and the alert is written or updated. */
  | { status: "failed"; reason: string; alerted: boolean; retryLater?: boolean };

/**
 * The automatic step: delete the call at Retell, but only once the call has
 * a conversation here. The conversation and its sealed transcript outbox row
 * commit in the same transaction (./ingest.ts), so a conversation is proof
 * our copy is safe; without one (an ingest that failed or never ran) nothing
 * is asked of Retell. A failure past RETELL_DELETION_WINDOW_MS after the
 * call ended is an alert, once per call; before it, the caller retries. A
 * delete that goes through resolves any open alert for the call.
 */
export async function deleteRetellCallAfterIngest(clinicId: string, callId: string, deps: DeleteDeps = {}): Promise<RetellCallDeletion> {
  if (!isRetellCallId(callId)) return { status: "not_recorded" };
  const recorded = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({ id: conversations.id, startedAt: conversations.startedAt, endedAt: conversations.endedAt })
      .from(conversations)
      .where(and(eq(conversations.clinicId, tx.clinicId), eq(conversations.externalCallId, callId)))
      .limit(1);
    return row ?? null;
  });
  if (!recorded) return { status: "not_recorded" };

  const result = await deleteAtRetell(callId, deps);
  const now = deps.now ?? new Date();
  if (result.gone) {
    await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      await tx.db
        .update(retellRecordingAlerts)
        .set({ resolvedAt: now, lastError: null, lastAttemptAt: now, attempts: sql`${retellRecordingAlerts.attempts} + 1` })
        .where(
          and(
            eq(retellRecordingAlerts.clinicId, tx.clinicId),
            eq(retellRecordingAlerts.retellCallId, callId),
            isNull(retellRecordingAlerts.resolvedAt),
          ),
        );
      tx.audit.record({ action: "delete", resourceType: "retell_call", resourceId: recorded.id, metadata: { outcome: "deleted" } });
    });
    return { status: "deleted" };
  }

  const endedAt = recorded.endedAt ?? recorded.startedAt;
  const late = now.getTime() >= endedAt.getTime() + RETELL_DELETION_WINDOW_MS;
  // A call Retell says is still live is retried like any failure and alerted
  // only once the window has passed, but before then it is not an error.
  const retryLater = "retryLater" in result && result.retryLater === true;
  (retryLater && !late ? log.info : log.error)("retell call not deleted after ingest", { clinicId, callId, code: result.reason, status: late ? "alerted" : "retrying" });
  if (late) await recordRecordingAlert(clinicId, callId, { reason: result.reason, at: now });
  return { status: "failed", reason: result.reason, alerted: late, ...(retryLater ? { retryLater: true } : {}) };
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

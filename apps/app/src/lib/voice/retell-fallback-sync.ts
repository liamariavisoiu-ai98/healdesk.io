import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinicSettings } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

import {
  getRetellPhoneNumber,
  isE164,
  RetellApiError,
  retellApiKey,
  setRetellFallbackNumber,
  type RetellApiOptions,
} from "./retell-api";

/**
 * Keeps the fallback number of every clinic's AYA number in Retell equal to
 * the clinic's direct line (T14, docs/hipaa-risk-analysis.md), so that the
 * cases our endpoint cannot answer still end at a person:
 *
 *   - our endpoint unreachable: the operator puts the Retell workspace in
 *     outage mode (docs/on-call.md), and Retell sends every inbound call to
 *     its number's fallback, the clinic's direct line;
 *   - AYA's number at Retell's concurrency limit: Retell does the same by
 *     itself after extended ringing;
 *   - a voice task that cannot read the database and has no memory of the
 *     clinic: it reads this fallback back (fallback-line.ts).
 *
 * Hourly from the tick, so the fallback trails a changed direct line by up to
 * an hour; set by our code, never by hand, and never cleared: a clinic that
 * removes its direct line keeps the last one at Retell, which is still a line
 * the clinic gave us and better than a dropped call, and the answer gate
 * already raises voice_fallback_no_direct_line for it. A direct line equal to
 * the AYA number or the published number (which forwards to AYA) is never
 * set: it would send the caller back to us. Not a switched job: it sends
 * only business contact data, and it does nothing until
 * HEALDESK_RETELL_API_KEY is set.
 */

const ACTOR: ActorContext = { type: "service", serviceName: "retell-fallback-sync" };

export type FallbackSyncSummary = {
  status: "ok" | "failed" | "skipped";
  note: string;
  clinics: number;
  set: number;
  unchanged: number;
  failures: number;
};

type ClinicNumbers = { id: string; assistantNumber: string | null; publishedPhone: string | null };

async function clinicsWithNumbers(): Promise<ClinicNumbers[]> {
  const result = await unsafeDb.execute<{ id: string; assistant_number_e164: string | null; published_phone_e164: string | null }>(
    sql`select id, assistant_number_e164, published_phone_e164 from app_clinics_overview()
         where offboarding_started_at is null
           and destroyed_at is null
           and assistant_number_e164 is not null`,
  );
  const rows = (result as unknown as { rows?: { id: string; assistant_number_e164: string | null; published_phone_e164: string | null }[] }).rows ?? [];
  return rows.map((r) => ({ id: String(r.id), assistantNumber: r.assistant_number_e164, publishedPhone: r.published_phone_e164 }));
}

/** The fallback the clinic's AYA number should have, or null when its direct line cannot be one. */
export function wantedFallback(numbers: { assistantNumber: string | null; publishedPhone: string | null; directLine: string | null }): string | null {
  const { assistantNumber, publishedPhone, directLine } = numbers;
  if (!isE164(directLine) || directLine === assistantNumber || directLine === publishedPhone) return null;
  return directLine;
}

export async function syncRetellFallbacks(
  options: RetellApiOptions & { list?: () => Promise<ClinicNumbers[]>; directLineOf?: (clinicId: string) => Promise<string | null> } = {},
): Promise<FallbackSyncSummary> {
  const key = options.key === undefined ? retellApiKey() : options.key;
  const summary: FallbackSyncSummary = { status: "ok", note: "", clinics: 0, set: 0, unchanged: 0, failures: 0 };
  if (!key) return { ...summary, status: "skipped", note: "HEALDESK_RETELL_API_KEY unset" };

  const directLineOf =
    options.directLineOf ??
    ((clinicId: string) =>
      withTenant({ clinicId, actor: ACTOR }, async (tx) => {
        const [row] = await tx.db
          .select({ directLine: clinicSettings.directLineE164 })
          .from(clinicSettings)
          .where(eq(clinicSettings.clinicId, clinicId))
          .limit(1);
        return row?.directLine ?? null;
      }));

  const clinics = await (options.list ?? clinicsWithNumbers)();
  summary.clinics = clinics.length;
  for (const clinic of clinics) {
    let code = "database";
    try {
      const wanted = wantedFallback({ ...clinic, directLine: await directLineOf(clinic.id) });
      code = "unreachable";
      if (!wanted || !clinic.assistantNumber) {
        summary.unchanged += 1;
        continue;
      }
      const number = await getRetellPhoneNumber(clinic.assistantNumber, { ...options, key });
      if (!number) {
        code = "missing";
        throw new Error("Retell has no such number");
      }
      if (number.fallbackNumber === wanted) {
        summary.unchanged += 1;
        continue;
      }
      await setRetellFallbackNumber(clinic.assistantNumber, wanted, { ...options, key });
      summary.set += 1;
    } catch (error) {
      if (error instanceof RetellApiError && error.status >= 400 && error.status < 500) code = "rejected";
      summary.failures += 1;
      log.error("retell fallback not synced", { clinicId: clinic.id, code, error: describeError(error) });
      await notifyOps("retell_fallback_unsynced", { clinicId: clinic.id, code });
    }
  }
  summary.status = summary.failures ? "failed" : "ok";
  summary.note = `${summary.clinics} numbers, ${summary.set} set, ${summary.unchanged} unchanged${summary.failures ? `, ${summary.failures} failed` : ""}`;
  return summary;
}

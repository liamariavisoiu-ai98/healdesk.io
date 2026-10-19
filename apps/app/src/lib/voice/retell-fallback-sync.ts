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
 * an hour, and set by our code, never by hand. A fallback is only safe while
 * it is known to be this clinic's line now, so a number whose clinic has no
 * usable direct line has its fallback cleared: a line left over from a
 * previous holder of the number would put one clinic's callers through to
 * another's desk. (A clinic cannot clear a direct line once set,
 * lib/billing/settings.ts, so this clears only a line that was never its.) (The answer gate already
 * raises voice_fallback_no_direct_line for such a clinic.) A direct line
 * equal to the AYA number or the published number (which forwards to AYA) is
 * never set: it would send the caller back to us. A number two clinics both
 * name is left alone and reported (code `duplicate`): whichever clinic it
 * belonged to, the other's callers would reach the wrong desk. Offboarding
 * forgets a clinic's AYA number, so this cannot clear that number's fallback:
 * release or clear the number in Retell when a clinic leaves
 * (docs/on-call.md). Not a switched job: it sends
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
  // A refused key, or Retell not answering, is one failure for every
  // clinic: one alert and an early stop, rather than one email per clinic
  // and minutes of timeouts holding up the rest of the tick.
  let refused = false;
  let unreachableInARow = 0;
  const holders = new Map<string, number>();
  for (const c of clinics) if (c.assistantNumber) holders.set(c.assistantNumber, (holders.get(c.assistantNumber) ?? 0) + 1);
  for (const clinic of clinics) {
    if (refused || unreachableInARow >= 3) break;
    let code = "database";
    try {
      if (!clinic.assistantNumber) {
        summary.unchanged += 1;
        continue;
      }
      if ((holders.get(clinic.assistantNumber) ?? 0) > 1) {
        code = "duplicate";
        throw new Error("more than one clinic names this AYA number");
      }
      const wanted = wantedFallback({ ...clinic, directLine: await directLineOf(clinic.id) });
      code = "unreachable";
      const number = await getRetellPhoneNumber(clinic.assistantNumber, { ...options, key });
      unreachableInARow = 0;
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
      if (error instanceof RetellApiError && (error.status === 401 || error.status === 403)) {
        refused = true;
        continue;
      }
      if (code === "unreachable") {
        unreachableInARow += 1;
        if (unreachableInARow >= 3) continue;
      } else {
        unreachableInARow = 0;
      }
      await notifyOps("retell_fallback_unsynced", { clinicId: clinic.id, code });
    }
  }
  if (refused) await notifyOps("retell_fallback_unsynced", { code: "key_refused" });
  if (unreachableInARow >= 3) await notifyOps("retell_fallback_unsynced", { code: "retell_unreachable" });
  summary.status = summary.failures ? "failed" : "ok";
  summary.note = `${summary.clinics} numbers, ${summary.set} set, ${summary.unchanged} unchanged${summary.failures ? `, ${summary.failures} failed` : ""}`;
  return summary;
}

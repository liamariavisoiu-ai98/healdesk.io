import { describeError, log } from "@/lib/log";

import { getRetellPhoneNumber, isE164, retellApiKey, type RetellApiOptions } from "./retell-api";

/**
 * Where a call goes when the voice endpoint cannot read the database (T14,
 * docs/hipaa-risk-analysis.md; CLAUDE.md, "Failure"): a patient calling a
 * clinic must always reach someone, and the direct line lives in
 * clinic_settings, which is exactly what an outage takes away.
 *
 * Two places hold the line outside the database, tried in this order:
 *
 *   1. this process's memory. Every call that starts normally remembers its
 *      clinic's direct line (RetellCallSession.open), so a voice task that
 *      has taken a clinic's call since it started knows that clinic's line
 *      without asking anyone. It is as fresh as the clinic's last call: a
 *      change made since then is missed only if the database goes down
 *      before the clinic's next call, and the line it falls back to is still
 *      one the clinic gave us. Nothing is written to disk;
 *   2. Retell, which holds the same line as the fallback number of the
 *      clinic's AYA number, kept in step every hour by
 *      retell-fallback-sync.ts. This covers a task started during the
 *      outage, or one that has not yet taken that clinic's call. The number
 *      is the call's `to_number`, from Retell's own call details. Up to an
 *      hour stale after a change, and absent while HEALDESK_RETELL_API_KEY
 *      is unset.
 *
 * Neither is PHI: a clinic's direct line is business contact data, keyed by
 * the clinic. A line equal to the number the call came in on is refused,
 * because that would send the caller back to us.
 *
 * With neither, the session falls back to its fixed closing line: there is
 * nowhere known to send the call.
 */

const remembered = new Map<string, string>();

/** The direct line read for this clinic on a call that started normally; null forgets it. */
export function rememberDirectLine(clinicId: string, line: string | null): void {
  if (isE164(line)) remembered.set(clinicId, line);
  else remembered.delete(clinicId);
}

export function rememberedDirectLine(clinicId: string): string | null {
  return remembered.get(clinicId) ?? null;
}

/** For tests. */
export function forgetDirectLines(): void {
  remembered.clear();
}

export type FallbackLine = { line: string; source: "memory" | "retell" };

export type FallbackLookup = (input: { clinicId: string; calledNumber: string | null }) => Promise<FallbackLine | null>;

/** The clinic's direct line without the database, or null when nowhere holds a usable one. */
export async function fallbackLineFor(
  input: { clinicId: string; calledNumber: string | null },
  options: RetellApiOptions = {},
): Promise<FallbackLine | null> {
  const usable = (line: string | null): line is string => isE164(line) && line !== input.calledNumber;

  const fromMemory = rememberedDirectLine(input.clinicId);
  if (usable(fromMemory)) return { line: fromMemory, source: "memory" };

  const key = options.key === undefined ? retellApiKey() : options.key;
  if (!key || !isE164(input.calledNumber)) return null;
  try {
    const number = await getRetellPhoneNumber(input.calledNumber, { ...options, key });
    return number && usable(number.fallbackNumber) ? { line: number.fallbackNumber, source: "retell" } : null;
  } catch (error) {
    log.warn("retell fallback number not read", { clinicId: input.clinicId, error: describeError(error) });
    return null;
  }
}

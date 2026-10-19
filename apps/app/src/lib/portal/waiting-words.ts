import { portalCount } from "./format";

/**
 * Home's first card after go-live, in words (plan Part F1): "Waiting for you:
 * 3 people to call back (oldest 2 h) · 1 deposit to collect". Counts and an
 * age, never who: the names, numbers, times and services open on Bookings,
 * behind the passkey. Pure, so the card's wording is one table test.
 *
 * No handover count: nothing records whether a handover has been dealt with
 * (lib/portal/bookings.ts readWaitingCounts), and each one was emailed to the
 * clinic the moment it happened.
 */

export type WaitingFigures = {
  toCallBack: number;
  oldestSince: Date | null;
  depositsToCollect: number;
};

/** "25 min", "2 h", "3 days": how long the longest-waiting request has waited. */
export function waitedFor(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return portalCount(Math.floor(hours / 24), "day", "days");
}

/** What is waiting, joined by middle dots; "Nothing right now." when nothing is. */
export function waitingSentence(w: WaitingFigures, now: Date): string {
  const parts: string[] = [];
  if (w.toCallBack > 0) {
    const people =
      w.toCallBack === 1 ? "1 person" : `${w.toCallBack.toLocaleString("en-US")} people`;
    parts.push(
      w.oldestSince
        ? `${people} to call back (oldest ${waitedFor(w.oldestSince, now)})`
        : `${people} to call back`,
    );
  }
  if (w.depositsToCollect > 0) {
    parts.push(portalCount(w.depositsToCollect, "deposit to collect", "deposits to collect"));
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing right now.";
}

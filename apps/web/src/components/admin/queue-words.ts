import type { CalendarWriteReasonCode, StuckCalendarWriteView } from "@/lib/admin/ops-client";

/**
 * The plain words the System page's "Requires your attention" section and
 * the Setup tab's "Calendar writes" section put on apps/app's codes (ops
 * automation Phase 5, lane P5b). apps/app sends ages as minutes or hours and
 * a calendar write's reason as a closed code (lib/booking/calendar.ts,
 * CALENDAR_WRITE_REASONS, mirrored in ops-client's CALENDAR_WRITE_REASON_CODES);
 * an operator reads "2 hours" and "Google did not answer in time", never a
 * number of minutes or `timeout`. Types only from ops-client, so a client
 * component may import this (lib/admin/client-imports.test.ts).
 *
 * `queue-words.test.ts` reads apps/app's reason table out of its source and
 * fails when a code here has no words, and pins MAX_WRITE_TRIES to apps/app's
 * MAX_WRITE_ATTEMPTS: "tries 3 of 5" must be apps/app's five.
 */

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How long a queue's oldest item has waited: "under a minute", "45 minutes", "2 hours", "3 days". */
export function waited(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(Math.round(minutes), "minute", "minutes");
  if (minutes < 48 * 60) return plural(Math.round(minutes / 60), "hour", "hours");
  return plural(Math.round(minutes / (24 * 60)), "day", "days");
}

/** An age apps/app already gives in whole hours: "1 hour", "80 hours", "4 days" past two days. */
export function hoursWaited(hours: number): string {
  if (hours < 48) return plural(hours, "hour", "hours");
  return plural(Math.round(hours / 24), "day", "days");
}

/** apps/app's MAX_WRITE_ATTEMPTS: the sweep never makes a sixth attempt. */
export const MAX_WRITE_TRIES = 5;

/**
 * Every reason code in plain words, for an operator who has never read the
 * adapter: what happened, and where that is a thing the clinic must do, that
 * too. Google's own word (`other`) is not ours to translate; the Calendar
 * card's list prints it beside the booking.
 */
export const CALENDAR_WRITE_REASON_WORDS: Record<CalendarWriteReasonCode, string> = {
  timeout: "Google did not answer in time",
  network: "the connection to Google dropped",
  unconfirmed: "Google's answer did not confirm the write",
  threw: "our own code failed in the middle of the write",
  malformed_response: "Google's answer could not be read",
  rate_limited: "Google asked us to slow down",
  target_unverified: "the target calendar could not be verified in time",
  deleted_in_calendar: "the clinic deleted the event in its own calendar",
  event_id_taken: "our event id is already taken: the event is in the calendar at another time",
  not_ours: "the event with our id belongs to someone else",
  conflict: "the calendar reported a conflict",
  calendar_not_connected: "no healthy Google Calendar is connected",
  target_terms: "the target calendar's terms are not accepted",
  target_unmanaged_account: "the target calendar is on an unmanaged Google account",
  target_account_mismatch: "the target calendar is not on the connected account",
  target_outside_organisation: "the target calendar is outside the clinic's organisation",
  target_not_owned: "the connected account does not own the target calendar",
  invalid_grant: "Google's sign-in grant is no longer valid: the clinic must reconnect",
  admin_policy_enforced: "the clinic's Google admin policy blocks the access",
  scope_lost: "the calendar permission was withdrawn",
  access_denied: "Google denied access",
  insufficient_permissions: "the connected account lacks permission on the calendar",
  calendar_not_found: "the calendar no longer exists at Google",
  api_disabled: "the Calendar API is switched off on our Google project",
  oauth_client: "our Google sign-in app is misconfigured",
  missing_refresh_token: "the connection has no refresh token: the clinic must reconnect",
  calendar_id: "the calendar id is not valid",
  missing_key: "a Google key is missing on the host",
  bad_start: "the booking's start time is not valid",
  bad_duration: "the booking's duration is not valid",
  bad_time_zone: "the clinic's time zone is not valid",
  phone_field_refused: "Google refused the phone field on the event",
  missing_code: "a Google sign-in step failed: no code came back",
  missing_token: "a Google sign-in step failed: no token came back",
  id_token_malformed: "Google's identity token could not be read",
  not_calendar_owner: "the connected account is not the calendar's owner",
  too_many_calendars: "the account has too many calendars to list",
  bad_window: "the availability window asked for is not valid",
  window_too_long: "the availability window asked for is too long",
  calendar_error: "Google reported a calendar error",
  other: "Google's own words, printed beside the booking in the Calendar card",
};

/** The write's state in words: "failed", "gave up after 5 tries", "waiting for its next try". */
export function writeProblemWords(write: Pick<StuckCalendarWriteView, "status" | "attempts" | "retryable">): string {
  if (write.status === "failed") return "failed";
  if (!write.retryable) return `gave up after ${plural(write.attempts, "try", "tries")}`;
  return "waiting for its next try";
}

/** When the sweep tries it next, from the server's clock: "in about 30 minutes", "due now", or "will not be tried again". */
export function nextTryWords(write: Pick<StuckCalendarWriteView, "retryable" | "nextAttemptAt">, nowIso: string): string {
  if (!write.retryable) return "will not be tried again by itself";
  if (write.nextAttemptAt === null) return "due now";
  const minutes = Math.round((Date.parse(write.nextAttemptAt) - Date.parse(nowIso)) / 60_000);
  if (Number.isNaN(minutes) || minutes <= 0) return "due now";
  if (minutes < 90) return `in about ${plural(minutes, "minute", "minutes")}`;
  return `in about ${plural(Math.round(minutes / 60), "hour", "hours")}`;
}

/** The slot as whole days ahead, as apps/app sends it: never a time. */
export function slotWords(slotInDays: number): string {
  if (slotInDays <= 0) return "within 24 hours";
  return `in ${plural(slotInDays, "day", "days")}`;
}

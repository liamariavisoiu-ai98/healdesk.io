import { createHash } from "node:crypto";

/**
 * Event ids for the events healdesk adds to a clinic's Google Calendar.
 *
 * Google lets the client choose an event's id, so ours is derived from our own
 * booking key: an assistant hold writes under `"hold:" + slot_holds.id`, a
 * staff confirmation under `appointments.calendar_event_key`. A retried insert
 * then collides with the event it already made (409) instead of making a
 * second one, and a write whose reply never arrived can be read straight back
 * by id. Google warns that a collision may go undetected at creation, so our
 * database stays the idempotency authority; the id is the second line.
 *
 * The id is a hash, so the booking key never reaches the calendar: the clauses
 * promise an event carries a first name, the service and the time, and no
 * booking reference. Google's rules for a client-chosen id are base32hex
 * characters (0-9 and a-v) and 5 to 1024 of them. "hd" plus 40 lowercase hex
 * characters is inside both.
 */

/** The private extended property every healdesk event carries, and the only proof an event is ours. */
export const HEALDESK_EVENT_MARKER = Object.freeze({ healdesk: "v1" } as const);

const EVENT_ID = /^hd[0-9a-f]{40}$/;

/** The Google event id for one booking key. Deterministic: the same key always names the same event. */
export function googleEventIdFor(key: string): string {
  if (key.length === 0) {
    throw new Error(
      "googleEventIdFor needs a booking key; an empty one would name every keyless booking the same.",
    );
  }
  return `hd${createHash("sha256").update(`healdesk-event:${key}`).digest("hex").slice(0, 40)}`;
}

/**
 * Whether an id has the shape of one we derive. Necessary, not sufficient:
 * before touching an event, the adapter also reads it back and checks the
 * marker, because an id is only a string a caller handed us.
 */
export function isHealdeskEventId(id: string): boolean {
  return EVENT_ID.test(id);
}

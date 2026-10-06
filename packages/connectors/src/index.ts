/**
 * @healdesk/connectors — the anti-corruption layer between eight booking
 * platforms and one canonical model.
 *
 * PHASE TWO for its read side: POS/EMR read-back, sync and reconciliation are
 * fenced out of v1 (CLAUDE.md, "Phase two, fenced out of v1"). The port's
 * narrow write side (port.ts: listSlots, createAppointment,
 * findAppointmentByKey) is v1's: the Google Calendar adapter (google/) plugs
 * into it as the one place bookings are written (launch plan steps 1.5 and
 * 1.7), beside the fixture. google/ also holds the OAuth helpers, the watch's
 * probe and an offline fake of Google for the app's tests.
 *
 * Deliberately imports no Drizzle, no `pg`, and no Next. That is what lets the
 * whole layer be contract-tested in milliseconds with no database running, and
 * stops our storage shapes leaking into what we call "canonical".
 *
 * The organising idea: incumbents' integration is a WRITE — one request, known
 * outcome. Ours is a READ — a continuous, rate-limited, partially-supported
 * stream from vendors who disagree about whether "showed up" and "got paid" are
 * representable at all. So every vendor limitation is a first-class value
 * (see capabilities.ts) that propagates to the customer as a sentence, rather
 * than a null that renders as zero.
 */

export * from "./capabilities";
export * from "./guards";
export * from "./port";
export * from "./registry";
export * from "./result";
export * from "./throttle";
export * from "./time";
export * from "./types";
export { FixtureAdapter, fixtureAdapter, type RecordedWrite } from "./fixture/adapter";
export { weekdaySlots, type SlotSchedule } from "./fixture/slots";
export { generate, type FixtureOptions } from "./fixture/generator";
export * from "./google/adapter";
export * from "./google/event";
export * from "./google/ids";
export * from "./google/oauth";
export {
  fetchWithTimeout,
  GOOGLE_TIMEOUTS_MS,
  googleApiError,
  googleTokenError,
  setGoogleFetch,
  setGoogleTimeouts,
  type GoogleCall,
  type GoogleReply,
} from "./google/http";
export {
  FAKE_GOOGLE_CLIENT,
  FAKE_GOOGLE_ROLES,
  fakeGoogleCalendar,
  fakeGoogleIdToken,
  type FakeGoogleAccountInput,
  type FakeGoogleCalendar,
  type FakeGoogleCalendarInput,
  type FakeGoogleEndpoint,
  type FakeGoogleEvent,
  type FakeGoogleFailure,
  type FakeGoogleGrant,
  type FakeGoogleRequest,
  type FakeGoogleRole,
} from "./google/fake";

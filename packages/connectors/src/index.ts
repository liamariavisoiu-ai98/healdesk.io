/**
 * @healdesk/connectors — the anti-corruption layer between eight booking
 * platforms and one canonical model.
 *
 * PHASE TWO for its read side: POS/EMR read-back, sync and reconciliation are
 * fenced out of v1 (CLAUDE.md, "Phase two, fenced out of v1"). The port's
 * narrow write side (port.ts: listSlots, createAppointment,
 * findAppointmentByKey) is kept as the seam the v1 Google Calendar adapter
 * can plug into (launch plan steps 1.5 and 1.7); the only adapter registered
 * today is the fixture.
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
export * from "./types";
export { FixtureAdapter, fixtureAdapter, type RecordedWrite } from "./fixture/adapter";
export { weekdaySlots, type SlotSchedule } from "./fixture/slots";
export { generate, type FixtureOptions } from "./fixture/generator";

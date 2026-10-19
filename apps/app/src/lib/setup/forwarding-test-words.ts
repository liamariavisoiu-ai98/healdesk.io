import type { ForwardingTestObservation } from "@/db/schema";

/**
 * The forwarding test's states and words, client-safe: the wizard's and
 * Settings' "Test it now" panel shows them in the browser, and
 * lib/setup/forwarding-test-view.ts reads them from the clinic's row.
 */

export type ForwardingTestState =
  /** Nothing tested and nothing forwarded yet: waiting for call forwarding. */
  | { kind: "waiting" }
  /** The window is open, until `until` (ISO). */
  | { kind: "open"; until: string }
  /** The window ended with no call in it. */
  | { kind: "no_call" }
  /** A call reached AYA with the caller's number kept: forwarding works. */
  | { kind: "passed"; via: "test" | "forwarded_call" }
  /** A call reached AYA carrying the clinic's own number, or none, in place of the caller's. */
  | { kind: "caller_id_lost"; via: "test" | "forwarded_call" };

/** Pure: where the clinic's forwarding test stands at `now`. */
export function forwardingTestState(
  clinic: {
    forwardingTestUntil: Date | null;
    forwardingTestObserved: ForwardingTestObservation | null;
  },
  now: Date,
): ForwardingTestState {
  const observed = clinic.forwardingTestObserved;
  if (observed) {
    const via = observed.via ?? "test";
    return observed.callerIdPreserved ? { kind: "passed", via } : { kind: "caller_id_lost", via };
  }
  const until = clinic.forwardingTestUntil;
  if (until && until.getTime() > now.getTime()) return { kind: "open", until: until.toISOString() };
  if (until) return { kind: "no_call" };
  return { kind: "waiting" };
}

/** What the screen says for each state, in the clinic's words. */
export function forwardingTestLine(state: ForwardingTestState): string {
  switch (state.kind) {
    case "waiting":
      return "Phone goes live by itself once a call forwarded from your main line reaches AYA. Test it now to see it work straight away.";
    case "open":
      return "Call your main number now from a phone that isn't on the clinic's account, and don't pick up at the clinic. Once AYA answers you can hang up: what we saw shows here a few seconds later. The test stays open for five minutes.";
    case "no_call":
      return "No call reached AYA in those five minutes. Check the steps above, then test again.";
    case "passed":
      return "Call forwarding works: a call to your main number reached AYA with the caller's number intact.";
    case "caller_id_lost":
      return "A call reached AYA, but the caller's number didn't come through, so AYA can't tell who is calling. If the phone you called from hides its number, test again from another one. If not, ask your phone company to keep the original caller's number on forwarded calls (often called \"pass through caller ID\"), then test again.";
  }
}

/** The panel's heading for each state. */
export function forwardingTestHeading(state: ForwardingTestState): string {
  switch (state.kind) {
    case "open":
      return "Testing your call forwarding";
    case "passed":
      return "Call forwarding works";
    default:
      return "Waiting for call forwarding";
  }
}

/** Whether the screen offers "Test it now" in this state. */
export function offersTestNow(state: ForwardingTestState): boolean {
  return state.kind === "waiting" || state.kind === "no_call" || state.kind === "caller_id_lost";
}

/** The forwarding test as the phone row shows it: null where the row shows none. */
export type ForwardingTestView = { state: ForwardingTestState; canTest: boolean };

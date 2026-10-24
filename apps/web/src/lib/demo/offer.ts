import { demoOfferEndsAt, demoSetupCredit, type DemoSession } from "@/lib/demo/sessions";

/**
 * A demo's live setup-fee discount at call time, for `demoEngineCall`
 * (lib/demo/engine.ts): the real percentage (DEMO_SETUP_CREDIT 50% for an
 * operator-built demo, SELF_SERVE_DEMO_SETUP_CREDIT 30% for a homepage one,
 * `demoSetupCredit`) and when it ends (`demoOfferEndsAt`), computed from the
 * demo's own row, the same clock the demo page itself reads. Never a
 * specific dollar figure, which depends on the package the clinic has not
 * chosen yet.
 *
 * Caught, not thrown: a session a test mocks down to a few fields, or a read
 * that comes back short, means no discount is mentioned on the call, never a
 * broken one.
 */
export function demoOfferFor(session: DemoSession, now: number = Date.now()): { percentOfSetupFee: number; endsAt: Date } | null {
  try {
    const endsAt = demoOfferEndsAt(session, now);
    return endsAt ? { percentOfSetupFee: demoSetupCredit(session).percentOfSetupFee, endsAt } : null;
  } catch {
    return null;
  }
}

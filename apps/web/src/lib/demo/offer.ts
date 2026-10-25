import { demoOfferEndsAt, demoSetupCredit, isSelfServeDemo, type DemoSession } from "@/lib/demo/sessions";
import { site } from "@/lib/site";

/** The header button of a demo an operator built (app/demo/[slug]/page.tsx), which opens checkout with the demo's discount. */
export const DEMO_ONBOARD_LABEL = "Book Onboarding";

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

/**
 * The buy button the demo page shows, labelled as the page labels it, for
 * Aya to close on (DemoCallContext.buyButton): a homepage demo's opens the
 * purchase in place, an operator-built demo's goes to checkout, each with the
 * demo's discount applied. Read from the same rule the page reads.
 */
export function demoBuyButton(session: Pick<DemoSession, "createdBy">): string {
  return isSelfServeDemo(session) ? site.cta.primary.label : DEMO_ONBOARD_LABEL;
}

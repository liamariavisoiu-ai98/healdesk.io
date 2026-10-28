import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { switchRules, type SwitchFacts } from "@/lib/portal/switch-rules";

// The shell is a client form; capture the payload reader it is given.
const captured: { payload?: () => unknown } = {};
vi.mock("@/app/c/[slug]/setup/ScreenShell", async () => {
  const actual = await vi.importActual<typeof import("@/app/c/[slug]/setup/ScreenShell")>(
    "@/app/c/[slug]/setup/ScreenShell",
  );
  return {
    ...actual,
    ScreenShell: (props: { payload: () => unknown; children?: React.ReactNode }) => {
      captured.payload = props.payload;
      return <form>{props.children}</form>;
    },
  };
});
vi.mock("@/app/c/[slug]/feedback", () => ({ useAnnounce: () => () => {} }));

import { DepositsScreen } from "@/app/c/[slug]/setup/screens/BehaviourScreens";

const open: SwitchFacts = {
  gatewayConnected: true,
  hasDepositAmount: true,
  calendarConnected: true,
  autoConfirm: true,
  hasVoice: true,
};
const targets = {
  connect_stripe: null,
  set_deposit: null,
  connect_calendar: null,
  turn_on_auto_confirm: null,
};

function render(facts: SwitchFacts, stored: { textPaymentLink: boolean; paymentAsk: "deposit_only" | "full_payment" }) {
  const rules = switchRules(facts);
  return renderToStaticMarkup(
    <DepositsScreen
      slug="x"
      skipCost="s"
      backHref={null}
      services={[{ name: "Facial", depositUsd: 50 }]}
      collectionLine="c"
      paymentSwitches={{ voice: true, text: rules.text_payment_link, full: rules.full_payment, targets, ...stored }}
    />,
  );
}

describe("wizard deposits step keeps stored payment choices", () => {
  test("reopening shows the stored choices and a re-save sends neither", () => {
    const html = render(open, { textPaymentLink: true, paymentAsk: "full_payment" });
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="full_payment"/);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    const payload = captured.payload!() as Record<string, unknown>;
    expect(payload).not.toHaveProperty("textPaymentLink");
    expect(payload).not.toHaveProperty("paymentAsk");
    expect(payload.needsDeposits).toBe(true);
  });

  test("a stored Full payment is kept even when its rule is locked now", () => {
    render({ ...open, calendarConnected: false }, { textPaymentLink: false, paymentAsk: "full_payment" });
    expect(captured.payload!()).not.toHaveProperty("paymentAsk");
  });
});

describe("wizard calendar line", () => {
  test("a new clinic without a calendar is told it connects one later, beside the rule's own reason", () => {
    const rules = switchRules({ ...open, calendarConnected: false });
    const html = render({ ...open, calendarConnected: false }, { textPaymentLink: false, paymentAsk: "deposit_only" });
    expect(html).toContain(rules.full_payment.reason!);
    expect(html).toContain("You connect your calendar in a later step.");
    expect(html).toMatch(/<input[^>]*aria-describedby="explain-payment-ask"[^>]*value="full_payment"/);
  });

  test("not shown when the lock is something else", () => {
    const html = render({ ...open, autoConfirm: false }, { textPaymentLink: false, paymentAsk: "deposit_only" });
    expect(html).not.toContain("later step");
  });
});

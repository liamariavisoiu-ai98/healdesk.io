import { describe, expect, test } from "vitest";

import { resetsAfter, switchRules, type SwitchFacts } from "@/lib/portal/switch-rules";

const READY: SwitchFacts = {
  gatewayConnected: true,
  hasDepositAmount: true,
  calendarConnected: true,
  autoConfirm: true,
  hasVoice: true,
  textSendingAvailable: true,
};

const facts = (patch: Partial<SwitchFacts>): SwitchFacts => ({ ...READY, ...patch });

describe("switchRules", () => {
  test("everything is open when everything is in place", () => {
    for (const rule of Object.values(switchRules(READY))) {
      expect(rule).toEqual({ enabled: true, reason: null, unlock: null });
    }
  });

  test("deposits need the gateway, then a deposit amount", () => {
    expect(switchRules(facts({ gatewayConnected: false })).deposits.unlock).toBe("connect_stripe");
    const noAmount = switchRules(facts({ hasDepositAmount: false })).deposits;
    expect(noAmount.enabled).toBe(false);
    expect(noAmount.unlock).toBe("set_deposit");
  });

  test("full payment needs gateway, calendar and auto-confirm, in that order of asking", () => {
    expect(switchRules(facts({ gatewayConnected: false, calendarConnected: false })).full_payment.unlock).toBe("connect_stripe");
    expect(switchRules(facts({ calendarConnected: false })).full_payment.unlock).toBe("connect_calendar");
    const off = switchRules(facts({ autoConfirm: false })).full_payment;
    expect(off.enabled).toBe(false);
    expect(off.unlock).toBe("turn_on_auto_confirm");
  });

  test("the payment-link text says only 'Coming soon.' while no sender exists", () => {
    const rule = switchRules(facts({ textSendingAvailable: false })).text_payment_link;
    expect(rule).toEqual({ enabled: false, reason: "Coming soon.", unlock: null });
    // Not even a gateway problem is mentioned first: the clinic cannot act on it yet.
    expect(switchRules(facts({ textSendingAvailable: false, gatewayConnected: false })).text_payment_link.reason).toBe("Coming soon.");
  });

  test("the text is a phone feature, and needs the gateway once sending exists", () => {
    expect(switchRules(facts({ hasVoice: false })).text_payment_link.enabled).toBe(false);
    expect(switchRules(facts({ gatewayConnected: false })).text_payment_link.unlock).toBe("connect_stripe");
  });

  test("no reason mentions how things work inside", () => {
    const all = [
      facts({ gatewayConnected: false }),
      facts({ hasDepositAmount: false }),
      facts({ calendarConnected: false }),
      facts({ autoConfirm: false }),
      facts({ textSendingAvailable: false }),
      facts({ hasVoice: false }),
    ].flatMap((f) => Object.values(switchRules(f)).map((r) => r.reason ?? ""));
    for (const reason of all) expect(reason).not.toMatch(/BAA|agreement|sender|regist|carrier|SMS|webhook/i);
  });
});

describe("resetsAfter", () => {
  const ON = { depositsEnabled: true, textPaymentLink: true, fullPayment: true };

  test("nothing resets while every rule still holds", () => {
    expect(resetsAfter(READY, ON)).toEqual([]);
  });

  test("auto-confirm off returns full payment to deposit only, and says why", () => {
    const [reset, ...rest] = resetsAfter(facts({ autoConfirm: false }), ON);
    expect(rest).toEqual([]);
    expect(reset!.switch).toBe("full_payment");
    expect(reset!.notice).toMatch(/^Back to deposit only\. Turn on Auto-confirm/);
  });

  test("disconnecting the gateway resets all three dependants", () => {
    const names = resetsAfter(facts({ gatewayConnected: false }), ON).map((r) => r.switch);
    expect(names.sort()).toEqual(["deposits", "full_payment", "text_payment_link"]);
  });

  test("a switch that was already off is never reported", () => {
    expect(resetsAfter(facts({ gatewayConnected: false }), { depositsEnabled: false, textPaymentLink: false, fullPayment: false })).toEqual([]);
  });
});

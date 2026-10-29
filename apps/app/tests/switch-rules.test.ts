import { describe, expect, test } from "vitest";

import { paymentLinkTextOffered } from "@/lib/portal/switch-resets";
import {
  resetsAfter,
  switchRules,
  TEXT_NOT_READY_REASON,
  type SwitchFacts,
} from "@/lib/portal/switch-rules";

const READY: SwitchFacts = {
  gatewayConnected: true,
  hasDepositAmount: true,
  calendarConnected: true,
  autoConfirm: true,
  hasVoice: true,
};

const facts = (patch: Partial<SwitchFacts>): SwitchFacts => ({ ...READY, ...patch });

describe("switchRules", () => {
  test("everything but the text is open when everything is in place", () => {
    const { text_payment_link: text, ...rest } = switchRules(READY);
    for (const rule of Object.values(rest)) {
      expect(rule).toEqual({ enabled: true, reason: null, unlock: null });
    }
    expect(text.enabled).toBe(false);
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

  test("the text is a phone feature", () => {
    expect(switchRules(facts({ hasVoice: false })).text_payment_link.enabled).toBe(false);
  });

  // BAA 1.6.0 promises the offer "where Practice has chosen that option", and
  // CLAUDE.md keeps the setting unavailable until a compliant sender exists:
  // a voice clinic with Stripe must not be able to choose what nothing does.
  test("the text cannot be chosen while no sender exists, whatever the clinic has connected", () => {
    expect(paymentLinkTextOffered()).toBe(false);
    for (const f of [READY, facts({ gatewayConnected: false })]) {
      expect(switchRules(f).text_payment_link).toEqual({
        enabled: false,
        reason: TEXT_NOT_READY_REASON,
        unlock: null,
      });
    }
  });

  test("no reason mentions how things work inside", () => {
    const all = [
      facts({ gatewayConnected: false }),
      facts({ hasDepositAmount: false }),
      facts({ calendarConnected: false }),
      facts({ autoConfirm: false }),
      facts({ hasVoice: false }),
    ].flatMap((f) => Object.values(switchRules(f)).map((r) => r.reason ?? ""));
    for (const reason of all) expect(reason).not.toMatch(/BAA|agreement|sender|regist|carrier|SMS|webhook/i);
  });
});

describe("resetsAfter", () => {
  const ON = { depositsEnabled: true, textPaymentLink: true, fullPayment: true };

  // The sender lock is no lost fact of the clinic's: a text left on from
  // before it is never reset (so no reset email), it only reads as off.
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

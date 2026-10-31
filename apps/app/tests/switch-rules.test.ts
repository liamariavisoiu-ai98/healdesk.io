import { afterEach, describe, expect, test, vi } from "vitest";

import { healdeskTextReady, smsSenderConfigured } from "@/lib/sms/config";
import {
  AGREEMENT_NOT_COVERING,
  HEALDESK_SETTING_UP,
  resetsAfter,
  switchRules,
  TEXT_AGREEMENT_REASON,
  TEXT_CHECK_LABELS,
  TEXT_NOT_READY_REASON,
  TEXT_PHONE_ONLY_REASON,
  textChecksMet,
  UNLOCK_REASONS,
  withTextSwitch,
  type SwitchFacts,
} from "@/lib/portal/switch-rules";

const READY: SwitchFacts = {
  gatewayConnected: true,
  hasDepositAmount: true,
  calendarConnected: true,
  autoConfirm: true,
  hasVoice: true,
  agreementCoversText: true,
};

const facts = (patch: Partial<SwitchFacts>): SwitchFacts => ({ ...READY, ...patch });

describe("switchRules", () => {
  test("everything but the text is open when everything is in place", () => {
    const { text_payment_link: text, ...rest } = switchRules(READY, false);
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
  // CLAUDE.md keeps the setting unavailable until a sender is chosen and built:
  // a voice clinic with Stripe must not be able to choose what nothing does.
  test("the text cannot be chosen while healdesk's number is not ready, whatever the clinic has connected", () => {
    for (const f of [READY, facts({ textPaymentLinkOn: true })]) {
      const rule = switchRules(f, false).text_payment_link;
      expect(rule.enabled).toBe(false);
      expect(rule.reason).toBe(TEXT_NOT_READY_REASON);
      expect(rule.unlock).toBeNull();
      expect(textChecksMet(rule.checks)).toBe(false);
    }
  });

  test("with nothing configured, as in CI, the number reads as not ready and the switch stays locked", () => {
    expect(smsSenderConfigured()).toBe(false);
    expect(switchRules(READY).text_payment_link.enabled).toBe(false);
  });

  describe("healdesk's side is the number AND real calls", () => {
    afterEach(() => vi.unstubAllEnvs());
    test("the number set but real calls off: healdesk's check is unmet, the switch locked", () => {
      vi.stubEnv("HEALDESK_SMS_ORIGINATION_IDENTITY", "phone-0123456789abcdef0123456789abcdef");
      vi.stubEnv("HEALDESK_VOICE_REAL_CALLS", "");
      expect(healdeskTextReady()).toBe(false);
      const rule = switchRules(facts({ textPaymentLinkOn: true })).text_payment_link;
      expect(rule.enabled).toBe(false);
      expect(rule.checks.find((c) => c.id === "healdesk")!.met).toBe(false);
      vi.stubEnv("HEALDESK_VOICE_REAL_CALLS", "1");
      expect(healdeskTextReady()).toBe(true);
      expect(textChecksMet(switchRules(facts({ textPaymentLinkOn: true })).text_payment_link.checks)).toBe(true);
    });
  });

  test("an agreement that does not cover the text locks it, with its own reason and no button", () => {
    for (const covered of [false, undefined]) {
      const rule = switchRules(facts({ agreementCoversText: covered, textPaymentLinkOn: true }), true).text_payment_link;
      expect(rule).toMatchObject({ enabled: false, reason: TEXT_AGREEMENT_REASON, unlock: null });
      expect(textChecksMet(rule.checks)).toBe(false);
      const agreement = rule.checks.find((c) => c.id === "agreement")!;
      expect(agreement).toMatchObject({ met: false, who: "you", unlock: null, waiting: AGREEMENT_NOT_COVERING });
    }
  });

  test("no reason mentions how things work inside", () => {
    const all = [
      facts({ gatewayConnected: false }),
      facts({ hasDepositAmount: false }),
      facts({ calendarConnected: false }),
      facts({ autoConfirm: false }),
      facts({ hasVoice: false }),
    ].flatMap((f) => [false, true].flatMap((ready) => Object.values(switchRules(f, ready)).map((r) => r.reason ?? "")));
    all.push(TEXT_AGREEMENT_REASON, AGREEMENT_NOT_COVERING);
    for (const reason of all) expect(reason).not.toMatch(/BAA|DPA|\d\.\d|sender|regist|carrier|SMS|webhook|AWS|toll|REAL_CALLS|flag/i);
  });
});

describe("the text's five checks", () => {
  // Every combination of the five facts: phone, payments, the agreement, the switch, healdesk's side.
  const combos = [false, true].flatMap((hasVoice) =>
    [false, true].flatMap((gatewayConnected) =>
      [false, true].flatMap((covered) =>
        [false, true].flatMap((on) => [false, true].map((ready) => ({ hasVoice, gatewayConnected, covered, on, ready }))),
      ),
    ),
  );

  test.each(combos)(
    "phone $hasVoice, payments $gatewayConnected, agreement $covered, switch $on, healdesk $ready",
    ({ hasVoice, gatewayConnected, covered, on, ready }) => {
      const rule = switchRules(
        facts({ hasVoice, gatewayConnected, agreementCoversText: covered, textPaymentLinkOn: on }),
        ready,
      ).text_payment_link;
      expect(rule.checks.map((c) => c.id)).toEqual(["phone", "payments", "agreement", "switch", "healdesk"]);
      expect(rule.checks.map((c) => c.label)).toEqual(Object.values(TEXT_CHECK_LABELS));
      expect(rule.checks.map((c) => c.who)).toEqual(["you", "you", "you", "you", "healdesk"]);
      const others = hasVoice && gatewayConnected && covered && ready;
      // The switch's own check counts the stored choice in effect: on, and allowed by the others.
      expect(rule.checks.map((c) => c.met)).toEqual([hasVoice, gatewayConnected, covered, on && others, ready]);

      // The switch can be set exactly when every check but its own is met: the
      // server's decision is read from the same list the clinic sees.
      expect(rule.enabled).toBe(others);
      // The text is offered only when all five are.
      expect(textChecksMet(rule.checks)).toBe(others && on);

      // The reason is the first unmet check's, in order.
      if (!hasVoice) expect(rule.reason).toBe(TEXT_PHONE_ONLY_REASON);
      else if (!gatewayConnected) expect([rule.reason, rule.unlock]).toEqual([UNLOCK_REASONS.connect_stripe, "connect_stripe"]);
      else if (!covered) expect([rule.reason, rule.unlock]).toEqual([TEXT_AGREEMENT_REASON, null]);
      else if (!ready) expect([rule.reason, rule.unlock]).toEqual([TEXT_NOT_READY_REASON, null]);
      else expect([rule.reason, rule.unlock]).toEqual([null, null]);

      // Only the payment account has a button; the agreement and healdesk's check only a waiting line.
      const [phone, payments, agreement, sw, healdesk] = rule.checks;
      expect(payments!.unlock).toBe(gatewayConnected ? null : "connect_stripe");
      expect(agreement!.unlock).toBeNull();
      expect(agreement!.waiting).toBe(covered ? null : AGREEMENT_NOT_COVERING);
      expect(healdesk!.unlock).toBeNull();
      expect(healdesk!.waiting).toBe(ready ? null : HEALDESK_SETTING_UP);
      expect([phone!.waiting, payments!.waiting, sw!.waiting]).toEqual([null, null, null]);
    },
  );

  test("healdesk's check unmet keeps the offer off even when the clinic has done all three of its own", () => {
    // Phone bought, Stripe connected, and the switch chosen on (stored).
    const rule = switchRules(facts({ textPaymentLinkOn: true }), false).text_payment_link;
    expect(rule.checks.filter((c) => c.id === "phone" || c.id === "payments").every((c) => c.met)).toBe(true);
    expect(textChecksMet(rule.checks)).toBe(false);
    expect(rule.enabled).toBe(false);
    // The stored choice reads as off while it is not in effect, as the toggle above it does,
    // and comes back on its own the moment healdesk's number is ready: nothing for the clinic to redo.
    expect(rule.checks.find((c) => c.id === "switch")!.met).toBe(false);
    const ready = switchRules(facts({ textPaymentLinkOn: true }), true).text_payment_link;
    expect(ready.checks.every((c) => c.met)).toBe(true);
    expect(textChecksMet(ready.checks)).toBe(true);
  });

  test("the words never say how healdesk's number works inside", () => {
    const words = [...Object.values(TEXT_CHECK_LABELS), HEALDESK_SETTING_UP, AGREEMENT_NOT_COVERING].join(" ");
    expect(words).not.toMatch(/AWS|Parameter|toll|carrier|regist|SMS|Pinpoint|REAL_CALLS|BAA|DPA/i);
    // Nothing sends a notice when it is ready, so the line promises none.
    expect(HEALDESK_SETTING_UP).not.toMatch(/tell you|let you know|notify|email/i);
  });

  test("the wizard's unsaved toggle moves the switch's check and nothing else", () => {
    const { checks } = switchRules(READY, true).text_payment_link;
    expect(withTextSwitch(checks, true).map((c) => c.met)).toEqual([true, true, true, true, true]);
    expect(withTextSwitch(checks, false).map((c) => c.met)).toEqual([true, true, true, false, true]);
    // Turned on where healdesk's number is not ready, it still reads as off.
    const notReady = switchRules(READY, false).text_payment_link.checks;
    expect(withTextSwitch(notReady, true).map((c) => c.met)).toEqual([true, true, true, false, false]);
  });
});

describe("resetsAfter", () => {
  const ON = { depositsEnabled: true, textPaymentLink: true, fullPayment: true };

  // The sender lock is no lost fact of the clinic's: a text left on from
  // before it is never reset (so no reset email), it only reads as off.
  test("nothing resets while every rule still holds", () => {
    expect(resetsAfter(READY, ON)).toEqual([]);
  });

  test("an agreement that does not cover the text is no lost fact: nothing resets, no email", () => {
    expect(resetsAfter(facts({ agreementCoversText: false }), ON)).toEqual([]);
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

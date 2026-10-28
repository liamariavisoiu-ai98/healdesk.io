import { describe, expect, test } from "vitest";

import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import { clinicReason } from "@/lib/email/templates/context";
import { renderSettingChanged } from "@/lib/email/templates/setting_changed";
import { calendarRowConnected } from "@/lib/portal/switch-facts";
import { paymentLinkTextOffered } from "@/lib/portal/switch-resets";
import {
  resetNotice,
  resetsAfter,
  switchRules,
  UNLOCK_REASONS,
} from "@/lib/portal/switch-rules";
import { SETTING_CHANNELS, SETTING_KEYS } from "@/lib/portal/settings";
import { SETTING_PLACES } from "@/lib/support/targets";
import { publicUrl } from "@/lib/public-url";

/**
 * The payment switches without a database (lane A, 28 October 2026): the
 * contract's setting keys and channels, the calendar reading the rules weigh,
 * the reset email's words and its payload, and the text offer that stays off
 * while no sender exists. The writers are tests/payment-switches.test.ts.
 */

const CTX = {
  clinicName: "Radiance Med Spa",
  audience: "patients" as const,
  reason: clinicReason("Radiance Med Spa"),
  raisedAt: new Date("2026-10-28T14:32:00Z"),
  timeZone: "America/New_York",
};

describe("the contract's setting keys", () => {
  test("text_payment_link is phone's alone and payment_ask every channel's", () => {
    expect(SETTING_KEYS).toContain("text_payment_link");
    expect(SETTING_KEYS).toContain("payment_ask");
    expect(SETTING_CHANNELS.text_payment_link).toEqual(["voice"]);
    expect(SETTING_CHANNELS.payment_ask).toEqual(["web", "meta", "voice"]);
    expect(SETTING_PLACES.text_payment_link.card).toBe("payments");
    expect(SETTING_PLACES.payment_ask.card).toBe("payments");
  });
});

describe("calendarRowConnected", () => {
  test("active and degraded count; none, pending, revoked, error or a broken stamp do not", () => {
    expect(calendarRowConnected(null)).toBe(false);
    expect(calendarRowConnected({ status: "active", brokenAt: null })).toBe(true);
    expect(calendarRowConnected({ status: "degraded", brokenAt: null })).toBe(true);
    for (const status of ["pending", "revoked", "error"]) {
      expect(calendarRowConnected({ status, brokenAt: null })).toBe(false);
    }
    expect(calendarRowConnected({ status: "active", brokenAt: new Date(0) })).toBe(false);
  });
});

describe("the reasons have one home", () => {
  test("each rule's reason and each reset's notice come from UNLOCK_REASONS", () => {
    const rules = switchRules({
      gatewayConnected: true,
      hasDepositAmount: true,
      calendarConnected: false,
      autoConfirm: true,
      hasVoice: true,
    });
    expect(rules.full_payment.reason).toBe(UNLOCK_REASONS.connect_calendar);
    const [reset] = resetsAfter(
      { gatewayConnected: true, hasDepositAmount: true, calendarConnected: true, autoConfirm: false, hasVoice: true },
      { depositsEnabled: true, textPaymentLink: true, fullPayment: true },
    );
    expect(reset).toEqual({
      switch: "full_payment",
      notice: resetNotice("full_payment", UNLOCK_REASONS.turn_on_auto_confirm),
    });
  });
});

describe("the reset email (O4, payment_switches_reset)", () => {
  const payload = {
    field: "payment_switches_reset" as const,
    beforeMasked: null,
    afterMasked: null,
    switchIds: ["full_payment" as const, "text_payment_link" as const, "deposits" as const],
    code: "connect_stripe" as const,
    changedAt: "2026-10-28T14:32:00Z",
    settingsUrl: publicUrl("/c/radiance-med-spa/settings#payments"),
  };

  test("its payload passes the allowlist the sender checks", () => {
    expect(() => assertPayloadAllowed(payload, "setting_changed")).not.toThrow();
  });

  test("names every switch reset and the one reason, in the Settings page's words", () => {
    const r = renderSettingChanged(payload, CTX);
    expect(r.subject).toBe("Some payment settings were switched off");
    expect(r.text).toContain("Your Stripe account was disconnected for Radiance Med Spa");
    expect(r.text).toContain(`Back to deposit only. ${UNLOCK_REASONS.connect_stripe}`);
    expect(r.text).toContain(`Texting the payment link is off. ${UNLOCK_REASONS.connect_stripe}`);
    expect(r.text).toContain(`Deposits are off. ${UNLOCK_REASONS.connect_stripe}`);
    expect(subjectProblems(r.subject)).toEqual([]);
    expect(copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n"))).toEqual([]);
    expect(linkProblems(r, "setting_changed")).toEqual([]);
  });

  test("one switch reads in the singular, and Auto-confirm is named as the cause", () => {
    const r = renderSettingChanged(
      { ...payload, switchIds: ["full_payment"], code: "turn_on_auto_confirm" },
      CTX,
    );
    expect(r.subject).toBe("A payment setting was switched off");
    expect(r.text).toContain("Auto-confirm bookings was turned off");
    expect(r.text).not.toContain("Deposits are off");
  });

  test("a reset with no switch or no reason is refused rather than sent half-worded", () => {
    expect(() => renderSettingChanged({ ...payload, switchIds: [] }, CTX)).toThrow();
    expect(() => renderSettingChanged({ ...payload, code: undefined }, CTX)).toThrow();
  });
});

describe("the payment-link text", () => {
  test("is never offered while no sender exists", () => {
    expect(paymentLinkTextOffered()).toBe(false);
  });
});

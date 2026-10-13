import { describe, expect, test } from "vitest";

import type { Lead } from "@/lib/leads";
import { TOUCHES, abandonmentEmail, dueTouch } from "@/lib/email/nurture";
import { unsubscribeToken, verifyUnsubscribeToken } from "@/lib/email";
import { canEmail } from "@/lib/leads";

const HOUR = 60 * 60 * 1000;

function lead(over: Partial<Lead> = {}): Lead {
  const consentAt = new Date("2026-09-10T12:00:00Z");
  return {
    id: "0c1d2e3f-0000-4000-8000-000000000001",
    email: "alex.chen@radiance.test",
    emailNormalized: "alex.chen@radiance.test",
    phone: null,
    clinicName: null,
    website: null,
    specialty: null,
    segment: null,
    sourceCampaign: null,
    leadScore: "business",
    isBusinessEmail: true,
    marketingConsent: true,
    consentNoticeVersion: "v",
    consentText: "Email me",
    consentAt,
    claimToken: null,
    unsubscribedAt: null,
    bouncedAt: null,
    nurtureStep: 0,
    lastTouchAt: null,
    cohortCreditOfferedAt: null,
    checkoutStartedAt: null,
    checkoutAbandonedAt: null,
    abandonmentSentAt: null,
    convertedAt: null,
    convertedPlan: null,
    convertedMrrUsd: null,
    referrerHost: null,
    unlockCount: 1,
    firstSeenAt: consentAt,
    lastSeenAt: consentAt,
    createdAt: consentAt,
    updatedAt: consentAt,
    ...over,
  };
}

describe("nurture sequence", () => {
  test("touches are due by elapsed time since consent, one at a time, and stop at the end", () => {
    const l = lead();
    const t0 = l.consentAt!.getTime();
    expect(dueTouch(l, new Date(t0 + 23 * HOUR))).toBeNull();
    expect(dueTouch(l, new Date(t0 + 25 * HOUR))?.step).toBe(0);
    // Three days late: still only step 0 is offered; the cron advances one per run.
    expect(dueTouch(l, new Date(t0 + 200 * HOUR))?.step).toBe(0);
    expect(dueTouch(lead({ nurtureStep: 1 }), new Date(t0 + 71 * HOUR))).toBeNull();
    expect(dueTouch(lead({ nurtureStep: 1 }), new Date(t0 + 73 * HOUR))?.step).toBe(1);
    expect(dueTouch(lead({ nurtureStep: TOUCHES.length }), new Date(t0 + 999 * HOUR))).toBeNull();
    expect(dueTouch(lead({ consentAt: null }), new Date(t0 + 999 * HOUR))).toBeNull();
  });

  test("every touch carries the unsubscribe link and no invented urgency or recovery claim", () => {
    for (const touch of TOUCHES) {
      const text = touch.text(lead());
      expect(text).toContain("/api/email/unsubscribe?t=");
      expect(text).not.toMatch(/expir/i);
      expect(text).not.toMatch(/\b\d{2}%/);
      expect(text).not.toMatch(/hurry|only \d+ left|countdown/i);
    }
    const abandoned = abandonmentEmail(lead());
    expect(abandoned.text).toContain("Nothing has been charged");
    expect(abandoned.text).toContain("/api/email/unsubscribe?t=");
  });

  test("the cohort credit quotes the setup fees of the step pricing, and prices point at /pricing", () => {
    // The owner's sheet of 13 October 2026: setup is $259 (Web Chat) to
    // $1,394 (Voice + Meta Chat) at list price, and the credit waives it in
    // full, so the email quotes the range and never one round number.
    const last = TOUCHES[TOUCHES.length - 1]!.text(lead());
    expect(last).toContain("waives the one-time setup fee in full ($259–$1,394 depending on the package)");
    expect(TOUCHES[1]!.text(lead())).toContain("/pricing");
    for (const touch of TOUCHES) {
      expect(touch.text(lead())).not.toMatch(/\$497|\$997|50% off|half off/i);
    }
  });

  test("every touch describes v1, and nothing it does not do", () => {
    // docs/v1-product-spec.md: inbound only, no SMS, no reminders, calls are
    // transcribed and never recorded, and v1 claims booked value, never
    // revenue. Each of these phrases was in the sequence before 30 September.
    for (const touch of TOUCHES) {
      const text = touch.text(lead());
      expect(text).not.toMatch(/revenue/i);
      expect(text).not.toMatch(/call is recorded/i);
      expect(text).not.toMatch(/\bSMS\b|\btext you\b|remind/i);
      expect(text).not.toMatch(/insurable/i);
      expect(text).not.toMatch(/ring you back/i);
      expect(text).not.toContain("/#leak");
      expect(text).not.toMatch(/two minutes/i);
    }
    const all = TOUCHES.map((touch) => touch.text(lead())).join("\n");
    expect(all).toContain("transcribed, not recorded");
    expect(all).toContain("Google Calendar");
    expect(all).toContain("/why-wait");
  });

  test("canEmail: marketing needs the box, both kinds stop on unsubscribe, bounce and purchase", () => {
    expect(canEmail(lead(), "marketing")).toEqual({ ok: true });
    expect(canEmail(lead({ marketingConsent: false }), "marketing").ok).toBe(false);
    expect(canEmail(lead({ marketingConsent: false }), "relationship").ok).toBe(true);
    expect(canEmail(lead({ unsubscribedAt: new Date() }), "relationship").ok).toBe(false);
    expect(canEmail(lead({ bouncedAt: new Date() }), "marketing").ok).toBe(false);
    expect(canEmail(lead({ convertedAt: new Date() }), "marketing").ok).toBe(false);
  });

  test("unsubscribe tokens verify only for the id they were minted for", () => {
    const id = "0c1d2e3f-0000-4000-8000-000000000001";
    const token = unsubscribeToken(id);
    expect(verifyUnsubscribeToken(token)).toBe(id);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
    expect(verifyUnsubscribeToken(`0c1d2e3f-0000-4000-8000-000000000002.${token.split(".")[1]}`)).toBeNull();
    expect(verifyUnsubscribeToken("nonsense")).toBeNull();
    expect(verifyUnsubscribeToken(null)).toBeNull();
  });
});

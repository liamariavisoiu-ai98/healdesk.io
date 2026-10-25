import { describe, expect, test } from "vitest";

import { PACKAGES, PRODUCTS } from "./plans";
import {
  catalogPricesCents,
  SUPPORT_CLAIM_RULES,
  SUPPORT_NAME_ALLOW,
  SUPPORT_PACKAGE_NAMES,
  SUPPORT_PROMISE_RULES,
  SUPPORT_REPLY_LIMITS,
} from "./support-checks";

/**
 * The support reply checks' word lists (design E5 §6; lane P7b). The checks
 * themselves are tested in apps/app (tests/support-draft-checks.test.ts);
 * these hold the lists to what the design says they are.
 */

const promise = (id: string) => SUPPORT_PROMISE_RULES.find((r) => r.id === id)!;
const claim = (id: string) => SUPPORT_CLAIM_RULES.find((r) => r.id === id)!;

describe("support reply word lists", () => {
  test("every promise the design names is caught, and a credit card is not a credit", () => {
    expect(promise("refund").pattern.test("We'll refund it")).toBe(true);
    expect(promise("credit").pattern.test("a credit on your next invoice")).toBe(true);
    expect(promise("credit").pattern.test("update the credit card in Billing")).toBe(false);
    expect(promise("free").pattern.test("the next month is free")).toBe(true);
    expect(promise("free").pattern.test("hands-free")).toBe(false);
    expect(promise("guarantee").pattern.test("we guarantee it")).toBe(true);
    expect(promise("waive").pattern.test("we'll waive the fee")).toBe(true);
    expect(promise("live_by").pattern.test("you'll be live by Friday")).toBe(true);
    expect(promise("go_live_date").pattern.test("WhatsApp will be live on Monday")).toBe(true);
    expect(promise("go_live_date").pattern.test("WhatsApp goes live once the payment method is added")).toBe(false);
    expect(promise("response_time").pattern.test("we'll reply within 24 hours")).toBe(true);
    expect(promise("response_time").pattern.test("within two days")).toBe(true);
  });

  test("only a refund, a credit or a waiver can be backed by a billing record", () => {
    const backed = SUPPORT_PROMISE_RULES.filter((r) => r.billingStem !== null).map((r) => r.id);
    expect(backed.sort()).toEqual(["credit", "refund", "waive"]);
  });

  test("the claims the product may not make", () => {
    expect(claim("hipaa_compliant").pattern.test("we are HIPAA compliant")).toBe(true);
    expect(claim("hipaa_compliant").pattern.test("HIPAA-compliant")).toBe(true);
    expect(claim("revenue").pattern.test("your revenue")).toBe(true);
    expect(claim("recovered").pattern.test("calls recovered")).toBe(true);
    expect(claim("collected").unlessBefore!.test("12 deposits ")).toBe(true);
  });

  test("the shape limits are the design's", () => {
    expect(SUPPORT_REPLY_LIMITS).toEqual({ sentences: 6, characters: 900, questions: 1, links: 1 });
  });

  test("the names a reply may use include the product, the vendors and the carriers, and no person", () => {
    for (const word of ["AYA", "healdesk", "Google", "Calendar", "Stripe", "Instagram", "Messenger", "WhatsApp", "Verizon", "AT&T", "T-Mobile"]) {
      expect(SUPPORT_NAME_ALLOW).toContain(word);
    }
    expect(SUPPORT_NAME_ALLOW).not.toContain("Dana");
    expect(SUPPORT_NAME_ALLOW).not.toContain("Liam");
  });

  test("every package and product name is a fact to check, longest first", () => {
    for (const p of PACKAGES) expect(SUPPORT_PACKAGE_NAMES).toContain(p.name);
    for (const p of Object.values(PRODUCTS)) expect(SUPPORT_PACKAGE_NAMES).toContain(p.name);
    const lengths = SUPPORT_PACKAGE_NAMES.map((n) => n.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  test("the catalog's prices: setup fees, per-step prices, overage blocks and credits, and not an invented amount", () => {
    const prices = catalogPricesCents();
    for (const usd of [697, 259, 956, 80, 40, 60, 104, 52, 78, 349, 64]) {
      expect(prices.has(usd * 100), `$${usd}`).toBe(true);
    }
    expect(prices.has(123_45)).toBe(false);
    expect(prices.has(19_99)).toBe(false);
  });
});

import { CARRIERS } from "./forwarding";
import { allPlans, PACKAGES, PRODUCTS, SETUP_CREDITS, setupCreditUsd, STEP_UNITS } from "./plans";
import { SUPPORT_SIGN_OFF } from "./support-copy";

/**
 * The word lists behind the support reply checks (ops automation design E5
 * §6, checks 3, 5, 6 and 7; lane P7b). The checks themselves run in apps/app
 * (lib/support/draft/checks.ts), after every draft the model writes and again
 * on the text the owner approves; the lists live here, beside the tone lint
 * (support-copy.ts), so the drafter's prompt, its checks and the send path
 * read one copy.
 *
 * Every list is matched without regard to case on word boundaries. None of it
 * names a clinic, a person or a patient: it is the product's own vocabulary.
 * No dependencies beyond the catalog itself.
 */

/**
 * Check 5, promises. A reply never promises money back, something for
 * nothing, a guarantee or a time. `stem` names what a recorded billing
 * action must say for the word to stand: a refund or a credit the billing
 * record shows may be told; a go-live date or a response time never may
 * (go-live is always "once {step}", E5 §6; the tone guide names the day the
 * next step happens, never "within 24 hours").
 */
export const SUPPORT_PROMISE_RULES: readonly {
  id: string;
  pattern: RegExp;
  /** The word a billing fact must carry for this one to stand, or null when nothing can. */
  billingStem: string | null;
}[] = [
  { id: "refund", pattern: /(?<![\p{L}\p{N}])refund(?:s|ed|ing)?(?![\p{L}\p{N}])/iu, billingStem: "refund" },
  // "credit card" is a card, not a credit.
  {
    id: "credit",
    pattern: /(?<![\p{L}\p{N}])credit(?:s|ed|ing)?(?![\p{L}\p{N}])(?!\s+cards?\b)/iu,
    billingStem: "credit",
  },
  { id: "free", pattern: /(?<![\p{L}\p{N}-])free(?![\p{L}\p{N}-])/iu, billingStem: null },
  { id: "guarantee", pattern: /(?<![\p{L}\p{N}])guarant(?:ee|ees|eed|eeing)(?![\p{L}\p{N}])/iu, billingStem: null },
  { id: "waive", pattern: /(?<![\p{L}\p{N}])waiv(?:e|es|ed|ing|er)(?![\p{L}\p{N}])/iu, billingStem: "waive" },
  { id: "live_by", pattern: /(?<![\p{L}\p{N}])live\s+by(?![\p{L}\p{N}])/iu, billingStem: null },
  {
    id: "go_live_date",
    pattern:
      /(?<![\p{L}\p{N}])(?:go|goes|going|went|be|is|are|will\s+be)\s+live\s+(?:on|by|before|within|in|from|next)(?![\p{L}\p{N}])/iu,
    billingStem: null,
  },
  {
    id: "response_time",
    pattern: /(?<![\p{L}\p{N}])within\s+(?:\d+|a|an|one|two|twenty-four|twenty\s+four|24|48)\s+(?:hours?|days?|minutes?)(?![\p{L}\p{N}])/iu,
    billingStem: null,
  },
];

/**
 * Check 6, claims the product may not make (CLAUDE.md "Claims and copy"):
 * never "HIPAA compliant", never "revenue", "recovered" or "collected",
 * except "deposits collected", which v1 may claim.
 */
export const SUPPORT_CLAIM_RULES: readonly { id: string; pattern: RegExp; unlessBefore?: RegExp }[] = [
  { id: "hipaa_compliant", pattern: /(?<![\p{L}\p{N}])HIPAA[\s-]+complian(?:t|ce)(?![\p{L}\p{N}])/iu },
  { id: "revenue", pattern: /(?<![\p{L}\p{N}])revenues?(?![\p{L}\p{N}])/iu },
  { id: "recovered", pattern: /(?<![\p{L}\p{N}])recover(?:ed|s|ing|y)?(?![\p{L}\p{N}])/iu },
  {
    id: "collected",
    pattern: /(?<![\p{L}\p{N}])collect(?:ed|s|ing|ion)?(?![\p{L}\p{N}])/giu,
    unlessBefore: /deposits?\s+$/iu,
  },
];

/** The words that describe each agreement (check 6: "the agreement described in the turn's sentence only"). */
export const SUPPORT_AGREEMENT_WORDS = {
  baa: /(?<![\p{L}\p{N}])(?:business\s+associate\s+agreement|BAA)s?(?![\p{L}\p{N}])/iu,
  dpa: /(?<![\p{L}\p{N}])(?:data\s+protection\s+agreement|DPA)s?(?![\p{L}\p{N}])/iu,
} as const;

/** Check 7, the reply's shape (E5 §6 and the tone guide's "Short"). */
export const SUPPORT_REPLY_LIMITS = {
  sentences: 6,
  characters: 900,
  questions: 1,
  links: 1,
} as const;

/**
 * Check 3, the capitalised words a reply may use that are not a person: the
 * product, the vendors a clinic connects to, the carriers, the packages and
 * the sign-off. The portal's own screen and setting names, the practice's
 * name, the days and the months are added by the check itself.
 */
export const SUPPORT_NAME_ALLOW: readonly string[] = [
  "AYA",
  "healdesk",
  "Healdesk",
  "Google",
  "Calendar",
  "Gmail",
  "Stripe",
  "Instagram",
  "Messenger",
  "WhatsApp",
  "Facebook",
  "Meta",
  "Business",
  "Voice",
  "Web",
  "Chat",
  "Phone",
  "Website",
  "Team",
  "I",
  "OK",
  "AM",
  "PM",
  "US",
  "PDF",
  ...SUPPORT_SIGN_OFF.split(/\s+/),
  ...CARRIERS.flatMap((c) => c.name.split(/[\s/()]+/)).filter((w) => /^\p{Lu}/u.test(w)),
  ...PACKAGES.flatMap((p) => p.name.split(/[\s+]+/)).filter((w) => /^\p{Lu}/u.test(w)),
];

/**
 * Check 3, the portal's own places, as a reply names them ("Settings →
 * Channels", "Knowledge → Hours"): every capitalised word of the screens,
 * the Settings cards and the switches' labels. apps/app's tests hold this
 * list to the portal's registry (lib/support/targets.ts), so a screen or a
 * switch added there fails until its words are here.
 */
export const SUPPORT_PORTAL_WORDS: readonly string[] = [
  "Home",
  "Building",
  "Setup",
  "Settings",
  "Channels",
  "How",
  "Talks",
  "Tone",
  "Greeting",
  "Languages",
  "Payments",
  "Safety",
  "Alerts",
  "Sign-in",
  "Sign",
  "Knowledge",
  "Conversations",
  "Bookings",
  "Billing",
  "Hours",
  "Closures",
  "Prices",
  "Services",
  "Policies",
  "Promotions",
  "Invoices",
  "Help",
  "Which",
  "Suggest",
  "Mention",
  "Take",
  "Book",
  "When",
  "Direct",
  "Daily",
  "Transfer",
  "Your",
  "Auto-confirm",
];

/**
 * The package and product names (check 1 counts each as a fact the reply
 * must take from the account): longest first, so "AYA Voice + Meta Chat" is
 * read before "AYA Voice".
 */
export const SUPPORT_PACKAGE_NAMES: readonly string[] = [
  ...new Set([...PACKAGES.map((p) => p.name), ...Object.values(PRODUCTS).map((p) => p.name)]),
].sort((a, b) => b.length - a.length);

let pricesCents: ReadonlySet<number> | null = null;

/**
 * Check 6, every dollar amount the catalog can price, in cents: each plan's
 * monthly price, its annual per-month price and annual total, its setup fee
 * and that fee after each setup credit, each product's price per step on
 * either billing, and each overage block of 100. A reply quoting any other
 * amount is quoting a price the catalog does not have.
 */
export function catalogPricesCents(): ReadonlySet<number> {
  if (pricesCents) return pricesCents;
  const out = new Set<number>();
  const add = (usd: number) => out.add(Math.round(usd * 100));
  for (const plan of allPlans()) {
    add(plan.monthlyUsd);
    add(plan.annualMonthlyUsd);
    add(plan.annualMonthlyUsd * 12);
    add(plan.setupFeeUsd);
    for (const credit of SETUP_CREDITS) {
      const off = setupCreditUsd(plan, credit);
      add(off);
      add(plan.setupFeeUsd - off);
    }
  }
  for (const product of Object.values(PRODUCTS)) {
    add(product.perStepMonthlyUsd);
    add(product.perStepAnnualMonthlyUsd);
    add(product.setupFeeUsd);
    add(product.overagePerUnitUsd * STEP_UNITS);
  }
  pricesCents = out;
  return out;
}

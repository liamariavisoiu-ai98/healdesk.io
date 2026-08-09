/**
 * Billing plans.
 *
 * Priced against a market that converged independently at $295–299 for a
 * single-location med spa (AgentZap $295, MedspAI $299, Clara $299). We sit
 * below that cluster without dropping into the ~$199 band, where buyers in this
 * category reportedly assume they're looking at a chatbot with no real
 * integration — pricing too low costs conversions here rather than winning them.
 *
 * Minutes are capped because voice minutes are the dominant cost and scale with
 * usage. Every competitor caps them; a flat "unlimited" tier would be a margin
 * trap the first time a busy clinic signed up.
 *
 * The bigger wedge is `setupFeeUsd: 0` — the closest competitor charges $499 to
 * start, so year one is $2,988 against $4,039. That's 26% cheaper in the number
 * a buyer actually writes down, and it costs us nothing.
 *
 * See docs/launch-plan.md → "Pricing and unit economics".
 */

export type Plan = {
  id: string;
  name: string;
  monthlyUsd: number;
  setupFeeUsd: number;
  includedMinutes: number;
  overagePerMinuteUsd: number;
  /** Locations covered before the next tier is needed. */
  locations: number;
  highlight?: string;
};

export const TRIAL_DAYS = 14;

export const plans: readonly Plan[] = [
  {
    id: "core",
    name: "Core",
    monthlyUsd: 249,
    setupFeeUsd: 0,
    includedMinutes: 500,
    overagePerMinuteUsd: 0.45,
    locations: 1,
    highlight: "Most single-location clinics",
  },
  {
    id: "growth",
    name: "Growth",
    monthlyUsd: 449,
    setupFeeUsd: 0,
    includedMinutes: 1_200,
    overagePerMinuteUsd: 0.4,
    locations: 1,
  },
  {
    id: "multi",
    name: "Multi-location",
    monthlyUsd: 799,
    setupFeeUsd: 0,
    includedMinutes: 2_500,
    overagePerMinuteUsd: 0.35,
    locations: 5,
  },
] as const;

export function getPlan(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export function isPlanId(id: unknown): id is string {
  return typeof id === "string" && plans.some((p) => p.id === id);
}

/**
 * What a clinic is displacing, for the comparison on the pricing page.
 * Sourced ranges, not invented — see docs/launch-plan.md.
 */
export const ALTERNATIVES = {
  inHouseReceptionistMonthlyUsd: [3_900, 4_830] as const,
  answeringServiceMonthlyUsd: [400, 1_500] as const,
} as const;

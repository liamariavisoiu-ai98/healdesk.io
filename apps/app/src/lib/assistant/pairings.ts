import { priceText } from "./prompt";
import type { AssistantService } from "./facts";

/**
 * One add-on worth suggesting, chosen by code from the practice's own menu
 * (owner, 1 November 2026, approving review point 7 of
 * docs/design/demo-aya-simpler-2026-11-01.md): what pairs with the treatment
 * being booked, and why, in words about convenience (the same visit), never
 * about what it will do for them. The model says it once, before times are
 * looked for, and drops it at a no (turn.ts addOnNote). On a demonstration
 * only for now: a clinic's own calls keep the spec's switch, off by default,
 * and its plain add-on line.
 */

type Kind = "toxin" | "filler" | "facial" | "peel" | "needling" | "prp" | "cleaning" | "whitening";

const KINDS: readonly [Kind, RegExp][] = [
  ["toxin", /\b(?:botox|dysport|xeomin|jeuveau|daxxify|neuro ?toxin|wrinkle relax\w*)/i],
  ["filler", /\b(?:filler|juvederm|restylane|rha|sculptra|radiesse|lip)/i],
  ["facial", /\b(?:hydra ?facial|facial|dermaplan\w*)/i],
  ["peel", /\bpeel/i],
  ["needling", /\b(?:microneedling|morpheus|rf needling)/i],
  ["prp", /\b(?:prp|prf)\b/i],
  ["whitening", /\bwhitening/i],
  ["cleaning", /\b(?:cleaning|hygiene)/i],
];

const PAIRS: Readonly<Partial<Record<Kind, { with: readonly Kind[]; why: string }>>> = {
  toxin: { with: ["facial", "filler"], why: "in the same visit" },
  filler: { with: ["toxin", "facial"], why: "in the same visit" },
  facial: { with: ["peel", "toxin"], why: "while they're in" },
  peel: { with: ["facial"], why: "while they're in" },
  needling: { with: ["prp", "facial"], why: "in the same session" },
  cleaning: { with: ["whitening"], why: "in the same visit" },
};

function kindOf(name: string): Kind | null {
  return KINDS.find(([, match]) => match.test(name))?.[0] ?? null;
}

const priced = (svc: AssistantService) => svc.priceFromUsd !== null || svc.priceToUsd !== null;

/** The add-on for `service`, from the practice's own priced menu, with its price and why; null when nothing pairs. */
export function pairingFor(service: string, services: readonly AssistantService[]): { name: string; price: string; why: string } | null {
  const own = kindOf(service);
  const pair = own ? PAIRS[own] : undefined;
  if (!pair) return null;
  for (const kind of pair.with) {
    const match = services.find((svc) => kindOf(svc.name) === kind && priced(svc) && svc.name.toLowerCase() !== service.toLowerCase());
    if (match) return { name: match.name, price: priceText(match), why: pair.why };
  }
  return null;
}

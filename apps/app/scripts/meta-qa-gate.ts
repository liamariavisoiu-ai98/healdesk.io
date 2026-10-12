import { metaEligible, resolveBookingRequirements } from "@healdesk/catalog";

import {
  FRONT_DOOR_PROBES,
  anthropicResponder,
  buildFrontDoorPrompt,
  guardContextFor,
  probeVerdict,
  type FrontDoorFacts,
} from "../src/lib/meta/front-door";

/**
 * The Meta front door's QA gate: does the narrow agent still refuse to be a
 * hallway?
 *
 *   ANTHROPIC_API_KEY=... npm run qa:meta -w @healdesk/app
 *
 * Runs the exact system prompt the webhook runs, for a representative
 * clinic, against nine messages a real patient sends — a condition, a
 * booking request with a time and a provider, an insurance question, a
 * safety question, a symptom, "are you human", "check my file", and a
 * prompt injection — and grades each reply with the SAME deterministic guard
 * the webhook applies before sending, plus a hand-off check. Costs real
 * tokens; run before any prompt change ships and nightly. Exit 1 on any
 * failure. The guard in production replaces a failing reply with the fixed
 * hand-off line, so a failure here is a quality regression, not a leak —
 * but a prompt that fails often is a prompt that hands off on everything.
 */
const FACTS: FrontDoorFacts = {
  clinicName: "Radiance Med Spa",
  phone: "+1 415 555 0199",
  websiteHint: "radiancemedspa.example",
  services: [
    { name: "Consultation", priceFromUsd: 0, priceToUsd: 0 },
    { name: "Injectables appointment", priceFromUsd: 300, priceToUsd: 900 },
    { name: "Facial or skin treatment", priceFromUsd: 150, priceToUsd: 400 },
  ],
  notes: "Free parking behind the building. Open Monday to Friday 9 to 5, Saturday 10 to 2.",
  escalationHours: "Monday to Friday 9 to 5",
  // A med-spa's set: the locked four on this channel; `service` waits for the phone.
  requirements: metaEligible(resolveBookingRequirements("med-spa", null)),
  deferredRequirements: resolveBookingRequirements("med-spa", null).filter((f) => !f.metaEligible),
  // The opening and closing times the notes give, the only clock times a reply may name.
  publishedTimes: [9 * 60, 17 * 60, 10 * 60, 14 * 60],
};

async function main(): Promise<void> {
  const responder = anthropicResponder();
  if (!responder) throw new Error("ANTHROPIC_API_KEY is not set.");
  const system = buildFrontDoorPrompt(FACTS);
  let failures = 0;
  for (const probe of FRONT_DOOR_PROBES) {
    const reply = await responder(system, probe.text);
    const verdict = probeVerdict(reply, guardContextFor(FACTS));
    if (!verdict.ok) failures += 1;
    console.log(
      `${verdict.ok ? "PASS" : "FAIL"} ${probe.id.padEnd(10)} ${verdict.reason ? `(${verdict.reason}) ` : ""}— ${reply.replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }
  console.log(`\n${FRONT_DOOR_PROBES.length - failures}/${FRONT_DOOR_PROBES.length} passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

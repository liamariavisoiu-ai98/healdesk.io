import { metaEligible, resolveBookingRequirements } from "@healdesk/catalog";

import { isModelRefusal } from "../src/lib/assistant/responder";
import { neverSayWithDefaults } from "../src/lib/setup/knowledge";
import {
  FRONT_DOOR_PROBES,
  anthropicResponder,
  buildFrontDoorPrompt,
  firstReplyVerdict,
  guardContextFor,
  parseModelReply,
  probeVerdict,
  promisesReplyInChat,
  staffCanReplyOn,
  type FrontDoorFacts,
  type MetaPlatform,
} from "../src/lib/meta/front-door";

/**
 * The Meta front door's QA gate: does the narrow agent still refuse to be a
 * hallway?
 *
 *   ANTHROPIC_API_KEY=... npm run qa:meta -w @healdesk/app
 *
 * Runs the exact system prompts the webhook runs (Messenger's, which
 * Instagram shares, and WhatsApp's), for a representative clinic, against
 * the messages a real patient sends (FRONT_DOOR_PROBES) — a condition, a
 * booking request with a time and a provider, an insurance question, a
 * safety question, a symptom, "are you human", "can I talk to someone",
 * "check my file",
 * a prompt injection and more — and grades each reply with the SAME
 * deterministic guard the webhook applies before sending, plus a hand-off
 * check. Costs real tokens; run before any prompt change ships and nightly.
 * Exit 1 on any failure. The guard in production replaces a failing reply
 * with the fixed hand-off line, so a failure here is a quality regression,
 * not a leak — but a prompt that fails often is a prompt that hands off on
 * everything.
 *
 * Each reply is graded a second way, for BAA 1.3.0 release gate 20: as it
 * would go out as the first reply of a conversation, metaChannelGreeting()
 * in front and the model's own leading greeting stripped exactly as
 * answerFrontDoor strips it, it must hold no second greeting and no second
 * AI self-introduction (firstReplyVerdict). A reply that passes only because
 * the backstop stripped something is marked "[greeting stripped]": the
 * person reads one greeting, but the prompt alone did not hold.
 *
 * The clinic carries a never-say list, the built-in defaults and one entry
 * of its own, so the prompt lists it and the guard grades every reply
 * against it, as answerFrontDoor does; the "never-say" probe asks for two of
 * its phrases outright.
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
  neverSay: neverSayWithDefaults(["cheapest in town"]),
};

/**
 * The prompt differs by platform in one rule only, a request for a person
 * (rule 5): on Instagram and Messenger the team can answer in the thread,
 * on WhatsApp nobody can, and no reply there may promise one
 * (promisesReplyInChat). Messenger's prompt stands for Instagram's, which is
 * the same, and WhatsApp's is graded too.
 */
const PLATFORMS: readonly MetaPlatform[] = ["messenger", "whatsapp"];

async function main(): Promise<void> {
  const responder = anthropicResponder();
  if (!responder) throw new Error("ANTHROPIC_API_KEY is not set.");
  let failures = 0;
  let runs = 0;
  for (const platform of PLATFORMS) {
    const system = buildFrontDoorPrompt(FACTS, platform);
    for (const probe of FRONT_DOOR_PROBES) {
      runs += 1;
      const label = `${platform.padEnd(9)} ${probe.id.padEnd(10)}`;
      const raw = await responder(system, probe.text);
      if (isModelRefusal(raw)) {
        // In production the hand-off line goes instead, but a probe the model
        // will not answer is not a pass.
        failures += 1;
        console.log(`FAIL ${label} (the model declined to answer: ${raw.category ?? "no category"})`);
        continue;
      }
      const reply = raw;
      const verdict = probeVerdict(reply, guardContextFor(FACTS));
      const first = firstReplyVerdict(reply, {
        clinicName: FACTS.clinicName,
        platform,
        inbound: probe.text,
      });
      // On WhatsApp answerFrontDoor refuses a reply that promises an answer in the chat.
      const promised = !staffCanReplyOn(platform) && promisesReplyInChat(parseModelReply(reply).reply) ? "a reply promised in a chat nobody answers" : null;
      const ok = verdict.ok && first.ok && promised === null;
      if (!ok) failures += 1;
      const reasons = [verdict.reason, first.reason, promised].filter((r): r is string => r !== null);
      console.log(
        `${ok ? "PASS" : "FAIL"} ${label} ${reasons.length ? `(${reasons.join("; ")}) ` : ""}${first.stripped ? "[greeting stripped] " : ""}— ${reply.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }
  console.log(`\n${runs - failures}/${runs} passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

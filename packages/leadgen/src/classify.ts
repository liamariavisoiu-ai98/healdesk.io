import Anthropic from "@anthropic-ai/sdk";

import type { BookingDetection, BookingMethod } from "./types.ts";

/**
 * Stage 2 (smarter) — LLM classification of a rendered page.
 *
 * The regex signature list in booking-detection.ts is brittle: it only knows
 * the vendors we listed, and a clinic on an unlisted or self-hosted scheduler
 * reads as a false negative. This handles the pages the footprint pass could
 * not settle.
 *
 * Cost note: this runs once per ambiguous page. It uses claude-opus-5 with
 * structured outputs at low effort. If you sweep whole metros and the per-page
 * cost matters more than edge-case accuracy, this is the obvious knob to turn —
 * see the README.
 */

const SCHEMA = {
  type: "object",
  properties: {
    has_online_booking: {
      type: "boolean",
      description:
        "True only if a patient can self-schedule via an online calendar or booking widget.",
    },
    method: {
      type: "string",
      enum: ["widget", "phone_only", "contact_form", "none"],
    },
    provider: {
      type: "string",
      description:
        "Scheduler vendor if identifiable (e.g. mindbody, vagaro), otherwise an empty string.",
    },
  },
  required: ["has_online_booking", "method", "provider"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You classify medical-clinic websites by how a patient can book an appointment.",
  "",
  "Rules:",
  '- "widget" means genuine self-serve scheduling: an embedded calendar, a booking iframe, or a link out to a scheduler where the patient picks a slot themselves.',
  '- "contact_form" means the site collects interest — a contact form, "request an appointment", "request a consultation" — that a human then has to chase. This is NOT self-serve booking.',
  '- "phone_only" means the only path is calling a number.',
  '- "none" means no discernible booking path at all.',
  "",
  "A form that emails the clinic is contact_form, never widget. When genuinely unsure between widget and contact_form, choose contact_form — a false negative keeps a clinic in the target set, a false positive drops a real prospect.",
].join("\n");

export async function classifyPage(
  pageText: string,
  client: Anthropic,
): Promise<BookingDetection> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1_000,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Classify this clinic website:\n\n${pageText.slice(0, 12_000)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Classification refused by safety classifiers.");
  }

  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Classification returned no text block.");
  }

  const parsed = JSON.parse(text.text) as {
    has_online_booking: boolean;
    method: BookingMethod;
    provider: string;
  };

  return {
    hasOnlineBooking: parsed.has_online_booking,
    method: parsed.method,
    provider: parsed.provider || null,
    source: "llm",
    matchedSignatures: [],
  };
}

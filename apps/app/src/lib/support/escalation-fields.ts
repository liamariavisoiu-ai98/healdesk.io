import {
  CARRIERS,
  CHANNEL_NAMES,
  CHANNELS,
  COVERAGE_MODE_OPTIONS,
  type Carrier,
  type Channel,
  type CoverageModeId,
} from "@healdesk/catalog";

/**
 * What an escalation from the support chat may carry (plan Part H:
 * "escalate_to_support(category, fields)", "fields chosen from fixed
 * lists"): a topic, what is wrong picked from that topic's list, and for the
 * topics that need them the carrier, the phone system, the coverage mode or
 * the channel. Every value is an id from a list below or the catalog's, so an
 * escalation can carry nothing anyone typed: not the chat's words, not a
 * name, not a number. The model fills them through a strict tool schema
 * (support/tools.ts) and the server checks them again here.
 *
 * The topics are the spec's common tickets ("forwarding help, reconnecting a
 * calendar, changing a plan, getting a transcript sent again") and the rest
 * of the portal's ground. Pure, so the email templates can read the labels.
 */

export const ESCALATION_TOPICS = {
  forwarding: {
    label: "Call forwarding",
    symptoms: {
      calls_not_reaching_aya: "Calls aren't reaching AYA",
      calls_ring_out: "Calls ring out unanswered",
      staff_not_getting_calls: "Staff aren't getting calls they should",
      caller_id_shows_own_number: "Forwarded calls show the practice's own number",
      codes_not_working: "The forwarding codes don't work",
      undo_forwarding: "Help undoing call forwarding",
      other: "Something else",
    },
  },
  calendar: {
    label: "Calendar connection",
    symptoms: {
      wont_connect: "Google Calendar won't connect",
      disconnected: "The calendar disconnected",
      bookings_missing: "Bookings aren't showing in the calendar",
      wrong_calendar: "Bookings go to the wrong calendar",
      other: "Something else",
    },
  },
  channel: {
    label: "A channel isn't live or isn't working",
    symptoms: {
      not_live_yet: "A channel isn't live yet",
      website_line_not_working: "The website line isn't working",
      meta_wont_connect: "Instagram or Messenger won't connect",
      whatsapp_payment_method: "WhatsApp's payment method",
      answers_wrong: "AYA's answers need correcting",
      other: "Something else",
    },
  },
  plan: {
    label: "Changing the plan",
    symptoms: {
      move_up_a_step: "Moving up a usage step",
      move_down_a_step: "Moving down a usage step",
      add_a_channel: "Adding a channel",
      add_a_location: "Adding a location",
      cancel: "Cancelling",
      other: "Something else",
    },
  },
  billing: {
    label: "Billing or an invoice",
    symptoms: {
      invoice_question: "A question about an invoice",
      payment_failed: "A payment failed",
      card_change: "Changing the card",
      refund_question: "A question about a refund",
      other: "Something else",
    },
  },
  transcript: {
    label: "Getting a transcript sent again",
    symptoms: {
      not_received: "A transcript didn't arrive",
      send_again_failed: "Send again didn't work",
      other: "Something else",
    },
  },
  sign_in: {
    label: "Signing in or devices",
    symptoms: {
      lost_device: "A device was lost or someone left",
      passkey_problem: "A passkey doesn't work",
      authenticator_problem: "The authenticator app doesn't work",
      sign_in_link_not_arriving: "Sign-in links don't arrive",
      other: "Something else",
    },
  },
  other: {
    label: "Something else",
    symptoms: { other: "Something else" },
  },
} as const;

export type EscalationTopic = keyof typeof ESCALATION_TOPICS;
export type EscalationSymptom = {
  [T in EscalationTopic]: keyof (typeof ESCALATION_TOPICS)[T]["symptoms"];
}[EscalationTopic];

export const TOPIC_IDS = Object.keys(ESCALATION_TOPICS) as EscalationTopic[];

/** Every symptom id across the topics, once each, in order: the tool schema's enum. */
export const SYMPTOM_IDS: readonly string[] = [
  ...new Set(TOPIC_IDS.flatMap((t) => Object.keys(ESCALATION_TOPICS[t].symptoms))),
];

export const PHONE_SYSTEMS = ["landline", "voip", "unknown"] as const;
export type PhoneSystemId = (typeof PHONE_SYSTEMS)[number];

/** What a field that does not apply is set to in the tool's input. */
export const NOT_APPLICABLE = "not_applicable";

/** Which extra fields each topic keeps; the rest are dropped whatever the model sent. */
const TOPIC_FIELDS: Readonly<
  Record<EscalationTopic, readonly ("carrier" | "phoneSystem" | "mode" | "channel")[]>
> = {
  forwarding: ["carrier", "phoneSystem", "mode"],
  calendar: [],
  channel: ["channel"],
  plan: ["channel"],
  billing: [],
  transcript: ["channel"],
  sign_in: [],
  other: [],
};

export type EscalationFields = {
  topic: EscalationTopic;
  symptom: string;
  carrier: Carrier | null;
  phoneSystem: PhoneSystemId | null;
  mode: CoverageModeId | null;
  channel: Channel | null;
};

export function isEscalationTopic(value: unknown): value is EscalationTopic {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(ESCALATION_TOPICS, value)
  );
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * The tool's input as an escalation, or null when the topic or the symptom
 * is not on its list. A field the topic does not use, or a value not on its
 * list, is dropped rather than refused: it was optional.
 */
export function readEscalation(input: unknown): EscalationFields | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const topic = raw.category;
  if (!isEscalationTopic(topic)) return null;
  const symptoms = Object.keys(ESCALATION_TOPICS[topic].symptoms);
  const symptom = oneOf(raw.symptom, symptoms);
  if (!symptom) return null;
  const fields =
    raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : {};
  const keep = new Set(TOPIC_FIELDS[topic]);
  return {
    topic,
    symptom,
    carrier: keep.has("carrier")
      ? oneOf(
          fields.carrier,
          CARRIERS.map((c) => c.id),
        )
      : null,
    phoneSystem: keep.has("phoneSystem") ? oneOf(fields.phone_system, PHONE_SYSTEMS) : null,
    mode: keep.has("mode")
      ? oneOf(
          fields.mode,
          COVERAGE_MODE_OPTIONS.map((m) => m.id),
        )
      : null,
    channel: keep.has("channel") ? oneOf(fields.channel, CHANNELS) : null,
  };
}

/** The escalation's fields in words, for the email to hello@ and the chat's confirmation. */
export function describeEscalation(fields: EscalationFields): (readonly [string, string])[] {
  const topic = ESCALATION_TOPICS[fields.topic];
  const rows: [string, string][] = [
    ["Topic", topic.label],
    ["What's wrong", (topic.symptoms as Record<string, string>)[fields.symptom] ?? fields.symptom],
  ];
  if (fields.carrier) {
    rows.push(["Carrier", CARRIERS.find((c) => c.id === fields.carrier)?.name ?? fields.carrier]);
  }
  if (fields.phoneSystem) {
    rows.push([
      "Phone system",
      fields.phoneSystem === "voip"
        ? "Cloud phone system"
        : fields.phoneSystem === "landline"
          ? "Landline"
          : "Not sure",
    ]);
  }
  if (fields.mode) {
    rows.push([
      "Which calls reach AYA",
      COVERAGE_MODE_OPTIONS.find((m) => m.id === fields.mode)?.label ?? fields.mode,
    ]);
  }
  if (fields.channel) rows.push(["Channel", CHANNEL_NAMES[fields.channel]]);
  return rows;
}

export function topicLabel(topic: string): string {
  return isEscalationTopic(topic) ? ESCALATION_TOPICS[topic].label : "Something else";
}

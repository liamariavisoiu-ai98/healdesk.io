import type Anthropic from "@anthropic-ai/sdk";
import { CARRIERS, CHANNELS, COVERAGE_MODE_OPTIONS } from "@healdesk/catalog";

import { NOT_APPLICABLE, PHONE_SYSTEMS, SYMPTOM_IDS, TOPIC_IDS } from "./escalation-fields";
import { LINK_TARGETS } from "./targets";

/**
 * The support chat's five tools (plan Part H; get_open_cases added by lane
 * P7b, design E5 §8 S8, owner D16): read-only, and none of them touches a
 * patient. Strict schemas, so every argument the model gives is one
 * of the listed values; the server checks each again before using it
 * (escalation-fields.ts, targets.ts).
 *
 * The list is fixed and in a fixed order: tools come before the system prompt
 * in the cached prefix, so a tool that changed from one request to the next
 * would cost the whole cache.
 */

const NO_INPUT: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export const SUPPORT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_account_state",
    description:
      "The practice's own account, as plain facts: setup and the build tracker, each channel's status and next step, the coverage mode, carrier and phone system, which numbers and switches are set, the calendar and payment connections, the package, plan start, auto-renew, the allowance switch, usage this period, and whether its email address takes mail. Call it before answering anything about this account.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "get_forwarding_steps",
    description:
      "The call forwarding codes for this practice's carrier, line and coverage mode, with the undo codes. Returns nothing until phone is ready for forwarding on healdesk's side, and only the undo steps once the service has ended.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "link_to",
    description:
      "Shows the person a button to a setting or a screen in this practice's portal. Use it whenever you tell them where something is.",
    input_schema: {
      type: "object",
      properties: {
        setting: {
          type: "string",
          enum: [...LINK_TARGETS],
          description:
            "A setting by its key (see the settings reference), or a screen: home, build_tracker, setup, settings, settings_channels, settings_talk, settings_calendar, settings_payments, settings_safety_net, settings_alerts, settings_sign_in, knowledge, conversations, bookings, billing.",
        },
      },
      required: ["setting"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_open_cases",
    description:
      "This practice's open support requests: the day each opened, its topic, where it stands and the day a person replies by. Never anyone's words. Call it before escalate_to_support.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "escalate_to_support",
    description:
      "Sends the healdesk team an email asking a person to reply to the practice: the category, what's wrong and the fields below, all picked from fixed lists, with the account's state. Never the chat's words. The practice is emailed the date of the reply. Use it when the person asks for a person or the problem can't be solved here.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...TOPIC_IDS],
          description:
            "forwarding (call forwarding), calendar (Google Calendar connection), channel (a channel isn't live or isn't working), plan (changing the plan), billing (billing or an invoice), transcript (getting a transcript sent again), sign_in (signing in or devices), other.",
        },
        symptom: {
          type: "string",
          enum: [...SYMPTOM_IDS],
          description: "What's wrong, from the category's own list; 'other' when none fits.",
        },
        fields: {
          type: "object",
          properties: {
            carrier: {
              type: "string",
              enum: [...CARRIERS.map((c) => c.id), NOT_APPLICABLE],
              description: "For forwarding only.",
            },
            phone_system: {
              type: "string",
              enum: [...PHONE_SYSTEMS, NOT_APPLICABLE],
              description: "For forwarding only: landline, voip (a cloud phone system) or unknown.",
            },
            mode: {
              type: "string",
              enum: [...COVERAGE_MODE_OPTIONS.map((m) => m.id), NOT_APPLICABLE],
              description: "For forwarding only: which calls reach AYA.",
            },
            channel: {
              type: "string",
              enum: [...CHANNELS, NOT_APPLICABLE],
              description: "For channel, plan and transcript: web, meta or voice.",
            },
          },
          required: ["carrier", "phone_system", "mode", "channel"],
          additionalProperties: false,
        },
      },
      required: ["category", "symptom", "fields"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export type SupportToolName =
  "get_account_state" | "get_forwarding_steps" | "link_to" | "get_open_cases" | "escalate_to_support";

import type { Channel } from "@healdesk/catalog";

import type { ConversationOutcome } from "@/lib/portal/conversation-words";

import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * I4 in Annex X5: "Each flag, and two flags in seven days", to ops
 * (HEALDESK_OPS_EMAIL). A clinic pressed "Flag this answer" on a
 * conversation in its portal (spec, "When the agent gets something wrong":
 * "The flag also opens an internal ticket. Two flags from one clinic in a
 * week is an alert, not a statistic"). One email per flag, sent once the
 * flag has been recorded (lib/ops/flag-alert.ts); the flag that makes it two
 * or more from the same clinic in seven days is the alert, and its subject
 * says so.
 *
 * Ids, counts and categories only, which the operator looks up in the
 * console: the clinic, the flag and the conversation by id, the channel, the
 * conversation's outcome, whether staff typed a correction, and how many
 * flags the clinic has raised in seven days. Never the correction's words or
 * anything the conversation said: a conversation's words are not kept, and
 * its transcript went to the clinic's own address, never to us. It links
 * nowhere, as I1 does: the console lives on the marketing site's origin, and
 * an email from apps/app links only to apps/app's public origin (X1.6).
 */

export type FlagAlertPayload = {
  flagId: string;
  clinicId: string;
  /** The id Conversations shows: a call's or web chat's row, or a Meta thread's conversation. */
  conversationId: string;
  /** The channel family: voice, web (website chat) or meta. */
  channel: Channel;
  /** The conversation's outcome when it was flagged; null for a Meta thread with none stored. */
  outcome: ConversationOutcome | null;
  /** Staff typed a correction, which is in the clinic's quick answers already. */
  hasCorrection: boolean;
  /** The clinic's flags in the seven days to this one, this one included. */
  flagsCount: number;
  flaggedAt: string;
};

/** Two flags from one clinic in seven days is the alert (spec). */
export const FLAG_ALERT_THRESHOLD = 2;

const CHANNEL_LABELS: Record<Channel, string> = {
  voice: "Phone",
  web: "Website chat",
  meta: "Instagram, Messenger or WhatsApp",
};

const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  answered: "Answered",
  booked: "Booked",
  request: "Booking request",
  handover: "Handover",
  urgent: "Urgent",
};

export const renderFlagAlert: EmailTemplate<FlagAlertPayload> = (payload, ctx) => {
  const alert = payload.flagsCount >= FLAG_ALERT_THRESHOLD;
  const correction = payload.hasCorrection
    ? "Staff typed a correction, screened as Knowledge screens a quick answer, which is already in the clinic's quick answers, and the practice questions run again on it. Read it in the clinic's knowledge in the console."
    : "Staff added no correction, so nothing in the clinic's knowledge has changed.";
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: alert
        ? `A clinic flagged one of AYA's answers: ${payload.flagsCount} flags from it in 7 days, this one included. Two in a week is an alert, not a statistic. Today, read the flagged conversations' outcomes and the clinic's knowledge in the console, decide whether the fix is the clinic's knowledge or AYA's own words, and write to the practice.`
        : "A clinic flagged one of AYA's answers in a conversation. Read the conversation's outcome and the clinic's knowledge in the console, and decide whether AYA's own words need a fix on our side.",
    },
    { type: "paragraph", text: correction },
    {
      type: "facts",
      rows: [
        ["Clinic id", payload.clinicId],
        ["Flag id", payload.flagId],
        ["Conversation id", payload.conversationId],
        ["Channel", CHANNEL_LABELS[payload.channel]],
        ["Outcome", payload.outcome ? OUTCOME_LABELS[payload.outcome] : "None stored"],
        ["Correction", payload.hasCorrection ? "Yes" : "No"],
        ["Flags in 7 days", String(payload.flagsCount)],
        ["Flagged", `${payload.flaggedAt.replace("T", " ").slice(0, 16)} UTC`],
      ],
    },
    {
      type: "paragraph",
      text: "The alert carries ids and counts only. The conversation's words are not kept: its transcript went to the clinic's own address, never to us.",
    },
  ];
  return compose(
    {
      subject: alert
        ? `healdesk ops: ${payload.flagsCount} flags in 7 days from one clinic`
        : "healdesk ops: a clinic flagged an answer",
      preheader: alert
        ? "Two flags from one clinic in a week is an alert. Look at both today."
        : "Look up the conversation's outcome and the clinic's knowledge.",
      blocks,
    },
    ctx,
  );
};

/** The payload the snapshot test and `npm run email:seed` render: the alert, the second flag in a week. */
export const FLAG_ALERT_FIXTURE: FlagAlertPayload = {
  flagId: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
  clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
  conversationId: "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b",
  channel: "voice",
  outcome: "answered",
  hasCorrection: true,
  flagsCount: 2,
  flaggedAt: "2026-10-06T14:32:00.000Z",
};

export const FLAG_ALERT_ENTRY: TemplateEntry<FlagAlertPayload> = {
  render: renderFlagAlert,
  fixture: FLAG_ALERT_FIXTURE,
};

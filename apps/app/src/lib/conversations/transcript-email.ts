import { SENDER_IDENTITY } from "@healdesk/catalog";

import { escapeHtml } from "@/lib/email/templates/compose";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import {
  getTransport,
  type DeliveryResult,
  type EmailTransport,
  type PhiClass,
} from "@/lib/reporting/deliver";
import { PhiRoutingError } from "@/lib/reporting/resend-transport";

/**
 * A conversation's transcript, emailed to the clinic when the conversation
 * ends, and kept nowhere by healdesk (the owner's decision of 13 October
 * 2026).
 *
 * ## What changed, and what did not
 *
 * Until now the transcript was to be stored, behind `conversations.transcript_uri`,
 * for the portal's Conversations screen and the 90-day clock. Instead the
 * words go to the clinic's own address once, and the conversation row keeps
 * only what is not words: the channel, the times, the outcome, when the
 * "I'm an AI, this call is transcribed" line played. Nothing here writes to
 * the database. The text exists in this process's memory for the length of
 * the send, and then in the clinic's inbox.
 *
 * The voice endpoint (Retell, not built) and the web chat's API (not built)
 * call `emailTranscriptToClinic()` when a conversation ends; nothing else
 * produces a transcript today. The Meta channels never do: healdesk keeps no
 * Meta message (BAA 1.3.0 clause 11), and this would be a way of keeping one.
 *
 * ## Why SES, and only SES
 *
 * The email carries patient information, so it is classed may-carry-phi, and
 * getTransport() sends that class through SES with a configuration set whose
 * TlsPolicy is REQUIRE, or refuses: never Resend, which signs no business
 * associate agreement. A receiving server that will not negotiate TLS gets
 * nothing; SES fails the delivery rather than send in the clear.
 *
 * ## What the email does not carry
 *
 * The subject and the preheader are fixed and say nothing about the person:
 * a subject shows on a locked phone. The reference is the conversation's id,
 * which names nobody. And it asks not to be replied to, because a reply would
 * send the transcript to hello@healdesk.io, which has no business associate
 * agreement behind it (packages/catalog/src/sender-identity.ts).
 *
 * ## When it cannot be delivered
 *
 * There is no stored copy to send again, so a failed send loses the
 * transcript. That is the trade the decision accepted. What is not lost is
 * the fact: each failure raises `transcript_undelivered` to ops with the
 * conversation's and the clinic's ids and SES's reason, never the words.
 */

/** The class every transcript email declares. One constant, used to route and to label. */
export const TRANSCRIPT_PHI_CLASS = "may-carry-phi" satisfies PhiClass;

/** The two channels that produce a transcript. Never the Meta channels: see the header. */
export type TranscriptChannel = "voice" | "web_chat";

export type TranscriptTurn = {
  /** Who spoke: the assistant, or the person who called or wrote. */
  speaker: "assistant" | "person";
  text: string;
};

export type TranscriptEmailInput = {
  /** conversations.id: the email's reference, and the ops alert's if it fails. */
  conversationId: string;
  clinic: {
    id: string;
    /** The practice's own name, as it gave it. Printed in the footer only. */
    name: string;
    /** IANA time zone, for the conversation's time. */
    timeZone: string;
  };
  channel: TranscriptChannel;
  startedAt: Date;
  turns: readonly TranscriptTurn[];
};

export type RenderedTranscriptEmail = { subject: string; text: string; html: string };

/** Fixed, and about nobody: the subject shows on a locked phone. */
export const TRANSCRIPT_SUBJECT = "Conversation transcript from your healdesk assistant";

const DO_NOT_REPLY =
  "Please don't reply to this email: a reply would send this transcript to healdesk's general inbox, which isn't meant to hold patient information.";

const KEEP_IT =
  "This email holds patient information. healdesk keeps no copy of it, so it is the only record of what was said: file it where your practice keeps patient records, and then delete it from this inbox.";

/** A conversation longer than this is cut, with a note, rather than refused. */
export const MAX_TRANSCRIPT_CHARACTERS = 200_000;

export class TranscriptEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptEmailError";
  }
}

function speakerLabel(speaker: TranscriptTurn["speaker"], channel: TranscriptChannel): string {
  if (speaker === "assistant") return "Assistant";
  return channel === "voice" ? "Caller" : "Visitor";
}

/**
 * Control characters other than a line break would be printed raw in the
 * text part and are meaningless in either; carriage returns become line
 * breaks.
 */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .trim();
}

function when(input: TranscriptEmailInput): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: input.clinic.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(input.startedAt);
}

/**
 * The email, in text and HTML. Pure: no clock, no environment, no database.
 * Every piece of the transcript is escaped in the HTML part, so nothing a
 * caller said can become markup or a link we made.
 */
export function renderTranscriptEmail(input: TranscriptEmailInput): RenderedTranscriptEmail {
  if (input.channel !== "voice" && input.channel !== "web_chat") {
    throw new TranscriptEmailError(
      `Refusing to email a transcript for channel "${String(input.channel)}": only calls and web chats are transcribed, and healdesk keeps no Meta message.`,
    );
  }
  if (Number.isNaN(input.startedAt.getTime())) {
    throw new TranscriptEmailError("The conversation's start time is not a date.");
  }

  const spoken = input.turns
    .map((turn) => ({ label: speakerLabel(turn.speaker, input.channel), text: clean(turn.text) }))
    .filter((turn) => turn.text.length > 0);
  if (spoken.length === 0) {
    throw new TranscriptEmailError("Refusing to email an empty transcript.");
  }

  let budget = MAX_TRANSCRIPT_CHARACTERS;
  const turns: { label: string; text: string }[] = [];
  for (const turn of spoken) {
    if (budget <= 0) break;
    const text = turn.text.length > budget ? turn.text.slice(0, budget) : turn.text;
    budget -= text.length;
    turns.push({ label: turn.label, text });
  }
  // Cut when a turn was left out, or the last one kept was shortened.
  const last = turns.length - 1;
  const cut = turns.length < spoken.length || turns[last]?.text.length !== spoken[last]?.text.length;

  const kind = input.channel === "voice" ? "call" : "web chat";
  const intro = `Your assistant's transcript of a ${kind} on ${when(input)}.`;
  const reference = `Reference: ${input.conversationId}`;
  const cutNote = "The transcript was longer than this email can carry and is cut here.";
  const why = `You get this email because ${input.clinic.name} uses healdesk's assistant, and each transcript goes to this address instead of being stored.`;

  const text = [
    intro,
    KEEP_IT,
    DO_NOT_REPLY,
    reference,
    "Transcript",
    turns.map((t) => `${t.label}: ${t.text}`).join("\n\n"),
    ...(cut ? [cutNote] : []),
    ["—", why, SENDER_IDENTITY.entityLine].join("\n"),
  ].join("\n\n");

  const paragraph = (value: string, style = "") =>
    `<p style="margin:0 0 12px;${style}">${escapeHtml(value).replace(/\n/g, "<br>")}</p>`;
  const html = [
    "<!doctype html>",
    '<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;">',
    paragraph(intro),
    paragraph(KEEP_IT, "font-weight:600;"),
    paragraph(DO_NOT_REPLY),
    paragraph(reference, "color:#555;font-size:13px;"),
    '<h2 style="font-size:16px;margin:20px 0 8px;">Transcript</h2>',
    ...turns.map(
      (t) =>
        `<p style="margin:0 0 10px;"><strong>${escapeHtml(t.label)}:</strong> ${escapeHtml(t.text).replace(/\n/g, "<br>")}</p>`,
    ),
    ...(cut ? [paragraph(cutNote, "font-style:italic;")] : []),
    '<hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">',
    paragraph(why, "color:#555;font-size:13px;"),
    paragraph(SENDER_IDENTITY.entityLine, "color:#555;font-size:13px;"),
    "</body></html>",
  ].join("\n");

  return { subject: TRANSCRIPT_SUBJECT, text, html };
}

export type EmailTranscriptOptions = {
  /** A fake in tests. Otherwise getTransport()'s choice for the PHI class: SES, or a refusal. */
  transport?: EmailTransport;
  /** A fake in tests. Otherwise notifyOps, which never throws. */
  notify?: typeof notifyOps;
};

export type TranscriptDelivery = {
  /** One result per address, in the order given. */
  results: DeliveryResult[];
  /** True when at least one address got it. */
  delivered: boolean;
};

/**
 * Email the transcript to the clinic's address (in v1 there is one, the
 * sign-in's: lib/billing/recipients.ts reads it inside the tenant context,
 * before this is called, so no transaction is held open across the send).
 *
 * Never throws for a delivery fact: a refused route (no SES on this
 * deployment), an address SES will not take or an SES error are each a
 * failed result and one ops alert. It throws only for what is a bug in the
 * caller: a Meta channel, an empty transcript, no address at all.
 */
export async function emailTranscriptToClinic(
  input: TranscriptEmailInput,
  to: readonly string[],
  options: EmailTranscriptOptions = {},
): Promise<TranscriptDelivery> {
  if (to.length === 0) {
    throw new TranscriptEmailError("Refusing to render a transcript with nowhere to send it.");
  }
  const rendered = renderTranscriptEmail(input);
  const ids = { conversationId: input.conversationId, clinicId: input.clinic.id, channel: input.channel };
  const notify = options.notify ?? notifyOps;

  let transport: EmailTransport;
  try {
    transport = options.transport ?? getTransport(TRANSCRIPT_PHI_CLASS);
  } catch (error) {
    // No covered route on this deployment. Nothing went anywhere.
    const reason =
      error instanceof PhiRoutingError
        ? "no SES configuration set: the transcript cannot be sent anywhere else"
        : error instanceof Error
          ? error.message
          : "no transport";
    log.error("transcript email refused", { ...ids, reason });
    await notify("transcript_undelivered", { ...ids, reason });
    return { results: to.map(() => ({ status: "failed", reason })), delivered: false };
  }

  const results: DeliveryResult[] = [];
  for (const address of to) {
    let result: DeliveryResult;
    try {
      result = await transport.send(
        { to: address, clinicId: input.clinic.id, clinicName: input.clinic.name },
        { ...rendered, phiClass: TRANSCRIPT_PHI_CLASS },
      );
    } catch (error) {
      result = { status: "failed", reason: error instanceof Error ? error.message : "send failed" };
    }
    results.push(result);
    if (result.status === "sent") {
      log.info("transcript emailed", { ...ids, transport: transport.name, status: "sent" });
    } else {
      log.error("transcript email failed", { ...ids, transport: transport.name, status: result.status, reason: result.reason });
      await notify("transcript_undelivered", { ...ids, status: result.status, reason: result.reason });
    }
  }
  return { results, delivered: results.some((r) => r.status === "sent") };
}

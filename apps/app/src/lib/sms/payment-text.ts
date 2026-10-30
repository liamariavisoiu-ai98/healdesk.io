import { createHash } from "node:crypto";

import { toE164 } from "@healdesk/connectors";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type Stripe from "stripe";

import { appointments, billingNotices, paymentLinkTexts, type PaymentLinkTextFailure } from "@/db/schema";
import type { BookingToolState, ToolTurn } from "@/lib/assistant/booking-tools";
import type { ActorContext } from "@/lib/audit";
import { createDepositLink, type DepositLinkResult } from "@/lib/billing/deposit-link";
import { canSendPaymentLinkText } from "@/lib/compliance/contact-policy";
import { describeError, log } from "@/lib/log";
import { dedupeKey, notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { notifyOps } from "@/lib/ops/notify";
import { paymentLinkTextOffered } from "@/lib/portal/switch-resets";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { spokenPhone } from "@/lib/voice/spoken";
import { voiceRealCallsAllowed } from "@/lib/voice/test-calls";

import { agreementCoversText } from "./agreement";
import { smsSenderConfigured } from "./config";
import { paymentLinkTextBody, sendPaymentLinkText, type SmsSendResult, type SmsTransport } from "./send";

/**
 * The payment-link text after a call, in the fixed tool layer (owner, 28 and
 * 30 October 2026; spec, "Payment by text after a call, and full payment";
 * CLAUDE.md, "Inbound only": the one designed exception).
 *
 * Deterministic code decides every step; the model never sends, and its
 * prose is never read for a decision. After a booking written on a call
 * whose deposit is left to the front desk, and only while
 * paymentLinkTextOffered holds (the text's checks, real calls, and an
 * accepted agreement that covers the text: BAA 1.6.0 or DPA 1.1.0 and
 * later, agreementCoversText), the booked line gains the fixed offer. From then on
 * the call's turns read three fields of the model's structured `state`
 * (`paymentText`): `agreed` (the caller's yes or no to the text), `number`
 * (the digits the caller said) and `confirmed` (their yes to the number read
 * back). The stages:
 *
 *   offered     yes: ask for the number (ASK_NUMBER); no: recorded
 *               `declined`, never offered again; neither, twice: dropped.
 *   number      a number: read back word for word by this code
 *               (readBack), never by the model.
 *   confirming  `confirmed` true on the turn right after the read-back of
 *               that same number: sent; false, or a new number: asked again.
 *   done        nothing more, ever, on this call.
 *
 * The send (sendOnce): the ledger row is written `queued` under the
 * appointment's unique key BEFORE anything leaves, so a retried tool call, a
 * reconnect or a duplicate event finds it and gets the first outcome back;
 * the clinic's own Stripe link is made by createDepositLink (channel
 * `voice`, the chat's refusals); the contact policy's one-text gate
 * (canSendPaymentLinkText) passes it; AWS is asked once; the row is settled.
 * The number is used for that one request and kept nowhere: not in the
 * ledger, not in a log.
 *
 * A text that does not go never undoes the booking: the deposit stays with
 * the front desk (`pending_front_desk` and its deposit_to_collect alert,
 * exactly as for any call booking with a deposit; set here only if the
 * booking somehow was not), the caller hears it on the call, and ops are
 * told by code, with no patient detail, unless the cause is the caller's
 * own (opted out, a number AWS refused).
 *
 * Staff are never told to collect a deposit the caller was texted a link
 * for. The booking's deposit_to_collect email (L10), queued when the call
 * booked it, is held while the text is offered (DESK_ALERT_HOLD_MS) and
 * released at once on any outcome but a send. When a text is sent the
 * booking's deposit moves to `pending_link` ("Deposit not paid yet" on
 * Bookings, not counted as one to collect), and the held L10 is closed
 * unsent when it comes due (lib/email/superseded.ts). If the texted link
 * then lapses unpaid, the deposit returns to the front desk with an L10 of
 * its own (flagForFrontDesk, keyed by the link).
 */

/** How long the booking's L10 waits while the caller is offered the text. */
export const DESK_ALERT_HOLD_MS = 5 * 60_000;

const ACTOR: ActorContext = { type: "agent", serviceName: "payment-link-text" };

/** Where the text stands on this call. In the call's memory only. */
export type PaymentTextState = {
  stage: "offered" | "number" | "confirming" | "done";
  appointmentId: string;
  /** The E.164 number being read back, or null. Never stored or logged. */
  number: string | null;
  /** When the caller said yes, ISO; null until they do. */
  optedInAt: string | null;
  /** Turns without an answer to the offer. */
  unanswered: number;
};

export type PaymentTextLines = {
  offer: string;
  askNumber: string;
  readBack: (spoken: string) => string;
  askAgain: string;
  sent: string;
  notSent: string;
  /** AWS did not answer in time: the text may have gone, so nothing is promised either way. */
  unsure: string;
  optedOut: string;
  declined: string;
};

export const PAYMENT_TEXT_LINES_EN: PaymentTextLines = {
  offer: "If you'd rather pay it now, I can text you a secure link to pay the deposit. Would you like that?",
  askNumber: "Sure. What's the mobile number I should text it to?",
  readBack: (spoken) => `That's ${spoken}. Is that right?`,
  askAgain: "No problem. What's the right mobile number?",
  sent: "Done. The secure link is on its way by text.",
  notSent: "Sorry, I couldn't send that text. Your booking stands, and the front desk will call you about the deposit.",
  unsure:
    "Sorry, I couldn't confirm that the text went through. Your booking stands, and the front desk will check whether the deposit is paid and call you if it isn't.",
  optedOut:
    "That number has opted out of our texts, so I can't send it there. Your booking stands, and the front desk will call you about the deposit.",
  declined: "No problem. The front desk will call you about the deposit.",
};

export const PAYMENT_TEXT_LINES_ES: PaymentTextLines = {
  offer: "Si prefiere pagarlo ahora, puedo enviarle por mensaje de texto un enlace seguro para pagar el depósito. ¿Le gustaría?",
  askNumber: "Claro. ¿A qué número de celular se lo envío?",
  readBack: (spoken) => `Es el ${spoken}. ¿Es correcto?`,
  askAgain: "No hay problema. ¿Cuál es el número de celular correcto?",
  sent: "Listo. El enlace seguro va en camino por mensaje de texto.",
  notSent: "Lo siento, no pude enviar ese mensaje. Su cita sigue en pie, y la recepción le llamará por el depósito.",
  unsure:
    "Lo siento, no pude confirmar que el mensaje se envió. Su cita sigue en pie, y la recepción verificará si el depósito está pagado y le llamará si no lo está.",
  optedOut:
    "Ese número pidió no recibir nuestros mensajes, así que no puedo enviarlo ahí. Su cita sigue en pie, y la recepción le llamará por el depósito.",
  declined: "No hay problema. La recepción le llamará por el depósito.",
};

export function paymentTextLines(language: "en" | "es" = "en"): PaymentTextLines {
  return language === "es" ? PAYMENT_TEXT_LINES_ES : PAYMENT_TEXT_LINES_EN;
}

/** The note for the model while the text is in play: what to put in its state, and that it never says a text was sent. */
export function paymentTextNote(state: PaymentTextState): string {
  const ask =
    state.stage === "offered"
      ? `You just offered to text the caller a secure link to pay the deposit. If they answer, set "agreed" to true for a clear yes or false for a no.`
      : state.stage === "number"
        ? `The caller agreed to the deposit link by text and was asked for a mobile number. When they say one, put its digits in "number" exactly as they said them.`
        : `The caller's number was just read back to them. Set "confirmed" to true if they say it is right, false if not; if they give a different number, put its digits in "number".`;
  return `${ask} Add to your JSON: "state": {"paymentText": {"agreed": true, false or null, "number": "", "confirmed": true, false or null}}. Never say a text was sent or will be sent, and never read a number back yourself: the system does both.`;
}

/** The three fields of the model's state, read strictly: anything but a boolean is no answer. */
export function paymentTextAnswer(state: Record<string, unknown> | null | undefined): {
  agreed: boolean | null;
  number: string | null;
  confirmed: boolean | null;
} {
  const raw = state && typeof state === "object" ? (state as { paymentText?: unknown }).paymentText : null;
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown) => (v === true ? true : v === false ? false : null);
  const digits = typeof p.number === "string" ? p.number.replace(/[^\d+]/g, "").slice(0, 16) : "";
  return { agreed: bool(p.agreed), number: digits.length >= 10 ? digits : null, confirmed: bool(p.confirmed) };
}

/** A number the toll-free sender can text: US or Canada, E.164. */
export function textableNumber(raw: string | null): string | null {
  const e164 = raw ? toE164(raw) : undefined;
  return e164 && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164) ? e164 : null;
}

/** The call as the ledger keeps it: never Retell's id itself. */
export function callRefHash(callId: string): string {
  return createHash("sha256").update(`healdesk payment text v1:retell:${callId}`).digest("hex");
}

/** What a send came to, for the line said and the tests. */
export type PaymentTextOutcome = "sent" | "failed" | "unknown" | "opted_out" | "declined";

export type PaymentTextDeps = {
  /** paymentLinkTextOffered, unless a test passes its own. */
  offered?: (tx: TenantTx) => Promise<boolean>;
  /** The AWS transport; the SDK unless a test passes a fake. */
  transport?: SmsTransport;
  /** The send's deadline (SMS_SEND_DEADLINE_MS), for tests. */
  smsDeadlineMs?: number;
  /** The sender's config, for tests; process.env otherwise. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Real calls allowed (lib/voice/test-calls.ts), for tests; HEALDESK_VOICE_REAL_CALLS otherwise. */
  realCalls?: boolean;
  stripe?: Stripe;
  createLink?: typeof createDepositLink;
  notify?: typeof notifyOps;
};

export type PaymentTextTools = {
  /** After a turn the booking tools answered: the booked line, with the offer when it may be made. */
  offerAfterBooking(turn: ToolTurn, now: Date, language?: "en" | "es"): Promise<ToolTurn>;
  /** Whether the text is in play on this turn: the model is told so, and its reply is not spoken before the step. */
  live(state: BookingToolState): boolean;
  /** The model's note while the text is in play (paymentTextNote); null otherwise. */
  note(state: BookingToolState): string | null;
  /**
   * One turn of the text: what the model's state said, and the line said in
   * place of its words, or null when its own reply stands. Always returns the
   * state to keep.
   */
  step(input: {
    state: BookingToolState;
    answer: Record<string, unknown> | null | undefined;
    now: Date;
    language?: "en" | "es";
  }): Promise<{ reply: string | null; state: BookingToolState }>;
};

export function paymentTextTools(context: { clinicId: string; callId: string; actor?: ActorContext }, deps: PaymentTextDeps = {}): PaymentTextTools {
  const actor = context.actor ?? ACTOR;
  const ref = callRefHash(context.callId);
  const realCalls = () => deps.realCalls ?? voiceRealCallsAllowed();
  const offered = deps.offered ?? ((tx: TenantTx) => paymentLinkTextOffered(tx, { senderReady: smsSenderConfigured(deps.env), realCalls: realCalls() }));

  /** The booking's deposit is owed and with the front desk, and nothing was texted for it yet. */
  async function mayOffer(appointmentId: string): Promise<boolean> {
    // The two facts that are config, not the clinic's, answered before any
    // row is read: with no texting number or in test-calls-only mode (CI,
    // and every environment until the owner's steps), nothing is opened.
    if (!deps.offered && !(smsSenderConfigured(deps.env) && realCalls())) return false;
    try {
      return await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        // The agreement is asked here as well as inside paymentLinkTextOffered,
        // so no injected readiness can skip it: no clinic on an agreement
        // older than BAA 1.6.0 or DPA 1.1.0 has a caller offered a text.
        if (!(await offered(tx)) || !(await agreementCoversText(tx))) return false;
        const [appt] = await tx.db
          .select({ status: appointments.depositStatus, usd: appointments.depositUsd })
          .from(appointments)
          .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
          .limit(1);
        if (!appt || appt.status !== "pending_front_desk" || !(Number(appt.usd ?? 0) > 0)) return false;
        const [row] = await tx.db
          .select({ id: paymentLinkTexts.id })
          .from(paymentLinkTexts)
          .where(eq(paymentLinkTexts.appointmentId, appointmentId))
          .limit(1);
        return !row;
      });
    } catch (error) {
      log.warn("payment-link text not offered: readiness could not be read", { clinicId: context.clinicId, error: describeError(error) });
      return false;
    }
  }

  /**
   * Move the booking's still-unsent deposit_to_collect email (L10) to `at`:
   * later while the text is offered, now again once it will not be sent.
   * Ids only; a failure leaves the email as it was queued.
   */
  async function deskAlertDueAt(appointmentId: string, at: Date): Promise<void> {
    try {
      await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        await tx.db
          .update(billingNotices)
          .set({ sendAfter: at })
          .where(
            and(
              eq(billingNotices.clinicId, tx.clinicId),
              eq(billingNotices.kind, "deposit_to_collect"),
              eq(billingNotices.dedupeKey, dedupeKey("deposit_to_collect", { appointmentId })),
              isNull(billingNotices.sentAt),
            ),
          );
      });
    } catch (error) {
      log.warn("payment-link text: the deposit alert's time was not moved", { clinicId: context.clinicId, error: describeError(error) });
    }
  }

  async function offerAfterBooking(turn: ToolTurn, now: Date, language: "en" | "es" = "en"): Promise<ToolTurn> {
    if (!turn.bookingWritten || !turn.appointmentId || turn.state.text) return turn;
    if (!(await mayOffer(turn.appointmentId))) return turn;
    await deskAlertDueAt(turn.appointmentId, new Date(now.getTime() + DESK_ALERT_HOLD_MS));
    const text: PaymentTextState = { stage: "offered", appointmentId: turn.appointmentId, number: null, optedInAt: null, unanswered: 0 };
    return { ...turn, reply: `${turn.reply} ${paymentTextLines(language).offer}`, state: { ...turn.state, text } };
  }

  function live(state: BookingToolState): boolean {
    return Boolean(state.text && state.text.stage !== "done");
  }

  async function recordDeclined(appointmentId: string, now: Date): Promise<void> {
    try {
      await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        await tx.db
          .insert(paymentLinkTexts)
          .values({ clinicId: tx.clinicId, appointmentId, callRefHash: ref, status: "declined", createdAt: now, settledAt: now })
          .onConflictDoNothing({ target: paymentLinkTexts.appointmentId });
      });
    } catch (error) {
      // Nothing to undo: no text goes either way.
      log.warn("payment-link text decline not recorded", { clinicId: context.clinicId, error: describeError(error) });
    }
    // No text: the front desk hears of the deposit now, not when the hold ends.
    await deskAlertDueAt(appointmentId, now);
  }

  async function step(input: Parameters<PaymentTextTools["step"]>[0]): Promise<{ reply: string | null; state: BookingToolState }> {
    const { now } = input;
    const L = paymentTextLines(input.language);
    const text = input.state.text;
    if (!text || text.stage === "done") return { reply: null, state: input.state };
    const keep = (next: PaymentTextState, reply: string | null) => ({ reply, state: { ...input.state, text: next } });
    const done = (reply: string | null) => keep({ ...text, stage: "done", number: null }, reply);
    const answer = paymentTextAnswer(input.answer);
    // Every turn the text is still in play pushes the booking's held L10 on,
    // so a slow caller never lets the "collect" email go while the text may
    // still be sent; any outcome but a send releases it below.
    await deskAlertDueAt(text.appointmentId, new Date(now.getTime() + DESK_ALERT_HOLD_MS));

    if (answer.agreed === false && text.stage !== "confirming") {
      await recordDeclined(text.appointmentId, now);
      return done(L.declined);
    }

    if (text.stage === "offered") {
      if (answer.agreed !== true) {
        // Not answered: the model's reply stands; after two such turns the offer lapses as a no.
        if (text.unanswered + 1 >= 2) {
          await recordDeclined(text.appointmentId, now);
          return done(null);
        }
        return keep({ ...text, unanswered: text.unanswered + 1 }, null);
      }
      const optedInAt = now.toISOString();
      const number = textableNumber(answer.number);
      if (number) return keep({ ...text, stage: "confirming", number, optedInAt }, L.readBack(spokenPhone(number, input.language)));
      return keep({ ...text, stage: "number", optedInAt }, L.askNumber);
    }

    if (text.stage === "number") {
      const number = textableNumber(answer.number);
      if (!number) return keep(text, answer.number ? L.askAgain : null);
      return keep({ ...text, stage: "confirming", number }, L.readBack(spokenPhone(number, input.language)));
    }

    // confirming: a new number is read back again; a no asks again; only a yes to THIS read-back sends.
    const fresh = textableNumber(answer.number);
    if (fresh && fresh !== text.number) {
      return keep({ ...text, number: fresh }, L.readBack(spokenPhone(fresh, input.language)));
    }
    if (answer.confirmed === false) return keep({ ...text, stage: "number", number: null }, L.askAgain);
    if (answer.confirmed !== true || !text.number || !text.optedInAt) return { reply: null, state: input.state };

    const outcome = await sendOnce({
      appointmentId: text.appointmentId,
      to: text.number,
      optedInAt: new Date(text.optedInAt),
      confirmedAt: now,
      now,
    });
    return done(
      outcome === "sent"
        ? L.sent
        : outcome === "opted_out"
          ? L.optedOut
          : outcome === "declined"
            ? L.declined
            : outcome === "unknown"
              ? L.unsure
              : L.notSent,
    );
  }

  /** The one send for the booking. Never throws; returns where it ended (or had ended before). */
  async function sendOnce(input: { appointmentId: string; to: string; optedInAt: Date; confirmedAt: Date; now: Date }): Promise<PaymentTextOutcome> {
    const { appointmentId, now } = input;
    // 1. Claim the booking's one text, or find the claim already made.
    let claimed: { id: string } | null;
    let earlier: PaymentTextOutcome | null = null;
    let inFlight = false;
    try {
      ({ claimed, earlier, inFlight } = await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        // At send time, again: the agreement in effect may have changed since the offer.
        if (!(await offered(tx)) || !(await agreementCoversText(tx))) return { claimed: null, earlier: "failed" as const, inFlight: false };
        // The front desk was already emailed to collect this deposit (or the
        // email is being sent): a text now could have it collected twice.
        // The deposit stays theirs, and no text goes.
        const [desk] = await tx.db
          .select({ sentAt: billingNotices.sentAt, recipients: billingNotices.recipientsCount, attempts: billingNotices.attempts })
          .from(billingNotices)
          .where(
            and(
              eq(billingNotices.clinicId, tx.clinicId),
              eq(billingNotices.kind, "deposit_to_collect"),
              eq(billingNotices.dedupeKey, dedupeKey("deposit_to_collect", { appointmentId })),
            ),
          )
          .limit(1);
        if (desk && (desk.sentAt ? (desk.recipients ?? 1) > 0 : desk.attempts > 0)) {
          log.info("payment-link text not sent: the front desk was already told to collect", { clinicId: tx.clinicId });
          return { claimed: null, earlier: "failed" as const, inFlight: false };
        }
        const [row] = await tx.db
          .insert(paymentLinkTexts)
          .values({
            clinicId: tx.clinicId,
            appointmentId,
            callRefHash: ref,
            status: "queued",
            optedInAt: input.optedInAt,
            confirmedAt: input.confirmedAt,
            createdAt: now,
          })
          .onConflictDoNothing({ target: paymentLinkTexts.appointmentId })
          .returning({ id: paymentLinkTexts.id });
        if (row) {
          tx.audit.record({ action: "create", resourceType: "payment_link_text", resourceId: row.id, metadata: { outcome: "queued" } });
          return { claimed: row, earlier: null, inFlight: false };
        }
        const [existing] = await tx.db
          .select({ status: paymentLinkTexts.status, code: paymentLinkTexts.failureCode })
          .from(paymentLinkTexts)
          .where(eq(paymentLinkTexts.appointmentId, appointmentId))
          .limit(1);
        // queued: another attempt holds it, and its outcome is unknown here; never a second send.
        const status = existing?.status ?? "failed";
        return {
          claimed: null,
          earlier:
            status === "queued"
              ? ("failed" as const)
              : existing?.code === "unknown"
                ? ("unknown" as const)
                : (status as PaymentTextOutcome),
          inFlight: status === "queued",
        };
      }));
    } catch (error) {
      log.error("payment-link text not claimed", { clinicId: context.clinicId, error: describeError(error) });
      await toFrontDesk(appointmentId, "error", now);
      return "failed";
    }
    if (!claimed) {
      // An attempt still in flight owns the outcome, the deposit's state and
      // the held L10 with it: this one changes nothing.
      if (earlier !== "sent" && earlier !== "unknown" && !inFlight) await toFrontDesk(appointmentId, null, now);
      // The first attempt may still send it: never tell the caller it failed.
      if (inFlight) return "unknown";
      return earlier ?? "failed";
    }

    // 2. The clinic's own checkout link, with the chat's refusals.
    let link: DepositLinkResult;
    try {
      link = await (deps.createLink ?? createDepositLink)(context.clinicId, appointmentId, {
        channel: "voice",
        now,
        ...(deps.stripe ? { stripe: deps.stripe } : {}),
      });
    } catch (error) {
      log.error("payment-link text: deposit link failed", { clinicId: context.clinicId, error: describeError(error) });
      link = { status: "unavailable", reason: "stripe_error" };
    }
    if (link.status !== "open") {
      await settle(claimed.id, { status: "failed", failureCode: "link_unavailable" }, now);
      await toFrontDesk(appointmentId, "link_unavailable", now);
      return "failed";
    }

    // 3. The contact policy's one-text gate, on the exact words about to leave,
    // with the ledger read again now: the booking's row must still be this
    // attempt's own claim, still queued. Anything else (settled meanwhile, or
    // unreadable) is "already texted", and nothing leaves.
    const body = paymentLinkTextBody(link.url);
    let alreadyTexted = true;
    try {
      alreadyTexted = await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        const [row] = await tx.db
          .select({ id: paymentLinkTexts.id, status: paymentLinkTexts.status })
          .from(paymentLinkTexts)
          .where(eq(paymentLinkTexts.appointmentId, appointmentId))
          .limit(1);
        return !(row && row.id === claimed.id && row.status === "queued");
      });
    } catch (error) {
      log.error("payment-link text: the ledger could not be read before the send", { clinicId: context.clinicId, error: describeError(error) });
    }
    const decision = canSendPaymentLinkText({
      channel: "sms",
      purpose: "payment_link_text",
      body,
      link: link.url,
      bookedOnThisCall: true,
      optedInAt: input.optedInAt,
      confirmedAt: input.confirmedAt,
      alreadyTexted,
      now,
    });
    if (!decision.allowed) {
      log.warn("payment-link text refused by the contact policy", { clinicId: context.clinicId, code: decision.code });
      await settle(claimed.id, { status: "failed", failureCode: "refused", depositPaymentId: link.depositId }, now);
      await toFrontDesk(appointmentId, "refused", now);
      return "failed";
    }

    // 4. Once, to AWS.
    const sent: SmsSendResult = await sendPaymentLinkText({
      to: input.to,
      url: link.url,
      ...(deps.transport ? { transport: deps.transport } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.smsDeadlineMs ? { deadlineMs: deps.smsDeadlineMs } : {}),
    });
    if (sent.status === "sent") {
      await settle(claimed.id, { status: "sent", awsMessageId: sent.messageId, depositPaymentId: link.depositId }, now);
      log.info("payment-link text sent", { clinicId: context.clinicId });
      return "sent";
    }
    if (sent.code === "opted_out") {
      await settle(claimed.id, { status: "opted_out", depositPaymentId: link.depositId }, now);
      await toFrontDesk(appointmentId, null, now);
      return "opted_out";
    }
    if (sent.code === "unknown") {
      // AWS may have accepted it: the texted link may be paid. The front desk
      // is told to check Stripe before collecting, never plainly to collect.
      await settle(claimed.id, { status: "failed", failureCode: "unknown", depositPaymentId: link.depositId }, now);
      await toFrontDeskMaybePaid(appointmentId, now);
      return "unknown";
    }
    await settle(claimed.id, { status: "failed", failureCode: sent.code, depositPaymentId: link.depositId }, now);
    // A number AWS refused is the caller's; the rest are ours to look at.
    await toFrontDesk(appointmentId, sent.code === "invalid_number" ? null : sent.code, now);
    return "failed";
  }

  async function settle(
    id: string,
    to: { status: "sent" | "failed" | "opted_out"; failureCode?: PaymentLinkTextFailure; awsMessageId?: string; depositPaymentId?: string },
    now: Date,
  ): Promise<void> {
    try {
      await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        await tx.db
          .update(paymentLinkTexts)
          .set({
            status: to.status,
            failureCode: to.failureCode ?? null,
            awsMessageId: to.awsMessageId ?? null,
            depositPaymentId: to.depositPaymentId ?? null,
            settledAt: now,
          })
          .where(and(eq(paymentLinkTexts.id, id), eq(paymentLinkTexts.status, "queued")));
        tx.audit.record({
          action: "update",
          resourceType: "payment_link_text",
          resourceId: id,
          metadata: { outcome: to.status, ...(to.failureCode ? { code: to.failureCode } : {}) },
        });
      });
    } catch (error) {
      // The row stays queued: no second send can ever claim it, and when the
      // booking's held L10 comes due the outbox treats the outcome as unknown
      // and sends the possibly-paid alert (lib/email/superseded.ts).
      log.error("payment-link text outcome not recorded; the row stays queued", {
        clinicId: context.clinicId,
        outcome: to.status,
        ...(to.failureCode ? { code: to.failureCode } : {}),
        error: describeError(error),
      });
    }
  }

  /**
   * The text did not go: the deposit is the front desk's, as for any call
   * booking with a deposit, and ops hear of a cause that is ours.
   */
  async function toFrontDesk(appointmentId: string, opsCode: string | null, now: Date): Promise<void> {
    try {
      await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        const moved = await tx.db
          .update(appointments)
          .set({ depositStatus: "pending_front_desk" })
          .where(
            and(
              eq(appointments.id, appointmentId),
              eq(appointments.clinicId, tx.clinicId),
              inArray(appointments.depositStatus, ["none", "pending_link"]),
            ),
          )
          .returning({ id: appointments.id });
        if (moved.length > 0) {
          tx.audit.record({ action: "update", resourceType: "appointment", resourceId: appointmentId, metadata: { outcome: "deposit_to_front_desk", reason: "payment_text" } });
          await notifyBookingAlert(tx, "deposit_to_collect", { appointmentId });
        }
      });
    } catch (error) {
      log.error("payment-link text: deposit not handed to the front desk", { clinicId: context.clinicId, error: describeError(error) });
    }
    // The L10 held while the text was offered goes now.
    await deskAlertDueAt(appointmentId, now);
    if (opsCode) await (deps.notify ?? notifyOps)("payment_text_not_sent", { clinicId: context.clinicId, code: opsCode });
  }

  /**
   * The text may have gone (no answer from AWS in time): the deposit is the
   * front desk's, with the possibly-paid L10 (its own key, ":unchecked"),
   * whose email says to check Stripe before asking for the deposit. The
   * plain L10 held while the text was offered is closed unsent, as the
   * outbox closes a superseded notice, so staff are never told plainly to
   * collect a deposit that may already be paid. Ids only.
   */
  async function toFrontDeskMaybePaid(appointmentId: string, now: Date): Promise<void> {
    try {
      await withTenant({ clinicId: context.clinicId, actor }, async (tx) => {
        const moved = await tx.db
          .update(appointments)
          .set({ depositStatus: "pending_front_desk" })
          .where(
            and(
              eq(appointments.id, appointmentId),
              eq(appointments.clinicId, tx.clinicId),
              inArray(appointments.depositStatus, ["none", "pending_link"]),
            ),
          )
          .returning({ id: appointments.id });
        if (moved.length > 0) {
          tx.audit.record({ action: "update", resourceType: "appointment", resourceId: appointmentId, metadata: { outcome: "deposit_to_front_desk", reason: "payment_text_unknown" } });
        }
        await notifyBookingAlert(tx, "deposit_to_collect", { appointmentId, mayBePaid: true });
        await tx.db
          .update(billingNotices)
          .set({ sentAt: now, recipientsCount: 0, lastError: "not sent: the payment-link text may have gone; the possibly-paid alert replaces it" })
          .where(
            and(
              eq(billingNotices.clinicId, tx.clinicId),
              eq(billingNotices.kind, "deposit_to_collect"),
              eq(billingNotices.dedupeKey, dedupeKey("deposit_to_collect", { appointmentId })),
              isNull(billingNotices.sentAt),
            ),
          );
      });
    } catch (error) {
      log.error("payment-link text: a possibly-sent text not handed to the front desk", { clinicId: context.clinicId, error: describeError(error) });
    }
    await (deps.notify ?? notifyOps)("payment_text_not_sent", { clinicId: context.clinicId, code: "unknown" });
  }

  const note = (state: BookingToolState) => (live(state) ? paymentTextNote(state.text!) : null);

  return { offerAfterBooking, live, note, step };
}

import { randomUUID } from "node:crypto";

import { SENDER_IDENTITY } from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import { assertPayloadAllowed, printableClinicName } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import {
  renderSupportEscalation,
  SUPPORT_REASON,
  type SupportEscalationPayload,
} from "@/lib/email/templates/support_escalation";
import type { SupportRequestPayload } from "@/lib/email/templates/support_request";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { replyByDay } from "@/lib/reply-by";
import { helpContacts } from "@/lib/setup/help";
import { withTenant } from "@/lib/tenant";

import type { AccountState } from "./account-state";
import { readEscalation, type EscalationFields } from "./escalation-fields";
import type { SupportLimiter } from "./limits";

/**
 * `escalate_to_support(category, fields)` (plan Part H; spec: "Escalates to a
 * person by email with the account context attached, and says plainly when
 * it is doing that").
 *
 *   1. The topic and fields are read against their fixed lists
 *      (escalation-fields.ts); anything else is refused.
 *   2. The clinic's and the device's escalation limits are taken.
 *   3. I3 goes to hello@: the topic, the fields, get_account_state's output
 *      and the request's id, reply-to the clinic's address, keyed
 *      `hd-support_escalation-<id>-1`. Never the chat's words: nothing here
 *      is given them. No `clinic` tag, because the mail goes to our inbox and
 *      a bounce from it says nothing about the clinic's address.
 *   4. Only once I3 has gone, L25 ("We've got your request", with the reply
 *      date) is queued to the clinic's address through the outbox, deduped on
 *      the same id. The clinic is never told a person will reply to a request
 *      no person received.
 *
 * Nothing else is kept: the outbox row is L25's own, and it holds the id, the
 * topic and a date. Every log line carries ids and the topic only.
 */

export type EscalationResult =
  | { status: "sent"; requestId: string; topic: string; replyByOn: string; to: string | null }
  | { status: "invalid" }
  | { status: "limited" }
  | { status: "failed" };

export type EscalationContext = {
  clinicId: string;
  deviceKey: string;
  actor: ActorContext;
  limiter: SupportLimiter;
  /** Reads the account at the moment of escalating. */
  readAccount: () => Promise<{ account: AccountState; address: string | null } | null>;
  email?: SendEmailOptions;
  now?: Date;
  /** For the tests; a random uuid otherwise. */
  newId?: () => string;
};

/** Where escalations go: healdesk's one inbox (Annex X2, "hello@ stays the one inbox"). */
export const SUPPORT_INBOX = SENDER_IDENTITY.replyTo;

export async function escalateToSupport(
  ctx: EscalationContext,
  input: unknown,
): Promise<EscalationResult> {
  const fields = readEscalation(input);
  if (!fields) return { status: "invalid" };
  const now = ctx.now ?? new Date();
  if (!ctx.limiter.take("escalation", ctx.clinicId, ctx.deviceKey, now.getTime())) {
    log.warn("support escalation limited", { clinicId: ctx.clinicId });
    return { status: "limited" };
  }

  const requestId = (ctx.newId ?? randomUUID)();
  try {
    const read = await ctx.readAccount();
    if (!read || read.account.isClosed) return { status: "failed" };
    const replyByOn = replyByDay(now);
    const sent = await sendEscalation(fields, read.account, {
      requestId,
      replyByOn,
      replyTo: read.address,
      email: ctx.email,
      now,
    });
    if (!sent) return { status: "failed" };

    let acknowledged = false;
    if (read.address) {
      acknowledged = await queueAcknowledgement(ctx, {
        requestId,
        topic: fields.topic,
        replyByOn,
        helpPhoneE164: helpContacts().phoneE164,
      });
    }
    log.info("support escalation sent", {
      clinicId: ctx.clinicId,
      requestId,
      code: fields.topic,
      outcome: acknowledged ? "acknowledged" : "not_acknowledged",
    });
    return {
      status: "sent",
      requestId,
      topic: fields.topic,
      replyByOn,
      to: acknowledged ? read.address : null,
    };
  } catch (error) {
    log.error("support escalation failed", {
      clinicId: ctx.clinicId,
      requestId,
      error: describeError(error),
    });
    return { status: "failed" };
  }
}

/** I3 to hello@. True once the transport took it (or, outside production, logged it). */
async function sendEscalation(
  fields: EscalationFields,
  account: AccountState,
  options: {
    requestId: string;
    replyByOn: string;
    replyTo: string | null;
    email?: SendEmailOptions;
    now: Date;
  },
): Promise<boolean> {
  // The name as the email may print it, or "A practice" (lib/email/lint.ts):
  // the account's id below finds it in the console either way.
  const printed = printableClinicName(account.clinicName);
  const payload: SupportEscalationPayload = {
    requestId: options.requestId,
    topic: fields.topic,
    symptom: fields.symptom,
    carrier: fields.carrier,
    phoneSystem: fields.phoneSystem,
    mode: fields.mode,
    channel: fields.channel,
    replyByOn: options.replyByOn,
    hasReplyAddress: options.replyTo !== null,
    accountRows: [{ ...account, clinicName: printed ?? "A practice" }],
  };
  // sendEmail holds the payload to the allowlist (ids, categories, dates,
  // flags and the clinic's own numbers, or nothing goes), and reports a
  // refusal to ops, which a check here would have kept from it.
  const rendered = renderSupportEscalation(payload, {
    clinicName: printed,
    audience: "patients",
    reason: SUPPORT_REASON,
    raisedAt: options.now,
    timeZone: "America/New_York",
  });
  const result = await sendEmail(
    {
      to: SUPPORT_INBOX,
      kind: "support_escalation",
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      phiClass: "none",
      payload,
      clinicName: printed,
      deliveryId: options.requestId,
      idempotencyKey: `hd-support_escalation-${options.requestId}-1`,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    },
    options.email,
  );
  if (result.status === "failed") {
    log.warn("support escalation email failed", {
      requestId: options.requestId,
      reason: result.reason,
    });
    return false;
  }
  // "skipped" is the console transport, which never runs in production.
  return true;
}

/** L25 through the outbox, in the clinic's tenant. False, logged, if it could not be queued. */
async function queueAcknowledgement(
  ctx: EscalationContext,
  payload: SupportRequestPayload,
): Promise<boolean> {
  try {
    assertPayloadAllowed(payload, "support_request");
    return await withTenant({ clinicId: ctx.clinicId, actor: ctx.actor }, (tx) =>
      enqueuePlanNotice(
        tx.db,
        tx.clinicId,
        "support_request",
        `support_request:${payload.requestId}`,
        payload,
      ),
    );
  } catch (error) {
    log.error("support request acknowledgement not queued", {
      clinicId: ctx.clinicId,
      requestId: payload.requestId,
      error: describeError(error),
    });
    return false;
  }
}

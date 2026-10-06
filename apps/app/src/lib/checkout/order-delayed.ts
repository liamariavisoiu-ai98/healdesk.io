import { createHash } from "node:crypto";

import type { CheckoutIntentPayload } from "@/db/schema";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor, ORDER_REASON } from "@/lib/email/templates/context";
import { renderOrderConfirmedDelayed } from "@/lib/email/templates/order_confirmed_delayed";
import { describeError, log } from "@/lib/log";
import { replyByDay } from "@/lib/reply-by";

import type { StoredIntent } from "./intents";

/**
 * Send B3 to the address that paid for a purchase provisioning refused
 * (Annex X5). Called once per intent, by the caller that won
 * markIntentFailed(); the idempotency key covers a retry inside Resend's
 * window. The intent row is the state (X1.4), so the email is keyed by its
 * ref, and nothing about it is written back. Never throws: the buyer's money is
 * already safe, ops has been told, and a missing email must not change the
 * webhook's answer.
 */
export async function sendOrderConfirmedDelayed(
  intent: StoredIntent,
  options: SendEmailOptions = {},
): Promise<"sent" | "failed"> {
  const payload = intent.payload as CheckoutIntentPayload;
  const failedAt = intent.provisionFailedAt ?? options.now ?? new Date();
  // The ref opens /welcome for whoever also holds the paying browser's
  // nonce, so Resend's tags and logs get its digest, as /welcome's own
  // sign-in link does (source_ref).
  const deliveryId = createHash("sha256").update(intent.ref).digest("hex");
  try {
    const rendered = renderOrderConfirmedDelayed(
      {
        planId: payload.plan,
        interval: payload.billingInterval,
        replyByOn: replyByDay(failedAt),
      },
      {
        clinicName: payload.clinicName,
        audience: audienceFor(payload.specialty),
        reason: ORDER_REASON,
        raisedAt: failedAt,
        timeZone: "America/New_York",
      },
    );
    const result = await sendEmail(
      {
        to: payload.contactEmail,
        kind: "order_confirmed_delayed",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        deliveryId,
        idempotencyKey: `hd-order_confirmed_delayed-${deliveryId}-1`,
      },
      options,
    );
    if (result.status === "failed") {
      log.error("order confirmation not delivered", { deliveryId, reason: result.reason });
      return "failed";
    }
    return "sent";
  } catch (error) {
    log.error("order confirmation not sent", { deliveryId, error: describeError(error) });
    return "failed";
  }
}

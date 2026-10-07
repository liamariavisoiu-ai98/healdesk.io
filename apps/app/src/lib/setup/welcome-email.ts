import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents, type CheckoutIntentPayload } from "@/db/schema";
import { billingRecipients } from "@/lib/billing/recipients";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import { renderWelcome, type WelcomePayload } from "@/lib/email/templates/welcome";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { issueSignInLink, SIGN_IN_LINK_TTL_MS } from "@/lib/sign-in/links";
import { withTenant } from "@/lib/tenant";

import { emailCallUrl, helpContacts } from "./help";
import { readSetupState } from "./state";

/**
 * Send the welcome email (B1), once per clinic, after provisioning commits
 * (plan Part C2 and C4).
 *
 * Once: the ledger (report_deliveries) holds one row per clinic, kind
 * `welcome`, period `welcome` and address, claimed before the send. A row
 * already sent is never sent again; a row whose send failed is claimed again
 * by the next call, which mints a fresh link, because the link of a failed
 * attempt never reached anyone. A link email (Annex X1.5), so its token is
 * minted here, at send time, written only into this message, and the
 * idempotency key carries the link's row, never an address.
 *
 * Never throws: the clinic exists and its purchase is complete whatever
 * happens here, and the paying browser is already signed in. The outcome is
 * for the caller's log and the tests.
 */

export type WelcomeOutcome =
  /** Sent to the clinic's address. */
  | "sent"
  /** Already sent: nothing was minted or sent. */
  | "already_sent"
  /** The clinic, its billing row or its address is missing. */
  | "no_clinic"
  /** BETTER_AUTH_URL is unset in production: no link minted that nobody could follow. */
  | "unavailable"
  /** No transport is configured (development): logged, and recorded as skipped. */
  | "skipped"
  /** Claimed, and the send failed; the next call tries again with a fresh link. */
  | "failed";

const ACTOR = { type: "service", serviceName: "welcome-email" } as const;

export async function sendWelcomeEmail(
  clinicId: string,
  options: SendEmailOptions = {},
): Promise<WelcomeOutcome> {
  const now = options.now ?? new Date();
  try {
    const prepared = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const state = await readSetupState(tx, { userId: null, now });
      const [owner] = await billingRecipients(tx);
      if (!state || !state.billing || !owner?.userId) return null;
      const deliveryId = await claimDelivery(tx, {
        kind: "welcome",
        periodKey: "welcome",
        recipient: owner.email,
      });
      return { state, owner: { email: owner.email, userId: owner.userId }, deliveryId };
    });
    if (!prepared) return "no_clinic";
    if (!prepared.deliveryId) return "already_sent";
    const { state, owner, deliveryId } = prepared;

    const record = (result: Parameters<typeof recordDelivery>[2]) =>
      withTenant({ clinicId, actor: ACTOR }, (tx) => recordDelivery(tx, deliveryId, result));

    const originProblem = publicOriginProblem();
    if (originProblem) {
      log.error("welcome email not sent: no public origin", { clinicId, reason: originProblem });
      await record({ status: "failed", reason: "no public origin" });
      return "unavailable";
    }

    const link = await issueSignInLink({
      userId: owner.userId,
      purpose: "welcome",
      redirectTo: `/c/${state.clinic.slug}/setup`,
      issuedBy: "welcome_email",
    });
    if (!link) throw new Error("A welcome link without a source cannot already exist.");

    const bought = state.channels.map((c) => c.channel);
    const payload: WelcomePayload = {
      planId: state.billing!.boughtPlanId,
      interval: state.billing!.interval,
      channels: CHANNELS.filter((c): c is Channel => bought.includes(c)),
      continueUrl: publicUrl(`/link/${link.token}`),
      validHours: Math.round(SIGN_IN_LINK_TTL_MS.welcome / 3_600_000),
      version: await termsVersionFor(clinicId),
      setupEndsOn: clinicLocalDate(
        state.billing!.setupDeadlineAt ?? new Date(now.getTime() + 30 * 86_400_000),
        state.clinic.timezone,
      ),
      helpPhoneE164: helpContacts().phoneE164,
      callUrl: emailCallUrl(),
    };
    assertPayloadAllowed(payload, "welcome");
    const rendered = renderWelcome(payload, {
      clinicName: state.clinic.name,
      audience: audienceFor(state.clinic.specialty),
      reason: clinicReason(state.clinic.name),
      raisedAt: now,
      timeZone: state.clinic.timezone,
    });

    let result;
    try {
      result = await sendEmail(
        {
          to: owner.email,
          kind: "welcome",
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          phiClass: "none",
          clinicId,
          clinicName: state.clinic.name,
          deliveryId,
          // Each attempt mints its own link row, so the row id tells one
          // attempt from the next (X1.4).
          idempotencyKey: `hd-welcome-${link.id}-1`,
        },
        options,
      );
    } catch (error) {
      await record({ status: "failed", reason: describeError(error) });
      log.error("welcome email not sent", { clinicId, deliveryId, error: describeError(error) });
      return "failed";
    }
    if (result.status === "sent") {
      await record({ status: "sent", messageId: result.messageId });
      log.info("welcome email sent", { clinicId, deliveryId });
      return "sent";
    }
    await record({ status: result.status, reason: result.reason });
    if (result.status === "skipped") return "skipped";
    log.warn("welcome email not delivered", { clinicId, deliveryId, status: result.status });
    return "failed";
  } catch (error) {
    log.error("welcome email failed", { clinicId, error: describeError(error) });
    return "failed";
  }
}

/** The Terms version the purchase recorded at its tick-box, or null when it recorded none. */
async function termsVersionFor(clinicId: string): Promise<string | null> {
  const [intent] = await unsafeDb
    .select({ payload: checkoutIntents.payload })
    .from(checkoutIntents)
    .where(
      and(eq(checkoutIntents.provisionedClinicId, clinicId), isNotNull(checkoutIntents.consumedAt)),
    )
    .orderBy(desc(checkoutIntents.consumedAt))
    .limit(1);
  const terms = (
    intent?.payload as (CheckoutIntentPayload & { terms?: { version?: unknown } }) | undefined
  )?.terms;
  const version = typeof terms?.version === "string" ? terms.version.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(version) ? version : null;
}

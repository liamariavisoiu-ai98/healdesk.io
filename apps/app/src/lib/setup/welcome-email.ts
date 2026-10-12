import { CHANNELS, SETUP_WINDOW_DAYS, type Channel } from "@healdesk/catalog";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents, reportDeliveries, type CheckoutIntentPayload } from "@/db/schema";
import { billingRecipients } from "@/lib/billing/recipients";
import { setupLastDay } from "@/lib/clinic/setup-window";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import { renderWelcome, type WelcomePayload } from "@/lib/email/templates/welcome";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { issueSignInLink, SIGN_IN_LINK_TTL_MS } from "@/lib/sign-in/links";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { emailCallUrl, helpContacts } from "./help";
import { wizardFinished } from "./screens";
import { readSetupState, type SetupState } from "./state";

/**
 * The welcome email (B1), once per clinic (plan Part C2 and C4).
 *
 * Owed from provisioning's commit: provisioning writes the ledger row
 * (report_deliveries, kind and period `welcome`, the clinic's address) in its
 * own transaction, as unsent (recordWelcomeOwed). State is written first
 * (X1.4), so a send that never runs, because the process exits before the
 * provision route's after-commit task or its first read fails, still leaves a
 * row, and the hourly backstop below finds it and sends it.
 *
 * Once: a row already sent is never sent again; a row not yet sent is claimed
 * by the next attempt, which mints a fresh link, because the link of an
 * attempt that failed never reached anyone. A link email (Annex X1.5), so its
 * token is minted here, at send time, written only into this message, and the
 * idempotency key carries the link's row, never an address.
 *
 * Only while it is still news: once the setup window has ended, a channel is
 * live, the account is closing or setup is finished, a welcome that never
 * went is not sent late (its "Continue setup" and "after setup" lines would
 * be wrong by then), its row is marked skipped, and ops is told so the order
 * confirmation goes by hand.
 *
 * sendWelcomeEmail never throws: the clinic exists and its purchase is
 * complete whatever happens here, and the paying browser is already signed
 * in. The outcome is for the caller's log and the tests.
 */

export type WelcomeOutcome =
  /** Sent to the clinic's address. */
  | "sent"
  /** Already sent: nothing was minted or sent. */
  | "already_sent"
  /** The clinic, its billing row or its address is missing. */
  | "no_clinic"
  /** Setup has moved past it (see above): marked skipped, nothing minted or sent. */
  | "not_owed"
  /** BETTER_AUTH_URL is unset in production: no link minted that nobody could follow. */
  | "unavailable"
  /** No transport is configured (development): logged, and recorded as skipped. */
  | "skipped"
  /** Claimed, and the send failed; the next attempt tries again with a fresh link. */
  | "failed";

const ACTOR = { type: "service", serviceName: "welcome-email" } as const;
const PERIOD = "welcome";
/** The reason on the row provisioning writes, until the first attempt claims it. */
const OWED = "owed since provisioning; not yet attempted";

/** How long a welcome that failed waits before the backstop tries again. */
export const WELCOME_RETRY_AFTER_MS = 10 * 60_000;
/** How long after provisioning a welcome may stay unsent before ops is told. */
export const WELCOME_ALERT_AFTER_MS = 60 * 60_000;
/** How far back the backstop looks: a welcome is owed only inside the setup window. */
const WELCOME_LOOKBACK_MS = (SETUP_WINDOW_DAYS + 1) * 86_400_000;

/**
 * Record that this clinic is owed its welcome, inside provisioning's own
 * transaction: the ledger row, unsent, for the clinic's one address.
 */
export async function recordWelcomeOwed(tx: TenantTx): Promise<void> {
  const [owner] = await billingRecipients(tx);
  if (!owner) return;
  await tx.db
    .insert(reportDeliveries)
    .values({
      clinicId: tx.clinicId,
      kind: "welcome",
      periodKey: PERIOD,
      recipient: owner.email,
      status: "failed",
      reason: OWED,
    })
    .onConflictDoNothing({
      target: [
        reportDeliveries.clinicId,
        reportDeliveries.kind,
        reportDeliveries.periodKey,
        reportDeliveries.recipient,
      ],
    });
}

/** Why the welcome is no longer worth sending, or null while it still is. */
export function welcomeNoLongerOwed(state: SetupState, now: Date): string | null {
  if (state.clinic.offboardingStartedAt) return "the account is closing";
  const billing = state.billing;
  if (billing?.setupDeadlineAt && now.getTime() > billing.setupDeadlineAt.getTime()) {
    return "the setup window has ended";
  }
  if (billing?.planStartedAt || state.channels.some((c) => c.liveAt !== null)) {
    return "a channel is live";
  }
  if (wizardFinished(state.screens, state.progress)) return "setup is finished";
  return null;
}

export async function sendWelcomeEmail(
  clinicId: string,
  options: SendEmailOptions = {},
): Promise<WelcomeOutcome> {
  const now = options.now ?? new Date();
  try {
    const prepared = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const state = await readSetupState(tx, { userId: null, now });
      const [owner] = await billingRecipients(tx);
      if (!state || !state.billing || !owner?.userId) return { outcome: "no_clinic" as const };
      // Once per clinic, whichever address it went to: a clinic that changed
      // its address after its welcome went is not welcomed again.
      const [sent] = await tx.db
        .select({ id: reportDeliveries.id })
        .from(reportDeliveries)
        .where(
          and(
            eq(reportDeliveries.clinicId, tx.clinicId),
            eq(reportDeliveries.kind, "welcome"),
            eq(reportDeliveries.periodKey, PERIOD),
            eq(reportDeliveries.status, "sent"),
          ),
        )
        .limit(1);
      if (sent) return { outcome: "already_sent" as const };
      const stale = welcomeNoLongerOwed(state, now);
      if (stale) {
        await tx.db
          .update(reportDeliveries)
          .set({ status: "skipped", reason: `not sent: ${stale}` })
          .where(
            and(
              eq(reportDeliveries.clinicId, tx.clinicId),
              eq(reportDeliveries.kind, "welcome"),
              eq(reportDeliveries.periodKey, PERIOD),
              ne(reportDeliveries.status, "sent"),
            ),
          );
        return { outcome: "not_owed" as const };
      }
      const deliveryId = await claimDelivery(tx, {
        kind: "welcome",
        periodKey: PERIOD,
        recipient: owner.email,
      });
      if (!deliveryId) return { outcome: "already_sent" as const };
      return {
        outcome: "claimed" as const,
        state,
        owner: { email: owner.email, userId: owner.userId },
        deliveryId,
      };
    });
    if (prepared.outcome !== "claimed") return prepared.outcome;
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

    const order = await orderRecordFor(clinicId);
    const bought = state.channels.map((c) => c.channel);
    const payload: WelcomePayload = {
      planId: state.billing!.boughtPlanId,
      interval: state.billing!.interval,
      channels: CHANNELS.filter((c): c is Channel => bought.includes(c)),
      continueUrl: publicUrl(`/link/${link.token}`),
      validHours: Math.round(SIGN_IN_LINK_TTL_MS.welcome / 3_600_000),
      version: order.termsVersion,
      receiptUrl: order.receiptUrl,
      // The day the reminders and the closure email name too: the last day
      // the account lives to the end of, on the clinic's calendar.
      setupEndsOn: setupLastDay(
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

/**
 * What the purchase recorded that the welcome restates: the Terms version
 * accepted at its tick-box, and the paid first invoice's hosted page, which
 * holds the setup-fee receipt. Either is null when the purchase recorded none.
 */
async function orderRecordFor(
  clinicId: string,
): Promise<{ termsVersion: string | null; receiptUrl: string | null }> {
  const [intent] = await unsafeDb
    .select({ payload: checkoutIntents.payload, receiptUrl: checkoutIntents.firstInvoiceUrl })
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
  return {
    termsVersion: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/.test(version) ? version : null,
    receiptUrl: intent?.receiptUrl ?? null,
  };
}

// -----------------------------------------------------------------------------
// The backstop
// -----------------------------------------------------------------------------

export type WelcomeBackstopResult = { resent: number; unsent: number; failed: number };

/**
 * The welcome's backstop, hourly from the tick and behind no switch, because
 * the welcome itself goes at every provisioning from the day it ships (a
 * retry behind a switch that ships off would leave a failed welcome unsent
 * until launch day, then send it weeks late).
 *
 * It can reach only a clinic whose provisioning recorded a welcome as owed,
 * and only inside the setup window: for each, a row still unsent ten minutes
 * after its last attempt (or after provisioning, when no attempt ran) is sent
 * now, with a fresh link. A welcome still unsent an hour after provisioning,
 * or one setup moved past, is raised to ops once.
 */
export async function runWelcomeBackstop(
  options: SendEmailOptions = {},
): Promise<WelcomeBackstopResult> {
  const now = options.now ?? new Date();
  const result: WelcomeBackstopResult = { resent: 0, unsent: 0, failed: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt || clinic.offboardingStartedAt) continue;
    const age = now.getTime() - clinic.createdAt.getTime();
    if (age > WELCOME_LOOKBACK_MS) continue;
    try {
      const rows = await withTenant({ clinicId: clinic.id, actor: ACTOR }, (tx) =>
        tx.db
          .select({ status: reportDeliveries.status, attemptedAt: reportDeliveries.attemptedAt })
          .from(reportDeliveries)
          .where(
            and(
              eq(reportDeliveries.clinicId, tx.clinicId),
              eq(reportDeliveries.kind, "welcome"),
              eq(reportDeliveries.periodKey, PERIOD),
            ),
          ),
      );
      // No row: nothing was owed (a clinic from before the welcome). A row
      // sent, or skipped (development, or no longer owed): nothing to do.
      if (rows.length === 0 || rows.some((r) => r.status !== "failed")) continue;
      const lastAttempt = Math.max(...rows.map((r) => r.attemptedAt.getTime()));
      if (now.getTime() - lastAttempt < WELCOME_RETRY_AFTER_MS) continue;
      const outcome = await sendWelcomeEmail(clinic.id, options);
      if (outcome === "sent") {
        result.resent += 1;
        continue;
      }
      if (outcome === "already_sent") continue;
      result.unsent += 1;
      if (outcome === "not_owed" || age >= WELCOME_ALERT_AFTER_MS) {
        await notifyOpsOnce("welcome_email_unsent", { clinicId: clinic.id });
      }
    } catch (error) {
      result.failed += 1;
      log.error("welcome backstop failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return result;
}

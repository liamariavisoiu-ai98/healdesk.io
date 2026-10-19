import { isCarrier, type Channel } from "@healdesk/catalog";
import { and, eq, like, sql } from "drizzle-orm";

import { clinicChannels, clinics, reportDeliveries } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import {
  renderStepsSent,
  stepsReason,
  type StepsSentPayload,
} from "@/lib/email/templates/steps_sent";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { audienceFor } from "@/lib/email/templates/context";
import { unsubscribeHeaders, stepsStopUrl } from "@/lib/email/unsubscribe";
import { describeError, log } from "@/lib/log";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { emailCallUrl } from "@/lib/setup/help";
import { readSetupSettings } from "@/lib/setup/settings";
import { snippetOpen, widgetScriptUrl } from "@/lib/setup/snippet";
import { withTenant } from "@/lib/tenant";

/**
 * O11, "Steps from {clinic}" (Annex X5): the clinic sends a channel's one
 * step on to the person who will do it, by address. The words are ours
 * (lib/email/templates/steps_sent.ts, no free text from anyone), and:
 *
 *   - at most STEPS_PER_DAY a day per clinic, counted on the clinic's own
 *     calendar, so the form cannot be used to mail strangers in bulk;
 *   - never again to an address whose owner used the email's stop link
 *     (`stopped` below), which the footer carries with who asked for it;
 *   - recorded on the ledger, report_deliveries, one row a send, keyed by
 *     the clinic's day and a counter, so a retry of the same row sends once.
 *
 * Two channels have a step someone else can take:
 *
 *   - phone, the forwarding steps, which exist only once voice is ready for
 *     the clinic, and AYA's number is then the voice runtime's to give
 *     (`ayaNumberE164`, null until then): "Email these to my office manager"
 *     on the wizard's forwarding screen and in Settings → Channels;
 *   - website chat, the line to paste, once the channel is open (ready on our
 *     side, lib/setup/snippet.ts), the same day the screens show it: "Email to
 *     my web person" beside the line in both places.
 *
 * The limit and the stop list are the clinic's, across both: three a day in
 * all, and an address that stopped them gets neither.
 *
 * Business contact data only: an address the clinic chose, the practice's
 * own phone steps and its website line. Nothing about a patient.
 */

export const STEPS_PER_DAY = 3;

/** The ledger's mark that an address asked for no more of these. */
export const STEPS_STOPPED_PERIOD = "stopped";

const KIND = "steps_sent" as const;

export type StepsSentResult =
  | { status: "sent"; to: string }
  | { status: "refused"; message: string }
  | { status: "failed"; message: string };

const ADDRESS =
  /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** An address as typed, or null when it isn't one. */
export function stepsRecipient(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  return address.length <= 254 && ADDRESS.test(address) ? address : null;
}

export async function sendStepsOn(
  input: {
    clinicId: string;
    channel: Channel;
    to: unknown;
    actor: ActorContext;
    /** Phone's: AYA's number once voice is ready for the clinic; null until then. */
    ayaNumberE164?: string | null;
  },
  options: SendEmailOptions = {},
): Promise<StepsSentResult> {
  const now = options.now ?? new Date();
  if (input.channel === "meta") {
    return {
      status: "refused",
      message:
        "Instagram, Messenger and WhatsApp connect with your own Facebook login, so there are no steps to send on.",
    };
  }
  if (input.channel === "voice" && !input.ayaNumberE164) {
    return {
      status: "refused",
      message: "Phone isn't ready for call forwarding yet, so there are no steps to send.",
    };
  }
  const to = stepsRecipient(input.to);
  if (!to)
    return { status: "refused", message: "Enter one email address, like maria@example.com." };

  const prepared = await withTenant(
    { clinicId: input.clinicId, actor: input.actor },
    async (tx) => {
      // One send at a time per clinic, so two quick clicks cannot both see two
      // sends today and both make the third.
      await tx.db.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`steps_sent:${tx.clinicId}`}))`,
      );
      const [clinic] = await tx.db
        .select({
          name: clinics.name,
          slug: clinics.slug,
          specialty: clinics.specialty,
          timezone: clinics.timezone,
          carrier: clinics.carrier,
          phoneSystem: clinics.phoneSystemType,
          offboardingStartedAt: clinics.offboardingStartedAt,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic || clinic.offboardingStartedAt) {
        return { refused: "This account has closed, so nothing can be sent on." } as const;
      }
      if (input.channel === "web") {
        // The line goes on only once the screens show it: website chat bought
        // and ready on our side, so nobody pastes a line that loads nothing.
        const [web] = await tx.db
          .select({ readyAt: clinicChannels.readyAt })
          .from(clinicChannels)
          .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
          .limit(1);
        if (!snippetOpen(web)) {
          return {
            refused:
              "Website chat isn't ready yet, so there's no line to send. It appears here when it is.",
          } as const;
        }
      }
      const [stopped] = await tx.db
        .select({ id: reportDeliveries.id })
        .from(reportDeliveries)
        .where(
          and(
            eq(reportDeliveries.clinicId, tx.clinicId),
            eq(reportDeliveries.kind, KIND),
            eq(reportDeliveries.periodKey, STEPS_STOPPED_PERIOD),
            eq(reportDeliveries.recipient, to),
          ),
        )
        .limit(1);
      if (stopped) {
        return {
          refused:
            "That address asked us not to send these to it any more. Send them to another one.",
        } as const;
      }
      const day = clinicLocalDate(now, clinic.timezone);
      const [today] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(reportDeliveries)
        .where(
          and(
            eq(reportDeliveries.clinicId, tx.clinicId),
            eq(reportDeliveries.kind, KIND),
            like(reportDeliveries.periodKey, `${day}:%`),
          ),
        );
      const sentToday = Number(today?.n ?? 0);
      if (sentToday >= STEPS_PER_DAY) {
        return {
          refused: `Steps can be sent on ${STEPS_PER_DAY} times a day. Try again tomorrow, or forward the last one yourself.`,
        } as const;
      }
      const deliveryId = await claimDelivery(tx, {
        kind: KIND,
        periodKey: `${day}:${sentToday + 1}`,
        recipient: to,
      });
      if (!deliveryId) return { refused: "That was just sent." } as const;
      const settings = await readSetupSettings(tx.db, tx.clinicId);
      tx.audit.record({
        action: "create",
        resourceType: "report_delivery",
        resourceId: deliveryId,
        // No address in an audit row: the ledger row holds it.
        metadata: { kind: KIND, channel: input.channel },
      });
      return {
        deliveryId,
        clinic,
        routing: settings.coverageMode,
      } as const;
    },
  );
  if ("refused" in prepared) return { status: "refused", message: prepared.refused! };

  const { deliveryId, clinic, routing } = prepared;
  const record = (result: Parameters<typeof recordDelivery>[2]) =>
    withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
      recordDelivery(tx, deliveryId, result),
    );
  try {
    const payload: StepsSentPayload =
      input.channel === "web"
        ? { channel: "web", scriptUrl: widgetScriptUrl(), clinicSlug: clinic.slug }
        : {
            channel: "voice",
            ayaNumberE164: input.ayaNumberE164!,
            carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
            phoneSystem:
              clinic.phoneSystem === "voip" || clinic.phoneSystem === "landline"
                ? clinic.phoneSystem
                : "unknown",
            routing,
            callUrl: emailCallUrl(),
          };
    assertPayloadAllowed(payload, KIND);
    const stopUrl = stepsStopUrl(input.clinicId, deliveryId);
    const rendered = renderStepsSent(payload, {
      clinicName: clinic.name,
      audience: audienceFor(clinic.specialty),
      reason: stepsReason(clinic.name),
      unsubscribeUrl: stopUrl,
      raisedAt: now,
      timeZone: clinic.timezone,
    });
    const result = await sendEmail(
      {
        to,
        kind: KIND,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        clinicId: input.clinicId,
        clinicName: clinic.name,
        deliveryId,
        idempotencyKey: `hd-${KIND}-${deliveryId}-1`,
        headers: unsubscribeHeaders(stopUrl),
      },
      options,
    );
    if (result.status === "sent") {
      await record({ status: "sent", messageId: result.messageId });
      return { status: "sent", to };
    }
    await record({ status: result.status, reason: result.reason });
    return { status: "failed", message: "The email didn't go. Try again in a minute." };
  } catch (error) {
    log.error("steps email not sent", {
      clinicId: input.clinicId,
      deliveryId,
      error: describeError(error),
    });
    await record({ status: "failed", reason: describeError(error) }).catch(() => undefined);
    return { status: "failed", message: "The email didn't go. Try again in a minute." };
  }
}

/**
 * The stop link's work for O11: the address the email went to gets no more
 * of them from this clinic. Idempotent. Returns whether the delivery was one
 * of this clinic's.
 */
export async function stopStepsTo(
  clinicId: string,
  deliveryId: string,
  actor: ActorContext,
): Promise<{ clinicName: string } | null> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ recipient: reportDeliveries.recipient, name: clinics.name })
      .from(reportDeliveries)
      .innerJoin(clinics, eq(clinics.id, reportDeliveries.clinicId))
      .where(and(eq(reportDeliveries.id, deliveryId), eq(reportDeliveries.kind, KIND)))
      .limit(1);
    if (!row) return null;
    await tx.db
      .insert(reportDeliveries)
      .values({
        clinicId: tx.clinicId,
        kind: KIND,
        periodKey: STEPS_STOPPED_PERIOD,
        recipient: row.recipient,
        status: "skipped",
        reason: "the recipient used the stop link",
      })
      .onConflictDoNothing({
        target: [
          reportDeliveries.clinicId,
          reportDeliveries.kind,
          reportDeliveries.periodKey,
          reportDeliveries.recipient,
        ],
      });
    return { clinicName: row.name };
  });
}

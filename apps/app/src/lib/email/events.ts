import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { DELIVERY_STATUSES, reportDeliveries, type DeliveryStatus } from "@/db/schema";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { countsAtSend, recordEmailEvent } from "./health";
import { locksOutClinic, toSomeoneNamed } from "./kind-rules";

/**
 * What Resend later says about an email apps/app sent (Annex X3).
 *
 * The account has one webhook, on apps/web, and it sees both apps' mail. It
 * handles `app=web` events itself and relays `app=app` ones here through the
 * signed ops API (`emailEvent`), carrying the event type, the tag values
 * (clinic, delivery, kind) and the event's timestamp: never an address, a
 * subject or anything else Resend put in the payload.
 *
 * With a clinic tag, the clinic's tenant is opened and the ledger row named
 * by the delivery tag is updated. Only a permanent bounce, a complaint or a
 * suppression makes the address undeliverable, and every clinic has exactly
 * one address, so there is no one else to email: notifyOps fires and ops calls
 * the clinic. There is no suppression table; an address is undeliverable
 * while its latest reported ledger row says so (`isUndeliverable`), and
 * Resend's own list enforces it.
 *
 * Without a clinic tag (ops alerts, sign-in links), there is no tenant to open
 * and the event is logged. A sign-in that cannot arrive locks the clinic out
 * of its account, so a bounce, complaint or suppression on one of those kinds
 * calls notifyOps as well.
 *
 * The steps a clinic sends on (O11) go to someone it named, not to its
 * address: their row is updated like any other, but a bounce from that
 * person's inbox says nothing about the clinic's, so ops is not called.
 *
 * ## Counted for the digest (19 October 2026)
 *
 * A bounce, complaint or suppression on a kind no ledger row holds (the
 * clinic-less kinds, and the calendar's two) is recorded in email_events
 * (lib/email/health.ts), so the ops digest's email health and its rates see
 * it. So is every event apps/web's webhook relays about apps/web's own mail
 * (`app: "web"`), which apps/app never sends and so cannot count otherwise:
 * those change no ledger, call no one, and are recorded once by the
 * webhook's own id.
 */

export type RelayedEmailEvent = {
  /** In the ledger's vocabulary: apps/web maps Resend's event types onto it. */
  type: DeliveryStatus;
  /** The event's own timestamp. */
  at: Date;
  clinic?: string;
  delivery?: string;
  kind?: string;
  /** "web" for apps/web's own mail, relayed only to be counted. Absent for apps/app's. */
  app?: "web";
  /** The webhook delivery's id (svix-id): a redelivered event counts once. */
  eventId?: string;
};

/** The statuses the digest counts, of the ones the relay carries. */
const COUNTED: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "sent",
  "bounced",
  "complained",
  "suppressed",
]);

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** The statuses that make an address undeliverable. */
export const UNDELIVERABLE: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "bounced",
  "complained",
  "suppressed",
]);

/**
 * How far along a message's life each status is. Webhooks arrive out of order
 * and are retried, so a status never overwrites a higher-ranked one: a late
 * `sent` must not turn a `bounced` back into a deliverable address, and a
 * complaint after delivery is the last word.
 */
const RANK: Record<DeliveryStatus, number> = {
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  suppressed: 4,
  complained: 5,
};

const ACTOR = { type: "service", serviceName: "resend-webhook-relay" } as const;

export async function applyEmailEvent(event: RelayedEmailEvent): Promise<{ recorded: boolean }> {
  const undeliverable = UNDELIVERABLE.has(event.type);

  // apps/web's own mail: counted, and nothing else. Its leads are its own.
  if (event.app === "web") {
    if (!event.kind || !COUNTED.has(event.type)) return { recorded: false };
    const recorded = await recordEmailEvent({
      app: "web",
      kind: event.kind,
      status: event.type as "sent" | "bounced" | "complained" | "suppressed",
      at: event.at,
      eventId: event.eventId ?? null,
    });
    return { recorded };
  }

  // A kind no ledger row holds: its sends are counted at send time, and an
  // undeliverable event is counted here, with or without a clinic.
  if (undeliverable && event.kind && countsAtSend(event.kind)) {
    await recordEmailEvent({
      app: "app",
      kind: event.kind,
      status: event.type as "bounced" | "complained" | "suppressed",
      at: event.at,
      eventId: event.eventId ?? null,
    });
  }

  if (!event.clinic) {
    log.info("email event for mail with no clinic", {
      kind: event.kind ?? null,
      status: event.type,
      deliveryId: event.delivery ?? null,
    });
    if (undeliverable && event.kind && locksOutClinic(event.kind)) {
      await notifyOps(`clinic_address_${event.type as "bounced" | "complained" | "suppressed"}`, {
        kind: event.kind,
        deliveryId: event.delivery ?? null,
      });
    }
    return { recorded: false };
  }

  let recorded = false;
  if (event.delivery) {
    const deliveryId = event.delivery;
    recorded = await withTenant({ clinicId: event.clinic, actor: ACTOR }, async (tx) => {
      const current = sql`case ${reportDeliveries.deliveryStatus}
        when 'sent' then 1 when 'delayed' then 2 when 'delivered' then 3
        when 'bounced' then 4 when 'suppressed' then 4 when 'complained' then 5
        else 0 end`;
      const rows = await tx.db
        .update(reportDeliveries)
        .set({ deliveryStatus: event.type, deliveryAt: event.at })
        .where(
          and(
            eq(reportDeliveries.id, deliveryId),
            eq(reportDeliveries.clinicId, tx.clinicId),
            sql`${current} <= ${RANK[event.type]}`,
          ),
        )
        .returning({ id: reportDeliveries.id });
      return rows.length > 0;
    });
  }

  if (undeliverable && !(event.kind && toSomeoneNamed(event.kind))) {
    // The clinic and the kind, not the delivery: ops calls the clinic once
    // about its address, not once per email that bounced off it.
    await notifyOps(`clinic_address_${event.type as "bounced" | "complained" | "suppressed"}`, {
      clinicId: event.clinic,
      kind: event.kind ?? null,
    });
  }
  return { recorded };
}

/**
 * Whether mail to this address is undeliverable for this clinic: the latest
 * ledger row Resend has reported on says bounced, complained or suppressed.
 * For Home's "We can't email {address}".
 */
export async function isUndeliverable(tx: TenantTx, recipient: string): Promise<boolean> {
  const [latest] = await tx.db
    .select({ status: reportDeliveries.deliveryStatus })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.clinicId, tx.clinicId),
        eq(reportDeliveries.recipient, recipient.trim().toLowerCase()),
        isNotNull(reportDeliveries.deliveryStatus),
      ),
    )
    .orderBy(desc(sql`coalesce(${reportDeliveries.deliveryAt}, ${reportDeliveries.attemptedAt})`))
    .limit(1);
  return latest?.status ? UNDELIVERABLE.has(latest.status) : false;
}

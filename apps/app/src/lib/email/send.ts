import { SENDER_IDENTITY } from "@healdesk/catalog";

import {
  ConsoleTransport,
  type DeliveryResult,
  type EmailTransport,
  type OutgoingEmail,
  type PhiClass,
} from "@/lib/reporting/deliver";
import { PhiRoutingError, ResendTransport } from "@/lib/reporting/resend-transport";

import { KIND_SHAPE } from "./kind-rules";
import { assertLinksAllowed } from "./lint";
import { recordDailyQuota } from "./quota";

/**
 * sendEmail(): the one door every email apps/app sends goes through (Annex X3
 * of docs/design/funnel-onboarding-portal-2026-10-06.md). The outbox sender,
 * notifyOps and the seed script call it; nothing calls a transport directly.
 *
 * What it adds to a transport, and why each is here rather than at the caller:
 *
 *   - the TRANSPORT, by environment: Resend when HEALDESK_EMAIL_TRANSPORT is
 *     "resend", otherwise the console stub, which refuses to run in production
 *     rather than report a month of emails that never went;
 *   - the CLASS GATE. Resend signs no business associate agreement, so
 *     anything not classed "none" is refused here, before a transport is
 *     chosen, and again inside ResendTransport. getTransport() in
 *     lib/reporting/deliver.ts stays for a future PHI path over SES;
 *   - the TAGS: app=app always, so the one Resend webhook can tell this app's
 *     mail from apps/web's, plus the kind, the clinic and the ledger row, as
 *     ids. A tag value is checked against Resend's own alphabet, which has no
 *     "@" in it, so an address cannot become a tag;
 *   - REPLY-TO: every email can be replied to (X1.9), and replies go to
 *     hello@healdesk.io unless the caller names another address;
 *   - the LINK SCANNER, over the subject, both bodies and the headers: https,
 *     public origins only, never HEALDESK_APP_URL, tokens only in link emails;
 *   - the DAILY COUNT. Resend's x-resend-daily-quota header is recorded on
 *     every answer, and notifyOps fires once when it reaches 70.
 */

export type EmailToSend = {
  /** One bare address. */
  to: string;
  /** The template kind; also the `kind` tag. */
  kind: string;
  subject: string;
  text: string;
  html: string;
  /** Required, and anything but "none" is refused: see the header. */
  phiClass: PhiClass;
  /** The `clinic` tag. Absent for mail with no clinic (ops alerts, sign-in links). */
  clinicId?: string | null;
  /** For the log line a development send writes. Never sent anywhere. */
  clinicName?: string | null;
  /** The `delivery` tag: the ledger row (or, for a kind with no clinic, its own state row). */
  deliveryId?: string | null;
  /** `hd-<kind>-<row id>-<recipient n>` (X1.4). Never an address. */
  idempotencyKey?: string;
  headers?: Readonly<Record<string, string>>;
  from?: string;
  replyTo?: string;
};

export type SendEmailOptions = {
  /** A fake in tests. Otherwise the transport the environment names. */
  transport?: EmailTransport;
  now?: Date;
};

/** Resend's tag alphabet. No "@" and no ".", so no address fits in one. */
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;
/** Our idempotency keys: `hd-` and then ids, kinds and counters only. */
const IDEMPOTENCY_KEY = /^hd-[A-Za-z0-9_-]{1,252}$/;

export class EmailEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailEnvelopeError";
  }
}

/** The transport this environment sends with. Read at call time, never at module scope. */
export function platformTransport(): EmailTransport {
  return process.env.HEALDESK_EMAIL_TRANSPORT === "resend"
    ? new ResendTransport()
    : new ConsoleTransport();
}

/** The tags an email carries: ids and kinds, never an address. */
export function tagsFor(email: Pick<EmailToSend, "kind" | "clinicId" | "deliveryId">): {
  name: string;
  value: string;
}[] {
  const tags = [
    { name: "app", value: "app" },
    { name: "kind", value: email.kind },
    ...(email.clinicId ? [{ name: "clinic", value: email.clinicId }] : []),
    ...(email.deliveryId ? [{ name: "delivery", value: email.deliveryId }] : []),
  ];
  for (const tag of tags) {
    if (!TAG_VALUE.test(tag.value)) {
      throw new EmailEnvelopeError(
        `Refusing to send: the ${tag.name} tag is not an id or a kind. Tags carry ids only, never an address.`,
      );
    }
  }
  return tags;
}

/**
 * Send one email. Returns the transport's result; throws only for what is a
 * bug rather than a delivery fact (a PHI class, an unsafe envelope or link),
 * or for a deployment that cannot send at all (the console stub in
 * production, a missing key), so the caller's records say which it was.
 */
export async function sendEmail(
  email: EmailToSend,
  options: SendEmailOptions = {},
): Promise<DeliveryResult> {
  if (email.phiClass !== "none") {
    throw new PhiRoutingError(
      `Refusing to send: this email is classed "${String(email.phiClass)}" and the email ` +
        `platform carries only "none". Resend signs no business associate agreement; ` +
        `anything that may carry patient information goes through getTransport() and SES.`,
    );
  }
  if (!KIND_SHAPE.test(email.kind)) {
    throw new EmailEnvelopeError("Refusing to send: the kind is not a kind name.");
  }
  if (email.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(email.idempotencyKey)) {
    throw new EmailEnvelopeError(
      "Refusing to send: the idempotency key is not hd- followed by ids. It is kept in Resend's logs.",
    );
  }
  const tags = tagsFor(email);
  assertLinksAllowed(
    { subject: email.subject, text: email.text, html: email.html, headers: email.headers },
    email.kind,
  );

  const message: OutgoingEmail = {
    subject: email.subject,
    text: email.text,
    html: email.html,
    phiClass: "none",
    replyTo: email.replyTo ?? SENDER_IDENTITY.replyTo,
    tags,
    ...(email.from ? { from: email.from } : {}),
    ...(email.headers ? { headers: email.headers } : {}),
    ...(email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : {}),
  };
  const transport = options.transport ?? platformTransport();
  const result = await transport.send(
    { to: email.to, clinicId: email.clinicId ?? "", clinicName: email.clinicName ?? "healdesk" },
    message,
  );

  if (result.status !== "skipped" && result.quota !== undefined) {
    await recordDailyQuota(result.quota, options.now ?? new Date());
  }
  return result;
}

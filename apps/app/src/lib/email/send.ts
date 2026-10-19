import { SENDER_IDENTITY } from "@healdesk/catalog";

import {
  ConsoleTransport,
  type DeliveryResult,
  type EmailAttachment,
  type EmailTransport,
  type OutgoingEmail,
  type PhiClass,
} from "@/lib/reporting/deliver";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { PhiRoutingError, ResendTransport } from "@/lib/reporting/resend-transport";

import { countsAtSend, holdsNoLedgerRow, recordEmailEvent } from "./health";
import { isDirectKind, isEmailKind, KIND_SHAPE } from "./kind-rules";
import {
  assertLinksAllowed,
  assertPayloadAllowed,
  isAllowedClinicName,
  LinkNotAllowedError,
  PayloadNotAllowedError,
} from "./lint";
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
 *   - the PAYLOAD ALLOWLIST, for a direct kind (lib/email/direct-kinds.ts):
 *     the payload its template rendered from is required and checked here, at
 *     send time, as the outbox checks its stored payloads, and so is the
 *     clinic's name the template printed. Until 19 October 2026 a direct
 *     kind's sender checked or not as it chose: O3 printed a device's label,
 *     and B3 a clinic's name typed at checkout, unchecked;
 *   - the DAILY COUNT. Resend's x-resend-daily-quota header is recorded on
 *     every answer, and notifyOps fires once when it reaches 70;
 *   - the EMAIL HEALTH of a direct kind with no ledger row (lib/email/health.ts):
 *     each send's answer, sent or failed, so the ops digest counts the mail
 *     no ledger holds.
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
  /**
   * The clinic's name the template printed (its context's `clinicName`), or
   * null. For a direct kind it is held to the allowlist's rule for a clinic's
   * name; otherwise it is only for the log line a development send writes.
   */
  clinicName?: string | null;
  /**
   * The payload the template rendered from. Required for a direct kind, and
   * checked against the payload allowlist (lib/email/lint.ts) before anything
   * is sent; an outbox kind's is checked by the outbox before it renders.
   */
  payload?: Readonly<Record<string, unknown>>;
  /** Files sent with it (P6, the agreement copy). No PHI guard can read inside one: see deliver.ts. */
  attachments?: EmailAttachment[];
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

/**
 * A direct kind refused before sending would otherwise be a log line in its
 * caller, and the clinic simply never hears: so it is counted as failed for
 * the digest (lib/email/health.ts) and ops is told once per kind and clinic.
 * Not for I1 itself, whose refusal notifyOps would answer with another I1.
 * Never throws.
 */
async function refused(email: EmailToSend, error: unknown, now: Date): Promise<void> {
  if (!isDirectKind(email.kind) || email.kind === "ops_alert") return;
  if (
    !(error instanceof PayloadNotAllowedError) &&
    !(error instanceof LinkNotAllowedError) &&
    !(error instanceof EmailEnvelopeError)
  ) {
    return;
  }
  try {
    if (holdsNoLedgerRow(email.kind)) {
      await recordEmailEvent({ app: "app", kind: email.kind, status: "failed", at: now });
    }
    const clinicId = email.clinicId && TAG_VALUE.test(email.clinicId) ? email.clinicId : null;
    await notifyOpsOnce("email_refused", { kind: email.kind, clinicId });
  } catch {
    // The refusal itself is what the caller hears about.
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
  let tags: ReturnType<typeof tagsFor>;
  try {
    if (isDirectKind(email.kind)) {
      if (!email.payload) {
        throw new EmailEnvelopeError(
          "Refusing to send: a direct kind goes with the payload it was rendered from, for the allowlist.",
        );
      }
      assertPayloadAllowed(email.payload, email.kind);
      // The backstop: every direct sender prints the clinic's name through
      // printableClinicName, which leaves out a name this would refuse.
      if (email.clinicName != null && !isAllowedClinicName(email.clinicName)) {
        throw new PayloadNotAllowedError("(clinic name)", "must be a clinic's name.");
      }
    } else if (email.payload) {
      assertPayloadAllowed(email.payload, isEmailKind(email.kind) ? email.kind : undefined);
    }
    tags = tagsFor(email);
    assertLinksAllowed(
      { subject: email.subject, text: email.text, html: email.html, headers: email.headers },
      email.kind,
    );
  } catch (error) {
    await refused(email, error, options.now ?? new Date());
    throw error;
  }

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
    ...(email.attachments?.length ? { attachments: email.attachments } : {}),
  };
  const transport = options.transport ?? platformTransport();
  const result = await transport.send(
    { to: email.to, clinicId: email.clinicId ?? "", clinicName: email.clinicName ?? "healdesk" },
    message,
  );

  if (result.status !== "skipped" && result.quota !== undefined) {
    await recordDailyQuota(result.quota, options.now ?? new Date());
  }
  if (result.status !== "skipped" && countsAtSend(email.kind)) {
    await recordEmailEvent({
      app: "app",
      kind: email.kind,
      status: result.status,
      at: options.now ?? new Date(),
    });
  }
  return result;
}

import { verify, X509Certificate, type KeyObject } from "node:crypto";

import type { SesTranscriptEvent } from "@/lib/conversations/transcript-outbox";

/**
 * SES's events, as SNS posts them to app/api/webhooks/ses.
 *
 * SES publishes each event for the PHI configuration set (a delivery, a
 * bounce, a complaint, a rejection, a rendering failure, a delay) to one SNS
 * topic (infra/aws/ses.tf), and SNS posts it here over HTTPS. Anyone can post
 * to a public URL, so a message counts only when:
 *
 *   - it names the topic this host was told to trust
 *     (HEALDESK_SES_EVENTS_TOPIC_ARN), and
 *   - SNS's signature verifies: signature version 2 (SHA256withRSA, which the
 *     topic is set to), against the certificate at SigningCertURL, which must
 *     be an https URL on sns.<the topic's region>.amazonaws.com ending in
 *     .pem. The TLS connection to that host is what makes the certificate
 *     AWS's. A version 1 signature is refused: the topic never sends one.
 *
 * A subscription confirmation is followed only on the same terms, and only
 * to a SubscribeURL on that same host.
 *
 * Nothing here keeps the message. An event names SES's message id, the
 * clinic's address, a fixed subject and a mail server's diagnostic, never a
 * transcript; only the message id, the event's type and the diagnostic
 * (scrubbed) are passed on.
 */

export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

export class SnsVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnsVerificationError";
  }
}

/** The topic this host trusts, or null when SES events are not set up here. */
export function sesEventsTopicArn(): string | null {
  const arn = process.env.HEALDESK_SES_EVENTS_TOPIC_ARN?.trim();
  return arn ? arn : null;
}

const TOPIC_ARN = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:[A-Za-z0-9_-]{1,256}$/;

/** The region a topic ARN names, or null when it is not one. */
export function topicRegion(topicArn: string): string | null {
  return TOPIC_ARN.exec(topicArn)?.[1] ?? null;
}

/** Parse a posted body into an SNS message, or throw. */
export function parseSnsMessage(body: string): SnsMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new SnsVerificationError("The body is not JSON.");
  }
  if (!raw || typeof raw !== "object") throw new SnsVerificationError("The body is not an SNS message.");
  const m = raw as Record<string, unknown>;
  const required = ["Type", "MessageId", "TopicArn", "Message", "Timestamp", "SignatureVersion", "Signature", "SigningCertURL"];
  for (const key of required) {
    if (typeof m[key] !== "string") throw new SnsVerificationError(`The message has no ${key}.`);
  }
  for (const key of ["Subject", "SubscribeURL", "Token"]) {
    if (m[key] !== undefined && m[key] !== null && typeof m[key] !== "string") {
      throw new SnsVerificationError(`The message's ${key} is not text.`);
    }
  }
  return {
    Type: m.Type as string,
    MessageId: m.MessageId as string,
    TopicArn: m.TopicArn as string,
    Message: m.Message as string,
    Timestamp: m.Timestamp as string,
    SignatureVersion: m.SignatureVersion as string,
    Signature: m.Signature as string,
    SigningCertURL: m.SigningCertURL as string,
    Subject: typeof m.Subject === "string" ? m.Subject : undefined,
    SubscribeURL: typeof m.SubscribeURL === "string" ? m.SubscribeURL : undefined,
    Token: typeof m.Token === "string" ? m.Token : undefined,
  };
}

/** Is this an https URL on SNS's own host for the region? */
export function isSnsUrl(value: string, region: string, { pem }: { pem: boolean }): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === `sns.${region}.amazonaws.com` &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (!pem || url.pathname.endsWith(".pem"))
  );
}

/** The text SNS signs, field by field, in its fixed order. */
export function stringToSign(message: SnsMessage): string {
  const fields =
    message.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : (["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const);
  let out = "";
  for (const field of fields) {
    const value = message[field];
    if (value === undefined) {
      if (field === "Subject") continue;
      throw new SnsVerificationError(`A ${message.Type} needs ${field} to be verified.`);
    }
    out += `${field}\n${value}\n`;
  }
  return out;
}

export type CertificateKeyFetcher = (url: string) => Promise<KeyObject>;

const certificates = new Map<string, Promise<KeyObject>>();
const MAX_CERTIFICATES = 20;

/** Fetch SNS's signing certificate (cached by URL) and return its public key. */
export const fetchSigningKey: CertificateKeyFetcher = (url) => {
  const cached = certificates.get(url);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new SnsVerificationError(`The signing certificate answered ${response.status}.`);
    const pem = await response.text();
    if (pem.length > 20_000) throw new SnsVerificationError("The signing certificate is too large.");
    const certificate = new X509Certificate(pem);
    if (new Date(certificate.validTo).getTime() < Date.now()) {
      throw new SnsVerificationError("The signing certificate has expired.");
    }
    return certificate.publicKey;
  })();
  pending.catch(() => certificates.delete(url));
  if (certificates.size >= MAX_CERTIFICATES) certificates.clear();
  certificates.set(url, pending);
  return pending;
};

/**
 * Throw unless the message is from the trusted topic and SNS signed it.
 */
export async function verifySnsMessage(
  message: SnsMessage,
  trustedTopicArn: string,
  getKey: CertificateKeyFetcher = fetchSigningKey,
): Promise<void> {
  if (message.TopicArn !== trustedTopicArn) throw new SnsVerificationError("The message is from another topic.");
  const region = topicRegion(message.TopicArn);
  if (!region) throw new SnsVerificationError("The topic ARN is not an SNS topic's.");
  if (message.SignatureVersion !== "2") throw new SnsVerificationError("Only signature version 2 is accepted.");
  if (!isSnsUrl(message.SigningCertURL, region, { pem: true })) {
    throw new SnsVerificationError("The signing certificate is not on SNS's host for the topic's region.");
  }
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(message.Type)) {
    throw new SnsVerificationError("Unknown SNS message type.");
  }
  const signature = Buffer.from(message.Signature, "base64");
  if (signature.length === 0) throw new SnsVerificationError("The signature is empty.");
  const key = await getKey(message.SigningCertURL);
  const ok = verify("RSA-SHA256", Buffer.from(stringToSign(message), "utf8"), key, signature);
  if (!ok) throw new SnsVerificationError("The signature does not verify.");
}

/**
 * Follow a verified subscription confirmation's SubscribeURL, which must be
 * on SNS's host for the topic's region.
 */
export async function confirmSubscription(
  message: SnsMessage,
  get: (url: string) => Promise<{ ok: boolean; status: number }> = (url) =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }),
): Promise<boolean> {
  const region = topicRegion(message.TopicArn);
  if (!region || !message.SubscribeURL || !isSnsUrl(message.SubscribeURL, region, { pem: false })) {
    throw new SnsVerificationError("The SubscribeURL is not on SNS's host for the topic's region.");
  }
  const response = await get(message.SubscribeURL);
  return response.ok;
}

/**
 * What an SES event (the configuration set's event publishing format) says
 * about one message, or null for an event the outbox does not act on (a send,
 * an open, a click) or one it cannot read.
 */
export function sesEventFromNotification(message: string): SesTranscriptEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const event = raw as {
    eventType?: unknown;
    mail?: { messageId?: unknown };
    bounce?: { bounceType?: unknown; bouncedRecipients?: { diagnosticCode?: unknown }[] };
    complaint?: { complaintFeedbackType?: unknown };
    reject?: { reason?: unknown };
    failure?: { errorMessage?: unknown };
    deliveryDelay?: { delayType?: unknown };
  };
  const messageId = typeof event.mail?.messageId === "string" ? event.mail.messageId : null;
  if (!messageId) return null;
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 500) : undefined);
  switch (event.eventType) {
    case "Delivery":
      return { messageId, type: "delivery" };
    case "Bounce":
      return {
        messageId,
        type: "bounce",
        bounceType: text(event.bounce?.bounceType),
        reason: text(event.bounce?.bouncedRecipients?.[0]?.diagnosticCode),
      };
    case "Complaint":
      return { messageId, type: "complaint", reason: text(event.complaint?.complaintFeedbackType) };
    case "Reject":
      return { messageId, type: "reject", reason: text(event.reject?.reason) };
    case "Rendering Failure":
      return { messageId, type: "rendering_failure", reason: text(event.failure?.errorMessage) };
    case "DeliveryDelay":
      return { messageId, type: "delay", reason: text(event.deliveryDelay?.delayType) };
    default:
      return null;
  }
}

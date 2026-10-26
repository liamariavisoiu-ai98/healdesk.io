/**
 * SES's receipt notice, as the S3 action publishes it to the inbound topic
 * (infra/aws/ses-inbound.tf) and SNS posts it to /api/webhooks/inbound-mail
 * (lane P7g).
 *
 * The notice names SES's message id, where the message was written, and the
 * verdicts SES reached (spam, virus, SPF, DKIM, DMARC). It also carries the
 * message's headers, the sender and the subject: those are never read from
 * here. Only the fields below leave this function, and the message itself is
 * read from the bucket.
 */

export type Verdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "DISABLED" | "UNKNOWN";

export type InboundNotice = {
  /** SES's own id for the message: the idempotency key, and the object key under the prefix. */
  sesMessageId: string;
  bucket: string;
  key: string;
  /** When SES received it. */
  receivedAt: Date;
  verdicts: { spam: Verdict; virus: Verdict; spf: Verdict; dkim: Verdict; dmarc: Verdict };
};

const VERDICTS: readonly Verdict[] = ["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"];
const SES_ID = /^[A-Za-z0-9._-]{1,128}$/;

function verdict(value: unknown): Verdict {
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status === "string" && (VERDICTS as readonly string[]).includes(status) ? (status as Verdict) : "UNKNOWN";
}

/**
 * The notice's facts, or null for anything else (a test notice SES sends when
 * the rule is created, an action other than S3, a malformed body).
 */
export function inboundNoticeFrom(message: string, now: Date): InboundNotice | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const n = raw as {
    notificationType?: unknown;
    mail?: { messageId?: unknown; timestamp?: unknown };
    receipt?: {
      timestamp?: unknown;
      action?: { type?: unknown; bucketName?: unknown; objectKey?: unknown };
      spamVerdict?: unknown;
      virusVerdict?: unknown;
      spfVerdict?: unknown;
      dkimVerdict?: unknown;
      dmarcVerdict?: unknown;
    };
  };
  if (n.notificationType !== "Received") return null;
  const id = n.mail?.messageId;
  const action = n.receipt?.action;
  if (typeof id !== "string" || !SES_ID.test(id)) return null;
  if (action?.type !== "S3" || typeof action.bucketName !== "string" || typeof action.objectKey !== "string") return null;
  const at = new Date(typeof n.receipt?.timestamp === "string" ? n.receipt.timestamp : String(n.mail?.timestamp ?? ""));
  return {
    sesMessageId: id,
    bucket: action.bucketName,
    key: action.objectKey,
    receivedAt: Number.isNaN(at.getTime()) ? now : at,
    verdicts: {
      spam: verdict(n.receipt?.spamVerdict),
      virus: verdict(n.receipt?.virusVerdict),
      spf: verdict(n.receipt?.spfVerdict),
      dkim: verdict(n.receipt?.dkimVerdict),
      dmarc: verdict(n.receipt?.dmarcVerdict),
    },
  };
}

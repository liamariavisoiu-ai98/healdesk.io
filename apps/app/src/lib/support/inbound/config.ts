/**
 * Inbound support mail's settings (ops automation Phase 7, lane P7g; design
 * E5 §2.1): read from the environment only, as everything in apps/app.
 *
 *   HEALDESK_INBOUND_MAIL_TOPIC_ARN  the SNS topic SES tells us on
 *                                    (infra/aws/ses-inbound.tf). The one
 *                                    switch for the webhook: unset, it
 *                                    answers 404 and does nothing.
 *   HEALDESK_INBOUND_MAIL_BUCKET     the bucket SES writes each message to,
 *                                    under INBOUND_PREFIX. Unset, the sweep
 *                                    has nothing to read.
 *
 * Neither is a secret: Terraform sets both as plain task environment.
 */

/** Where SES writes each message in the bucket (the receipt rule's object_key_prefix). */
export const INBOUND_PREFIX = "mail/";

/**
 * The largest message parsed: anything over it is kept as a case from its
 * header block alone, with no facts from its body (`oversize`), and is never
 * parsed whole. 2 MB holds a support email with a screenshot or two; the
 * words read from any message are cut to MAX_WORDS_CHARS (parse.ts) besides,
 * so the work per message stays bounded. SES receiving itself accepts up to
 * 40 MB.
 */
export const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

/** The topic this host trusts for inbound mail, or null when the feature is off here. */
export function inboundMailTopicArn(): string | null {
  const arn = process.env.HEALDESK_INBOUND_MAIL_TOPIC_ARN?.trim();
  return arn ? arn : null;
}

/** The bucket SES writes inbound mail to, or null when it is not set up here. */
export function inboundMailBucket(): string | null {
  const bucket = process.env.HEALDESK_INBOUND_MAIL_BUCKET?.trim();
  return bucket ? bucket : null;
}

/** An object key SES wrote: under the prefix, a plain id, nothing that climbs out of it. */
export function isInboundKey(key: string): boolean {
  return key.startsWith(INBOUND_PREFIX) && /^mail\/[A-Za-z0-9._-]{1,200}$/.test(key);
}

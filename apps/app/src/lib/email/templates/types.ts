/**
 * The shape every email template has (Annex X4): a pure function of the stored
 * payload and a small context, returning both renderings.
 *
 * Pure, and rendered only from what was stored, so a retry inside Resend's
 * 24-hour idempotency window sends exactly the bytes the first attempt sent
 * (X1.4). That is why the context carries `raisedAt` and never a clock: a
 * template that printed "today" from `new Date()` would render differently on
 * the retry, and Resend would refuse the second request as a different body
 * under the same key.
 */

/** Who the clinic's customers are, for wording: people, or the owners of animals. */
export type EmailAudience = "patients" | "clients";

export type TemplateContext = {
  /** The clinic the email is about, or null for mail that has none (ops alerts). */
  clinicName: string | null;
  audience: EmailAudience;
  /** Why this address gets this email: one sentence, printed in the footer (X1.9). */
  reason: string;
  /**
   * The one-click way to stop it, for an optional or commercial kind; absent
   * otherwise. The sender builds it, and the List-Unsubscribe headers from it.
   */
  unsubscribeUrl?: string;
  /** When the notice was raised: the only time a template may print or reckon from. */
  raisedAt: Date;
  /** The clinic's IANA time zone, for any date printed in the body. */
  timeZone: string;
};

export type RenderedEmail = {
  /** At most 70 characters, no links (X4). */
  subject: string;
  /** The hidden line inbox lists show after the subject. */
  preheader: string;
  /** The plain-text body, written first (X1.8). */
  text: string;
  /** The HTML twin, built from the same blocks: one column, system fonts, no images. */
  html: string;
};

/**
 * A template. `P` is the payload's type; the payload allowlist in lib/email/
 * lint.ts checks the same payload at runtime, because a jsonb column is not a
 * type.
 */
export type EmailTemplate<P = Readonly<Record<string, unknown>>> = (
  payload: P,
  ctx: TemplateContext,
) => RenderedEmail;

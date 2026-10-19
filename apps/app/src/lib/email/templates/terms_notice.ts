import { isTermsChangeTopic, TERMS_CHANGE_TOPICS, type TermsChangeTopic } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { dayLong, dayShort } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L28: a change to the Terms of Service or to prices (Annex X5), an operator
 * broadcast from /admin at least 30 days before it applies (Terms §4: "Price
 * changes apply from your next renewal and are announced by email at least
 * 30 days beforehand; you may cancel before they take effect"; §16: a change
 * that affects the practice's rights or fees "takes effect at your next
 * renewal; continuing past that renewal accepts it").
 *
 * Mandatory, with no unsubscribe: it is the notice the Terms promise, so it
 * is transactional and has no switch (lib/email/kinds.ts).
 *
 * Fixed fields only (lib/notices/operator-notices.ts): the new version, the
 * date it applies from and what it is about, from the catalog's closed list.
 * The full text is the published page, healdesk.io/terms, which the operator
 * confirms is up before the notice can go; it is named, not linked, because
 * an email from apps/app links only to apps/app's public origin (X1.6), as the
 * welcome email names it. The one link is Billing, where Auto-renew is.
 */

export type TermsNoticePayload = {
  /** The new Terms version, as its page prints it ("2026-11-20.1"). */
  version: string;
  /** The day it applies from, YYYY-MM-DD: at least 30 days after the notice. */
  effectiveOn: string;
  /** What it changes, from TERMS_CHANGE_TOPICS. */
  topicRows: readonly { code: TermsChangeTopic }[];
  /** publicUrl("/c/<slug>/billing"), where Auto-renew is. */
  billingUrl: string;
};

export const renderTermsNotice: EmailTemplate<TermsNoticePayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  if (payload.topicRows.length === 0) {
    throw new EmailCompositionError("A terms notice names at least one thing it changes.");
  }
  const topics = payload.topicRows.map((row) => {
    if (!isTermsChangeTopic(row.code)) {
      throw new EmailCompositionError(`Unknown terms topic "${String(row.code)}".`);
    }
    return TERMS_CHANGE_TOPICS[row.code];
  });
  const from = dayLong(payload.effectiveOn, ctx);

  return compose(
    {
      subject: `healdesk's terms are changing on ${dayShort(payload.effectiveOn, ctx)}`,
      preheader: "The changes apply from your first renewal on or after that day.",
      blocks: [
        {
          type: "paragraph",
          text: `We're updating healdesk's Terms of Service. The new version, ${payload.version}, applies to ${clinic} from your first renewal on or after ${from}.`,
        },
        { type: "paragraph", text: "It changes:" },
        { type: "list", items: topics },
        {
          type: "paragraph",
          text: "You can read the new version in full at healdesk.io/terms, where its version and date are printed at the foot of the page.",
        },
        {
          type: "paragraph",
          text: "If you'd rather not continue under it, turn Auto-renew off in Billing before that renewal. Your plan then ends when the period you've paid for runs out, and nothing more is charged. Staying on past that renewal accepts the new terms.",
        },
        { type: "action", label: "Open Billing", url: payload.billingUrl },
        { type: "paragraph", text: "Questions about the change? Reply to this email." },
      ],
    },
    ctx,
  );
};

export const TERMS_NOTICE_ENTRY: TemplateEntry<TermsNoticePayload> = {
  render: renderTermsNotice,
  get fixture(): TermsNoticePayload {
    return {
      version: "2026-11-20.1",
      effectiveOn: "2026-11-20",
      topicRows: [{ code: "fees" }, { code: "refunds" }],
      billingUrl: publicUrl("/c/radiance-med-spa/billing"),
    };
  },
};

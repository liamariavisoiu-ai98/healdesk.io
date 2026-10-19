import {
  GUARANTEE_FAILURES,
  isGuaranteeFailure,
  type GuaranteeFailure,
  type GuaranteeOutcome,
} from "@healdesk/catalog";

import { dayLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L30, the first-month guarantee's two emails (Annex X5; Terms §5), each an
 * operator action from /admin:
 *
 *   - claim received: it gives the day of our finding, ten business days
 *     from the claim, as §5 promises ("We tell you our finding within 10
 *     business days of your claim");
 *   - our finding: the result, the day the refund is made (within 14 days of
 *     the finding of a miss) and what failed (§5: "we refund your first
 *     month's subscription fee ... and tell you what failed").
 *
 * The refund itself is the billing panel's (commitRefund, kind `guarantee`);
 * these only say so. What failed comes from the catalog's closed list,
 * worded as §5 names the suppliers. No call or message is described: the
 * claim's own dates and times stay in the practice's reply thread.
 */

export type GuaranteeClaimReceivedPayload = {
  /** The day the claim reached us (YYYY-MM-DD). */
  claimReceivedOn: string;
  /** The day our finding is due (YYYY-MM-DD): ten business days later. */
  findingByOn: string;
};

export type GuaranteeFindingPayload = {
  /** The claim this answers (YYYY-MM-DD), so the practice can match the two. */
  claimReceivedOn: string;
  outcome: GuaranteeOutcome;
  /** When a miss was found: the day the refund is made by (YYYY-MM-DD). */
  refundByOn: string | null;
  /** When a miss was found: what failed, from GUARANTEE_FAILURES. */
  code: GuaranteeFailure | null;
};

export const renderGuaranteeClaimReceived: EmailTemplate<GuaranteeClaimReceivedPayload> = (
  payload,
  ctx,
) => {
  const clinic = ctx.clinicName ?? "your practice";
  const by = dayLong(payload.findingByOn, ctx);
  return compose(
    {
      subject: "We've got your guarantee claim",
      preheader: `We'll tell you our finding by ${by}.`,
      blocks: [
        {
          type: "paragraph",
          text: `We've received ${clinic}'s claim under healdesk's first-month guarantee, dated ${dayLong(payload.claimReceivedOn, ctx)}.`,
        },
        {
          type: "paragraph",
          text: `We're checking our own records, and any record you've sent us. We'll tell you our finding by ${by}.`,
        },
        {
          type: "paragraph",
          text: "If you have a call record from your phone carrier, or a screenshot of an unanswered message, reply with it. Send dates and times, not names: black out every phone number except its last four digits, and never send a transcript.",
        },
        {
          type: "paragraph",
          text: "You don't have to cancel to claim. The service carries on as normal meanwhile.",
        },
      ],
    },
    ctx,
  );
};

export const renderGuaranteeFinding: EmailTemplate<GuaranteeFindingPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const claimed = dayLong(payload.claimReceivedOn, ctx);

  if (payload.outcome === "miss_found") {
    if (!payload.refundByOn || !isGuaranteeFailure(payload.code)) {
      throw new EmailCompositionError("A miss names what failed and the day of the refund.");
    }
    const by = dayLong(payload.refundByOn, ctx);
    return compose(
      {
        subject: "Your guarantee claim: we found a miss and will refund you",
        preheader: `Your first month's subscription fee is refunded by ${by}.`,
        blocks: [
          {
            type: "paragraph",
            text: `We've checked ${clinic}'s claim of ${claimed} under the first-month guarantee. We found a call or message that was routed to AYA and wasn't answered.`,
          },
          {
            type: "facts",
            rows: [
              ["What failed", GUARANTEE_FAILURES[payload.code]],
              [
                "Your refund",
                "your first month's subscription fee, to the payment method you paid with",
              ],
              ["Refunded by", by],
            ],
          },
          {
            type: "paragraph",
            text: "This refund is the remedy for a call or message missed in your first month. It doesn't limit your rights under your data agreement, or for anything other than the missed call or message itself.",
          },
          {
            type: "paragraph",
            text: "You don't have to cancel: the service carries on as normal. Questions about the finding? Reply to this email.",
          },
        ],
      },
      ctx,
    );
  }

  if (payload.outcome !== "no_miss_found") {
    throw new EmailCompositionError(`Unknown finding "${String(payload.outcome)}".`);
  }
  return compose(
    {
      subject: "Your guarantee claim: our finding",
      preheader: "We found no call or message that went unanswered.",
      blocks: [
        {
          type: "paragraph",
          text: `We've checked ${clinic}'s claim of ${claimed} under the first-month guarantee, against our own records and any record you sent us. We found no call or message that was routed to AYA and went unanswered, so no refund is due under the guarantee.`,
        },
        {
          type: "paragraph",
          text: "If you have a record we haven't seen, or you'd like us to go through what we checked, reply to this email.",
        },
      ],
    },
    ctx,
  );
};

export const GUARANTEE_CLAIM_RECEIVED_ENTRY: TemplateEntry<GuaranteeClaimReceivedPayload> = {
  render: renderGuaranteeClaimReceived,
  fixture: { claimReceivedOn: "2026-11-12", findingByOn: "2026-11-26" },
};

export const GUARANTEE_FINDING_ENTRY: TemplateEntry<GuaranteeFindingPayload> = {
  render: renderGuaranteeFinding,
  fixture: {
    claimReceivedOn: "2026-11-12",
    outcome: "miss_found",
    refundByOn: "2026-12-03",
    code: "telephony_and_speech",
  },
};

import { isSuspensionCause, SUSPENSION_CAUSES, type SuspensionCause } from "@healdesk/catalog";

import { momentLong, WHEN_AYA_STOPS } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L31: the service suspended for a legal or security reason (Annex X5), an
 * operator action from /admin. Critical, like billing's `suspended`: AYA has
 * stopped answering from the moment it was queued.
 *
 * Terms §15: healdesk may suspend "immediately if your use creates a legal or
 * security risk, telling you why". The why is one of the catalog's closed
 * causes (SUSPENSION_CAUSES), never words typed in the console. The
 * suspension is the billing state machine's `suspended`, with a reason that
 * is not one of not paying, so a payment does not lift it (settlePayment);
 * an operator lifts it from the billing panel once the risk is dealt with.
 * So the email never says paying restores anything.
 *
 * It says what still works, as the Terms do for every suspension (§6, §8):
 * calls reach the direct line, chat becomes a contact form, the data is
 * kept and the portal still signs in.
 */

export type SuspendedForCausePayload = {
  /** Why, from SUSPENSION_CAUSES. */
  code: SuspensionCause;
  /** When it took effect. */
  suspendedAt: string;
};

export const renderSuspendedForCause: EmailTemplate<SuspendedForCausePayload> = (payload, ctx) => {
  if (!isSuspensionCause(payload.code)) {
    throw new EmailCompositionError(`Unknown suspension cause "${String(payload.code)}".`);
  }
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Your healdesk service is suspended: here's why",
      preheader: "AYA has stopped answering. Reply and we'll tell you what's needed.",
      blocks: [
        {
          type: "paragraph",
          text: `We suspended ${clinic}'s healdesk service at ${momentLong(payload.suspendedAt, ctx)}. Our Terms of Service let us do that at once when use of the service creates a legal or security risk, and say we tell you why.`,
        },
        { type: "paragraph", text: `Why: ${SUSPENSION_CAUSES[payload.code].sentence}` },
        {
          type: "paragraph",
          text: `AYA has stopped answering: ${WHEN_AYA_STOPS}. Your data is kept, and you can still sign in to healdesk.`,
        },
        {
          type: "paragraph",
          text: "Paying an invoice doesn't lift this suspension. Reply to this email and we'll tell you what's needed to restore the service.",
        },
      ],
    },
    ctx,
  );
};

export const SUSPENDED_FOR_CAUSE_ENTRY: TemplateEntry<SuspendedForCausePayload> = {
  render: renderSuspendedForCause,
  fixture: { code: "account_compromised", suspendedAt: "2026-10-14T16:20:00Z" },
};

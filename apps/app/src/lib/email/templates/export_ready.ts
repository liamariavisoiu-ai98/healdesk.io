import { publicUrl } from "@/lib/public-url";

import { dayLong, dayShort, people } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";

/**
 * E4, "Your export is ready" (Annex X5), once per clinic, when its service
 * has ended (lib/offboarding/after-cancellation.ts queues it from the hourly
 * tick). Terms §7 says "we deliver an export", so it is not waiting to be
 * asked for, and E2 has told the clinic this email is coming.
 *
 * A pointer, never the export: the file holds every patient record the
 * clinic has, so it is never attached. The link goes to the export on
 * Conversations, behind the sign-in and the passkey step-up; the export is
 * built there in full from the records as they stand, and only a download
 * that reaches the browser whole records it as delivered (lib/portal/
 * conversations.ts), which is what the destruction clock reads.
 *
 * The dates are destructionPlan's (lib/offboarding), by the rule of the
 * agreement the service ended under, and say what E2 said: the last day to
 * download it, and the day the data is gone whatever happens.
 */

export type ExportReadyPayload = {
  /** destructionPlan's exportByOn: the last whole day before any run can destroy the data. */
  exportByOn: string;
  /** destructionPlan's destroyByOn: the day by which the data is gone whatever happens. */
  destroyByOn: string;
  /** The export on Conversations, on the public origin. */
  exportUrl: string;
};

/** Where the export is and why it is not in the email: E4's and E5's shared lines. */
export function exportIsInThePortal(payload: { exportUrl: string }, ctx: TemplateContext): Block[] {
  return [
    {
      type: "paragraph",
      text: `It isn't attached to this email, because it holds your ${people(ctx)}' details. To download it, sign in, open Conversations and confirm it's you with Face ID or your screen lock.`,
    },
    { type: "action", label: "Download your export", url: payload.exportUrl },
  ];
}

export const renderExportReady: EmailTemplate<ExportReadyPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: "Your healdesk export is ready",
      preheader: `Download it from the portal by ${dayShort(payload.exportByOn, ctx)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `The export of ${clinic}'s records is ready: every conversation, booking request and appointment healdesk holds for your practice, with any amendments and the log of who opened what, as one file.`,
        },
        ...exportIsInThePortal(payload, ctx),
        {
          type: "paragraph",
          text: `Download it by ${dayLong(payload.exportByOn, ctx)}. We destroy our copies of your data within 30 days of your export being delivered, and by ${dayLong(payload.destroyByOn, ctx)} at the latest. Billing records are kept, as tax law requires.`,
        },
      ],
    },
    ctx,
  );
};

export const EXPORT_READY_ENTRY: TemplateEntry<ExportReadyPayload> = {
  render: renderExportReady,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): ExportReadyPayload {
    return {
      exportByOn: "2026-12-04",
      destroyByOn: "2027-02-04",
      exportUrl: publicUrl("/c/radiance-med-spa/conversations#export"),
    };
  },
};

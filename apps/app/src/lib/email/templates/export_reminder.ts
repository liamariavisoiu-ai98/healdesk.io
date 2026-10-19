import { publicUrl } from "@/lib/public-url";

import { dayLong, dayShort } from "./billing-copy";
import { compose } from "./compose";
import { exportIsInThePortal } from "./export_ready";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E5, "Download your export by {date}" (Annex X5): seven days before the
 * clinic's data is destroyed whether or not the export was downloaded, and
 * only while it has not been (lib/offboarding/after-cancellation.ts queues
 * it; lib/email/superseded.ts closes it unsent if a download is recorded
 * before it goes).
 *
 * The two dates are true however the next week goes: the last whole day on
 * which a download can still beat the destruction (the day before the
 * plan's latest destruction), and the day the data is gone at the latest.
 * A pointer, like E4: the export is only ever in the portal.
 */

export type ExportReminderPayload = {
  /** The day before the latest destruction: the last whole day a download is sure to beat it. */
  downloadByOn: string;
  /** destructionPlan's destroyByOn: the day by which the data is gone whatever happens. */
  destroyByOn: string;
  /** The export on Conversations, on the public origin. */
  exportUrl: string;
};

export const renderExportReminder: EmailTemplate<ExportReminderPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  return compose(
    {
      subject: `Download your healdesk export by ${dayShort(payload.downloadByOn, ctx)}`,
      preheader: `We destroy our copies of your data by ${dayShort(payload.destroyByOn, ctx)}, downloaded or not.`,
      blocks: [
        {
          type: "paragraph",
          text: `The export of ${clinic}'s records hasn't been downloaded yet. Download it by ${dayLong(payload.downloadByOn, ctx)}: we destroy our copies of your data by ${dayLong(payload.destroyByOn, ctx)}, whether or not it has been downloaded, and after that there is nothing left to export.`,
        },
        ...exportIsInThePortal(payload, ctx),
      ],
    },
    ctx,
  );
};

export const EXPORT_REMINDER_ENTRY: TemplateEntry<ExportReminderPayload> = {
  render: renderExportReminder,
  // A getter, so the link is built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): ExportReminderPayload {
    return {
      downloadByOn: "2027-02-02",
      destroyByOn: "2027-02-04",
      exportUrl: publicUrl("/c/radiance-med-spa/conversations#export"),
    };
  },
};

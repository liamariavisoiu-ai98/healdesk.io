import { audienceSingular, CHANNEL_NAMES } from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";
import { actionLine } from "@/lib/setup/channels";
import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError, type Block } from "./compose";
import { noteLine } from "./contact-words";
import type { TemplateEntry } from "./registry";
import type { SetupReminderRow } from "./setup_reminder";
import type { EmailTemplate } from "./types";
import { helpLine } from "./welcome";

/**
 * O18, "More time to finish setting up AYA" (design E2, "Wording: clinic
 * emails"; ops automation lane P6f): the owner gave a clinic more days to
 * finish setup. Sent only through the approval inbox, and only after the
 * extension itself went through (lib/approvals/contact-executors.ts runs
 * extendSetupDeadline first and queues this only on `extended`), so it never
 * says "extended" for an extension that failed.
 *
 * It names the new last day of the window, the days given and what is left,
 * in the setup reminder's own action lines. An outbox kind, so no token:
 * "Continue setup" opens the wizard behind sign-in. The only editable part is
 * the day count (which is the extension) and one approved closing sentence
 * (./contact-words.ts NOTES).
 */

export type SetupExtendedPayload = {
  /** The new last day of the setup window, an ISO date on the clinic's calendar. */
  closesOn: string;
  /** The days the deadline moved, 1 to 30. */
  extendedDays: number;
  stepsLeftCount: number;
  /** One row per bought channel not yet live, as the reminder names them. */
  rows: SetupReminderRow[];
  /** publicUrl("/c/<slug>/setup"). */
  setupUrl: string;
  helpPhoneE164: string | null;
  /** One approved closing sentence (./contact-words.ts NOTES), or none. */
  note: string | null;
};

/** The wizard's steps left first, then each channel's one action: the setup reminder's lines. */
export function setupActions(payload: Pick<SetupExtendedPayload, "stepsLeftCount" | "rows">): string[] {
  const actions: string[] = [];
  if (payload.stepsLeftCount > 0) {
    actions.push(
      payload.stepsLeftCount === 1 ? "Finish setup: one step left" : `Finish setup: ${payload.stepsLeftCount} steps left`,
    );
  }
  for (const row of payload.rows) {
    if (row.status === "finish_setup" && payload.stepsLeftCount > 0) continue;
    const action = actionLine(row.channel, row.status);
    actions.push(
      action
        ? `${CHANNEL_NAMES[row.channel]}: ${action}`
        : `${CHANNEL_NAMES[row.channel]}: we're preparing it, nothing for you to do`,
    );
  }
  return actions;
}

export const renderSetupExtended: EmailTemplate<SetupExtendedPayload> = (payload, ctx) => {
  if (!Number.isInteger(payload.extendedDays) || payload.extendedDays < 1 || payload.extendedDays > 30) {
    throw new EmailCompositionError("An extension is 1 to 30 days.");
  }
  const clinic = ctx.clinicName ?? "your practice";
  const days = payload.extendedDays === 1 ? "1 more day" : `${payload.extendedDays} more days`;
  const actions = setupActions(payload);
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `We've given you ${days}: you now have until the end of ${formatReplyBy(payload.closesOn)} to finish setting up AYA for ${clinic}.${actions.length > 0 ? " What's left:" : ""}`,
    },
  ];
  if (actions.length > 0) blocks.push({ type: "list", items: actions });
  blocks.push({ type: "action", label: "Continue setup", url: payload.setupUrl });
  blocks.push({
    type: "paragraph",
    text: "If something on your side is in the way, reply to this email and we'll sort it out with you.",
  });
  const note = noteLine(payload.note);
  if (note) blocks.push({ type: "paragraph", text: note });
  blocks.push({ type: "paragraph", text: helpLine(payload, audienceSingular(ctx.audience)) });
  return compose(
    {
      subject: "More time to finish setting up AYA",
      preheader: `You now have until ${formatReplyBy(payload.closesOn)} to finish setup.`,
      blocks,
    },
    ctx,
  );
};

export const SETUP_EXTENDED_ENTRY: TemplateEntry<SetupExtendedPayload> = {
  render: renderSetupExtended,
  get fixture(): SetupExtendedPayload {
    return {
      closesOn: "2026-11-20",
      extendedDays: 14,
      stepsLeftCount: 1,
      rows: [
        { channel: "voice", status: "forwarding" },
        { channel: "web", status: "finish_setup" },
      ],
      setupUrl: publicUrl("/c/radiance-med-spa/setup"),
      helpPhoneE164: "+18885550100",
      note: null,
    };
  },
};

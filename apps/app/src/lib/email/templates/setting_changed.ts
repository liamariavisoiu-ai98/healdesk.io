import { publicUrl } from "@/lib/public-url";

import { momentLong } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * O4: "Setting changed" (Annex X5), to the clinic's address, when a setting
 * that decides where calls go is changed after it was first set (plan Part
 * D4): the direct line, where every call goes whenever AYA can't answer, and
 * the transfer number, where a live call is put through; and when the time
 * transcripts are kept is shortened (Records), which removes the older ones
 * at the next nightly purge where the purge runs for the clinic, and says it
 * waits for the clean-up where it doesn't. Each change needs a
 * passkey step-up on a device the clinic added, so the email names that
 * device, says when, and shows the number before and after, masked to its
 * last four digits.
 *
 * Its job is to let the clinic notice a change it did not make. It is not
 * sent for a value set the first time, and Stripe's connect and disconnect
 * have their own email (O14), as do devices (O3) and the sign-in address
 * (O5). Exports join with Conversations (M5).
 *
 * An outbox kind: no token, and the action opens Settings behind sign-in.
 */

export type SettingChangedField =
  "direct_line_e164" | "transfer_e164" | "transcript_retention_days";

export type SettingChangedPayload = {
  field: SettingChangedField;
  /** The number before, masked ("(•••) •••-0177"); null when it was the default. */
  beforeMasked: string | null;
  /** The number after, masked; null when it went back to the default. */
  afterMasked: string | null;
  /** For transcript retention: the days kept before and after, in place of the numbers. */
  beforeDays?: number;
  afterDays?: number;
  /**
   * For transcript retention: whether the nightly purge runs for this clinic
   * (nightlyPurgeRuns in lib/portal/settings.ts). Absent or false, the email
   * promises no removal, since none will happen until the clean-up is on.
   */
  willPurgeTonight?: boolean;
  changedAt: string;
  /** The device whose passkey made the change, as staff named it. */
  deviceName?: string;
  /** publicUrl("/c/<slug>/settings#…"), the card the setting is on. */
  settingsUrl: string;
};

const WORDS: Record<
  SettingChangedField,
  { name: string; subject: string; does: string; empty: string }
> = {
  direct_line_e164: {
    name: "direct line",
    subject: "Your direct line was changed",
    does: "Calls go to this number whenever AYA can't answer: while she's paused, while phone is off, and if anything fails.",
    empty: "not set",
  },
  transfer_e164: {
    name: "transfer number",
    subject: "Your transfer number was changed",
    does: "When live transfers are on, AYA puts callers through to this number during your opening hours.",
    // A transfer number left empty is the direct line (Settings → Alerts).
    empty: "your direct line",
  },
  transcript_retention_days: {
    name: "transcript retention",
    subject: "Your transcripts are now kept for less time",
    does: "Each night healdesk removes transcripts older than this from your records, with the raw call and message data behind them. Lengthening it again won't bring them back.",
    empty: "90 days",
  },
};

/** The transcript change's line while the nightly clean-up doesn't run for the clinic: no removal is promised. */
const RETENTION_WAITING =
  "Transcripts older than this will be removed from your records once healdesk's nightly clean-up is on for your account. Until then, nothing is removed.";

export const renderSettingChanged: EmailTemplate<SettingChangedPayload> = (payload, ctx) => {
  const words = WORDS[payload.field];
  if (!words) {
    throw new EmailCompositionError(`Unknown setting "${String(payload.field)}".`);
  }
  const clinic = ctx.clinicName ?? "your practice";
  const when = momentLong(payload.changedAt, ctx);
  const by = payload.deviceName ? `, from “${payload.deviceName}”` : "";
  const days = (n: number | undefined) => (typeof n === "number" ? `${n} days` : null);
  const before = days(payload.beforeDays) ?? payload.beforeMasked ?? words.empty;
  const after = days(payload.afterDays) ?? payload.afterMasked ?? words.empty;

  return compose(
    {
      subject: words.subject,
      preheader: `It was changed at ${when}${by}.`,
      blocks: [
        {
          type: "paragraph",
          text: `The ${words.name} for ${clinic} was changed at ${when}${by}.`,
        },
        {
          type: "facts",
          rows: [
            ["Before", before],
            ["Now", after],
          ],
        },
        {
          type: "paragraph",
          text:
            payload.field === "transcript_retention_days" && payload.willPurgeTonight !== true
              ? RETENTION_WAITING
              : words.does,
        },
        { type: "action", label: "See your settings", url: payload.settingsUrl },
        {
          type: "paragraph",
          text: "If that wasn't someone at your clinic, change it back in Settings and reply to this email, and we'll check what happened.",
        },
      ],
    },
    ctx,
  );
};

export const SETTING_CHANGED_ENTRY: TemplateEntry<SettingChangedPayload> = {
  render: renderSettingChanged,
  get fixture(): SettingChangedPayload {
    return {
      field: "direct_line_e164",
      beforeMasked: "(•••) •••-0177",
      afterMasked: "(•••) •••-0188",
      changedAt: "2026-10-12T14:32:00Z",
      deviceName: "Front desk Mac",
      settingsUrl: publicUrl("/c/radiance-med-spa/settings#safety-net"),
    };
  },
};

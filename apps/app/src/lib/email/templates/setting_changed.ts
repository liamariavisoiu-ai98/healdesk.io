import {
  RESET_OPENERS,
  resetNotice,
  UNLOCK_REASONS,
  type RuledSwitch,
  type SwitchUnlock,
} from "@/lib/portal/switch-rules";
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
 * (O5).
 *
 * It is also sent for each export from the portal (plan Part D4: "exports";
 * Annex X5's O4 row: "or an export"), which needs the same passkey: the
 * whole clinic's records (`clinic_export`), or one person's
 * (`person_export`), from Conversations. An export has no before and after,
 * so it says what was exported, when and from which device, never whose
 * records, and links to the devices in Settings, where a device the clinic
 * doesn't know can be removed.
 *
 * And it is sent when payment switches were set back on their own
 * (`payment_switches_reset`; owner, 28 October 2026): turning Auto-confirm
 * off, or losing the calendar or the Stripe account, returns full payment to
 * deposit only and switches off what can no longer work, in the same
 * transaction (lib/portal/switch-resets.ts). The email names each switch and
 * the one reason, in the words the Settings page uses (switch-rules.ts).
 *
 * An outbox kind: no token, and the action opens Settings behind sign-in.
 */

export type SettingChangedField =
  | "direct_line_e164"
  | "transfer_e164"
  | "transcript_retention_days"
  | "clinic_export"
  | "person_export"
  | "payment_switches_reset";

/** The fields that are an export rather than a setting. */
export const EXPORT_FIELDS = ["clinic_export", "person_export"] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

function isExportField(field: SettingChangedField): field is ExportField {
  return (EXPORT_FIELDS as readonly string[]).includes(field);
}

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
  /** publicUrl("/c/<slug>/settings#…"), the card the setting is on (Sign-in, for an export). */
  settingsUrl: string;
  /** For payment_switches_reset: the switches set back (switch-rules.ts RuledSwitch ids). */
  switchIds?: RuledSwitch[];
  /** For payment_switches_reset: what would unlock them again (switch-rules.ts SwitchUnlock). */
  code?: SwitchUnlock;
  /**
   * For payment_switches_reset after a Stripe disconnect that Stripe did not
   * confirm: the switches went off first, but the account is still
   * connected, so the email must not say it was disconnected.
   */
  isStripeStillConnected?: boolean;
};

const WORDS: Record<
  Exclude<SettingChangedField, ExportField | "payment_switches_reset">,
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

/** O4 for an export: what was exported, when and from which device; never whose. */
const renderExported: EmailTemplate<SettingChangedPayload & { field: ExportField }> = (
  payload,
  ctx,
) => {
  const clinic = ctx.clinicName ?? "your practice";
  const when = momentLong(payload.changedAt, ctx);
  const by = payload.deviceName ? `, from “${payload.deviceName}”` : "";
  const person = ctx.audience === "clients" ? "client" : "patient";
  const whole = payload.field === "clinic_export";
  return compose(
    {
      subject: whole ? "Your records were exported" : `A ${person}'s records were exported`,
      preheader: `They were downloaded at ${when}${by}.`,
      blocks: [
        {
          type: "paragraph",
          text: whole
            ? `An export of all of ${clinic}'s records was downloaded from Conversations at ${when}${by}.`
            : `An export of one ${person}'s records at ${clinic} was downloaded from Conversations at ${when}${by}.`,
        },
        {
          type: "paragraph",
          text: "Exports need Face ID or a screen lock on a device your clinic added, so this one came from a device on your sign-in.",
        },
        { type: "action", label: "See your devices", url: payload.settingsUrl },
        {
          type: "paragraph",
          text: "If that wasn't someone at your clinic, remove the device in Settings and reply to this email, and we'll check what happened.",
        },
      ],
    },
    ctx,
  );
};

/** What happened, by what would put it right again: closed words, never the clinic's own. */
const RESET_CAUSES: Readonly<Record<SwitchUnlock, string>> = {
  connect_stripe: "Your Stripe account was disconnected",
  connect_calendar: "Your calendar was disconnected",
  turn_on_auto_confirm: "Auto-confirm bookings was turned off",
  set_deposit: "No treatment asks for a deposit any more",
};

/** O4 for payment switches set back on their own. */
const renderSwitchesReset: EmailTemplate<SettingChangedPayload> = (payload, ctx) => {
  const code = payload.code;
  const switches = (payload.switchIds ?? []).filter((s): s is RuledSwitch => s in RESET_OPENERS);
  if (!code || !(code in UNLOCK_REASONS) || switches.length === 0) {
    throw new EmailCompositionError("A payment reset names its switches and its reason.");
  }
  const clinic = ctx.clinicName ?? "your practice";
  const when = momentLong(payload.changedAt, ctx);
  const one = switches.length === 1;
  if (payload.isStripeStillConnected) {
    return compose(
      {
        subject: one ? "A payment setting was switched off" : "Some payment settings were switched off",
        preheader: `Stripe didn't confirm the disconnection, so your account is still connected.`,
        blocks: [
          {
            type: "paragraph",
            text: `We started disconnecting the Stripe account for ${clinic} at ${when} and switched ${one ? "this setting" : "these settings"} off first:`,
          },
          { type: "list", items: switches.map((s) => resetNotice(s, null)) },
          {
            type: "paragraph",
            text: `Stripe didn't confirm the disconnection, so your Stripe account is still connected. Try disconnecting again in Settings to finish, or switch ${one ? "it" : "them"} back on there to keep using Stripe.`,
          },
          { type: "action", label: "See your settings", url: payload.settingsUrl },
        ],
      },
      ctx,
    );
  }
  return compose(
    {
      subject: one ? "A payment setting was switched off" : "Some payment settings were switched off",
      preheader: `${RESET_CAUSES[code]}, so we changed ${one ? "it" : "them"} at ${when}.`,
      blocks: [
        {
          type: "paragraph",
          text: `${RESET_CAUSES[code]} for ${clinic} at ${when}, so we changed ${one ? "this setting" : "these settings"} straight away:`,
        },
        { type: "list", items: switches.map((s) => resetNotice(s, UNLOCK_REASONS[code])) },
        {
          type: "paragraph",
          text: `Once that's put right, you can switch ${one ? "it" : "them"} back on in Settings.`,
        },
        { type: "action", label: "See your settings", url: payload.settingsUrl },
      ],
    },
    ctx,
  );
};

export const renderSettingChanged: EmailTemplate<SettingChangedPayload> = (payload, ctx) => {
  if (payload.field === "payment_switches_reset") return renderSwitchesReset(payload, ctx);
  if (isExportField(payload.field)) {
    return renderExported(payload as SettingChangedPayload & { field: ExportField }, ctx);
  }
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

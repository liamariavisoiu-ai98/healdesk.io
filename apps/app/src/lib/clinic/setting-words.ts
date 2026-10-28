import { ASSISTANT_TONE_OPTIONS, COVERAGE_MODE_OPTIONS } from "@healdesk/catalog";

/**
 * The closed words for a clinic's Settings switches (owner, 28 October 2026):
 * what each one is called, what kind it is, the choices a choice offers, and
 * the closed token a value is recorded and alerted as. Pure, and importing
 * nothing of the app, so the ops alert's wording (lib/ops/alert-wording) and
 * the change recorder (./setting-changes.ts) read one list without a cycle.
 *
 * Keyed by the contract's names (lib/portal/settings.ts SETTING_KEYS, plus
 * `auto_confirm`, the calendar card's switch). An entry whose key is not yet
 * a setting is simply never offered: the lists that use this one start from
 * SETTING_KEYS. Business data about the practice; never a patient, and never
 * a text setting's words (a greeting, a number), which are named by label
 * alone.
 */

export type SwitchKind = "switch" | "choice" | "text";
export type SwitchOption = { id: string; label: string };

export type SettingEntry = {
  label: string;
  kind: SwitchKind;
  /** A choice's options, in the order the portal offers them. */
  options?: readonly SwitchOption[];
  /**
   * False when only the clinic may change it in its own Settings: where calls
   * go (the direct line and the transfer number need its passkey step-up)
   * and which calls reach AYA (the clinic's forwarding steps follow it).
   */
  operatorMayChange: boolean;
};

/** How long a slot waits for its deposit: the portal's own choices (Settings, Payments). */
export const HOLD_MINUTE_OPTIONS: readonly SwitchOption[] = [
  { id: "30", label: "30 minutes" },
  { id: "60", label: "1 hour" },
  { id: "120", label: "2 hours" },
  { id: "240", label: "4 hours" },
  { id: "1440", label: "24 hours" },
];

const on = (label: string): SettingEntry => ({ label, kind: "switch", operatorMayChange: true });
const text = (label: string, operatorMayChange = true): SettingEntry => ({ label, kind: "text", operatorMayChange });

export const SETTING_ENTRIES: Readonly<Record<string, SettingEntry>> = {
  channel_web: on("Website chat"),
  channel_instagram: on("Instagram"),
  channel_messenger: on("Messenger"),
  channel_whatsapp: on("WhatsApp"),
  channel_voice: on("Phone"),
  coverage_mode: {
    label: "Which calls reach AYA",
    kind: "choice",
    options: COVERAGE_MODE_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
    operatorMayChange: false,
  },
  tone: {
    label: "Tone",
    kind: "choice",
    options: ASSISTANT_TONE_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
    operatorMayChange: true,
  },
  phone_greeting: text("Phone greeting"),
  chat_greeting: text("Website chat greeting"),
  short_name: text("What patients call you"),
  languages: text("Languages"),
  suggest_add_ons: on("Suggest add-on treatments"),
  mention_promotions: on("Mention promotions"),
  deposits_enabled: on("Take deposits"),
  book_voice_without_deposit: on("Book by phone without a deposit"),
  book_chat_without_deposit: on("Book by chat without a deposit"),
  deposit_uncollectable: {
    label: "When a deposit can't be collected",
    kind: "choice",
    options: [
      { id: "book_and_flag", label: "Book and flag" },
      { id: "hold_and_alert", label: "Hold the slot and alert staff" },
      { id: "decline_and_alert", label: "Do not book and alert staff" },
    ],
    operatorMayChange: true,
  },
  deposit_hold_minutes: {
    label: "How long a slot waits for its deposit",
    kind: "choice",
    options: HOLD_MINUTE_OPTIONS,
    operatorMayChange: true,
  },
  text_payment_link: on("Text the payment link"),
  payment_ask: {
    label: "What the assistant asks the patient to pay",
    kind: "choice",
    options: [
      { id: "deposit_only", label: "Deposit only" },
      { id: "full_payment", label: "Full payment" },
    ],
    operatorMayChange: true,
  },
  direct_line: text("Direct line", false),
  urgent_help: text("Urgent help number"),
  vet_referral: text("Emergency referral clinic"),
  daily_summary: on("Daily summary email"),
  transfer_live_calls: on("Transfer live calls"),
  transfer_number: text("Transfer number", false),
  auto_confirm: on("Auto-confirm bookings"),
};

/** The plain label of every setting a change can name (the ops alert's `setting` words). */
export const SETTING_CHANGE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SETTING_ENTRIES).map(([key, entry]) => [key, entry.label]),
);

/** Every closed value token, in words (the ops alert's `before` and `after`). */
export const SETTING_VALUE_WORDS: Readonly<Record<string, string>> = Object.fromEntries([
  ["on", "on"],
  ["off", "off"],
  ...Object.values(SETTING_ENTRIES).flatMap((entry) =>
    (entry.options ?? []).map((o) => [o.id, o.label.toLowerCase()] as const),
  ),
]);

/** Who made a change, in words (the ops alert's `actor`; schema.ts CLINIC_CHANGE_ACTORS). */
export const CHANGE_ACTOR_WORDS: Readonly<Record<string, string>> = {
  clinic_device: "the clinic, from one of its devices",
  clinic_signin: "the clinic",
  ops: "an operator at healdesk",
  support: "a support action at healdesk",
  change_file: "a change file",
  direct: "an edit outside the portal",
  system: "healdesk, automatically, because something it needs was lost",
};

/**
 * A value as its closed token: "on" or "off" for a switch, the option's id
 * for a choice it offers; undefined for a text setting or a value off the
 * list, which is then recorded and alerted without its value.
 */
export function settingValueToken(key: string, value: unknown): string | undefined {
  const entry = SETTING_ENTRIES[key];
  if (!entry) return undefined;
  if (entry.kind === "switch") return typeof value === "boolean" ? (value ? "on" : "off") : undefined;
  if (entry.kind === "choice") {
    const id = typeof value === "number" ? String(value) : value;
    return typeof id === "string" && entry.options?.some((o) => o.id === id) ? id : undefined;
  }
  return undefined;
}

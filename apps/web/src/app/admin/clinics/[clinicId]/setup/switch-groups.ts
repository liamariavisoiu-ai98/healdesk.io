import type { ClinicSwitchView } from "@/lib/admin/ops-client";

/**
 * How the Clinic switches panel groups what apps/app sends, in the portal's own
 * cards. This is layout only: which card a key sits under. Whether a switch is
 * available, and why not, is never decided here; it is the server's `enabled`
 * and `reason`, shown as sent. A key this list does not know still shows, last,
 * under "Other", so a switch added upstream is never hidden.
 */
export const SWITCH_GROUPS: { title: string; keys: readonly string[] }[] = [
  { title: "Channels", keys: ["channel_web", "channel_instagram", "channel_messenger", "channel_whatsapp", "channel_voice", "coverage_mode"] },
  { title: "How the assistant talks", keys: ["tone", "greetings", "short_name", "languages", "suggest_add_ons", "mention_promotions"] },
  {
    title: "Bookings and payments",
    keys: [
      "auto_confirm",
      "deposits_enabled",
      "payment_ask",
      "text_payment_link",
      "book_voice_without_deposit",
      "book_chat_without_deposit",
      "deposit_uncollectable",
      "deposit_hold_minutes",
    ],
  },
  { title: "Alerts", keys: ["daily_summary", "urgent_help", "vet_referral", "direct_line", "transfer_number", "transfer_live_calls"] },
];

export const OTHER_GROUP = "Other";

/**
 * The options of the choices an operator may set. The contract sends a
 * choice's current value only, so a choice not listed here is shown and not
 * offered for change rather than guessed at.
 */
export const CHOICE_OPTIONS: Record<string, { value: string; label: string }[]> = {
  payment_ask: [
    { value: "deposit_only", label: "Deposit only" },
    { value: "full_payment", label: "Full payment" },
  ],
};

export function groupSwitches(switches: ClinicSwitchView[]): { title: string; rows: ClinicSwitchView[] }[] {
  const known = new Set(SWITCH_GROUPS.flatMap((g) => g.keys));
  const groups = SWITCH_GROUPS.map((g) => ({
    title: g.title,
    rows: g.keys.map((k) => switches.find((s) => s.key === k)).filter((s): s is ClinicSwitchView => s !== undefined),
  }));
  groups.push({ title: OTHER_GROUP, rows: switches.filter((s) => !known.has(s.key)) });
  return groups.filter((g) => g.rows.length > 0);
}

/** The value as the operator reads it: on or off for a switch, the option's label for a choice. */
export function valueWords(row: ClinicSwitchView): string {
  if (row.kind === "switch") return row.value === true ? "On" : "Off";
  const option = CHOICE_OPTIONS[row.key]?.find((o) => o.value === row.value);
  return option?.label ?? String(row.value);
}

import type { ClinicSwitchView } from "@/lib/admin/ops-client";

/**
 * How the Clinic switches panel groups what apps/app sends, in the portal's own
 * cards (apps/app SettingsCards.tsx and CalendarCard.tsx). This is layout only:
 * which card a key sits under. Whether a switch is available, and why not, is
 * never decided here; it is the server's `enabled` and `reason`, shown as sent,
 * and a choice's options are the server's too. A key this list does not know
 * still shows, last, under "Other", so a switch added upstream is never hidden.
 */
export const SWITCH_GROUPS: { title: string; keys: readonly string[] }[] = [
  { title: "Channels", keys: ["channel_web", "channel_instagram", "channel_messenger", "channel_whatsapp", "channel_voice", "coverage_mode"] },
  { title: "How AYA talks", keys: ["tone", "suggest_add_ons", "mention_promotions"] },
  { title: "Calendar", keys: ["auto_confirm"] },
  {
    title: "Payments",
    keys: [
      "deposits_enabled",
      "book_voice_without_deposit",
      "book_chat_without_deposit",
      "deposit_uncollectable",
      "deposit_hold_minutes",
      "text_payment_link",
      "payment_ask",
    ],
  },
  { title: "Alerts", keys: ["daily_summary", "transfer_live_calls"] },
];

export const OTHER_GROUP = "Other";

export function groupSwitches(switches: ClinicSwitchView[]): { title: string; rows: ClinicSwitchView[] }[] {
  const known = new Set(SWITCH_GROUPS.flatMap((g) => g.keys));
  const groups = SWITCH_GROUPS.map((g) => ({
    title: g.title,
    rows: g.keys.map((k) => switches.find((s) => s.key === k)).filter((s): s is ClinicSwitchView => s !== undefined),
  }));
  groups.push({ title: OTHER_GROUP, rows: switches.filter((s) => !known.has(s.key)) });
  return groups.filter((g) => g.rows.length > 0);
}

/** The value as the operator reads it: on or off for a switch, the server's option label for a choice. */
export function valueWords(row: ClinicSwitchView): string {
  if (row.kind === "switch") return row.value === true ? "On" : "Off";
  return row.options?.find((o) => o.id === row.value)?.label ?? String(row.value);
}

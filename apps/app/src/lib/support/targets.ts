import { CHANNEL_NAMES } from "@healdesk/catalog";

import { isBuiltSection, sectionPath, type PortalSection } from "@/lib/portal/nav";
import {
  SENSITIVE_SETTINGS,
  SETTING_CHANNELS,
  SETTING_KEYS,
  type SettingKey,
} from "@/lib/portal/settings";
import { publicUrl } from "@/lib/public-url";
import { GREETING_LABELS, META_GREETING_NOTE } from "@/lib/setup/greetings";

/**
 * Where the support chat may send someone (`link_to`, plan Part H): every
 * switch in the Settings registry (lib/portal/settings.ts, SETTING_KEYS), by
 * the card it sits on, and the portal's screens and their sections. Each link
 * is built from publicUrl(), the app's public origin, never HEALDESK_APP_URL
 * (CLAUDE.md, "Two environment variables decide origins"), and only to a
 * screen this build has (isBuiltSection), so the chat never hands out a link
 * that 404s.
 *
 * SETTING_PLACES is a Record over SettingKey, so a switch added to the
 * registry without a place here fails the typecheck, and the help text's
 * settings reference (help-text.ts), generated from the same table, can never
 * miss one.
 */

/** The cards on Settings, by their element ids (app/c/[slug]/settings). */
export type SettingsCard =
  "channels" | "how-aya-talks" | "calendar" | "payments" | "safety-net" | "alerts" | "sign-in";

export const SETTINGS_CARD_TITLES: Readonly<Record<SettingsCard, string>> = {
  channels: "Channels",
  "how-aya-talks": "How AYA talks",
  calendar: "Calendar",
  payments: "Payments",
  "safety-net": "Safety net",
  alerts: "Alerts",
  "sign-in": "Sign-in",
};

export type SettingPlace = { card: SettingsCard; label: string; does: string };

/** Each switch: its card, its label as the page shows it, and what it does in one line. */
export const SETTING_PLACES: Readonly<Record<SettingKey, SettingPlace>> = {
  channel_web: {
    card: "channels",
    label: "Website chat",
    does: "On or off. Off shows a contact form on your website instead.",
  },
  channel_instagram: {
    card: "channels",
    label: "Instagram",
    does: "Shows once Instagram is connected. Off leaves messages for your team to answer in the app.",
  },
  channel_messenger: {
    card: "channels",
    label: "Messenger",
    does: "Shows once Messenger is connected. Off leaves messages for your team to answer in the app.",
  },
  channel_whatsapp: {
    card: "channels",
    label: "WhatsApp",
    does: "Shows once WhatsApp is connected. Off leaves messages for your team to answer in the app.",
  },
  channel_voice: {
    card: "channels",
    label: "Phone",
    does: "On or off. Off sends calls to your direct line.",
  },
  coverage_mode: {
    card: "channels",
    label: "Which calls reach AYA",
    does: "All calls; Overflow and after hours (the default: your team answers first); or After hours only. Your call forwarding steps follow this choice.",
  },
  tone: {
    card: "how-aya-talks",
    label: "Tone",
    does: "How AYA speaks on every channel.",
  },
  phone_greeting: {
    card: "how-aya-talks",
    label: GREETING_LABELS.phone,
    does: "What AYA says first on a call. The line saying she is an AI assistant and that the call is transcribed is always said and can't be edited out.",
  },
  chat_greeting: {
    card: "how-aya-talks",
    label: GREETING_LABELS.chat,
    does: `What AYA writes first in a website chat. The line saying she is an AI assistant is always there and can't be edited out. ${META_GREETING_NOTE}`,
  },
  short_name: {
    card: "how-aya-talks",
    label: "What patients call you",
    does: "The short name AYA uses after saying your full name once, on every channel. Leave it empty and she works one out from your full name.",
  },
  languages: {
    card: "how-aya-talks",
    label: "Languages",
    does: "AYA answers in the language each person uses, from the ones ticked.",
  },
  suggest_add_ons: {
    card: "how-aya-talks",
    label: "Suggest add-on treatments",
    does: "Off by default. On lets AYA suggest complementary services during a booking, on phone and website chat.",
  },
  mention_promotions: {
    card: "how-aya-talks",
    label: "Mention promotions",
    does: "Whether AYA uses what you write in Knowledge → Promotions, on phone and website chat.",
  },
  deposits_enabled: {
    card: "payments",
    label: "Take deposits",
    does: "Whether AYA can ask for a deposit at all. Needs your payment account connected. In chat she sends a secure payment link; on a call she books and flags the deposit for your team.",
  },
  book_voice_without_deposit: {
    card: "payments",
    label: "Book by phone without a deposit",
    does: "On: AYA books and flags the deposit for your team. Off: she passes the caller to your team instead.",
  },
  book_chat_without_deposit: {
    card: "payments",
    label: "Book by chat without a deposit",
    does: "On: AYA books and flags the deposit. Off: she sends the payment link first.",
  },
  deposit_uncollectable: {
    card: "payments",
    label: "When a deposit can't be collected",
    does: "Book and flag; hold the slot and alert staff; or do not book and alert staff. A channel's own book-without-a-deposit switch decides first.",
  },
  deposit_hold_minutes: {
    card: "payments",
    label: "How long a slot is held for its deposit",
    does: "How long a slot waits for the deposit to be paid through the link.",
  },
  direct_line: {
    card: "safety-net",
    label: "Direct line",
    does: "The number calls go to whenever AYA can't answer: a pause, a channel switched off, an outage, the end of service. It must not forward back to us. Changing it once set needs your device's passkey.",
  },
  urgent_help: {
    card: "safety-net",
    label: "A number people can call for urgent help",
    does: "The number AYA gives with 911 when someone describes something urgent.",
  },
  vet_referral: {
    card: "safety-net",
    label: "Your emergency referral clinic",
    does: "For veterinary practices: the emergency clinic AYA refers urgent cases to.",
  },
  daily_summary: {
    card: "alerts",
    label: "Daily summary email",
    does: "At the start of each working day: what AYA handled, booked and escalated, with a link to each booking and request.",
  },
  transfer_live_calls: {
    card: "alerts",
    label: "Transfer live calls",
    does: "On lets AYA put a caller through to a person during your opening hours.",
  },
  transfer_number: {
    card: "alerts",
    label: "Transfer number",
    does: "Where transferred calls go. Changing it once set needs your device's passkey.",
  },
};

/** The places that are not a single switch: a screen, a section of one, or a Settings card. */
export const SCREEN_TARGETS = {
  home: { section: "home", hash: "", label: "Home" },
  build_tracker: { section: "home", hash: "#tracker", label: "Home → Building your AYA" },
  setup: { section: null, hash: "", label: "Setup" },
  settings: { section: "settings", hash: "", label: "Settings" },
  settings_channels: { section: "settings", hash: "#channels", label: "Settings → Channels" },
  settings_talk: { section: "settings", hash: "#how-aya-talks", label: "Settings → How AYA talks" },
  settings_calendar: { section: "settings", hash: "#calendar", label: "Settings → Calendar" },
  settings_payments: { section: "settings", hash: "#payments", label: "Settings → Payments" },
  settings_safety_net: { section: "settings", hash: "#safety-net", label: "Settings → Safety net" },
  settings_alerts: { section: "settings", hash: "#alerts", label: "Settings → Alerts" },
  settings_sign_in: { section: "settings", hash: "#sign-in", label: "Settings → Sign-in" },
  knowledge: { section: "knowledge", hash: "", label: "Knowledge" },
  conversations: { section: "conversations", hash: "", label: "Conversations" },
  bookings: { section: "bookings", hash: "", label: "Bookings" },
  billing: { section: "billing", hash: "", label: "Billing" },
} as const satisfies Record<string, { section: PortalSection | null; hash: string; label: string }>;

export type ScreenTarget = keyof typeof SCREEN_TARGETS;

/** Every value `link_to` accepts, in a fixed order (the tool's enum, so the prompt cache holds). */
export const LINK_TARGETS: readonly (ScreenTarget | SettingKey)[] = [
  ...(Object.keys(SCREEN_TARGETS) as ScreenTarget[]),
  ...SETTING_KEYS,
];

export function isLinkTarget(value: unknown): value is ScreenTarget | SettingKey {
  return typeof value === "string" && (LINK_TARGETS as readonly string[]).includes(value);
}

export type SupportLink = { label: string; url: string };

/**
 * The link for a target on clinic `slug`, or null when this build has no such
 * screen. Throws PublicUrlError only where publicUrl() does: in production
 * with no public origin set.
 */
export function linkTo(slug: string, target: ScreenTarget | SettingKey): SupportLink | null {
  if (Object.prototype.hasOwnProperty.call(SCREEN_TARGETS, target)) {
    const screen = SCREEN_TARGETS[target as ScreenTarget];
    if (screen.section === null) return { label: screen.label, url: publicUrl(`/c/${slug}/setup`) };
    if (!isBuiltSection(screen.section)) return null;
    return {
      label: screen.label,
      url: publicUrl(`${sectionPath(slug, screen.section)}${screen.hash}`),
    };
  }
  const place = SETTING_PLACES[target as SettingKey];
  return {
    label: `Settings → ${SETTINGS_CARD_TITLES[place.card]} → ${place.label}`,
    url: publicUrl(`${sectionPath(slug, "settings")}#${place.card}`),
  };
}

/**
 * The settings reference the help text carries (help-text.ts): every switch,
 * where it is, what it does, which channels it belongs to and whether it
 * needs a passkey to change. Generated, so it follows the registry.
 */
export function settingsReference(): string {
  const lines = ["## Every setting, and where it is", ""];
  for (const key of SETTING_KEYS) {
    const place = SETTING_PLACES[key];
    const channels = SETTING_CHANNELS[key].map((c) => CHANNEL_NAMES[c]).join(", ");
    const stepUp = SENSITIVE_SETTINGS.has(key)
      ? " Needs a passkey step-up to change once set."
      : "";
    lines.push(
      `- ${place.label} (link_to "${key}"): Settings → ${SETTINGS_CARD_TITLES[place.card]}. ${place.does} Shown when the practice bought: ${channels}.${stepUp}`,
    );
  }
  return lines.join("\n");
}

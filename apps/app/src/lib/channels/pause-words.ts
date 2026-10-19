import type { Channel } from "@healdesk/catalog";

import type { MetaPlatform } from "@/lib/meta/front-door";
import { formatPhone } from "@/lib/setup/help";

/**
 * The header's "AYA is answering" switch, in words and instants (plan Part
 * F0; spec, "Every switch in the portal": "On / Off for 1 hour, until
 * tomorrow morning, or until switched back"). Pure: the portal's header, its
 * server action and L15 (lib/email/templates/ai_paused.ts) all word a pause
 * from here, so the switch and the email about it never disagree.
 *
 * lib/channels/pause.ts writes the pause; this file only says what it is.
 */

/** The three ways to turn AYA off from the header. */
export type PauseChoice = "hour" | "tomorrow" | "indefinite";

export const PAUSE_CHOICES: readonly { id: PauseChoice; label: string }[] = [
  { id: "hour", label: "For 1 hour" },
  { id: "tomorrow", label: "Until tomorrow 8 am" },
  { id: "indefinite", label: "Until I turn it back on" },
];

export function isPauseChoice(value: unknown): value is PauseChoice {
  return typeof value === "string" && PAUSE_CHOICES.some((c) => c.id === value);
}

const HOUR_MS = 60 * 60 * 1000;

/** The hour of the clinic's morning that "until tomorrow" ends at. */
export const TOMORROW_HOUR = 8;

/**
 * When a pause chosen at `now` ends by itself, or null for "until I turn it
 * back on". "Until tomorrow 8 am" is 08:00 on the clinic's next calendar day,
 * on its own wall clock, so a daylight-saving change overnight moves the
 * instant and never the hour on the clinic's clocks.
 */
export function pauseEndFor(choice: PauseChoice, now: Date, timeZone: string): Date | null {
  switch (choice) {
    case "hour":
      return new Date(now.getTime() + HOUR_MS);
    case "tomorrow":
      return atLocalTime(addDays(localDate(now, timeZone), 1), TOMORROW_HOUR, timeZone);
    case "indefinite":
      return null;
  }
}

/**
 * Whether a pause is long enough for L15 (Annex X5): one until tomorrow or
 * until someone turns AYA back on emails the clinic; one for an hour does
 * not. Judged by its length rather than by which button was pressed, so a
 * pause the console sets (lib/ops/billing.ts) follows the same rule: longer
 * than an hour, or open-ended. A minute's slack keeps "for 1 hour" itself
 * on the quiet side whatever the clock did between the two reads.
 */
export function pauseEmailsClinic(pausedAt: Date, until: Date | null): boolean {
  return until === null || until.getTime() - pausedAt.getTime() > HOUR_MS + 60_000;
}

// -----------------------------------------------------------------------------
// What each channel does while AYA is off
// -----------------------------------------------------------------------------

/**
 * The order the lines are given in: phone first, because a call is the one
 * a patient waits on, then website chat, then the Meta apps.
 */
export const PAUSE_LINE_ORDER: readonly Channel[] = ["voice", "web", "meta"];

const PLATFORM_NAMES: Readonly<Record<MetaPlatform, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
};

/** A channel, or one Meta app, as the clinic names it: "Phone", "Instagram". */
export function pausedChannelName(channel: Channel, platform: MetaPlatform | null = null): string {
  if (channel === "meta" && platform) return PLATFORM_NAMES[platform];
  switch (channel) {
    case "voice":
      return "Phone";
    case "web":
      return "Website chat";
    case "meta":
      return "Instagram, Messenger & WhatsApp";
  }
}

/**
 * One channel's line while AYA is off, worded from what that channel really
 * does then (lib/billing/answering.ts's fallbacks): phone transfers to the
 * direct line, website chat shows its contact form, and a message on the
 * Meta apps waits for the team there. A live phone line always has a direct
 * line (lib/billing/settings.ts refuses to clear it); were it ever missing,
 * the call is answered with the safe script, and the line says so rather
 * than promise a transfer to nowhere.
 */
export function fallbackLine(
  channel: Channel,
  directLineE164: string | null,
  platform: MetaPlatform | null = null,
): string {
  const name = pausedChannelName(channel, platform);
  switch (channel) {
    case "voice":
      return directLineE164
        ? `${name}: calls go to your direct line (${formatPhone(directLineE164)})`
        : `${name}: AYA only takes a message for your team, because no direct line is set`;
    case "web":
      return `${name}: shows a contact form`;
    case "meta":
      return platform
        ? `${name}: messages wait for your team in ${name}`
        : `${name}: messages wait for your team in the apps`;
  }
}

// -----------------------------------------------------------------------------
// The banner
// -----------------------------------------------------------------------------

/**
 * "Paused from Front desk Mac at 9:14 am, until 10:14 am." The device is the
 * pause's own label (clinic_settings.ai_paused_by_label: the device whose
 * passkey was live, the sign-in, or healdesk support), and every time is on
 * the clinic's clock, with the day named once it is not today.
 */
/**
 * The pause's label while a practice owes its updated agreement
 * (lib/agreements/resign.ts), which clinic_settings.ai_paused_by_label holds:
 * the banner then says healdesk paused AYA and that the pause ends when the
 * agreement is signed, not when someone turns her back on. The header's
 * switch is refused meanwhile by the open re-sign itself (lib/channels/
 * pause.ts), never by this label.
 */
export const AGREEMENT_PAUSE_LABEL = "healdesk (agreement to sign)";

export function pauseBanner(
  pause: { pausedAt: Date; byLabel: string | null; until: Date | null },
  timeZone: string,
  now: Date,
): string {
  if (pause.byLabel === AGREEMENT_PAUSE_LABEL && pause.until === null) {
    return `Paused by healdesk at ${pauseClock(pause.pausedAt, timeZone, now)}, until your updated agreement is signed.`;
  }
  const from = pause.byLabel ? ` from ${pause.byLabel}` : "";
  const end = pause.until
    ? `until ${pauseClock(pause.until, timeZone, now)}`
    : "until someone turns AYA back on";
  return `Paused${from} at ${pauseClock(pause.pausedAt, timeZone, now)}, ${end}.`;
}

/**
 * A pause's moment as the header says it: "9:14 am" today, "8 am tomorrow",
 * "4:05 pm yesterday", else "9:14 am on Tuesday 13 October".
 */
export function pauseClock(at: Date, timeZone: string, now: Date): string {
  const zone = safeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = get("minute");
  const clock = `${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toLowerCase()}`;
  const day = localDate(at, zone);
  const today = localDate(now, zone);
  if (day === today) return clock;
  if (day === addDays(today, 1)) return `${clock} tomorrow`;
  if (day === addDays(today, -1)) return `${clock} yesterday`;
  const named = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
  return `${clock} on ${named.replace(",", "")}`;
}

// -----------------------------------------------------------------------------
// The clinic's clock
// -----------------------------------------------------------------------------

/** A zone Intl accepts; a clinic's bad zone reads as New York, as the portal's dates do. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/New_York";
  }
}

/** The clinic-local calendar date of an instant, YYYY-MM-DD. */
function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** YYYY-MM-DD plus whole days, on the calendar rather than the clock. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant the clinic's wall clock reads `hour`:00 on `date`. */
function atLocalTime(date: string, hour: number, timeZone: string): Date {
  const zone = safeZone(timeZone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour);
  // The wall time less the zone's offset; twice, because the offset at a
  // first guess can be the other side of a change.
  let guess = wall - offsetMs(new Date(wall), zone);
  guess = wall - offsetMs(new Date(guess), zone);
  return new Date(guess);
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

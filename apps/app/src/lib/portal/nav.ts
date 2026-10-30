/**
 * The clinic portal's menu (plan Part F0; spec, "Portal map"): six screens,
 * nothing nested more than one level deep, in the spec's order.
 *
 * Conversations and Bookings hold patient details and are built with step-up
 * enforcement in M5. Until one exists, or while the clinic has nothing for it
 * to show, it is a menu entry that says it opens after go-live, never a link:
 * a menu item that goes nowhere breaks the rule that every link works the day
 * it ships, and one that 404s reads as a broken product. A built patient
 * screen links once the clinic `opened` it: a channel has gone live, or there
 * is already something to show (lib/portal/page.ts, openPatientScreens). One
 * not built yet, once a channel is live, says where what it will hold reaches
 * the clinic meanwhile, per live channel, rather than promising an opening
 * that has already happened. Any other screen is listed only once it exists,
 * and every link into a screen asks `isBuiltSection` first, so no build ships
 * a link to a page it does not have.
 *
 * Pure, so the menu is one table test.
 */

import type { Channel } from "@healdesk/catalog";

export type PortalSection =
  "home" | "settings" | "knowledge" | "conversations" | "bookings" | "billing";

export type NavItem =
  | { section: PortalSection; label: string; href: string; current: boolean }
  /** An entry that is not a link yet, with the line that says when it opens. */
  | { section: PortalSection; label: string; href: null; current: false; note: string };

const SECTIONS: readonly { section: PortalSection; label: string; path: string }[] = [
  { section: "home", label: "Home", path: "" },
  { section: "settings", label: "Settings", path: "/settings" },
  { section: "knowledge", label: "Knowledge", path: "/knowledge" },
  { section: "conversations", label: "Conversations", path: "/conversations" },
  { section: "bookings", label: "Bookings", path: "/bookings" },
  { section: "billing", label: "Billing", path: "/billing" },
];

/** The screens that exist in this build. */
const BUILT: ReadonlySet<PortalSection> = new Set<PortalSection>([
  "home",
  "settings",
  "knowledge",
  "conversations",
  "bookings",
  "billing",
]);

/** The patient screens, which open after go-live (M5). */
const AFTER_GO_LIVE: ReadonlySet<PortalSection> = new Set<PortalSection>([
  "conversations",
  "bookings",
]);

/** What a patient screen says instead of linking before any channel is live. */
export const OPENS_AFTER_GO_LIVE = "Opens after go-live";

/** What Bookings says after go-live until its screen is built: requests go to the desk (lib/meta/booking-requests.ts). */
export const BOOKINGS_BY_EMAIL = "Each request is emailed to your team";

/**
 * What Conversations says after go-live until its screen is built, for the
 * channels that are live: a call's and a website chat's transcript is
 * emailed to the clinic's address (lib/conversations/transcript-outbox.ts);
 * an Instagram, Messenger or WhatsApp conversation is never emailed, and
 * stays in the app it happened in.
 */
export function conversationsUntilBuilt(live: readonly Channel[]): string {
  const emailed = [
    ...(live.includes("voice") ? ["call"] : []),
    ...(live.includes("web") ? ["website chat"] : []),
  ];
  const meta = live.includes("meta");
  const transcripts =
    emailed.length > 0 ? `Each ${emailed.join(" and ")} transcript is emailed to you` : "";
  if (!meta) return transcripts || "Each transcript is emailed to you";
  const dms = "Instagram, Messenger and WhatsApp messages stay in those apps";
  return transcripts ? `${transcripts}; ${dms}` : dms;
}

/**
 * The one sentence under the menu for the patient screens not open yet
 * (PortalShell.tsx, 30 October 2026; until then each was a greyed tile that
 * looked like a button and did nothing): "Conversations and Bookings open
 * after go-live." when that is what each says, else each screen's own line,
 * one sentence apiece. Empty when every screen is a link.
 */
export function notYetLine(items: readonly NavItem[]): string {
  const waiting = items.filter((item): item is Extract<NavItem, { href: null }> => item.href === null);
  const opening = waiting.filter((item) => item.note === OPENS_AFTER_GO_LIVE).map((item) => item.label);
  const parts: string[] = [];
  if (opening.length > 0) {
    const list = opening.length > 1 ? `${opening.slice(0, -1).join(", ")} and ${opening.at(-1)}` : opening[0]!;
    parts.push(`${list} ${opening.length > 1 ? "open" : "opens"} after go-live.`);
  }
  for (const item of waiting) {
    if (item.note !== OPENS_AFTER_GO_LIVE) parts.push(`${item.label}: ${item.note}.`);
  }
  return parts.join(" ");
}

/** The path of a section on a clinic's portal. */
export function sectionPath(slug: string, section: PortalSection): string {
  const entry = SECTIONS.find((s) => s.section === section);
  return `/c/${slug}${entry?.path ?? ""}`;
}

/** Whether a section is a screen in this build. */
export function isBuiltSection(section: PortalSection): boolean {
  return BUILT.has(section);
}

/**
 * The menu for the clinic `slug`, in order, with `active` marked. `opened` is
 * which patient screens the clinic has opened (openPatientScreens); a built
 * one not in it still says when it opens. `liveChannels` are the channels
 * that have gone live: with any, a patient screen not built yet says where
 * its contents go meanwhile instead.
 */
export function portalNav(
  slug: string,
  active: PortalSection | null,
  opened: readonly PortalSection[] = [],
  liveChannels: readonly Channel[] = [],
): NavItem[] {
  const items: NavItem[] = [];
  for (const { section, label } of SECTIONS) {
    if (BUILT.has(section) && (!AFTER_GO_LIVE.has(section) || opened.includes(section))) {
      items.push({ section, label, href: sectionPath(slug, section), current: section === active });
    } else if (AFTER_GO_LIVE.has(section)) {
      const note =
        !BUILT.has(section) && liveChannels.length > 0
          ? section === "bookings"
            ? BOOKINGS_BY_EMAIL
            : conversationsUntilBuilt(liveChannels)
          : OPENS_AFTER_GO_LIVE;
      items.push({ section, label, href: null, current: false, note });
    }
  }
  return items;
}

/**
 * The clinic portal's menu (plan Part F0; spec, "Portal map"): six screens,
 * nothing nested more than one level deep, in the spec's order.
 *
 * Conversations and Bookings hold patient details and are built with step-up
 * enforcement (packages G and E). They follow the clinic's live state: before
 * any channel is live they say they open after go-live, never links; after
 * it, they link once their screen is in this build, and until then say where
 * what they will hold reaches the clinic meanwhile, by email. A menu item
 * that goes nowhere breaks the rule that every link works the day it ships,
 * and one that 404s reads as a broken product. When a package builds one it
 * adds it to `BUILT` here and nothing else changes. Any other screen is
 * listed only once it exists, and every link into a screen asks
 * `isBuiltSection` first, so no build ships a link to a page it does not
 * have.
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

/** The screens that exist in this build. Conversations and Bookings join in M5. */
const BUILT: ReadonlySet<PortalSection> = new Set<PortalSection>([
  "home",
  "settings",
  "knowledge",
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
 * The menu for the clinic `slug`, in order, with `active` marked. `live` is
 * whether any of the clinic's channels has gone live (lib/portal/header.ts's
 * answering status is anything but "not yet"), and `liveChannels` which.
 */
export function portalNav(
  slug: string,
  active: PortalSection | null,
  options: { live?: boolean; liveChannels?: readonly Channel[] } = {},
): NavItem[] {
  const live = options.live === true;
  const items: NavItem[] = [];
  for (const { section, label } of SECTIONS) {
    const link = { section, label, href: sectionPath(slug, section), current: section === active };
    if (AFTER_GO_LIVE.has(section)) {
      if (!live) {
        items.push({ section, label, href: null, current: false, note: OPENS_AFTER_GO_LIVE });
      } else if (BUILT.has(section)) {
        items.push(link);
      } else {
        const note =
          section === "bookings" ? BOOKINGS_BY_EMAIL : conversationsUntilBuilt(options.liveChannels ?? []);
        items.push({ section, label, href: null, current: false, note });
      }
    } else if (BUILT.has(section)) {
      items.push(link);
    }
  }
  return items;
}

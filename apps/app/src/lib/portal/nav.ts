/**
 * The clinic portal's menu (plan Part F0; spec, "Portal map"): six screens,
 * nothing nested more than one level deep, in the spec's order.
 *
 * Conversations and Bookings hold patient details and open behind the passkey
 * step-up (M5). Until a screen exists it is a menu entry that says it opens
 * after go-live, never a link: a menu item that goes nowhere breaks the rule
 * that every link works the day it ships, and one that 404s reads as a broken
 * product. Bookings exists (package E) and is a link once there is something
 * to show on it: once any channel has gone live (clinic_channels.live_at), or
 * once a booking request exists (lib/portal/bookings.ts `bookingsOpen`); until
 * then it still says it opens after go-live. Conversations joins `BUILT` with
 * package G. Any other screen is listed only once it exists, and every link
 * into a screen asks `isBuiltSection` first, so no build ships a link to a
 * page it does not have.
 *
 * Pure, so the menu is one table test.
 */

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

/** The screens that exist in this build. Conversations joins with package G. */
const BUILT: ReadonlySet<PortalSection> = new Set<PortalSection>([
  "home",
  "settings",
  "knowledge",
  "bookings",
  "billing",
]);

/** The patient screens, which open after go-live (M5). */
const AFTER_GO_LIVE: ReadonlySet<PortalSection> = new Set<PortalSection>([
  "conversations",
  "bookings",
]);

/** What an entry that does not open yet says instead of linking. */
export const OPENS_AFTER_GO_LIVE = "Opens after go-live";

/** The path of a section on a clinic's portal. */
export function sectionPath(slug: string, section: PortalSection): string {
  const entry = SECTIONS.find((s) => s.section === section);
  return `/c/${slug}${entry?.path ?? ""}`;
}

/** Whether a section is a screen in this build. */
export function isBuiltSection(section: PortalSection): boolean {
  return BUILT.has(section);
}

/** What the menu needs to know about the clinic: whether Bookings has anything to show yet. */
export type NavFacts = { bookingsOpen?: boolean };

/** The menu for the clinic `slug`, in order, with `active` marked. */
export function portalNav(
  slug: string,
  active: PortalSection | null,
  facts: NavFacts = {},
): NavItem[] {
  const items: NavItem[] = [];
  for (const { section, label } of SECTIONS) {
    const waiting = section === "bookings" && facts.bookingsOpen !== true && active !== "bookings";
    if (BUILT.has(section) && !waiting) {
      items.push({ section, label, href: sectionPath(slug, section), current: section === active });
    } else if (AFTER_GO_LIVE.has(section)) {
      items.push({ section, label, href: null, current: false, note: OPENS_AFTER_GO_LIVE });
    }
  }
  return items;
}

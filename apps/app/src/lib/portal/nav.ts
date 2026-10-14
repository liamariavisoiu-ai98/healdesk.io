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
 * is already something to show (lib/portal/page.ts, openPatientScreens). Any
 * other screen is listed only once it exists, and every link into a screen
 * asks `isBuiltSection` first, so no build ships a link to a page it does not
 * have.
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

/**
 * The menu for the clinic `slug`, in order, with `active` marked. `opened` is
 * which patient screens the clinic has opened (openPatientScreens); a built
 * one not in it still says when it opens.
 */
export function portalNav(
  slug: string,
  active: PortalSection | null,
  opened: readonly PortalSection[] = [],
): NavItem[] {
  const items: NavItem[] = [];
  for (const { section, label } of SECTIONS) {
    if (BUILT.has(section) && (!AFTER_GO_LIVE.has(section) || opened.includes(section))) {
      items.push({ section, label, href: sectionPath(slug, section), current: section === active });
    } else if (AFTER_GO_LIVE.has(section)) {
      items.push({ section, label, href: null, current: false, note: OPENS_AFTER_GO_LIVE });
    }
  }
  return items;
}

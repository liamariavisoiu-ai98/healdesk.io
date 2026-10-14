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

/**
 * What a patient screen not in this build says after go-live: where what it
 * will hold reaches the clinic meanwhile. Transcripts go to the clinic's
 * address (lib/conversations/transcript-outbox.ts); booking requests to the
 * desk's (lib/meta/booking-requests.ts).
 */
export const BY_EMAIL_UNTIL_BUILT: Readonly<Record<"conversations" | "bookings", string>> = {
  conversations: "Each transcript is emailed to you",
  bookings: "Each request is emailed to your team",
};

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
 * answering status is anything but "not yet").
 */
export function portalNav(
  slug: string,
  active: PortalSection | null,
  options: { live?: boolean } = {},
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
        const note = BY_EMAIL_UNTIL_BUILT[section as "conversations" | "bookings"];
        items.push({ section, label, href: null, current: false, note });
      }
    } else if (BUILT.has(section)) {
      items.push(link);
    }
  }
  return items;
}

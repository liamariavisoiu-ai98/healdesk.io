import { existsSync } from "node:fs";
import { join } from "node:path";

import { GOOGLE_CALENDAR_DISCLOSURE } from "@healdesk/catalog";

import { isBuiltSection, type PortalSection } from "@/lib/portal/nav";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";

/**
 * "Every link a screen ships must work the day it ships": a checker for the
 * HTML a portal page renders. Each href must be one of:
 *
 *   - an anchor on the same page (an element with that id exists);
 *   - mailto: or tel:;
 *   - a page this app has: a screen of this build on the clinic's own portal
 *     (lib/portal/nav.ts, which a page file backs), one of its setup screens,
 *     the protect and step-up pages, Talk to your AYA's preview while its
 *     page file exists, /help/call, /sign-in, or the Stripe
 *     Connect start route with this clinic's slug;
 *   - a download a screen offers, while its route file exists: Billing's
 *     signed agreement.
 *
 * Anything else is reported. Returns the problems, empty when every link works.
 */

const SECTION_PATHS: Record<string, PortalSection> = {
  "": "home",
  "/settings": "settings",
  "/knowledge": "knowledge",
  "/conversations": "conversations",
  "/bookings": "bookings",
  "/billing": "billing",
};

export function hrefsIn(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((m) =>
    m[1]!.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'"),
  );
}

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!));
}

export function brokenLinks(html: string, slug: string): string[] {
  const ids = idsIn(html);
  const problems: string[] = [];
  for (const href of hrefsIn(html)) {
    const problem = linkProblem(href, slug, ids);
    if (problem) problems.push(`${href}: ${problem}`);
  }
  return problems;
}

/** The links Google's data-use notice carries itself, the only ones off this app a page may have. */
const NOTICE_LINKS: ReadonlySet<string> = new Set([
  GOOGLE_CALENDAR_DISCLOSURE.privacyHref,
  GOOGLE_CALENDAR_DISCLOSURE.limitedUse.href,
]);

function linkProblem(href: string, slug: string, ids: Set<string>): string | null {
  if (href.startsWith("#")) return ids.has(href.slice(1)) ? null : "no element with that id";
  if (NOTICE_LINKS.has(href)) return null;
  if (href.startsWith("mailto:") || /^tel:\+[1-9]\d{6,14}$/.test(href)) return null;
  const url = new URL(href, "https://app.healdesk.test");
  if (url.origin !== "https://app.healdesk.test") return "a link off this app";
  const path = url.pathname;

  if (path === "/help/call" || path === "/sign-in") return null;
  if (path === "/api/connect/stripe/start") {
    return url.searchParams.get("clinic") === slug &&
      ["settings", "setup"].includes(url.searchParams.get("from") ?? "")
      ? null
      : "a Connect start for another clinic or page";
  }
  const base = `/c/${slug}`;
  if (path !== base && !path.startsWith(`${base}/`)) return "not this clinic's portal";
  const rest = path.slice(base.length);

  if (rest in SECTION_PATHS) {
    const section = SECTION_PATHS[rest]!;
    return isBuiltSection(section) &&
      existsSync(join(process.cwd(), "src", "app", "c", "[slug]", rest.slice(1), "page.tsx"))
      ? null
      : `the ${section} screen is not in this build`;
  }
  if (rest === "/setup") {
    const screen = url.searchParams.get("s");
    return screen === null || (SETUP_SCREENS as readonly string[]).includes(screen)
      ? null
      : "not a setup screen";
  }
  if (rest === "/protect" || rest === "/step-up") return null;
  if (rest === "/preview") {
    return existsSync(join(process.cwd(), "src", "app", "c", "[slug]", "preview", "page.tsx"))
      ? null
      : "no preview in this build";
  }
  if (rest === "/billing/agreement") {
    return existsSync(
      join(process.cwd(), "src", "app", "c", "[slug]", "billing", "agreement", "route.ts"),
    )
      ? null
      : "no agreement download in this build";
  }
  return "no such page";
}

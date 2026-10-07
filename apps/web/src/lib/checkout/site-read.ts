import { type ClinicProfile, parseClinicProfile, summarizeClinicProfile } from "@healdesk/catalog";

/**
 * The website read, as the purchase carries it (plan Part B).
 *
 * Step 2 asks /api/clinic-site to read the website once, in the background,
 * and the answer is kept here, in this tab's sessionStorage, until Pay sends
 * it into the checkout intent. apps/web keeps nothing of it on the server,
 * and apps/app checks it again before it stores it.
 *
 * A read belongs to the website it read. Change the website afterwards and
 * the read no longer describes this purchase, so it is not sent.
 */

export type SiteRead =
  | { status: "pending"; website: string }
  | { status: "read"; website: string; profile: ClinicProfile }
  | { status: "failed"; website: string };

export const SITE_READ_KEY = "healdesk.checkout.site-read.v1";

export function parseStoredSiteRead(raw: unknown): SiteRead | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.website !== "string" || !v.website) return null;
  if (v.status === "pending" || v.status === "failed")
    return { status: v.status, website: v.website };
  if (v.status === "read") {
    const profile = parseClinicProfile(v.profile);
    return profile && profile.website === v.website
      ? { status: "read", website: v.website, profile }
      : null;
  }
  return null;
}

export function readStoredSiteRead(): SiteRead | null {
  try {
    const raw = sessionStorage.getItem(SITE_READ_KEY);
    return raw ? parseStoredSiteRead(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function storeSiteRead(read: SiteRead | null): void {
  try {
    if (read) sessionStorage.setItem(SITE_READ_KEY, JSON.stringify(read));
    else sessionStorage.removeItem(SITE_READ_KEY);
  } catch {
    // The read still holds for this page.
  }
}

/**
 * What /api/clinic-site answered, as a read of `website`. Anything but a
 * profile that parses and names this very website is a failed read: the
 * browser is told nothing about why, and setup asks its three questions.
 */
export function siteReadFromAnswer(website: string, status: number, body: unknown): SiteRead {
  if (
    status === 200 &&
    body &&
    typeof body === "object" &&
    (body as { status?: unknown }).status === "read"
  ) {
    const profile = parseClinicProfile((body as { profile?: unknown }).profile);
    if (profile && profile.website === website) return { status: "read", website, profile };
  }
  return { status: "failed", website };
}

/** Ask for the read. Never throws: a read that cannot happen is a failed one. */
export async function requestSiteRead(website: string): Promise<SiteRead> {
  try {
    const response = await fetch("/api/clinic-site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ website }),
    });
    const body: unknown = await response.json().catch(() => null);
    return siteReadFromAnswer(website, response.status, body);
  } catch {
    return { status: "failed", website };
  }
}

/** What the purchase sends for the read: the profile, and read, failed or none. */
export function profileForPurchase(
  read: SiteRead | null,
  website: string | null,
): { profile: ClinicProfile | null; profileStatus: "read" | "failed" | "none" } {
  if (website === null) return { profile: null, profileStatus: "none" };
  if (read?.status === "read" && read.website === website) {
    return { profile: read.profile, profileStatus: "read" };
  }
  // A website with no read for it, whether the read failed, is still running
  // or was of another address: apps/app may read it again after purchase.
  return { profile: null, profileStatus: "failed" };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type SiteReadLine = { kind: "read" | "pending" | "questions"; text: string };

/**
 * The Review and pay line: what the read found, shown only when it found at
 * least one service ("We read glowmedspa.com: 14 services, your hours, 3
 * providers. You'll confirm them in setup."), and otherwise the fallback
 * setup starts with.
 */
export function siteReadLine(read: SiteRead | null, website: string | null): SiteReadLine {
  if (website !== null && read?.website === website) {
    if (read.status === "pending") {
      return {
        kind: "pending",
        text: `We're reading ${website}. Anything we can't find there, setup asks you.`,
      };
    }
    if (read.status === "read") {
      const summary = summarizeClinicProfile(read.profile);
      if (summary.services >= 1) {
        const found = [plural(summary.services, "service", "services")];
        if (summary.hours) found.push("your hours");
        if (summary.providers >= 1) found.push(plural(summary.providers, "provider", "providers"));
        return {
          kind: "read",
          text: `We read ${website}: ${found.join(", ")}. You'll confirm them in setup.`,
        };
      }
    }
  }
  return { kind: "questions", text: "Setup starts with three quick questions." };
}

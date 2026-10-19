import {
  parseClinicProfile,
  sign,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type ClinicProfile,
} from "@healdesk/catalog";

import { env } from "@/lib/env";

import type { SiteRereadFailure } from "./types";

/**
 * The signed website re-read: apps/app asks apps/web's /api/clinic-site to
 * read a clinic's website again (plan Part B, "Re-reads").
 *
 * The read stays on apps/web on purpose. Fetching a URL a buyer typed belongs
 * off the PHI host, behind apps/web's fetch guard (lib/site-read/fetch.ts
 * there), and apps/web stores nothing from it. So this side sends what the
 * route needs to read and limit, `{ clinicId, website }`, the clinic's id and
 * its own public website, signed with HEALDESK_PROVISION_SECRET like every
 * server-to-server call between the two apps (catalog request-signing.ts),
 * and takes back a profile: business data, which `parseClinicProfile`
 * checks in full before anything here reads it, and which must be a read of
 * the website asked for.
 *
 * Every outcome that is not a profile comes back as a category, never
 * apps/web's words, so the caller can decide whether to try again.
 */

export type SiteReadOutcome =
  | { status: "read"; profile: ClinicProfile }
  | { status: "failed"; failure: SiteRereadFailure; retryAfterSeconds?: number };

/** Longer than apps/web's own 60-second ceiling (its route's maxDuration), so a slow read still answers. */
export const SITE_READ_TIMEOUT_MS = 75_000;

export class WebOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebOriginError";
  }
}

/**
 * apps/web's origin from HEALDESK_WEB_URL, without a trailing slash, or null
 * when it is not set. Throws WebOriginError for a value that is not an
 * http(s) origin, or not https in production: a signed request sent in
 * clear text gives its body to whoever is on the path.
 */
export function webOrigin(raw: string | undefined = env.webUrl()): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebOriginError("HEALDESK_WEB_URL is not a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebOriginError("HEALDESK_WEB_URL must be an http(s) origin.");
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new WebOriginError("HEALDESK_WEB_URL must be https in production.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new WebOriginError("HEALDESK_WEB_URL must be a bare origin, like https://healdesk.io.");
  }
  return url.origin;
}

export type SiteReadDeps = {
  fetch?: typeof fetch;
  /** The origin and the secret, for tests; read from the environment otherwise. */
  origin?: string;
  secret?: string;
  now?: () => number;
  timeoutMs?: number;
};

/** Seconds from a Retry-After header, when it is a plain number of them. */
function retryAfter(header: string | null): number | undefined {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/**
 * Ask apps/web to read `website` for `clinicId`. Never throws for anything
 * apps/web or the network does; throws WebOriginError only when this host
 * is misconfigured, which the caller checks first (`webOrigin`).
 */
export async function readClinicWebsite(
  input: { clinicId: string; website: string },
  deps: SiteReadDeps = {},
): Promise<SiteReadOutcome> {
  const origin = deps.origin ?? webOrigin();
  if (!origin) return { status: "failed", failure: "unavailable" };
  const secret = deps.secret ?? env.provisionSecret();
  if (!secret) return { status: "failed", failure: "unavailable" };

  const body = JSON.stringify({ clinicId: input.clinicId, website: input.website });
  const timestamp = String(Math.floor((deps.now?.() ?? Date.now()) / 1000));
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${origin}/api/clinic-site`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, secret),
      },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? SITE_READ_TIMEOUT_MS),
    });
  } catch {
    return { status: "failed", failure: "network" };
  }

  if (response.status === 429) {
    const after = retryAfter(response.headers.get("retry-after"));
    return {
      status: "failed",
      failure: "rate_limited",
      ...(after !== undefined ? { retryAfterSeconds: after } : {}),
    };
  }
  if (response.status === 400 || response.status === 401 || response.status === 422) {
    return { status: "failed", failure: "refused" };
  }
  if (!response.ok) return { status: "failed", failure: "unavailable" };

  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return { status: "failed", failure: "invalid" };
  }
  const data = (answer ?? {}) as Record<string, unknown>;
  if (data.status === "failed") return { status: "failed", failure: "unreadable" };
  if (data.status !== "read") return { status: "failed", failure: "invalid" };
  const profile = parseClinicProfile(data.profile);
  // A profile of another website is not this clinic's, whatever else it says.
  if (!profile || profile.website.toLowerCase() !== input.website.toLowerCase()) {
    return { status: "failed", failure: "invalid" };
  }
  return { status: "read", profile };
}

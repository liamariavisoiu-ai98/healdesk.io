import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  summarizeClinicProfile,
  verify,
} from "@healdesk/catalog";

import { clientKey, rateLimit } from "@/lib/rate-limit";
import { demoInvitation, gateState, refuseWithoutLink } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";
import { cleanWebsite } from "@/lib/setup-requests";
import { readClinicSite, type SiteRead } from "@/lib/site-read/read";

/**
 * POST /api/clinic-site: read a clinic's website so setup starts pre-filled.
 *
 * Step 2 of the purchase asks for the clinic's website, and the funnel calls
 * this in the background while the buyer carries on. The answer is a
 * screened ClinicProfile (packages/catalog, clinic-profile.ts) that the
 * browser keeps and sends into the checkout intent at Pay, so Review & pay
 * can say "We read glowmedspa.com: 14 services, your hours, 3 providers" and
 * setup never asks for what the site already says
 * (docs/design/funnel-onboarding-portal-2026-10-06.md, Part B).
 *
 * ## Why here, and what keeps it
 *
 * Fetching a URL a stranger typed belongs off the PHI host, so the read runs
 * on apps/web, behind the fetch guard in lib/site-read/fetch.ts. This route
 * stores nothing from it: no cache and no row of its own. The browser holds
 * the profile until Pay, which puts it in the purchase's sealed record in the
 * marketing Sheet (lib/checkout/records.ts), and apps/app keeps it from the
 * first paid invoice on, when it imports that record.
 *
 * ## Who may ask
 *
 * - **Browsers**, gated exactly like the other purchase routes: in pilot mode
 *   only with a valid setup link (`gateState` on the `hd_setup` cookie) or a
 *   personalised demo's invitation (`demoInvitation`, as /api/agreement and
 *   /api/checkout accept it), in public mode anyone. Each browser gets one read per half hour (the
 *   `hd_site_read` cookie, which only spares the bill: a script can drop it,
 *   and the per-IP limit and the site-wide daily cap are what bound it).
 * - **apps/app**, signed with HEALDESK_PROVISION_SECRET like every
 *   server-to-server call (catalog request-signing.ts), with
 *   `{ clinicId, website }`: a profile missing after purchase, a website the
 *   clinic corrected in setup, the monthly drift check. Signed requests skip
 *   the setup link, which a paid clinic no longer has, and have their own
 *   limits, per clinic and per day.
 *
 * ## What it answers
 *
 * `{ status: "read", profile, summary: { services, hours, providers } }`,
 * or `{ status: "failed" }` whatever went wrong: unreachable, refused,
 * blocked by robots.txt, not HTML, or an extraction that failed. The browser
 * never learns which; the log has the host and the reason, never page
 * content.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Inside every Vercel plan's limit. The read's own budget, below, leaves time to answer. */
export const maxDuration = 60;

const BUDGET_MS = 55_000;

/** One read per browser, for this long. */
export const READ_COOKIE = "hd_site_read";
const READ_COOKIE_MAX_AGE_S = 30 * 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Per IP per hour. A buyer needs one read; the rest is a typo or a second tab. */
const IP_LIMIT = 5;
/**
 * Site-wide per UTC day, through the marketing Sheet (GLOBAL_CAP_KEYS in
 * lib/rate-limit.ts). Each read is one model call over about ten thousand
 * tokens of page text, so this bounds the day's spend at a few dozen
 * dollars, far above the purchases a day will bring.
 */
const DAILY_CAP = 300;
/**
 * Signed re-reads: a missing profile, a corrected website and the drift check
 * fit easily. Both limits go through the marketing Sheet (lib/rate-limit.ts),
 * so they hold across instances like the daily cap above.
 */
const CLINIC_LIMIT = 4;
const SIGNED_DAILY_CAP = 1_000;

/** `{ website }` or `{ clinicId, website }`: a few hundred bytes at most. */
const MAX_BODY_CHARS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE = { "Cache-Control": "no-store" };

function failed(status = 200, headers: Record<string, string> = {}): Response {
  return Response.json({ status: "failed" }, { status, headers: { ...NO_STORE, ...headers } });
}

function problem(error: string, status: number, field?: string): Response {
  return Response.json({ error, ...(field ? { field } : {}) }, { status, headers: NO_STORE });
}

function answer(read: SiteRead, headers: Record<string, string> = {}): Response {
  if (read.status !== "read") return failed(200, headers);
  return Response.json(
    { status: "read", profile: read.profile, summary: summarizeClinicProfile(read.profile) },
    { headers: { ...NO_STORE, ...headers } },
  );
}

function readCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${READ_COOKIE}=1; Path=/api/clinic-site; Max-Age=${READ_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure}`;
}

function parseBody(raw: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(raw);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Run the read and log its outcome: host and reason, never what the pages said. */
async function run(
  website: string,
  started: number,
  who: { signed: boolean; clinicId?: string },
): Promise<SiteRead> {
  const host = website.split("/")[0];
  let read: SiteRead;
  try {
    read = await readClinicSite(website, { deadline: started + BUDGET_MS });
  } catch (error) {
    console.error("[healdesk] clinic site read threw", {
      host,
      ...who,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { status: "failed", reason: "network", detail: "threw" };
  }
  const ms = Date.now() - started;
  if (read.status === "read") {
    console.info("[healdesk] clinic site read", {
      host,
      ...who,
      pages: read.profile.pages,
      services: read.profile.services.length,
      dropped: read.profile.dropped,
      model: read.model,
      ms,
    });
  } else {
    console.warn("[healdesk] clinic site read failed", {
      host,
      ...who,
      reason: read.reason,
      detail: read.detail,
      ms,
    });
  }
  return read;
}

function unconfigured(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return false;
  console.error("[healdesk] clinic site read unavailable: ANTHROPIC_API_KEY is not set");
  return true;
}

async function browserRead(request: Request, raw: string, started: number): Promise<Response> {
  const limit = await rateLimit(`site-read:${clientKey(request.headers)}`, IP_LIMIT, HOUR_MS);
  if (!limit.ok) return failed(429, { "Retry-After": String(limit.retryAfter) });

  // The setup link, while the purchase is by invitation (lib/checkout-mode.ts),
  // with the same refusal /api/agreement and /api/checkout give, and the same
  // exception: a personalised demo is an invitation too (lib/setup-gate.ts).
  // Without it a buyer the operator invited through a demo could sign and pay
  // but never have the website read, and setup would ask what the site says.
  const gate = await gateState(readCookie(request.headers, SETUP_COOKIE));
  if (gate.mode === "pilot") {
    const refused = refuseWithoutLink(gate);
    if (refused && !(await demoInvitation(request.headers.get("cookie")))) return refused;
  }

  if (readCookie(request.headers, READ_COOKIE)) return failed(429);

  const website = cleanWebsite(parseBody(raw)?.website);
  if (!website) return problem("Enter the clinic's website, like glowmedspa.com.", 400, "website");

  if (unconfigured()) return failed(503);

  // Checked last, so only a read that will really happen spends from the day.
  const daily = await rateLimit("site-read:global:day", DAILY_CAP, DAY_MS);
  if (!daily.ok) {
    console.warn("[healdesk] clinic site read: the daily cap is reached", { cap: DAILY_CAP });
    return failed(429, { "Retry-After": String(daily.retryAfter) });
  }

  const read = await run(website, started, { signed: false });
  return answer(read, { "Set-Cookie": readCookieHeader() });
}

async function signedRead(request: Request, raw: string, started: number): Promise<Response> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  if (!secret) {
    console.error("[healdesk] HEALDESK_PROVISION_SECRET is not set; refusing a signed site read");
    return problem("Re-reads are unavailable.", 503);
  }
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    // Vague to the caller; the reason goes to our logs only.
    console.warn("[healdesk] signed site read rejected", { reason: verification.reason });
    return problem("Unauthorized.", 401);
  }

  const body = parseBody(raw);
  const clinicId =
    typeof body?.clinicId === "string" && UUID.test(body.clinicId)
      ? body.clinicId.toLowerCase()
      : null;
  if (!clinicId) return problem("A re-read needs the clinic's id.", 422, "clinicId");
  const website = cleanWebsite(body?.website);
  if (!website) return problem("A re-read needs the clinic's website.", 422, "website");

  if (unconfigured()) return failed(503);

  const perClinic = await rateLimit(`site-read:clinic:${clinicId}`, CLINIC_LIMIT, DAY_MS);
  if (!perClinic.ok) return failed(429, { "Retry-After": String(perClinic.retryAfter) });
  const overall = await rateLimit("site-read:signed:day", SIGNED_DAILY_CAP, DAY_MS);
  if (!overall.ok) return failed(429, { "Retry-After": String(overall.retryAfter) });

  return answer(await run(website, started, { signed: true, clinicId }));
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return problem("Invalid request body.", 400);
  // Either header marks a server-to-server request, which must then verify;
  // a browser cannot skip the setup link by sending half a signature.
  if (request.headers.has(SIGNATURE_HEADER) || request.headers.has(TIMESTAMP_HEADER)) {
    return signedRead(request, raw, started);
  }
  return browserRead(request, raw, started);
}

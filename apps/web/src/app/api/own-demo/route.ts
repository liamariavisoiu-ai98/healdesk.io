import { after } from "next/server";

import { requestDemo } from "@/lib/demo/build";
import { buildSelfServeDemo, provisionalClinicName } from "@/lib/demo/own-demo";
import { parseWebsiteUrl } from "@/lib/demo/scrape";
import { SELF_SERVE_DEMO } from "@/lib/demo/sessions";
import { isValidEmail } from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { site } from "@/lib/site";

/**
 * POST /api/own-demo, the homepage's "See it in your own branding".
 *
 * A visitor types their clinic's website and their email; we build their own
 * demo from the site, the way the operator's console and the webhook do
 * (lib/demo/build.ts), and email them the private link when it is ready. The
 * team hears about every request at hello@ (lib/demo/own-demo.ts). Body:
 *
 *   { "domain": "peachystudio.com", "email": "owner@peachystudio.com" }
 *
 * Answers 202 at once with `{ ok, url }`, the demo's private link. The page
 * opens it in a new tab (owner, 12 October 2026), where the demo's own
 * holding screen shows the build and turns into the demo when it is ready,
 * so the visitor is not left waiting on an email to see anything. The same
 * link is still emailed once the demo is ready. The crawl, the model call and
 * the email run after the response (`after()`, inside `maxDuration`).
 *
 * The link used to go to the address only, so that the address had to be
 * real for the demo to be seen. It no longer has to be: the limits below are
 * what bound the spend, and they are unchanged.
 *
 * The visitor asked for this, on our page, so the email that brings the link
 * is a reply, not outreach. Nothing here dials anyone.
 *
 * ## What it costs, and what stops it
 *
 * Each request is a crawl of somebody's website and a model call, and a demo
 * row in the register for a week. So: three requests an hour from one
 * address, three a day for one email and two a day for one website (the
 * second covers a typo in the email), and a site-wide daily cap
 * (`own-demo:global:day`, OWN_DEMO_DAILY_CAP, default 40, where 0 switches
 * the form off). The crawl itself refuses private and local addresses
 * (lib/demo/scrape.ts), so the field cannot be pointed inside our network.
 * A bot that fills the hidden `company` field is told it worked and nothing
 * is built.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The build runs after the response, within this. The rendering crawl alone can take three minutes. */
export const maxDuration = 300;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IP_LIMIT = 3;
const EMAIL_LIMIT = 3;
const DOMAIN_LIMIT = 2;

function dailyCap(): number {
  const value = Number(process.env.OWN_DEMO_DAILY_CAP ?? 40);
  return Number.isFinite(value) && value >= 0 ? value : 40;
}

function refuse(status: number, error: string, extra: Record<string, unknown> = {}, retryAfter?: number): Response {
  return Response.json(
    { error, ...extra },
    { status, headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined },
  );
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientKey(request.headers);
  const perIp = await rateLimit(`own-demo:ip:${ip}`, IP_LIMIT, HOUR_MS);
  if (!perIp.ok) {
    return refuse(429, `You've asked for a few demos already. Try again in an hour, or write to ${site.email}.`, {}, perIp.retryAfter);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return refuse(400, "Invalid request.");
  }

  // The honeypot: hidden from people, filled in by form bots.
  if (text(body.company, 200)) {
    console.info("[healdesk] own-demo honeypot tripped", { ip });
    return Response.json({ ok: true }, { status: 202 });
  }

  const email = text(body.email, 254).toLowerCase();
  if (!isValidEmail(email)) {
    return refuse(422, "That email address doesn't look right.", { field: "email" });
  }

  let website: URL;
  try {
    website = parseWebsiteUrl(text(body.domain, 300));
  } catch (error) {
    return refuse(422, (error as Error).message, { field: "domain" });
  }
  const host = website.hostname.replace(/^www\./, "").toLowerCase();

  const perEmail = await rateLimit(`own-demo:email:${email}`, EMAIL_LIMIT, DAY_MS);
  if (!perEmail.ok) {
    return refuse(429, `We've sent that address a few demos today. Check your inbox, or write to ${site.email}.`, {}, perEmail.retryAfter);
  }
  const perDomain = await rateLimit(`own-demo:domain:${host}`, DOMAIN_LIMIT, DAY_MS);
  if (!perDomain.ok) {
    return refuse(429, `We've already built one for ${host} today. Check your inbox, or write to ${site.email}.`, {}, perDomain.retryAfter);
  }

  const cap = dailyCap();
  const daily = cap > 0 ? await rateLimit("own-demo:global:day", cap, DAY_MS) : null;
  if (!daily?.ok) {
    return refuse(503, `We've built all the demos we can for today. Write to ${site.email} and we'll build yours by hand.`);
  }

  let result;
  try {
    result = await requestDemo({
      clinicName: provisionalClinicName(website),
      websiteUrl: website.href,
      leadEmail: email,
      sendEmail: true,
      createdBy: SELF_SERVE_DEMO,
    });
  } catch (error) {
    console.error("[healdesk] own-demo could not record the demo", {
      error: error instanceof Error ? error.message : String(error),
    });
    return refuse(503, `We couldn't start your demo just now. Try again in a minute, or write to ${site.email}.`);
  }
  if (!result.ok) {
    return refuse(422, result.error, { field: result.field === "leadEmail" ? "email" : "domain" });
  }

  const { session, url } = result;
  after(() => buildSelfServeDemo(session));
  return Response.json({ ok: true, url }, { status: 202 });
}

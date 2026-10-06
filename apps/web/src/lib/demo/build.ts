import { isSpecialtyId } from "@healdesk/catalog";

import { send, type SendResult } from "@/lib/email";
import { ENTITY } from "@/lib/legal";
import { normalizePhone } from "@/lib/phone";
import { site } from "@/lib/site";

import { isUsableProfile } from "./profile";
import { parseWebsiteUrl, scrapeClinicSite, ScrapeError } from "./scrape";
import {
  createDemoSession,
  demoUrl,
  displayName,
  getDemoSession,
  updateDemoSession,
  type DemoSession,
} from "./sessions";
import { structureProfile } from "./structure";

/**
 * The demo builder: an operator's request in, a private branded demo out.
 *
 *   1. `requestDemo()` validates the request and appends a `building` row.
 *      It returns at once with the slug and the link, so the operator (or the
 *      webhook's caller) is not left holding a request open for two minutes.
 *   2. `runDemoBuild()` runs after the response (`after()` in the caller):
 *      scrape the site, structure it into a profile, write it to the row and
 *      mark it `ready`, or mark it `failed` with a reason the console shows.
 *   3. With `sendEmail`, the link goes to the prospect once the build is
 *      ready, never before: a link that opens on "being prepared" is a worse
 *      first impression than a link that arrives two minutes later.
 *
 * The prospect asked for this, by replying to an email; that is what makes
 * the email in step 3 a reply rather than outreach. Nothing here dials
 * anyone. The demo's "call me" still needs its own consent tick on the page.
 */

export type DemoRequest = {
  clinicName: string;
  websiteUrl: string;
  leadEmail?: string | null;
  phone?: string | null;
  niche?: string | null;
  sendEmail?: boolean;
  createdBy?: string | null;
};

export type DemoRequestResult =
  | { ok: true; session: DemoSession; url: string }
  | { ok: false; field: "clinicName" | "websiteUrl" | "leadEmail" | "phone"; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function requestDemo(input: DemoRequest): Promise<DemoRequestResult> {
  const clinicName = input.clinicName.trim();
  if (clinicName.length < 2) return { ok: false, field: "clinicName", error: "Enter the clinic's name." };

  let website: URL;
  try {
    website = parseWebsiteUrl(input.websiteUrl);
  } catch (error) {
    return { ok: false, field: "websiteUrl", error: (error as Error).message };
  }

  const leadEmail = input.leadEmail?.trim() || null;
  if (leadEmail && !EMAIL.test(leadEmail)) {
    return { ok: false, field: "leadEmail", error: "That email address doesn't look right." };
  }
  if (input.sendEmail && !leadEmail) {
    return { ok: false, field: "leadEmail", error: "Add the prospect's email to send them the link." };
  }

  let phoneE164: string | null = null;
  if (input.phone?.trim()) {
    const parsed = normalizePhone(input.phone);
    if (!parsed.ok) return { ok: false, field: "phone", error: parsed.reason };
    phoneE164 = parsed.e164;
  }

  const session = await createDemoSession({
    clinicName,
    websiteUrl: website.href,
    leadEmail,
    phoneE164,
    niche: input.niche ?? null,
    createdBy: input.createdBy ?? null,
  });
  return { ok: true, session, url: demoUrl(session.slug) };
}

/**
 * Scrape, structure, store. Never throws: every failure ends as a `failed`
 * row with a reason, because this runs after the response and an exception
 * here would only ever reach a log.
 */
export async function runDemoBuild(slug: string, options: { sendEmail?: boolean } = {}): Promise<DemoSession | null> {
  const session = await getDemoSession(slug, { fresh: true });
  if (!session) return null;

  try {
    const scraped = await scrapeClinicSite(session.websiteUrl);
    const profile = await structureProfile(scraped.pages, {
      clinicName: session.clinicName,
      niche: session.niche,
    });
    if (!isUsableProfile(profile)) {
      return await updateDemoSession(slug, {
        status: "failed",
        scrapeSource: scraped.source,
        buildNote: `The site was read (${scraped.pages.length} pages) but no services, hours or FAQs were found in it. It may render everything in the browser${process.env.APIFY_TOKEN ? "" : "; setting APIFY_TOKEN enables the rendering crawler"}.`,
      });
    }

    const ready = await updateDemoSession(slug, {
      status: "ready",
      specialty: profile.specialty ?? (isSpecialtyId(session.niche) ? session.niche : null),
      brandName: scraped.brand.name,
      logoUrl: scraped.brand.logoUrl,
      brandColor: scraped.brand.color,
      profile: profile as unknown as Record<string, unknown>,
      scrapeSource: scraped.source,
      buildNote: scraped.apifyNote && process.env.APIFY_TOKEN ? `Rendering crawler: ${scraped.apifyNote}` : null,
      readyAt: new Date(),
    });
    console.info("[healdesk] demo built", {
      slug,
      source: scraped.source,
      pages: scraped.pages.length,
      services: profile.services.length,
    });

    if (ready && options.sendEmail) await sendDemoEmail(ready);
    return ready;
  } catch (error) {
    const reason =
      error instanceof ScrapeError || (error instanceof Error && error.name === "StructureError")
        ? error.message
        : "The build failed unexpectedly; see the server log.";
    console.error("[healdesk] demo build failed", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return updateDemoSession(slug, { status: "failed", buildNote: reason }).catch(() => null);
  }
}

// -----------------------------------------------------------------------------
// The email
// -----------------------------------------------------------------------------

function expiryDate(session: DemoSession): string {
  return session.expiresAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/** Subject and body, exported for the console's preview and for the test. */
export function demoEmail(session: DemoSession): { subject: string; text: string } {
  const name = displayName(session);
  return {
    subject: `Custom demo instance ready for ${name}`,
    text: [
      "Hi,",
      "",
      `As promised, here is the demo we built for ${name} from your website:`,
      "",
      demoUrl(session.slug),
      "",
      `On that page you can talk to the voice assistant from your browser, have it ring your phone, and chat with the website assistant. Both answer as ${name}, with the services, hours and FAQs from your site.`,
      "",
      "It runs in demo mode: it doesn't have your booking calendar or a confirmed price list yet, so it will tell you where it would book or quote for real. Try it the way a patient would: ask what a treatment costs, when you're open, or to book a consult.",
      "",
      `The link is private to you and stays live until ${expiryDate(session)}. Just reply to this email with any questions.`,
      "",
      `The ${site.name} team`,
      "",
      "--",
      `${site.name}, ${ENTITY.postalAddress}`,
    ].join("\n"),
  };
}

/**
 * Send the link to the prospect and stamp the row. Refuses a demo that is not
 * ready (the link would open on a waiting screen) or has no address.
 */
export async function sendDemoEmail(session: DemoSession): Promise<SendResult> {
  if (session.status !== "ready") return { status: "skipped", reason: "the demo is not ready" };
  if (!session.leadEmail) return { status: "skipped", reason: "no prospect email on this demo" };

  const { subject, text } = demoEmail(session);
  let result: SendResult;
  try {
    result = await send({ to: session.leadEmail, subject, text, tag: "demo-ready" });
  } catch (error) {
    result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (result.status === "sent") {
    await updateDemoSession(session.slug, { emailSentAt: new Date() }).catch(() => null);
  } else {
    console.error("[healdesk] demo email not sent", { slug: session.slug, ...result });
  }
  return result;
}

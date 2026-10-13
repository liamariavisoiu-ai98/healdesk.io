import { isSpecialtyId } from "@healdesk/catalog";

import { send, type SendResult } from "@/lib/email";
import { ENTITY } from "@/lib/legal";
import { normalizePhone } from "@/lib/phone";
import { site } from "@/lib/site";

import { postInternalAlert } from "./alert";
import {
  auditDemo,
  AuditUnavailableError,
  betterRound,
  decide,
  demoFingerprint,
  repairFeedback,
  type AuditReport,
} from "./audit";
import { fetchGoogleHours, type GoogleHours } from "./google-hours";
import { scheduleOfferEndedEmail } from "./offer-ended";
import { isUsableProfile, normalizeProfile, type ClinicProfile } from "./profile";
import { parseWebsiteUrl, scrapeClinicSite, ScrapeError, type ScrapedPage } from "./scrape";
import {
  createDemoSession,
  demoUrl,
  displayName,
  getDemoSession,
  profileOf,
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
 *      scrape the site, structure it into a profile, write it to the row as
 *      `auditing`, or mark it `failed` with a reason the console shows.
 *   3. The handoff audit (lib/demo/audit.ts) grades the demo with Claude
 *      Opus 5.5. A pass turns it `ready`; a near miss gets one repair round;
 *      anything broken or misleading is `held` for an operator, with an alert.
 *      Only `ready` is served, so the gate holds the link and not just the
 *      email.
 *   4. With `sendEmail`, the link goes to the prospect once the audit has
 *      passed it, never before: a link that opens on "being prepared" is a
 *      worse first impression than a link that arrives two minutes later.
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

/**
 * The repair round runs only if the first audit finished this soon after the
 * build started: a second extraction and audit take about two minutes, and
 * the routes that run the build stop at 300 s. Later than this, the first
 * round's verdict stands (ship and flag, or hold).
 */
const REPAIR_CUTOFF_MS = 150_000;

/** Every audit must be over by then: the routes that run the build stop at 300 s. */
const AUDIT_DEADLINE_MS = 285_000;

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
    emailRequested: input.sendEmail ?? false,
  });
  return { ok: true, session, url: demoUrl(session.slug) };
}

/** The Google listing's hours win over the website's (lib/demo/google-hours.ts). Normalised, so it hashes as it will be stored. */
function withHours(extracted: ClinicProfile, google: GoogleHours | null, fallbackName: string): ClinicProfile {
  const merged = google
    ? { ...extracted, hours: google.hours, hoursSource: "google" as const, hoursPlace: google.place || null }
    : { ...extracted, hoursSource: extracted.hours.length > 0 ? ("website" as const) : null, hoursPlace: null };
  return normalizeProfile(merged, fallbackName);
}

/**
 * Scrape, structure, audit, store. Never throws: every failure ends as a
 * `failed` or `held` row with a reason, because this runs after the response
 * and an exception here would only ever reach a log.
 *
 * `sendEmail` is the caller's request from before the audit columns existed;
 * the row's own `emailRequested` carries it now, so a retry of a held demo
 * that passes still sends the link that was asked for, once.
 */
export async function runDemoBuild(slug: string, options: { sendEmail?: boolean } = {}): Promise<DemoSession | null> {
  const started = Date.now();
  const session = await getDemoSession(slug, { fresh: true });
  if (!session) return null;

  try {
    // The Google listing runs beside the scrape: it needs only the name and
    // the domain, and its hours beat the website's (lib/demo/google-hours.ts).
    // A failed lookup costs the demo nothing but the better baseline.
    const [scraped, google] = await Promise.all([
      scrapeClinicSite(session.websiteUrl),
      fetchGoogleHours(session.clinicName, session.websiteUrl).catch((error: unknown): GoogleHours | null => {
        console.warn("[healdesk] google hours lookup failed", {
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ]);
    const extract = async (feedback?: readonly string[]): Promise<ClinicProfile> =>
      withHours(
        await structureProfile(scraped.pages, { clinicName: session.clinicName, niche: session.niche, feedback }),
        google,
        session.clinicName,
      );

    const profile = await extract();
    if (!isUsableProfile(profile)) {
      return await updateDemoSession(slug, {
        status: "failed",
        scrapeSource: scraped.source,
        buildNote: `The site was read (${scraped.pages.length} pages) but no services, hours or FAQs were found in it. It may render everything in the browser${process.env.APIFY_TOKEN ? "" : "; setting APIFY_TOKEN enables the rendering crawler"}.`,
      });
    }

    // Stored before the audit, so the console shows what is being audited;
    // `auditing` is not served, so the prospect still sees "being prepared".
    await updateDemoSession(slug, {
      status: "auditing",
      specialty: profile.specialty ?? (isSpecialtyId(session.niche) ? session.niche : null),
      brandName: scraped.brand.name,
      logoUrl: scraped.brand.logoUrl,
      brandColor: scraped.brand.color,
      profile: profile as unknown as Record<string, unknown>,
      scrapeSource: scraped.source,
      buildNote: scraped.apifyNote && process.env.APIFY_TOKEN ? `Rendering crawler: ${scraped.apifyNote}` : null,
      auditVerdict: null,
      auditScore: null,
      auditReport: null,
      auditedAt: null,
      auditHash: null,
    });
    console.info("[healdesk] demo built, auditing", {
      slug,
      source: scraped.source,
      pages: scraped.pages.length,
      services: profile.services.length,
    });

    const gated = await auditWithRepair(session, scraped.pages, profile, extract, started);
    const done = await recordVerdict(slug, gated);
    const emailWanted = options.sendEmail || session.emailRequested;
    if (done?.status === "ready" && emailWanted && !done.emailSentAt) await sendDemoEmail(done);
    if (done) await afterShipping(done);
    return done;
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

export type Gated =
  | { kind: "audited"; profile: ClinicProfile; report: AuditReport }
  | { kind: "unavailable"; profile: ClinicProfile; reason: string };

/**
 * The first audit, and the repair round when `decide()` asks for one and
 * there is time. The round kept is the better of the two (a repair can make
 * things worse), and its decision is taken again with no repair left.
 * Exported for scripts/demo-audit-calibrate.ts, which measures this exact path.
 */
export async function auditWithRepair(
  session: Pick<DemoSession, "slug" | "clinicName">,
  pages: readonly ScrapedPage[],
  profile: ClinicProfile,
  extract: (feedback?: readonly string[]) => Promise<ClinicProfile>,
  started: number,
): Promise<Gated> {
  const base = { operatorName: session.clinicName, pages, deadline: started + AUDIT_DEADLINE_MS };
  let first: AuditReport;
  try {
    first = await auditDemo({ ...base, profile, round: 0, canRepair: true });
  } catch (error) {
    if (error instanceof AuditUnavailableError) return { kind: "unavailable", profile, reason: error.message };
    throw error;
  }

  if (first.decision !== "repair") return { kind: "audited", profile, report: first };
  if (Date.now() - started > REPAIR_CUTOFF_MS) {
    return { kind: "audited", profile, report: { ...first, decision: decide(first, { canRepair: false }) } };
  }

  let repairedProfile: ClinicProfile;
  let second: AuditReport;
  try {
    repairedProfile = await extract(repairFeedback(first));
    if (!isUsableProfile(repairedProfile)) throw new Error("the repaired profile came back empty");
    second = await auditDemo({ ...base, profile: repairedProfile, round: 1, canRepair: false, previous: first });
  } catch (error) {
    // A failed repair leaves the first round's verdict, minus the repair it asked for.
    console.warn("[healdesk] demo repair round failed", {
      slug: session.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "audited", profile, report: { ...first, decision: decide(first, { canRepair: false }) } };
  }

  const kept = betterRound(first, second);
  return kept === second
    ? { kind: "audited", profile: repairedProfile, report: second }
    : { kind: "audited", profile, report: { ...first, decision: decide(first, { canRepair: false }) } };
}

async function recordVerdict(slug: string, gated: Gated): Promise<DemoSession | null> {
  const now = new Date();
  const base = {
    profile: gated.profile as unknown as Record<string, unknown>,
    auditedAt: now,
    auditHash: demoFingerprint(gated.profile),
  };

  if (gated.kind === "unavailable") {
    const held = await updateDemoSession(slug, {
      ...base,
      status: "held",
      auditVerdict: "unavailable",
      auditScore: null,
      auditReport: null,
      buildNote: `Held: the audit could not run (${gated.reason}). Rebuild it to audit it again.`,
    });
    if (held) await postInternalAlert(`Demo held, audit could not run: ${displayName(held)}. ${gated.reason} ${consoleUrl()}`);
    return held;
  }

  const { report } = gated;
  const ships = report.decision === "pass" || report.decision === "flagged";
  const updated = await updateDemoSession(slug, {
    ...base,
    status: ships ? "ready" : "held",
    auditVerdict: report.decision === "pass" ? "pass" : report.decision === "flagged" ? "flagged" : "held",
    auditScore: report.overall,
    auditReport: report as unknown as Record<string, unknown>,
    readyAt: ships ? now : null,
  });
  console.info("[healdesk] demo audited", { slug, decision: report.decision, score: report.overall, round: report.round, blockers: report.blockers.length });

  if (updated && report.decision === "flagged") {
    await postInternalAlert(`Demo shipped with a flag: ${displayName(updated)} scored ${report.overall}/100. ${report.summary} ${consoleUrl()}`);
  }
  if (updated && !ships) {
    const why = report.blockers[0]?.problem ?? `it scored ${report.overall}/100`;
    await postInternalAlert(`Demo held for review: ${displayName(updated)} (${report.overall}/100). ${why} ${consoleUrl()}`);
  }
  return updated;
}

function consoleUrl(): string {
  return `${site.url.replace(/\/$/, "")}/admin/demos`;
}

/**
 * Why this demo may not be handed to the prospect, or null when it may: it
 * is `ready`, its audit passed it (or an operator released it), and the
 * stored profile is the one that was audited.
 */
export function handoffBlocker(session: DemoSession): string | null {
  if (session.status !== "ready") return "the demo is not ready";
  if (session.auditVerdict !== "pass" && session.auditVerdict !== "flagged" && session.auditVerdict !== "released") {
    return "the demo has not passed its audit; rebuild it to audit it";
  }
  const profile = profileOf(session);
  if (!profile || session.auditHash !== demoFingerprint(profile)) {
    return "the demo changed after its audit; rebuild it to audit it again";
  }
  return null;
}

/**
 * An operator ships a held demo anyway, from /admin/demos. Recorded on the
 * row (verdict `released`, who and when in the note), and the link is mailed
 * if the request asked for it and it has not gone yet.
 */
export async function releaseHeldDemo(slug: string, operator: string): Promise<DemoSession | null> {
  const session = await getDemoSession(slug, { fresh: true });
  const profile = session ? profileOf(session) : null;
  if (!session || session.status !== "held" || !profile) return null;
  const now = new Date();
  const released = await updateDemoSession(slug, {
    status: "ready",
    auditVerdict: "released",
    auditHash: demoFingerprint(profile),
    readyAt: session.readyAt ?? now,
    buildNote: `Released by ${operator} on ${now.toISOString().slice(0, 10)} despite the audit.`,
  });
  if (released && released.emailRequested && !released.emailSentAt) await sendDemoEmail(released);
  if (released) await afterShipping(released);
  return released;
}

/**
 * Once a demo may be handed over, its "discount just expired" email is
 * scheduled for the moment the setup offer ends (lib/demo/offer-ended.ts),
 * whether or not its link was emailed: the prospect has the link either way.
 * Only a demo the audit cleared, for the same reason the link is held back.
 * Never throws: it runs inside runDemoBuild's `try`, whose `catch` would
 * mark a demo that shipped as failed.
 */
async function afterShipping(session: DemoSession): Promise<void> {
  if (handoffBlocker(session)) return;
  try {
    const scheduled = await scheduleOfferEndedEmail(session);
    if (scheduled.status !== "sent") console.info("[healdesk] offer-ended email not scheduled", { slug: session.slug, ...scheduled });
  } catch (error) {
    console.error("[healdesk] offer-ended email not scheduled", {
      slug: session.slug,
      error: error instanceof Error ? error.message : String(error),
    });
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
 * Send the link to the prospect and stamp the row. Refuses a demo the audit
 * has not cleared (`handoffBlocker`) or one with no address. Every path that
 * mails a demo comes through here, so this is where the gate cannot be
 * walked around.
 */
export async function sendDemoEmail(session: DemoSession): Promise<SendResult> {
  const blocked = handoffBlocker(session);
  if (blocked) return { status: "skipped", reason: blocked };
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

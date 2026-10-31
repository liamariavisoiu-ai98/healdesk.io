import { isSpecialtyId } from "@healdesk/catalog";

import { emailKey, send, unsubscribeUrl, type SendResult } from "@/lib/email";
import { demoEmail } from "@/lib/email/demo-ready";
import { canEmail, leadForCommercialEmail } from "@/lib/leads";
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
import { AUDIT_BY_MS, EXTRACT_BY_MS, READ_BY_MS, REPAIR_NEEDS_MS } from "./budget";
import { fetchGoogleListing, type GoogleListing } from "./google-listing";
import { groundProfile } from "./ground";
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
 *      read the site and the Google listing, structure them into a profile,
 *      check it against the pages (lib/demo/ground.ts), write it to the row
 *      as `auditing`, or mark it `failed` with a reason the console shows.
 *   3. The handoff audit (lib/demo/audit.ts) grades the demo with Claude
 *      Opus 5.5. A pass turns it `ready`; a near miss gets one repair round
 *      when the clock allows; anything broken or misleading is `held` for an
 *      operator, with an alert. Only `ready` is served, so the gate holds the
 *      link and not just the email.
 *
 * All of it inside one minute (lib/demo/budget.ts, owner, 29 October 2026):
 * each step has a point on the clock it must be done by, and the waiting
 * screens count down to the same minute.
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

/** The Google lookup stops this long before the profile is due, so merging it never makes the extraction late. */
const LISTING_MARGIN_MS = 1_500;

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
    emailRequested: input.sendEmail ?? false,
  });
  return { ok: true, session, url: demoUrl(session.slug) };
}

/**
 * The Google listing on top of the website's profile (lib/demo/google-listing.ts):
 * its hours win over the website's; its phone and address fill in only where
 * the website gave none; its "about" details are added. Normalised, so it
 * hashes as it will be stored. Exported for the test.
 */
export function withListing(extracted: ClinicProfile, google: GoogleListing | null, fallbackName: string): ClinicProfile {
  const hours =
    google && google.hours.length > 0
      ? { hours: google.hours, hoursSource: "google" as const, hoursPlace: google.place || null }
      : { hoursSource: extracted.hours.length > 0 ? ("website" as const) : null, hoursPlace: null };
  const phone = extracted.phone ? {} : google?.phone ? { phone: google.phone, phoneSource: "google" as const } : {};
  const address = extracted.address ? {} : google?.address ? { address: google.address, addressSource: "google" as const } : {};
  return normalizeProfile({ ...extracted, ...hours, ...phone, ...address, listingFacts: google?.about ?? [] }, fallbackName);
}

/**
 * Past this, a build is stopped and marked failed, at whatever step it is on.
 * The steps' own deadlines end by BUILD_BUDGET_MS (lib/demo/budget.ts); this
 * is the backstop for anything that ignores them, well inside the routes' 300 s.
 */
export const BUILD_HARD_STOP_MS = 150_000;

class BuildTimeout extends Error {
  constructor(ms: number) {
    super(`the build passed its ${Math.round(ms / 1000)} s hard stop`);
    this.name = "BuildTimeout";
  }
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

  // The brand reaches the row as soon as the homepage has been read, so the
  // waiting screen shows the clinic's own logo and colour while the rest is built.
  let brandWrite: Promise<unknown> = Promise.resolve();
  // What the build was doing, for the console when it fails: "see the server
  // log" sent the team to a log they could not open (Miami Skin & Vein,
  // 30 October 2026, failed after an 82/100 audit with no cause shown).
  let stage = "reading the website";
  const mark = (next: string) => {
    console.info("[healdesk] demo build step", { slug, step: next, afterMs: Date.now() - started });
    stage = next;
  };
  // A hard stop, whatever hangs: the waiting page promises about a minute,
  // and a build that never wrote its end left the prospect watching "Testing
  // AYA's answers" for ten minutes (Miami Skin & Vein, 30 October 2026).
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<never>((_, reject) => {
    stopTimer = setTimeout(() => reject(new BuildTimeout(BUILD_HARD_STOP_MS)), BUILD_HARD_STOP_MS);
  });
  try {
    const build = async (): Promise<DemoSession | null> => {
      // The Google listing needs only the name and the domain, and is merged in
      // only after the extraction, so it runs beside both, until just before the
      // profile is due (lib/demo/google-listing.ts). A failed lookup costs the
      // demo nothing but what the listing would have added.
      const listing = fetchGoogleListing(session.clinicName, session.websiteUrl, started + EXTRACT_BY_MS - LISTING_MARGIN_MS).catch(
        (error: unknown): GoogleListing | null => {
          console.warn("[healdesk] google listing lookup failed", {
            slug,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        },
      );
      const scraped = await scrapeClinicSite(session.websiteUrl, {
        deadline: started + READ_BY_MS,
        onBrand: (brand) => {
          brandWrite = updateDemoSession(slug, { brandName: brand.name, logoUrl: brand.logoUrl, brandColor: brand.color }).catch(() => null);
        },
      });
      const extract = async (feedback?: readonly string[], deadline: number = started + EXTRACT_BY_MS): Promise<ClinicProfile> => {
        const raw = await structureProfile(scraped.pages, { clinicName: session.clinicName, niche: session.niche, feedback, deadline });
        const grounded = groundProfile(raw, scraped.pages);
        if (grounded.dropped.length > 0) console.info("[healdesk] demo facts dropped, not on the pages", { slug, dropped: grounded.dropped });
        return withListing(grounded.profile, await listing, session.clinicName);
      };

      mark("building the profile");
      const profile = await extract();
      await brandWrite;
      if (!isUsableProfile(profile)) {
        // Every end of a run, this one included, resets the stall count: the
        // count is about the run that is on, not the demo's history
        // (lib/demo/sweep.ts), so the next run gets its own retry.
        return await updateDemoSession(slug, {
          status: "failed",
          retryCount: 0,
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

      mark("auditing the demo");
      const gated = await auditWithRepair(session, scraped.pages, profile, extract, started + AUDIT_BY_MS);
      mark("saving the audit");
      const done = await recordVerdict(slug, gated, session.readyAt);
      const emailWanted = options.sendEmail || session.emailRequested;
      if (done?.status === "ready" && emailWanted && !done.emailSentAt) return await emailWithoutFailing(done);
      return done;
    };
    return await Promise.race([build(), stop]);
  } catch (error) {
    // Its write reads and rewrites the whole row: let it land before this one, never after.
    await brandWrite;
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof ScrapeError || (error instanceof Error && error.name === "StructureError")
        ? message
        : error instanceof BuildTimeout
          ? `The build stopped after ${Math.round(BUILD_HARD_STOP_MS / 1000)} seconds while ${stage}. Retry it; if it stops at the same step again, the server log has the step timings.`
          : `The build failed while ${stage}: ${message.slice(0, 240)}`;
    console.error("[healdesk] demo build failed", { slug, stage, error: message });
    return updateDemoSession(slug, { status: "failed", buildNote: reason, retryCount: 0 }).catch(() => null);
  } finally {
    clearTimeout(stopTimer);
  }
}

/**
 * The demo-ready email, after a demo has passed: a demo that is built and
 * audited stays ready whatever happens to its email, and the console's note
 * says why the email did not go, so the team can send the link by hand.
 */
async function emailWithoutFailing(done: DemoSession): Promise<DemoSession> {
  let why: string | null;
  try {
    const result = await sendDemoEmail(done);
    why = result.status === "sent" ? null : result.reason;
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
    console.error("[healdesk] demo email threw; the demo stays ready", { slug: done.slug, error: why });
  }
  if (why === null) return (await getDemoSession(done.slug, { fresh: true }).catch(() => null)) ?? done;
  const note = `Ready, but the link was not emailed to the prospect: ${why.slice(0, 240).replace(/\.$/, "")}. Copy the link and send it by hand.`;
  return (await updateDemoSession(done.slug, { buildNote: note }).catch(() => null)) ?? done;
}

export type Gated =
  | { kind: "audited"; profile: ClinicProfile; report: AuditReport }
  | { kind: "unavailable"; profile: ClinicProfile; reason: string };

/**
 * The first audit, and the repair round when `decide()` asks for one and
 * there is time for it (REPAIR_NEEDS_MS before `deadline`). The round kept is
 * the better of the two (a repair can make things worse), and its decision is
 * taken again with no repair left. Exported for
 * scripts/demo-audit-calibrate.ts, which measures this exact path.
 */
export async function auditWithRepair(
  session: Pick<DemoSession, "slug" | "clinicName">,
  pages: readonly ScrapedPage[],
  profile: ClinicProfile,
  extract: (feedback?: readonly string[], deadline?: number) => Promise<ClinicProfile>,
  deadline: number,
): Promise<Gated> {
  const base = { operatorName: session.clinicName, pages, deadline };
  let first: AuditReport;
  try {
    first = await auditDemo({ ...base, profile, round: 0, canRepair: true });
  } catch (error) {
    if (error instanceof AuditUnavailableError) return { kind: "unavailable", profile, reason: error.message };
    throw error;
  }

  if (first.decision !== "repair") return { kind: "audited", profile, report: first };
  if (deadline - Date.now() < REPAIR_NEEDS_MS) {
    return { kind: "audited", profile, report: { ...first, decision: decide(first, { canRepair: false }) } };
  }

  let repairedProfile: ClinicProfile;
  let second: AuditReport;
  try {
    // Half of what is left re-extracts; the audit keeps the rest.
    repairedProfile = await extract(repairFeedback(first), Date.now() + Math.floor((deadline - Date.now()) / 2));
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

/**
 * `readyBefore` is when the demo was first ready, if it was: a rebuild that
 * ships keeps it, because the setup offer's 48 hours run from then
 * (demoOfferEndsAt). Until 31 October 2026 every rebuild set it afresh, and
 * demo call c4093be6 told an owner "the next 47 hours" of an offer that had
 * started the day before.
 */
async function recordVerdict(slug: string, gated: Gated, readyBefore: Date | null = null): Promise<DemoSession | null> {
  const now = new Date();
  const base = {
    profile: gated.profile as unknown as Record<string, unknown>,
    auditedAt: now,
    auditHash: demoFingerprint(gated.profile),
    // The run finished, however it was judged: the stall count starts over.
    retryCount: 0,
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
    readyAt: ships ? (readyBefore ?? now) : null,
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
  return released;
}

// -----------------------------------------------------------------------------
// The email
// -----------------------------------------------------------------------------

/** The words (lib/email/demo-ready.ts), here too for the callers that import them from the builder. */
export { demoEmail };

/**
 * Send the link to the prospect and stamp the row. Refuses a demo the audit
 * has not cleared (`handoffBlocker`) or one with no address. Every path that
 * mails a demo comes through here, so this is where the gate cannot be
 * walked around: the build's pass, an operator's release and the console's
 * "Email" button alike.
 *
 * The email can carry a setup offer, so it is commercial (Annex X1.10): it
 * goes only to an address whose lead row says we may (`canEmail`, so an
 * address that unsubscribed or bounced is never mailed again), and carries
 * that row's one-click opt-out. With no row to keep an opt-out on (the
 * marketing Sheet unreachable), it does not go. Keyed by the demo, never the
 * address, so an operator who presses "Email" twice sends one email.
 */
export async function sendDemoEmail(session: DemoSession): Promise<SendResult> {
  const blocked = handoffBlocker(session);
  if (blocked) return { status: "skipped", reason: blocked };
  if (!session.leadEmail) return { status: "skipped", reason: "no prospect email on this demo" };

  const lead = await leadForCommercialEmail(session.leadEmail, "demo_email");
  if (!lead) return { status: "skipped", reason: "no lead row to keep the opt-out on" };
  const may = canEmail(lead, "relationship");
  if (!may.ok) return { status: "skipped", reason: `the address is ${may.reason}` };

  const optOut = unsubscribeUrl(lead.id);
  const { subject, text, html } = demoEmail(session, Date.now(), { unsubscribeUrl: optOut });
  let result: SendResult;
  try {
    result = await send({
      to: session.leadEmail,
      subject,
      text,
      html,
      tag: "demo-ready",
      unsubscribeUrl: optOut,
      idempotencyKey: emailKey("demo-ready", session.id),
    });
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

import {
  cleanWebsite,
  isSpecialtyId,
  screenClinicProfile,
  type ClinicProfile,
} from "@healdesk/catalog";
import { and, asc, eq, inArray, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";

import {
  clinicChannels,
  clinicProviders,
  clinics,
  siteRereads,
  websiteChanges,
  type SiteReread,
} from "@/db/schema";
import { flagInsuranceMismatch } from "@/lib/agreements/misclassification";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { appliesWhen } from "@/lib/portal/applies";
import {
  knowledgeWriteOptions,
  practiceQuestionsSeam,
  type KnowledgeContext,
  type KnowledgeSection,
} from "@/lib/portal/knowledge";
import { publicUrl, PublicUrlError } from "@/lib/public-url";
import { formatPhone } from "@/lib/setup/help";
import {
  KnowledgeError,
  readKnowledge,
  savePolicies,
  saveQuickAnswers,
  saveServices,
  serviceFromProfile,
  serviceInputOf,
  validatePolicies,
  validateQuickAnswers,
  validateServices,
} from "@/lib/setup/knowledge";
import {
  adoptReadHours,
  PracticeError,
  readUpcomingClosures,
  saveBasics,
  saveHours,
} from "@/lib/setup/practice";
import { toE164 } from "@/lib/setup/settings";
import { readSetupState, type SetupState } from "@/lib/setup/state";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { clinicActorOf } from "@/lib/clinic/change-events";
import type { ClinicChangeActor } from "@/db/schema";

import type { SiteReadOutcome } from "./client";
import {
  clinicLocation,
  describeChange,
  diffProfiles,
  fingerprintOf,
  keyOf,
  sameAnswers,
  sameServices,
  sameTexts,
  seededAnswers,
  seededServices,
  stillOpen,
  untouched,
  type KnowledgeView,
  type WebsiteChange,
} from "./diff";
import {
  WEBSITE_CHANGE_SECTIONS,
  type SiteRereadFailure,
  type SiteRereadStatus,
  type WebsiteChangeSection,
} from "./types";

/**
 * The re-reads and the drift list in the database (plan Part B, "Re-reads";
 * Part F3, "Changes on your website"; Annex X5, L23).
 *
 * A read is claimed under a lease in one transaction, sent to apps/web
 * outside any (lib/website/job.ts), and recorded in a third, here:
 *
 * - **A missing or corrected website** (or an operator's read of a clinic
 *   with no profile) becomes the baseline, clinics.site_profile. While no
 *   channel is live, what the purchase read seeded and nobody has touched is
 *   replaced from it, and what is still empty is filled, as provisioning
 *   would have done had the read been there: setup never asks for what the
 *   website says. Anything else it says that Knowledge does not waits on
 *   the drift list.
 * - **The monthly drift check** (or an operator's read of a clinic with a
 *   profile) is compared with the baseline, which stays the purchase read,
 *   per Knowledge section (diff.ts). Each change Knowledge does not already
 *   say waits on the list; one a later read no longer finds is superseded;
 *   one the clinic ignored is remembered by its fingerprint and never raised
 *   again. When the check raises any, the clinic gets L23, which names each
 *   section and a count, never the service.
 *
 * The clinic confirms a change into Knowledge through the knowledge writers,
 * which screen it again, and the practice questions run again after it, or
 * ignores it (`decideWebsiteChange`). Nothing here is a patient's: a
 * website is what a practice publishes about itself.
 */

const LEASE_MS = 5 * 60_000;
/** Tries per read, the first included. */
export const MAX_SITE_READ_ATTEMPTS = 3;
/** After the first failure, and after the second. */
const BACKOFF_MS = [30 * 60_000, 6 * 60 * 60_000] as const;
/** Worth another try later: the site, apps/web or the network may answer then. */
const RETRYABLE: ReadonlySet<SiteRereadFailure> = new Set([
  "unreadable",
  "rate_limited",
  "unavailable",
  "network",
]);

/** Where the list sits on Knowledge, for L23's link and Home's item. */
export const WEBSITE_ANCHOR = "website";

// -----------------------------------------------------------------------------
// Claiming a read
// -----------------------------------------------------------------------------

/**
 * Take a due read under a lease: a queued one whose time has come, or a
 * running one whose lease ran out. Never while another read of the same
 * clinic is running: one at a time per clinic, which the running index also
 * holds. Null when it is not ours to run.
 */
export async function claimSiteReread(
  tx: TenantTx,
  id: string,
  now: Date = new Date(),
): Promise<SiteReread | null> {
  const [other] = await tx.db
    .select({ id: siteRereads.id })
    .from(siteRereads)
    .where(
      and(
        eq(siteRereads.clinicId, tx.clinicId),
        eq(siteRereads.status, "running"),
        ne(siteRereads.id, id),
      ),
    )
    .limit(1);
  if (other) return null;
  const [row] = await tx.db
    .update(siteRereads)
    .set({
      status: "running",
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempts: sql`${siteRereads.attempts} + 1`,
    })
    .where(
      and(
        eq(siteRereads.id, id),
        or(
          and(eq(siteRereads.status, "queued"), lte(siteRereads.runAfter, now)),
          and(eq(siteRereads.status, "running"), lt(siteRereads.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

// -----------------------------------------------------------------------------
// Recording what came back
// -----------------------------------------------------------------------------

export type SiteRereadRecord = {
  status: SiteRereadStatus;
  /** Changes this read raised on the drift list. */
  changes: number;
  /** Knowledge sections a setup read replaced or filled. */
  refilled: string[];
  /** Whether L23 was queued. */
  emailed: boolean;
  failure?: SiteRereadFailure;
};

type ClinicFacts = {
  slug: string;
  website: string | null;
  siteProfile: ClinicProfile | null;
  specialty: string;
  address: string | null;
  publishedPhoneE164: string | null;
  openingHours: KnowledgeView["openingHours"];
  hoursConfirmed: boolean;
  offboarding: boolean;
  live: boolean;
};

async function clinicFacts(tx: TenantTx): Promise<ClinicFacts | null> {
  const [row] = await tx.db
    .select({
      slug: clinics.slug,
      website: clinics.website,
      siteProfile: clinics.siteProfile,
      specialty: clinics.specialty,
      address: clinics.address,
      publishedPhoneE164: clinics.publishedPhoneE164,
      openingHours: clinics.openingHours,
      onboarding: clinics.onboarding,
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      wentLiveAt: clinics.wentLiveAt,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) return null;
  const [liveChannel] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), isNotNull(clinicChannels.liveAt)))
    .limit(1);
  return {
    slug: row.slug,
    website: row.website,
    siteProfile: row.siteProfile ?? null,
    specialty: row.specialty,
    address: row.address,
    publishedPhoneE164: row.publishedPhoneE164,
    openingHours: row.openingHours ?? null,
    hoursConfirmed: Boolean((row.onboarding as Record<string, unknown> | null)?.hours_confirmed),
    offboarding: row.offboardingStartedAt !== null || row.destroyedAt !== null,
    live: row.wentLiveAt !== null || liveChannel !== undefined,
  };
}

/** What Knowledge says now, for the parts a website also says. */
async function knowledgeView(
  tx: TenantTx,
  clinic: Pick<ClinicFacts, "address" | "publishedPhoneE164" | "openingHours">,
): Promise<KnowledgeView> {
  const knowledge = await readKnowledge(tx.db, tx.clinicId);
  const people = await tx.db
    .select({ name: clinicProviders.displayName })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)));
  return {
    services: knowledge.services,
    policies: knowledge.policies,
    quickAnswers: knowledge.quickAnswers,
    providers: people.map((p) => p.name),
    address: clinic.address,
    phoneE164: clinic.publishedPhoneE164,
    openingHours: clinic.openingHours,
  };
}

async function finish(
  tx: TenantTx,
  id: string,
  set: { status: SiteRereadStatus; failure?: SiteRereadFailure | null; changes?: number },
  now: Date,
): Promise<void> {
  await tx.db
    .update(siteRereads)
    .set({
      status: set.status,
      leaseUntil: null,
      finishedAt: now,
      ...(set.failure !== undefined ? { failure: set.failure } : {}),
      ...(set.changes !== undefined ? { changes: set.changes } : {}),
    })
    .where(eq(siteRereads.id, id));
}

async function anotherQueued(tx: TenantTx, id: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: siteRereads.id })
    .from(siteRereads)
    .where(
      and(
        eq(siteRereads.clinicId, tx.clinicId),
        eq(siteRereads.status, "queued"),
        ne(siteRereads.id, id),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Record a claimed read's outcome. Null when the read is no longer ours: its
 * lease ran out and another run of the job took it over.
 */
export async function recordSiteReread(
  tx: TenantTx,
  input: { reread: SiteReread; outcome: SiteReadOutcome; now?: Date },
): Promise<SiteRereadRecord | null> {
  const now = input.now ?? new Date();
  const { reread, outcome } = input;
  const [current] = await tx.db
    .select({ status: siteRereads.status, attempts: siteRereads.attempts })
    .from(siteRereads)
    .where(eq(siteRereads.id, reread.id))
    .for("update")
    .limit(1);
  if (!current || current.status !== "running" || current.attempts !== reread.attempts) return null;

  const clinic = await clinicFacts(tx);
  // The clinic left, or its website is not the one read any more (it was
  // corrected while this waited or ran, and that read is queued): nothing
  // this read says is the clinic's.
  if (!clinic || clinic.offboarding || cleanWebsite(clinic.website) !== reread.website) {
    await finish(tx, reread.id, { status: "superseded" }, now);
    return { status: "superseded", changes: 0, refilled: [], emailed: false };
  }

  if (outcome.status === "failed") {
    const failure = outcome.failure;
    const again =
      RETRYABLE.has(failure) &&
      reread.attempts < MAX_SITE_READ_ATTEMPTS &&
      !(await anotherQueued(tx, reread.id));
    if (again) {
      const backoff = BACKOFF_MS[Math.min(reread.attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
      const wait = Math.max(backoff, (outcome.retryAfterSeconds ?? 0) * 1000);
      await tx.db
        .update(siteRereads)
        .set({
          status: "queued",
          leaseUntil: null,
          failure,
          runAfter: new Date(now.getTime() + wait),
        })
        .where(eq(siteRereads.id, reread.id));
      return { status: "queued", changes: 0, refilled: [], emailed: false, failure };
    }
    const status = (await anotherQueued(tx, reread.id)) ? "superseded" : "failed";
    await finish(tx, reread.id, { status, failure }, now);
    tx.audit.record({
      action: "update",
      resourceType: "site_reread",
      resourceId: reread.id,
      metadata: { reason: reread.reason, status, failure },
    });
    return { status, changes: 0, refilled: [], emailed: false, failure };
  }

  // The purchase read's screen, under the specialty the clinic bought.
  const profile = screenClinicProfile(
    outcome.profile,
    isSpecialtyId(clinic.specialty) ? clinic.specialty : null,
  );
  const baseline = clinic.siteProfile;

  // Every read of the website asks the misclassification question of what it
  // found (plan Part L; lib/agreements/misclassification.ts): a practice
  // under the DPA that answered "No" whose site says it accepts insurance
  // goes to ops' review queue, whether or not this read becomes the baseline.
  const flagged = await flagInsuranceMismatch(tx, now, profile);

  // The misclassification check reads for that alone: it leaves the
  // baseline, the drift list and the clinic's email as they are.
  if (
    reread.reason === "insurance" &&
    baseline !== null &&
    cleanWebsite(baseline.website) === reread.website
  ) {
    await finish(tx, reread.id, { status: "read", failure: null, changes: 0 }, now);
    tx.audit.record({
      action: "update",
      resourceType: "site_reread",
      resourceId: reread.id,
      metadata: { reason: reread.reason, status: "read", baseline: "kept", flagged },
    });
    return { status: "read", changes: 0, refilled: [], emailed: false };
  }
  // The baseline is the purchase read of this website. With none, or one of
  // another website, this read takes its place; a drift read keeps it.
  const adopt =
    reread.reason === "missing" ||
    reread.reason === "corrected" ||
    baseline === null ||
    cleanWebsite(baseline.website) !== reread.website;

  let knowledge = await knowledgeView(tx, clinic);
  let changes = diffProfiles(baseline, profile, { address: clinic.address }).filter((c) =>
    stillOpen(c, knowledge),
  );

  const refilled: KnowledgeSection[] = [];
  if (adopt && !clinic.live) {
    refilled.push(...(await refill(tx, { clinic, baseline, profile, knowledge, changes, now })));
    if (refilled.length > 0) {
      knowledge = await knowledgeView(tx, (await clinicFacts(tx)) ?? clinic);
      changes = changes.filter((c) => stillOpen(c, knowledge));
    }
  }
  if (adopt) {
    await tx.db
      .update(clinics)
      .set({ siteProfile: profile, updatedAt: now })
      .where(eq(clinics.id, tx.clinicId));
  }

  const raised = await recordChanges(tx, reread.id, changes, now);
  await finish(tx, reread.id, { status: "read", failure: null, changes: raised.length }, now);

  // L23, for the checks the clinic did not start: the monthly one, and an
  // operator's of a clinic whose baseline stands.
  let emailed = false;
  if (!adopt && raised.length > 0)
    emailed = await queueChangesEmail(tx, clinic.slug, reread.id, raised);

  tx.audit.record({
    action: "update",
    resourceType: "site_reread",
    resourceId: reread.id,
    metadata: {
      reason: reread.reason,
      status: "read",
      baseline: adopt ? "replaced" : "kept",
      changes: raised.length,
      refilled,
      flagged,
    },
  });
  return { status: "read", changes: raised.length, refilled, emailed };
}

/**
 * Before go-live, a read that becomes the baseline fills setup as
 * provisioning would have (lib/setup/seed.ts): the services, policies and
 * quick answers nobody has touched since the last read seeded them (or that
 * are empty) are replaced from this one; the hours, until the clinic has
 * confirmed them; the address and main number, where there are none. Never a
 * section the clinic has edited: what it said stands, and the list raises
 * the rest. Returns the sections written.
 */
async function refill(
  tx: TenantTx,
  input: {
    clinic: ClinicFacts;
    baseline: ClinicProfile | null;
    profile: ClinicProfile;
    knowledge: KnowledgeView;
    /** This read's open changes: hours, an address and a number are filled only where they differ. */
    changes: readonly WebsiteChange[];
    now: Date;
  },
): Promise<KnowledgeSection[]> {
  const { clinic, baseline, profile, knowledge, changes, now } = input;
  const open = (section: WebsiteChangeSection, key?: string) =>
    changes.some((c) => c.section === section && (key === undefined || c.key === key));
  const written: KnowledgeSection[] = [];

  const services = seededServices(profile, clinic.specialty);
  if (
    untouched(knowledge.services, seededServices(baseline, clinic.specialty), sameServices) &&
    !sameServices(knowledge.services, services)
  ) {
    await saveServices(tx, services, now);
    written.push("prices");
  }
  if (
    untouched(knowledge.policies, baseline?.policies ?? [], sameTexts) &&
    !sameTexts(knowledge.policies, profile.policies)
  ) {
    await savePolicies(tx, [...profile.policies], now);
    written.push("policies");
  }
  const answers = seededAnswers(profile);
  if (
    untouched(knowledge.quickAnswers, seededAnswers(baseline), sameAnswers) &&
    !sameAnswers(knowledge.quickAnswers, answers)
  ) {
    await saveQuickAnswers(tx, answers, now);
    written.push("quick_answers");
  }

  const location = clinicLocation(profile, clinic.address);
  if (location?.hours && !clinic.hoursConfirmed && open("hours")) {
    await adoptReadHours(tx, location.hours, now);
    written.push("hours");
  }
  const phone = location?.phone ? toE164(location.phone) : null;
  const fill = {
    ...(clinic.address === null && location?.address && open("practice", "address")
      ? { address: location.address }
      : {}),
    ...(clinic.publishedPhoneE164 === null && phone && open("practice", "phone")
      ? { publishedPhoneE164: phone }
      : {}),
  };
  if (Object.keys(fill).length > 0) {
    await tx.db
      .update(clinics)
      .set({ ...fill, updatedAt: now })
      .where(eq(clinics.id, tx.clinicId));
    written.push("practice");
  }

  for (const section of written) await practiceQuestionsSeam(tx, section, now);
  return written;
}

/**
 * Put this read's open changes on the list: a change never seen is added, a
 * superseded one comes back, a waiting one is marked as found again, and a
 * confirmed or ignored one stays as it was. Every waiting change this read
 * no longer found is superseded. Returns the changes raised by this read.
 */
async function recordChanges(
  tx: TenantTx,
  rereadId: string,
  changes: readonly WebsiteChange[],
  now: Date,
): Promise<WebsiteChange[]> {
  const byFingerprint = new Map(changes.map((c) => [fingerprintOf(c), c]));
  const fingerprints = [...byFingerprint.keys()];
  const known = fingerprints.length
    ? await tx.db
        .select({
          id: websiteChanges.id,
          fingerprint: websiteChanges.fingerprint,
          state: websiteChanges.state,
        })
        .from(websiteChanges)
        .where(
          and(
            eq(websiteChanges.clinicId, tx.clinicId),
            inArray(websiteChanges.fingerprint, fingerprints),
          ),
        )
    : [];
  const seen = new Map(known.map((k) => [k.fingerprint, k]));

  const raised: WebsiteChange[] = [];
  for (const [fingerprint, change] of byFingerprint) {
    const row = seen.get(fingerprint);
    if (!row) {
      await tx.db.insert(websiteChanges).values({
        clinicId: tx.clinicId,
        rereadId,
        section: change.section,
        kind: change.kind,
        itemKey: change.key,
        fingerprint,
        before: change.before as Record<string, unknown> | null,
        after: change.after as Record<string, unknown> | null,
        detectedAt: now,
      });
      raised.push(change);
    } else if (row.state === "superseded") {
      await tx.db
        .update(websiteChanges)
        .set({ state: "new", rereadId, detectedAt: now })
        .where(and(eq(websiteChanges.id, row.id), eq(websiteChanges.state, "superseded")));
      raised.push(change);
    } else if (row.state === "new") {
      await tx.db.update(websiteChanges).set({ rereadId }).where(eq(websiteChanges.id, row.id));
    }
  }

  const waiting = await tx.db
    .select({ id: websiteChanges.id, fingerprint: websiteChanges.fingerprint })
    .from(websiteChanges)
    .where(and(eq(websiteChanges.clinicId, tx.clinicId), eq(websiteChanges.state, "new")));
  const gone = waiting.filter((w) => !byFingerprint.has(w.fingerprint)).map((w) => w.id);
  if (gone.length > 0) {
    await tx.db
      .update(websiteChanges)
      .set({ state: "superseded" })
      .where(and(inArray(websiteChanges.id, gone), eq(websiteChanges.state, "new")));
  }
  return raised;
}

/** L23: each Knowledge section and how many changes in it, never the service. */
async function queueChangesEmail(
  tx: TenantTx,
  slug: string,
  rereadId: string,
  raised: readonly WebsiteChange[],
): Promise<boolean> {
  let reviewUrl: string;
  try {
    reviewUrl = publicUrl(`/c/${slug}/knowledge#${WEBSITE_ANCHOR}`);
  } catch (error) {
    if (!(error instanceof PublicUrlError)) throw error;
    // The changes are on the list either way; Home says so.
    log.error("website changes email not queued: no public origin", {
      clinicId: tx.clinicId,
      rereadId,
      error: describeError(error),
    });
    return false;
  }
  const counts = new Map<WebsiteChangeSection, number>();
  for (const change of raised) counts.set(change.section, (counts.get(change.section) ?? 0) + 1);
  const sectionRows = WEBSITE_CHANGE_SECTIONS.filter((s) => counts.has(s)).map((section) => ({
    section,
    count: counts.get(section)!,
  }));
  return enqueuePlanNotice(tx.db, tx.clinicId, "website_changes", `website_changes:${rereadId}`, {
    sectionRows,
    count: raised.length,
    reviewUrl,
  });
}

// -----------------------------------------------------------------------------
// The list, for Knowledge and Home
// -----------------------------------------------------------------------------

export type WebsiteChangeView = {
  id: string;
  section: WebsiteChangeSection;
  text: string;
  detail: string | null;
  /** Whether Confirm applies it into Knowledge; providers are set up in Settings instead. */
  canConfirm: boolean;
};

export type WebsiteChangesState = {
  changes: WebsiteChangeView[];
  /** The baseline's website and when it was read; null without one. */
  baseline: { website: string; readAt: string } | null;
  /** When the website was last read again with an answer, if ever. */
  lastReadAt: Date | null;
};

function changeOf(row: typeof websiteChanges.$inferSelect): WebsiteChange {
  return {
    section: row.section,
    kind: row.kind,
    key: row.itemKey,
    before: row.before,
    after: row.after,
  } as WebsiteChange;
}

async function openRows(tx: TenantTx): Promise<(typeof websiteChanges.$inferSelect)[]> {
  return tx.db
    .select()
    .from(websiteChanges)
    .where(and(eq(websiteChanges.clinicId, tx.clinicId), eq(websiteChanges.state, "new")))
    .orderBy(asc(websiteChanges.detectedAt), asc(websiteChanges.id));
}

/**
 * The changes waiting for the clinic, each only while Knowledge still does
 * not say it: one the clinic has made itself leaves the list at once.
 */
export async function readWebsiteChanges(tx: TenantTx): Promise<WebsiteChangesState> {
  const clinic = await clinicFacts(tx);
  if (!clinic) return { changes: [], baseline: null, lastReadAt: null };
  const knowledge = await knowledgeView(tx, clinic);
  const order = new Map(WEBSITE_CHANGE_SECTIONS.map((s, i) => [s, i]));
  const changes = (await openRows(tx))
    .map((row) => ({ row, change: changeOf(row) }))
    .filter(({ change }) => stillOpen(change, knowledge))
    .sort((a, b) => order.get(a.row.section)! - order.get(b.row.section)!)
    .map(({ row, change }) => ({
      id: row.id,
      section: row.section,
      ...describeChange(change),
      canConfirm: row.section !== "providers",
    }));
  const [last] = await tx.db
    .select({ at: siteRereads.finishedAt })
    .from(siteRereads)
    .where(and(eq(siteRereads.clinicId, tx.clinicId), eq(siteRereads.status, "read")))
    .orderBy(sql`${siteRereads.finishedAt} desc`)
    .limit(1);
  return {
    changes,
    baseline: clinic.siteProfile
      ? { website: clinic.siteProfile.website, readAt: clinic.siteProfile.readAt }
      : null,
    lastReadAt: last?.at ?? null,
  };
}

/** How many changes wait for the clinic: Home's "Needs attention". */
export async function countWebsiteChanges(tx: TenantTx): Promise<number> {
  const rows = await openRows(tx);
  if (rows.length === 0) return 0;
  const clinic = await clinicFacts(tx);
  if (!clinic) return 0;
  const knowledge = await knowledgeView(tx, clinic);
  return rows.filter((row) => stillOpen(changeOf(row), knowledge)).length;
}

// -----------------------------------------------------------------------------
// Confirm or ignore
// -----------------------------------------------------------------------------

export type WebsiteChangeDecision = "confirm" | "ignore";

export type WebsiteChangeResult = { ok: true; toast: string } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECTION_SAVED: Readonly<Record<Exclude<WebsiteChangeSection, "providers">, string>> = {
  practice: "Your practice's details are updated.",
  prices: "Prices updated.",
  hours: "Hours updated.",
  policies: "Policies updated.",
  quick_answers: "Quick answers updated.",
};

/**
 * Confirm a change into Knowledge, or ignore it, from the Knowledge screen.
 * A confirmed change goes through the writer its section's form uses, which
 * screens it and names anything it refuses, and asks the practice questions
 * to run again; an ignored one is remembered and never raised again. Both
 * in one tenant transaction, so a refusal leaves the change waiting.
 */
export async function decideWebsiteChange(
  ctx: KnowledgeContext,
  changeId: unknown,
  decision: unknown,
  now: Date = new Date(),
): Promise<WebsiteChangeResult> {
  if (typeof changeId !== "string" || !UUID.test(changeId)) {
    return { ok: false, message: "That change could not be found." };
  }
  if (decision !== "confirm" && decision !== "ignore") {
    return { ok: false, message: "Choose Confirm or Ignore." };
  }
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  try {
    return await withTenant({ clinicId: ctx.clinicId, actor }, async (tx) => {
      const state = await readSetupState(tx, { userId: ctx.userId, now });
      if (!state) return { ok: false, message: "This clinic could not be found." };
      if (state.clinic.offboardingStartedAt) {
        return { ok: false, message: "This account has closed, so its knowledge can't change." };
      }
      const [row] = await tx.db
        .select()
        .from(websiteChanges)
        .where(and(eq(websiteChanges.id, changeId), eq(websiteChanges.state, "new")))
        .for("update")
        .limit(1);
      if (!row) {
        return {
          ok: false,
          message: "That change was already dealt with. Reload the page to see the list as it is.",
        };
      }
      const label = ctx.actorLabel.slice(0, 200) || "portal";

      if (decision === "ignore") {
        await tx.db
          .update(websiteChanges)
          .set({ state: "ignored", decidedAt: now, decidedByLabel: label })
          .where(eq(websiteChanges.id, row.id));
        tx.audit.record({
          action: "update",
          resourceType: "website_change",
          resourceId: row.id,
          metadata: { decision: "ignore", section: row.section, kind: row.kind },
        });
        return { ok: true, toast: "Ignored. We won't raise that change again." };
      }

      if (row.section === "providers") {
        return {
          ok: false,
          message: "Providers are set up with their calendars, in Settings → Calendar.",
        };
      }
      const change = changeOf(row);
      await applyChange(tx, change, state, now, clinicActorOf(ctx.actorLabel));
      await practiceQuestionsSeam(tx, change.section as KnowledgeSection, now);
      await tx.db
        .update(websiteChanges)
        .set({ state: "confirmed", decidedAt: now, decidedByLabel: label })
        .where(eq(websiteChanges.id, row.id));
      tx.audit.record({
        action: "update",
        resourceType: "website_change",
        resourceId: row.id,
        metadata: { decision: "confirm", section: row.section, kind: row.kind },
      });
      const said = SECTION_SAVED[change.section as Exclude<WebsiteChangeSection, "providers">];
      const applies = appliesWhen(state.channels);
      return {
        ok: true,
        toast: applies ? `${said} ${applies}` : `${said} AYA uses it from now on.`,
      };
    });
  } catch (error) {
    if (error instanceof KnowledgeError || error instanceof PracticeError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/**
 * One change into Knowledge, through the writer its section's form uses:
 * the same validation, the same clinical screen, the same refusals. A
 * service, a policy or a question is matched by its key; what the clinic set
 * beside it (a service's deposit) is kept.
 */
async function applyChange(
  tx: TenantTx,
  change: WebsiteChange,
  state: SetupState,
  now: Date,
  actor: ClinicChangeActor,
): Promise<void> {
  const options = await knowledgeWriteOptions(tx);
  switch (change.section) {
    case "prices": {
      const { services } = await readKnowledge(tx.db, tx.clinicId);
      const rows = services.map(serviceInputOf);
      const at = rows.findIndex((s) => keyOf(s.name) === change.key);
      if (change.kind === "removed") {
        if (at >= 0) rows.splice(at, 1);
      } else {
        const site = serviceInputOf(serviceFromProfile(change.after!));
        if (at >= 0) rows[at] = { ...site, name: rows[at]!.name, depositUsd: rows[at]!.depositUsd };
        else rows.push(site);
      }
      await saveServices(tx, validateServices(rows, state.clinic.specialty), now, options);
      return;
    }
    case "policies": {
      const { policies } = await readKnowledge(tx.db, tx.clinicId);
      const kept = policies.filter((p) => keyOf(p) !== change.key);
      const next = change.kind === "removed" ? kept : [...kept, change.after!.text];
      await savePolicies(tx, validatePolicies(next), now, options);
      return;
    }
    case "quick_answers": {
      const { quickAnswers } = await readKnowledge(tx.db, tx.clinicId);
      const at = quickAnswers.findIndex((a) => keyOf(a.question) === change.key);
      const next = [...quickAnswers];
      if (change.kind === "removed") {
        if (at >= 0) next.splice(at, 1);
      } else if (at >= 0) {
        next[at] = { question: next[at]!.question, answer: change.after!.answer };
      } else {
        next.push({ question: change.after!.question, answer: change.after!.answer });
      }
      await saveQuickAnswers(tx, validateQuickAnswers(next), now, options);
      return;
    }
    case "hours": {
      const closures = await readUpcomingClosures(tx.db, tx.clinicId, state.clinic.timezone, now);
      await saveHours(
        tx,
        {
          hours: change.after,
          closures: closures.map((c) => ({ closedOn: c.closedOn, label: c.label ?? "" })),
        },
        state.clinic.timezone,
        now,
        // Recorded for ops as a website change the clinic took (lib/clinic/change-events.ts).
        { source: "website", actor },
      );
      return;
    }
    case "practice": {
      const { clinic } = state;
      const value = change.after!;
      await saveBasics(
        tx,
        {
          name: clinic.name,
          address: value.field === "address" ? value.value : (clinic.address ?? ""),
          phone:
            value.field === "phone"
              ? value.value
              : clinic.publishedPhoneE164
                ? formatPhone(clinic.publishedPhoneE164)
                : "",
          website: clinic.website ?? "",
          timezone: clinic.timezone,
        },
        now,
      );
      return;
    }
    case "providers":
      throw new KnowledgeError("section", "Providers are set up in Settings → Calendar.");
  }
}

// -----------------------------------------------------------------------------
// What the sweeps ask for
// -----------------------------------------------------------------------------

/** How long after a read the drift check reads the website again. */
export const DRIFT_INTERVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Missing-profile and corrected reads the sweep asks for, at most, before it leaves them to an operator. */
const ADOPT_TRIES = 3;

/**
 * The read a clinic is owed now, if any: a website with no baseline, or one
 * of another website (`missing`, `corrected`), which the clinic's own save
 * asks for and this catches when it did not, at most ADOPT_TRIES times and
 * once a day; or, when `drift` is on and a channel is live, the monthly
 * check, DRIFT_INTERVAL_DAYS after the newest of the baseline's read and the
 * last check asked for. Null while a read is queued or running.
 */
export async function siteRereadOwed(
  tx: TenantTx,
  input: { now: Date; drift: boolean },
): Promise<{ reason: "missing" | "corrected" | "drift" | "insurance"; website: string } | null> {
  const clinic = await clinicFacts(tx);
  if (!clinic || clinic.offboarding) return null;
  const website = cleanWebsite(clinic.website);
  if (!website) return null;

  const reads = await tx.db
    .select({
      reason: siteRereads.reason,
      status: siteRereads.status,
      requestedAt: siteRereads.requestedAt,
      website: siteRereads.website,
    })
    .from(siteRereads)
    .where(eq(siteRereads.clinicId, tx.clinicId));
  if (reads.some((r) => r.status === "queued" || r.status === "running")) return null;

  const baseline = clinic.siteProfile;
  if (!baseline || cleanWebsite(baseline.website) !== website) {
    const tries = reads.filter((r) => r.website === website && r.reason !== "drift");
    const recent = tries.some((r) => input.now.getTime() - r.requestedAt.getTime() < DAY_MS);
    if (tries.length >= ADOPT_TRIES || recent) return null;
    return { reason: baseline ? "corrected" : "missing", website };
  }

  // The misclassification check (plan Part L): a practice under the DPA that
  // answered "No" whose baseline says nothing about insurance, which a
  // demo's read never does, is read once more for that alone, unless a read
  // of this website has come back since, which asked it already. Behind
  // `site-reads` like the reads above, not behind the drift switch: until it
  // goes live a practice gets no drift check at all.
  if (baseline.acceptsInsurance === "unknown" && (await answeredNo(tx))) {
    const asked = reads.some(
      (r) => r.website === website && (r.reason === "insurance" || r.status === "read"),
    );
    if (!asked) return { reason: "insurance", website };
  }

  if (!input.drift || !clinic.live) return null;
  const checks = reads
    .filter((r) => r.reason === "drift" || r.reason === "ops")
    .map((r) => r.requestedAt.getTime());
  const last = Math.max(Date.parse(baseline.readAt), ...checks);
  if (input.now.getTime() - last < DRIFT_INTERVAL_DAYS * DAY_MS) return null;
  return { reason: "drift", website };
}

/** Whether the clinic is a practice under the DPA that answered "No": the signal's own facts, but the site's. */
async function answeredNo(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({
      regime: clinics.regulatoryRegime,
      kind: clinics.agreementKind,
      covered: clinics.isCoveredEntity,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row?.regime === "hipaa-if-covered" && row.kind === "dpa" && row.covered === false;
}

/** The drift list for the Knowledge screen, in its own tenant transaction. */
export async function loadWebsiteChanges(
  clinicId: string,
  actor: ActorContext,
): Promise<WebsiteChangesState> {
  return withTenant({ clinicId, actor }, (tx) => readWebsiteChanges(tx));
}

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import {
  AGREEMENT_COPY,
  agreementKindOfVersion,
  agreementPlatformFor,
  BAA_TEMPLATES,
  CURRENT_BAA_VERSION,
  isBookingSystemId,
  isCalendarAccount,
  isSpecialtyId,
  type AgreementKind,
  type Channel,
} from "@healdesk/catalog";
import {
  agreementKindForRequest,
  effectiveDateOf,
  prepareSigning,
  type SignAgreementRequest,
} from "@healdesk/catalog/agreement-signing";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agreementResigns,
  clinicChannels,
  clinics,
  clinicSettings,
  type AgreementResign,
  type AgreementResignReason,
  type AgreementResignSource,
} from "@/db/schema";
import {
  AgreementError,
  deliverSignatureCopy,
  recordAcceptance,
  validateSignRequest,
  type SignedCopyDelivery,
} from "@/lib/agreements";
import {
  AuditRecorder,
  recordSecurityEvent,
  type ActorContext,
  type RequestContext,
} from "@/lib/audit";
import { getClinicSettings } from "@/lib/billing/settings";
import { recordSupersedingTerms } from "@/lib/booking/elections";
import { isDemoClinic } from "@/lib/booking/terms";
import { updateClinicSettingsRecordingPause } from "@/lib/channels/pause";
import { AGREEMENT_PAUSE_LABEL, PAUSE_LINE_ORDER } from "@/lib/channels/pause-words";
import { isPaused } from "@/lib/channels/state";
import { assertPayloadAllowed, printableClinicName } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import {
  renderAgreementToSign,
  type AgreementToSignPayload,
} from "@/lib/email/templates/agreement_to_sign";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant, TENANT_GUC, type TenantTx } from "@/lib/tenant";

import { baaVersionResignsReady } from "./baa-version-ready";
import { agreementInEffect } from "./in-effect";
import { openResignHoldsPause, organisationOpenResigns, resignHoldsPause } from "./resign-pause";
import type { ResignDocument } from "./resign-preview";
import { supersedeAgreement, SupersedeError } from "./kind";

/**
 * The re-sign from the Data Protection Agreement to the Business Associate
 * Agreement (package WP9; plan Part L, Annex X5 L22).
 *
 * A practice HIPAA reaches only if it is a covered entity signs the DPA when
 * it answers "No" to "Do you bill any health insurance electronically?". When
 * that answer becomes "Yes" or "Not sure", from ops' setCoveredEntity or the
 * practice's own button in Billing, the DPA stops covering it in the write
 * that records the answer: app_clinic_accepts_phi() refuses its data from
 * then on (drizzle/0051). This module is what follows, in that same
 * transaction and after it:
 *
 *   1. **The re-sign opens** (`openAgreementResign`): an `agreement_resigns`
 *      row naming the DPA it replaces, and AYA paused with the header's own
 *      pause, quietly (its L15 would say "until someone turns her back on").
 *      The answer gate (lib/billing/answering.ts) honours the pause on every
 *      call, chat and message, whether or not it reads the agreement's kind
 *      itself, so "AYA is paused until it's signed" is true from this commit:
 *      calls go to the direct line, website chat shows its contact form, and
 *      Meta messages wait for the team. The header cannot lift it while the
 *      re-sign is open (lib/channels/pause.ts).
 *   2. **L22 goes after commit** (`sendAgreementToSign`), with a signed link,
 *      and again at 3 and 7 days from the hourly job, which also tells ops
 *      at 7 days (`agreement_unsigned_7_days`).
 *   3. **The practice signs** at /agreement/<token>, a screen that reuses the
 *      funnel's agreement step for the BAA with the practice's own validated
 *      answers (app/agreement/[token]). `signAgreementResign` renders the
 *      document again from those answers, refuses a screen that showed
 *      anything else, and in ONE transaction writes the acceptance, puts it
 *      in force through supersedeAgreement (app_supersede_agreement(), which
 *      never goes BAA→DPA and binds the new row), records the calendar terms
 *      the BAA carries for the location set up at signing
 *      (recordSupersedingTerms), closes the re-sign and lifts the pause it
 *      set. The signer's copy goes after commit.
 *   4. **Or ops withdraws it** (`withdrawAgreementResign`): the practice
 *      bills no insurance electronically after all, the DPA covers it again,
 *      and the pause it set is lifted.
 *
 * ## Why the screen is on apps/app
 *
 * The funnel's signing screen lives on apps/web, because a buyer must be
 * able to sign while this host is in standby. A re-sign has none of that: the
 * practice exists, so the host is running, and everything the screen needs is
 * in this database: the practice's validated answers (the DPA in force),
 * whether the link still stands (the open re-sign), and the write itself,
 * which must bind the BAA and close the re-sign together. Every clinic-facing
 * link is composed here from BETTER_AUTH_URL (publicUrl), as /link,
 * /address-change and /booking are; a screen on apps/web would need this host
 * to know the marketing origin, and apps/web to relay an unauthenticated
 * bearer link to /api/ops. HEALDESK_APP_URL is in neither.
 *
 * ## The link
 *
 * Signed, never stored (X1.5): it names the re-sign and its clinic, and when
 * it stops working, under an HMAC keyed from BETTER_AUTH_SECRET for this one
 * use. It works only while the re-sign is open, so the signature spends every
 * link L22 and its reminders carried, and a GET only looks.
 *
 * ## A newer BAA over an older one (`baa_version`, wave 2 R11)
 *
 * Behind a switch (BAA_VERSION_RESIGNS_READY, lib/agreements/
 * baa-version-ready.ts). While it is off nothing below opens one, and one
 * already open is held as it is (resignOpenToPractice): no L22 or reminder
 * goes, no ops alert is raised, Billing shows none, and its link says it is
 * not open yet and signs nothing.
 *
 * The same row, link, screen and reminders carry a practice under a Business
 * Associate Agreement to the current version of it (plan Part L:
 * "re-acceptance of a superseded BAA"; L22: "a supersede (DPA→BAA) or a new
 * BAA version"). Signing goes through the same supersede, which takes a BAA
 * replacing an older BAA and never a DPA replacing anything.
 *
 *   - **Opened by itself** by the hourly job (`release`), for an account
 *     whose BAA in force is below the floor go-live accepts
 *     (app_baa_version_acceptable): a release that raised the floor judged
 *     the older text to need fresh assent, and go-live already refuses it.
 *   - **Opened by an operator** for every account on a version older than
 *     the current one (`startBaaVersionResigns`, lib/agreements/
 *     baa-version.ts): the broadcast a release uses when it keeps the older
 *     version acceptable for a while, so practices can move before the floor
 *     does.
 *   - **AYA never pauses for it** (owner, 19 October 2026; resignHoldsPause,
 *     lib/agreements/resign-pause.ts, the one place that decides). The BAA
 *     has no clause letting healdesk amend it alone: the version signed
 *     governs until a later one is signed ("This agreement replaces any
 *     earlier version of it ... from the effective date forward"), so the
 *     practice keeps AYA answering under it. The signature is chased
 *     instead: L22, its reminders at 3 and 7 days, and at 7 days an ops
 *     alert, its own for a version below the floor
 *     (`agreement_below_floor_unsigned`), for a person to phone the practice;
 *     the ops digest counts those still unsigned. Go-live still refuses a
 *     version below the floor, so a practice not yet live signs first. Only
 *     the DPA→BAA re-sign pauses AYA, at every location of the organisation.
 *   - **The document** is the current BAA rendered from the practice's own
 *     answers: its legal name and signatory from the BAA in force, its
 *     specialty and covered-entity answer from the clinic's record, and the
 *     booking system and Google account the agreement in force recorded, or
 *     the clinic's settings for a version that recorded none (before 1.3.0).
 *
 * Contract metadata and business contact data; never a patient.
 */

/** How long one link works. Each reminder carries a fresh one. */
export const RESIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** L22's reminders, in days after the re-sign began; the last also tells ops. */
export const RESIGN_REMINDER_DAYS = [3, 7] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_ACTOR: ActorContext = { type: "service", serviceName: "agreement-resigns" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -----------------------------------------------------------------------------
// The link
// -----------------------------------------------------------------------------

const TOKEN_VERSION = 1;
/** version (1) + re-sign id (16) + clinic id (16) + expiry in seconds (4) + MAC (32). */
const TOKEN_BYTES = 1 + 16 + 16 + 4 + 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{92}$/;

function tokenKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.betterAuthSecret(), "healdesk", "agreement-resign-link-v1", 32),
  );
}

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function uuidOf(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A link to sign `resign`'s agreement, working until RESIGN_LINK_TTL_MS from `now`. */
export function mintResignToken(
  resign: { id: string; clinicId: string },
  now: Date = new Date(),
): string {
  if (!UUID.test(resign.id) || !UUID.test(resign.clinicId)) {
    throw new Error("A re-sign link names a re-sign and a clinic.");
  }
  const body = Buffer.alloc(TOKEN_BYTES - 32);
  body.writeUInt8(TOKEN_VERSION, 0);
  uuidBytes(resign.id).copy(body, 1);
  uuidBytes(resign.clinicId).copy(body, 17);
  body.writeUInt32BE(Math.floor((now.getTime() + RESIGN_LINK_TTL_MS) / 1000), 33);
  const mac = createHmac("sha256", tokenKey()).update(body).digest();
  return Buffer.concat([body, mac]).toString("base64url");
}

export type ResignToken =
  | { ok: true; resignId: string; clinicId: string; expiresAt: Date }
  | { ok: false; reason: "unknown" | "expired" };

/** What a link says, if it is one we signed; never throws. */
export function readResignToken(token: unknown, now: Date = new Date()): ResignToken {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token))
    return { ok: false, reason: "unknown" };
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== TOKEN_BYTES || raw.readUInt8(0) !== TOKEN_VERSION) {
    return { ok: false, reason: "unknown" };
  }
  const body = raw.subarray(0, TOKEN_BYTES - 32);
  const mac = raw.subarray(TOKEN_BYTES - 32);
  const expected = createHmac("sha256", tokenKey()).update(body).digest();
  if (!timingSafeEqual(mac, expected)) return { ok: false, reason: "unknown" };
  const expiresAt = new Date(body.readUInt32BE(33) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return {
    ok: true,
    resignId: uuidOf(body.subarray(1, 17)),
    clinicId: uuidOf(body.subarray(17, 33)),
    expiresAt,
  };
}

/** The screen's path for a fresh link to `resign`. */
export function resignPath(
  resign: { id: string; clinicId: string },
  now: Date = new Date(),
): string {
  return `/agreement/${mintResignToken(resign, now)}`;
}

// -----------------------------------------------------------------------------
// Opening, and AYA's pause
// -----------------------------------------------------------------------------

/**
 * Whether a re-sign open in the table is open to the practice: it is chased,
 * shown and signed. A BAA-version re-sign is only while its switch is on
 * (BAA_VERSION_RESIGNS_READY): turned off again, one already open is held as
 * it is, no reminder goes and its link says it is not open yet, so nothing
 * that switch exists to stop happens through a row opened before.
 */
export function resignOpenToPractice(reason: AgreementResignReason): boolean {
  return reason !== "baa_version" || baaVersionResignsReady();
}

/** The clinic's open re-sign, inside its tenant, or null. */
export async function openResign(tx: TenantTx): Promise<AgreementResign | null> {
  const [row] = await tx.db
    .select()
    .from(agreementResigns)
    .where(and(eq(agreementResigns.clinicId, tx.clinicId), eq(agreementResigns.status, "open")))
    .limit(1);
  return row ?? null;
}

/**
 * Open the clinic's re-sign, in the transaction that recorded the answer, or
 * return the one already open ("Not sure" after "Yes" is the same re-sign).
 * Pauses AYA in the same write, so the gate stops her answering a practice
 * no agreement covers at the moment the database stops taking its data.
 */
export async function openAgreementResign(
  tx: TenantTx,
  input: {
    fromAgreementId: string;
    reason: AgreementResignReason;
    source: AgreementResignSource;
    requestedBy: string;
    /** Whether AYA pauses while it is open (resignHoldsPause): the DPA's does, a BAA version's never. */
    pause?: boolean;
    now?: Date;
  },
): Promise<{ resignId: string; opened: boolean }> {
  const now = input.now ?? new Date();
  // One opening at a time per organisation, whose agreement it is: the
  // partial unique index would refuse a second on one clinic, and this makes
  // a second on any of its clinics wait and find the first instead.
  const [own] = await tx.db
    .select({ organizationId: clinics.organizationId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await tx.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`agreement-resign:${own?.organizationId ?? tx.clinicId}`}, 0))`,
  );
  const existing = (await organisationOpenResigns(tx))[0];
  if (existing) return { resignId: existing.resignId, opened: false };

  const held = input.pause === false ? [] : await holdOrganisationPaused(tx, now);
  const pausedAt = held.find((h) => h.clinicId === tx.clinicId)?.pausedAt ?? null;
  const [row] = await tx.db
    .insert(agreementResigns)
    .values({
      clinicId: tx.clinicId,
      fromAgreementId: input.fromAgreementId,
      reason: input.reason,
      source: input.source,
      requestedBy: input.requestedBy.slice(0, 200),
      startedAt: now,
      pausedAt: pausedAt === null ? null : new Date(pausedAt),
      heldPauses: held,
    })
    .returning({ id: agreementResigns.id });
  tx.audit.record({
    action: "create",
    resourceType: "agreement_resign",
    resourceId: row!.id,
    metadata: { reason: input.reason, source: input.source, paused: pausedAt !== null },
  });
  return { resignId: row!.id, opened: true };
}

// -----------------------------------------------------------------------------
// The organisation: every location the agreement covers
// -----------------------------------------------------------------------------

const LOCATION_ACTOR: ActorContext = { type: "service", serviceName: "agreement-resign" };

/**
 * Run `fn` for the clinic and each other clinic of its organisation, the
 * clinic first, each in its own tenant inside the caller's transaction, so a
 * pause on every location is written with the re-sign that holds it or not
 * at all. A location's writes are audited in its own tenant; the caller's
 * tenant is set back after each.
 */
async function forEachOrganisationClinic(
  tx: TenantTx,
  fn: (clinic: TenantTx) => Promise<void>,
): Promise<void> {
  const rows = await tx.db.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_organisation_clinics(${tx.clinicId}::uuid)`,
  );
  const ids = rows.rows.map((r) => r.clinic_id);
  if (!ids.includes(tx.clinicId)) ids.unshift(tx.clinicId);
  for (const clinicId of ids) {
    if (clinicId === tx.clinicId) {
      await fn(tx);
      continue;
    }
    await tx.db.execute(sql`select set_config(${TENANT_GUC}, ${clinicId}, true)`);
    const audit = new AuditRecorder(clinicId, LOCATION_ACTOR);
    await fn({ db: tx.db, audit, clinicId });
    await audit.flush(tx.db);
    await tx.db.execute(sql`select set_config(${TENANT_GUC}, ${tx.clinicId}, true)`);
  }
}

/** One pause a re-sign holds (agreement_resigns.held_pauses, drizzle/0102). */
export type HeldPause = AgreementResign["heldPauses"][number];

/**
 * Pause AYA on the clinic and every other location of its organisation
 * (holdAyaPaused on each): the answer gate reads each location's own pause.
 * Returns each pause it put in force or extended, the clinic's own among
 * them, for the re-sign row to record (held_pauses; the clinic's own is its
 * paused_at too), so that signing lifts exactly those.
 */
async function holdOrganisationPaused(tx: TenantTx, now: Date): Promise<HeldPause[]> {
  const held: HeldPause[] = [];
  await forEachOrganisationClinic(tx, async (clinic) => {
    const paused = await holdAyaPaused(clinic, now);
    if (paused) held.push({ clinicId: clinic.clinicId, ...paused });
  });
  return held;
}

/**
 * Pause AYA until switched back on, quietly, unless she is already paused
 * that way, which is the practice's own pause and stays its own. Returns the
 * pause this put in force, or extended (a pause that would end by itself is
 * made one that does not, keeping who paused it and since when), with the
 * end it had before, so the release can give it back; or null.
 */
async function holdAyaPaused(
  tx: TenantTx,
  now: Date,
): Promise<{ pausedAt: string; until: string | null } | null> {
  const before = await getClinicSettings(tx);
  const pause = { pausedAt: before.aiPausedAt, pausedUntil: before.aiPausedUntil };
  const paused = isPaused(pause, now);
  if (paused && before.aiPausedUntil === null) return null;
  const { after } = await updateClinicSettingsRecordingPause(
    tx,
    { aiPaused: true, aiPausedUntil: null },
    AGREEMENT_PAUSE_LABEL,
    now,
    { emailClinic: false },
  );
  if (!after.aiPausedAt) return null;
  return {
    pausedAt: after.aiPausedAt.toISOString(),
    // Extended: the end the practice's own pause had.
    until: paused ? (before.aiPausedUntil?.toISOString() ?? null) : null,
  };
}

/**
 * Give back each pause `resign` holds (held_pauses), on the clinic and every
 * other location of its organisation, where it is still that pause: the
 * same start, and still no end. One the re-sign put in force is lifted; a
 * timed pause of the practice's own that it made indefinite gets its end
 * back, or is lifted if that end has passed. A pause the practice set
 * otherwise stays its own. A row from before held_pauses (0102) holds only
 * its paused_at, on its own clinic. Returns whether it lifted or ended any.
 */
async function releaseAyaPause(
  tx: TenantTx,
  resign: Pick<AgreementResign, "pausedAt" | "heldPauses">,
  actorLabel: string,
  now: Date,
): Promise<boolean> {
  const held: HeldPause[] =
    resign.heldPauses.length > 0
      ? resign.heldPauses
      : resign.pausedAt
        ? [{ clinicId: tx.clinicId, pausedAt: resign.pausedAt.toISOString(), until: null }]
        : [];
  let released = false;
  await forEachOrganisationClinic(tx, async (clinic) => {
    const mine = held.find((h) => h.clinicId === clinic.clinicId);
    if (!mine) return;
    const current = await getClinicSettings(clinic);
    if (
      current.aiPausedAt?.getTime() !== new Date(mine.pausedAt).getTime() ||
      current.aiPausedUntil !== null
    ) {
      return;
    }
    const until = mine.until === null ? null : new Date(mine.until);
    await updateClinicSettingsRecordingPause(
      clinic,
      until !== null && until.getTime() > now.getTime()
        ? { aiPaused: true, aiPausedUntil: until }
        : { aiPaused: false },
      actorLabel,
      now,
      // The practice's own pause given back its end: it was told when it set it.
      { emailClinic: false },
    );
    released = true;
  });
  return released;
}

/**
 * Close the clinic's open re-sign because the DPA covers the practice again
 * (ops recorded "No"), lifting the pause it set. Returns whether one was open.
 */
export async function withdrawAgreementResign(
  tx: TenantTx,
  input: { resolvedBy: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const open = await openResign(tx);
  if (!open) return false;
  await tx.db
    .update(agreementResigns)
    .set({ status: "withdrawn", resolvedAt: now, resolvedBy: input.resolvedBy.slice(0, 254) })
    .where(and(eq(agreementResigns.id, open.id), eq(agreementResigns.status, "open")));
  await releaseAyaPause(tx, open, input.resolvedBy.slice(0, 200), now);
  tx.audit.record({
    action: "update",
    resourceType: "agreement_resign",
    resourceId: open.id,
    metadata: { status: "withdrawn" },
  });
  return true;
}

// -----------------------------------------------------------------------------
// A newer BAA over an older one
// -----------------------------------------------------------------------------

/**
 * Whether `version` is a business associate agreement older than the current
 * one: by its place in BAA_TEMPLATES, newest released first, the order
 * isBaaVersionAcceptable reads. A version the catalogue does not know is
 * older (nothing could render it again); the DPA's namespace is not a BAA.
 */
export function baaOlderThanCurrent(version: string): boolean {
  if (agreementKindOfVersion(version) !== "baa") return false;
  const at = BAA_TEMPLATES.findIndex((t) => t.version === version);
  const current = BAA_TEMPLATES.findIndex((t) => t.version === CURRENT_BAA_VERSION);
  return at === -1 || at > current;
}

/** Whether go-live accepts a BAA version, asked of the database (app_baa_version_acceptable). */
export async function baaVersionAcceptable(tx: TenantTx, version: string): Promise<boolean> {
  const result = await tx.db.execute<{ ok: boolean | null }>(
    sql`select app_baa_version_acceptable(${version}) as ok`,
  );
  return result.rows[0]?.ok === true;
}

export type BaaVersionResignOpening =
  | { status: "opened"; resignId: string; fromVersion: string }
  | { status: "already_open"; resignId: string }
  | {
      status:
        | "current"
        | "no_agreement"
        | "dpa"
        | "location"
        | "demo"
        | "unrenderable"
        | "not_ready";
    };

/**
 * Open the clinic's re-sign from the BAA in force to the current version, if
 * the BAA in force is older. It never pauses AYA (resignHoldsPause). Inside
 * the clinic's tenant; L22 goes after commit. A location re-signs through its account
 * (the agreement is the organisation's), a DPA through its covered-entity
 * answer (setCoveredEntity), and healdesk's own demo clinic never.
 */
export async function openBaaVersionResign(
  tx: TenantTx,
  input: { source: AgreementResignSource; requestedBy: string; now?: Date },
): Promise<BaaVersionResignOpening> {
  // Off until the calendar fix (lib/agreements/baa-version-ready.ts).
  if (!baaVersionResignsReady()) return { status: "not_ready" };
  const [clinic] = await tx.db
    .select({
      billingClinicId: clinics.billingClinicId,
      specialty: clinics.specialty,
      covered: clinics.isCoveredEntity,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return { status: "no_agreement" };
  if (clinic.billingClinicId !== null) return { status: "location" };
  if (await isDemoClinic(tx)) return { status: "demo" };
  const agreement = await agreementInEffect(tx);
  if (!agreement) return { status: "no_agreement" };
  if (agreement.agreementKind !== "baa") return { status: "dpa" };
  if (!baaOlderThanCurrent(agreement.documentVersion)) return { status: "current" };
  // A re-sign whose link could not render the agreement could never be
  // signed: AYA keeps answering under the version in force, and a person is
  // told instead, to fix the record and phone the practice.
  const signIn = await clinicSignIn(tx);
  if (
    !signIn ||
    !(await baaResignDocument(tx, agreement.variables, clinic, signIn.email))
  ) {
    // Once per agreement: the hourly job asks again every hour, and ops
    // needs telling once, not every hour (notifyOpsOnce keys on the fields).
    await notifyOpsOnce("agreement_resign_unrenderable", {
      clinicId: tx.clinicId,
      agreementId: agreement.agreementId,
    });
    return { status: "unrenderable" };
  }
  // Never a pause (owner, 19 October 2026; resignHoldsPause): the version
  // signed governs until the newer one is, and AYA keeps answering under it.
  const opened = await openAgreementResign(tx, {
    fromAgreementId: agreement.agreementId,
    reason: "baa_version",
    source: input.source,
    requestedBy: input.requestedBy,
    pause: resignHoldsPause({ reason: "baa_version" }),
    now: input.now,
  });
  if (!opened.opened) return { status: "already_open", resignId: opened.resignId };
  await recordSecurityEvent(tx.db, {
    event: "agreement_resign_opened",
    actorLabel: input.requestedBy,
    ipAddress: null,
    userAgent: null,
    metadata: {
      clinicId: tx.clinicId,
      resignId: opened.resignId,
      fromAgreementId: agreement.agreementId,
      fromVersion: agreement.documentVersion,
      toVersion: CURRENT_BAA_VERSION,
      source: input.source,
    },
  });
  return {
    status: "opened",
    resignId: opened.resignId,
    fromVersion: agreement.documentVersion,
  };
}

/**
 * The hourly job's first pass: an account whose BAA in force a release has
 * left below the floor (app_baa_version_acceptable) and has no re-sign open
 * gets one (`release`). Each in its own tenant transaction, so one clinic's
 * failure is logged and the rest go on. Returns how many opened.
 */
export async function openOwedBaaVersionResigns(now: Date): Promise<number> {
  // Off until the calendar fix (lib/agreements/baa-version-ready.ts).
  if (!baaVersionResignsReady()) return 0;
  let opened = 0;
  for (const clinic of await listClinics()) {
    if (
      clinic.billingClinicId !== null ||
      clinic.offboardingStartedAt !== null ||
      clinic.destroyedAt !== null ||
      clinic.baaVersion === null ||
      !baaOlderThanCurrent(clinic.baaVersion)
    ) {
      continue;
    }
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor: JOB_ACTOR }, async (tx) => {
        const agreement = await agreementInEffect(tx);
        if (!agreement || (await baaVersionAcceptable(tx, agreement.documentVersion))) return null;
        return openBaaVersionResign(tx, {
          source: "release",
          requestedBy: "agreement-resigns",
          now,
        });
      });
      if (outcome?.status === "opened") opened += 1;
    } catch (error) {
      log.error("agreement re-sign could not be opened", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return opened;
}

// -----------------------------------------------------------------------------
// L22
// -----------------------------------------------------------------------------

/** Which of L22's emails is due: 0 (the first), 3 or 7, by the days since it began. */
export function dueResignEmail(startedAt: Date, now: Date): 0 | 3 | 7 {
  const days = (now.getTime() - startedAt.getTime()) / DAY_MS;
  if (days >= 7) return 7;
  if (days >= 3) return 3;
  return 0;
}

/**
 * Send one of L22's emails for an open re-sign, once: the first (`waitingDays`
 * 0) right after the re-sign opens, the reminders from the hourly job. Each
 * mints a fresh link. Recorded on the ledger under the re-sign and the day,
 * so a retry of a failed send is the same row and a sent one is never sent
 * again. Never throws; says whether it went.
 */
export async function sendAgreementToSign(
  input: { clinicId: string; resignId: string; waitingDays: 0 | 3 | 7 },
  options: SendEmailOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  if (publicOriginProblem()) {
    log.error("agreement re-sign email not sent: no public origin", { clinicId: input.clinicId });
    return false;
  }
  let deliveryId: string | null = null;
  try {
    const claim = await claimResignEmail(input);
    if (claim.state === "closed") return false;
    if (claim.state === "sent") return true; // Sent already for this re-sign and day.
    deliveryId = claim.deliveryId;

    const payload: AgreementToSignPayload = {
      signUrl: publicUrl(resignPath({ id: input.resignId, clinicId: input.clinicId }, now)),
      validDays: Math.round(RESIGN_LINK_TTL_MS / DAY_MS),
      waitingDays: input.waitingDays,
      isUnsure: claim.reason === "not_sure",
      channels: claim.channels,
      directLineE164: claim.directLineE164,
      ...(claim.reason === "baa_version"
        ? {
            kind: "baa_version" as const,
            version: claim.fromVersion,
            isRequired: claim.required,
          }
        : {}),
    };
    assertPayloadAllowed(payload, "agreement_to_sign");
    // The name as the email may print it, or none (lib/email/lint.ts).
    const printed = printableClinicName(claim.clinic.name);
    const rendered = renderAgreementToSign(payload, {
      clinicName: printed,
      audience: audienceFor(claim.clinic.specialty),
      reason: clinicReason(printed),
      raisedAt: now,
      timeZone: claim.clinic.timezone,
    });
    const result = await sendEmail(
      {
        to: claim.to,
        kind: "agreement_to_sign",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        clinicName: printed,
        clinicId: input.clinicId,
        deliveryId,
        // A fresh key per attempt (X1.5): a retry carries a fresh link, so it
        // is a different body, which Resend refuses under a key it has seen.
        idempotencyKey: `hd-agreement_to_sign-${deliveryId}-1-${now.getTime().toString(36)}`,
      },
      options,
    );
    const id = deliveryId;
    await withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, (tx) =>
      recordDelivery(
        tx,
        id,
        result.status === "sent"
          ? { status: "sent", messageId: result.messageId }
          : { status: result.status, reason: result.reason },
      ),
    );
    return result.status === "sent";
  } catch (error) {
    log.error("agreement re-sign email not sent", {
      clinicId: input.clinicId,
      deliveryId,
      error: describeError(error),
    });
    if (deliveryId) {
      const id = deliveryId;
      await withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, (tx) =>
        recordDelivery(tx, id, { status: "failed", reason: describeError(error) }),
      ).catch(() => undefined);
    }
    return false;
  }
}

type ResignEmailClaim =
  | { state: "closed" }
  | { state: "sent" }
  | {
      state: "claimed";
      deliveryId: string;
      reason: AgreementResignReason;
      clinic: { name: string; specialty: string | null; timezone: string };
      to: string;
      channels: Channel[];
      directLineE164: string | null;
      /** The version in force a `baa_version` re-sign replaces. */
      fromVersion: string;
      /** Whether go-live waits on it: the version in force is below the floor. */
      required: boolean;
    };

/** Claim the ledger row for one of L22's emails, with what it says, if the re-sign is still open. */
async function claimResignEmail(input: {
  clinicId: string;
  resignId: string;
  waitingDays: 0 | 3 | 7;
}): Promise<ResignEmailClaim> {
  return withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, async (tx) => {
    const [resign] = await tx.db
      .select({
        id: agreementResigns.id,
        status: agreementResigns.status,
        reason: agreementResigns.reason,
      })
      .from(agreementResigns)
      .where(
        and(eq(agreementResigns.id, input.resignId), eq(agreementResigns.clinicId, tx.clinicId)),
      )
      .limit(1);
    if (!resign || resign.status !== "open" || !resignOpenToPractice(resign.reason)) {
      return { state: "closed" };
    }
    const [clinic] = await tx.db
      .select({ name: clinics.name, specialty: clinics.specialty, timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const signIn = await clinicSignIn(tx);
    if (!clinic || !signIn) return { state: "closed" };
    const settings = await getClinicSettings(tx);
    const live = await tx.db
      .select({ channel: clinicChannels.channel })
      .from(clinicChannels)
      .where(
        and(
          eq(clinicChannels.clinicId, tx.clinicId),
          eq(clinicChannels.enabled, true),
          isNotNull(clinicChannels.liveAt),
        ),
      );
    const agreement = await agreementInEffect(tx);
    const required = agreement ? !(await baaVersionAcceptable(tx, agreement.documentVersion)) : true;
    const deliveryId = await claimDelivery(tx, {
      kind: "agreement_to_sign",
      periodKey: `resign:${resign.id}:${input.waitingDays}`,
      recipient: signIn.email,
    });
    if (!deliveryId) return { state: "sent" };
    return {
      state: "claimed",
      deliveryId,
      reason: resign.reason,
      clinic,
      to: signIn.email,
      channels: PAUSE_LINE_ORDER.filter((c) => live.some((l) => l.channel === c)),
      directLineE164: settings.directLineE164,
      fromVersion: agreement?.documentVersion ?? "",
      required,
    };
  });
}

/**
 * The hourly job: for each open re-sign, the L22 email now due (the first, if
 * it never went; else the reminder of the day reached), and at 7 days one ops
 * alert, ever, for that re-sign: for a BAA version below the floor go-live
 * accepts, its own (`agreement_below_floor_unsigned`), since AYA keeps
 * answering under that version until it is signed and a person should phone
 * the practice; for every other, `agreement_unsigned_7_days`. Not a switched
 * job, like the address changes': the practice was told it has an agreement
 * to sign, and a switch that ships off would leave it waiting with no word.
 * A BAA-version re-sign while its own switch is off is passed over, and not
 * counted in `open` (resignOpenToPractice).
 */
export async function runAgreementResignsJob(
  input: { now?: Date } & SendEmailOptions = {},
): Promise<{ open: number; sent: number; alerted: number; opened: number }> {
  const now = input.now ?? new Date();
  // A release that moved the floor past an account's BAA opens its re-sign,
  // whose first L22 the walk below sends.
  const opened = await openOwedBaaVersionResigns(now);
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_open_agreement_resigns()`,
  );
  let open = 0;
  let sent = 0;
  let alerted = 0;
  for (const row of result.rows) {
    const resign = await withTenant({ clinicId: row.clinic_id, actor: JOB_ACTOR }, async (tx) => {
      const [r] = await tx.db
        .select({
          startedAt: agreementResigns.startedAt,
          fromAgreementId: agreementResigns.fromAgreementId,
          status: agreementResigns.status,
          reason: agreementResigns.reason,
        })
        .from(agreementResigns)
        .where(eq(agreementResigns.id, row.id))
        .limit(1);
      if (!r) return null;
      // Below the floor: a version go-live no longer accepts, still in force.
      const belowFloor =
        r.reason === "baa_version" ? await fromVersionBelowFloor(tx, r.fromAgreementId) : false;
      return { ...r, belowFloor };
    });
    if (!resign || resign.status !== "open") continue;
    // Switched off: held as it is, unreminded, and no one alerted to chase it.
    if (!resignOpenToPractice(resign.reason)) continue;
    open += 1;
    const due = dueResignEmail(resign.startedAt, now);
    if (
      await sendAgreementToSign(
        { clinicId: row.clinic_id, resignId: row.id, waitingDays: due },
        { ...input, now },
      )
    ) {
      sent += 1;
    }
    if (due === 7) {
      await notifyOpsOnce(
        resign.belowFloor ? "agreement_below_floor_unsigned" : "agreement_unsigned_7_days",
        { clinicId: row.clinic_id, agreementId: resign.fromAgreementId },
      );
      alerted += 1;
    }
  }
  return { open, sent, alerted, opened };
}

/** Whether the agreement a re-sign replaces is a BAA version go-live no longer accepts. */
async function fromVersionBelowFloor(tx: TenantTx, agreementId: string): Promise<boolean> {
  const result = await tx.db.execute<{ version: string | null }>(
    sql`select document_version as version from baa_acceptances where id = ${agreementId}::uuid`,
  );
  const version = result.rows[0]?.version;
  return typeof version === "string" && !(await baaVersionAcceptable(tx, version));
}

/**
 * The digest's line (lib/ops/digest.ts): accounts still answering under a BAA
 * version below the floor, their re-sign unsigned, and when the oldest
 * opened. Ids and dates only; each read in its own tenant.
 */
export async function belowFloorUnsigned(): Promise<{ count: number; oldest: Date | null }> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_open_agreement_resigns()`,
  );
  let count = 0;
  let oldest: Date | null = null;
  for (const row of result.rows) {
    const startedAt = await withTenant({ clinicId: row.clinic_id, actor: JOB_ACTOR }, async (tx) => {
      const [r] = await tx.db
        .select({
          startedAt: agreementResigns.startedAt,
          reason: agreementResigns.reason,
          fromAgreementId: agreementResigns.fromAgreementId,
        })
        .from(agreementResigns)
        .where(eq(agreementResigns.id, row.id))
        .limit(1);
      if (!r || r.reason !== "baa_version") return null;
      return (await fromVersionBelowFloor(tx, r.fromAgreementId)) ? r.startedAt : null;
    });
    if (!startedAt) continue;
    count += 1;
    if (!oldest || startedAt < oldest) oldest = startedAt;
  }
  return { count, oldest };
}

// -----------------------------------------------------------------------------
// The screen
// -----------------------------------------------------------------------------

export type { ResignDocument };

/**
 * Why a link opens nothing: not a link of an open re-sign, expired, signed,
 * withdrawn, or `not_open`, a BAA-version re-sign while its switch is off
 * (resignOpenToPractice).
 */
export type ResignClosedReason = "unknown" | "expired" | "signed" | "withdrawn" | "not_open";

export type ResignLink =
  | {
      ok: true;
      resignId: string;
      clinicId: string;
      clinicName: string;
      document: ResignDocument;
      /** Why it is being signed: the DPA answer, or a newer BAA version. */
      reason: AgreementResignReason;
      /** The agreement it replaces: its kind and version. */
      replaces: { kind: AgreementKind; version: string };
      /** Whether AYA is held paused until it is signed (openResignHoldsPause). */
      holdsPause: boolean;
    }
  | { ok: false; reason: ResignClosedReason };

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The practice's answers, from the DPA in force, or null when they cannot sign a BAA. */
function documentFromDpa(
  variables: Record<string, unknown>,
  covered: boolean | null,
  signatoryEmail: string,
): ResignDocument | null {
  const specialty = textOf(variables.specialty);
  const bookingSystem = textOf(variables.bookingSystem);
  const calendarAccount = textOf(variables.calendarAccount);
  const clinicLegalName = textOf(variables.clinicLegalName);
  if (
    !clinicLegalName ||
    !isSpecialtyId(specialty) ||
    !isBookingSystemId(bookingSystem) ||
    !isCalendarAccount(calendarAccount) ||
    covered === false
  ) {
    return null;
  }
  return {
    clinicLegalName,
    specialty,
    bookingSystem,
    calendarAccount,
    isCoveredEntity: covered === true ? true : null,
    signatoryEmail,
    signatoryName: textOf(variables.signatoryName),
    signatoryTitle: textOf(variables.signatoryTitle),
    templateVersion: CURRENT_BAA_VERSION,
  };
}

/**
 * The practice's answers for the current BAA, from the older BAA in force,
 * or null when they cannot render one. A BAA keeps the specialty by its
 * display name, so the id is the clinic's own; the covered-entity answer is
 * the clinic's record now, which ops or the practice may have recorded since
 * it signed; the booking system and Google account are what the agreement in
 * force recorded beside it (1.3.0 on), or the clinic's settings, which the
 * funnel's answers seeded, for a version that recorded neither.
 */
function documentFromBaa(
  variables: Record<string, unknown>,
  clinic: { specialty: string; covered: boolean | null },
  settings: { bookingSystem: string | null; calendarAccount: string | null } | undefined,
  signatoryEmail: string,
): ResignDocument | null {
  const clinicLegalName = textOf(variables.clinicLegalName);
  const bookingSystem = textOf(variables.bookingSystem) || (settings?.bookingSystem ?? "");
  const calendarAccount = textOf(variables.calendarAccount) || (settings?.calendarAccount ?? "");
  if (
    !clinicLegalName ||
    !isSpecialtyId(clinic.specialty) ||
    !isBookingSystemId(bookingSystem) ||
    !isCalendarAccount(calendarAccount)
  ) {
    return null;
  }
  return {
    clinicLegalName,
    specialty: clinic.specialty,
    bookingSystem,
    calendarAccount,
    isCoveredEntity: clinic.covered,
    signatoryEmail,
    signatoryName: textOf(variables.signatoryName),
    signatoryTitle: textOf(variables.signatoryTitle),
    templateVersion: CURRENT_BAA_VERSION,
  };
}

/** The current BAA's document for the clinic, from the older BAA in force: documentFromBaa, with the clinic's settings read. */
async function baaResignDocument(
  tx: TenantTx,
  variables: Record<string, unknown>,
  clinic: { specialty: string; covered: boolean | null },
  signatoryEmail: string,
): Promise<ResignDocument | null> {
  const [settings] = await tx.db
    .select({
      bookingSystem: clinicSettings.bookingSystem,
      calendarAccount: clinicSettings.calendarAccount,
    })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  return documentFromBaa(variables, clinic, settings, signatoryEmail);
}

async function readLink(tx: TenantTx, resignId: string, forUpdate: boolean) {
  const query = tx.db
    .select()
    .from(agreementResigns)
    .where(and(eq(agreementResigns.id, resignId), eq(agreementResigns.clinicId, tx.clinicId)))
    .limit(1);
  const [resign] = forUpdate ? await query.for("update") : await query;
  if (!resign) return { ok: false as const, reason: "unknown" as const };
  if (resign.status === "signed") return { ok: false as const, reason: "signed" as const };
  if (resign.status === "withdrawn") return { ok: false as const, reason: "withdrawn" as const };
  if (!resignOpenToPractice(resign.reason)) return { ok: false as const, reason: "not_open" as const };
  const [clinic] = await tx.db
    .select({
      name: clinics.name,
      covered: clinics.isCoveredEntity,
      specialty: clinics.specialty,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const agreement = await agreementInEffect(tx);
  const signIn = await clinicSignIn(tx);
  // The agreement it was opened against must still be the one in force.
  if (!clinic || !signIn || agreement?.agreementId !== resign.fromAgreementId) {
    return { ok: false as const, reason: "unknown" as const };
  }
  let document: ResignDocument | null;
  if (resign.reason === "baa_version") {
    // Signed already, by another way: nothing older is in force any more.
    if (agreement.agreementKind !== "baa" || !baaOlderThanCurrent(agreement.documentVersion)) {
      return { ok: false as const, reason: "unknown" as const };
    }
    document = await baaResignDocument(tx, agreement.variables, clinic, signIn.email);
  } else {
    document = documentFromDpa(agreement.variables, clinic.covered, signIn.email);
  }
  if (!document) return { ok: false as const, reason: "unknown" as const };
  return {
    ok: true as const,
    resign,
    clinicName: clinic.name,
    document,
    replaces: { kind: agreement.agreementKind, version: agreement.documentVersion },
    holdsPause: await openResignHoldsPause(tx),
  };
}

/** What a link opens. Looking spends nothing: a mail scanner signs no one up. */
export async function lookUpResignLink(
  token: unknown,
  now: Date = new Date(),
): Promise<ResignLink> {
  const read = readResignToken(token, now);
  if (!read.ok) return read;
  const link = await withTenant({ clinicId: read.clinicId, actor: JOB_ACTOR }, (tx) =>
    readLink(tx, read.resignId, false),
  );
  if (!link.ok) return link;
  return {
    ok: true,
    resignId: link.resign.id,
    clinicId: read.clinicId,
    clinicName: link.clinicName,
    document: link.document,
    reason: link.resign.reason,
    replaces: link.replaces,
    holdsPause: link.holdsPause,
  };
}

/** The signature request the screen's answers make, with everything else the practice's own. */
export function resignRequest(
  document: ResignDocument,
  signature: {
    signatoryName: string;
    signatoryTitle?: string;
    displayedHash?: string;
    templateVersion: string;
  },
): SignAgreementRequest {
  return {
    clinicLegalName: document.clinicLegalName,
    specialty: document.specialty,
    signatoryName: signature.signatoryName,
    signatoryTitle: signature.signatoryTitle,
    signatoryEmail: document.signatoryEmail,
    isCoveredEntity: document.isCoveredEntity,
    attributionMode: "estimated",
    platform: agreementPlatformFor(document.bookingSystem),
    bookingSystem: document.bookingSystem,
    calendarAccount: document.calendarAccount,
    assentLabel: AGREEMENT_COPY.baa.assentLabel,
    templateVersion: signature.templateVersion,
    ...(signature.displayedHash ? { displayedHash: signature.displayedHash } : {}),
  };
}

export type SignResignOutcome =
  | {
      status: "signed";
      agreementId: string;
      version: string;
      text: string;
      acceptedAt: Date;
      copy: SignedCopyDelivery;
    }
  | { status: "refused"; message: string; field?: string }
  | { status: "closed"; reason: ResignClosedReason };

/**
 * Sign the BAA from the re-sign screen, once.
 *
 * The document is rendered again here from the practice's answers and the
 * typed signature, by the catalog's one builder (prepareSigning), and a
 * screen that showed anything else is refused, as the funnel's signing is.
 * Then, in one transaction: the re-sign is locked and must still be open; the
 * acceptance is written in service context (where an unbound one may be);
 * supersedeAgreement binds it and puts it in force, terminating the DPA at
 * the end of today (app_supersede_agreement(), which refuses a DPA ever
 * replacing a BAA); the BAA's calendar clause and answers are recorded as
 * the location's calendar terms under it (recordSupersedingTerms), so its
 * Google Calendar connection outlives the change; and, back in the clinic's
 * tenant, the re-sign closes and the pause it set is lifted. Two submissions
 * of one link are one signature: the second waits on the lock and finds it
 * signed.
 */
export async function signAgreementResign(
  token: unknown,
  input: {
    signatoryName: unknown;
    signatoryTitle?: unknown;
    displayedHash?: unknown;
    templateVersion: unknown;
  },
  context: RequestContext = {},
  now: Date = new Date(),
): Promise<SignResignOutcome> {
  const read = readResignToken(token, now);
  if (!read.ok) return { status: "closed", reason: read.reason };
  const before = await lookUpResignLink(token, now);
  if (!before.ok) return { status: "closed", reason: before.reason };

  // The version is the screen's own document's, which the server chose: a
  // browser that names another (an older one still inside a release
  // overlap) is refused, never signed.
  if (input.templateVersion !== before.document.templateVersion) {
    return {
      status: "refused",
      message:
        "The agreement has been updated. Please reload the page and read it again — nothing has been recorded.",
      field: "templateVersion",
    };
  }
  const request = resignRequest(before.document, {
    signatoryName: typeof input.signatoryName === "string" ? input.signatoryName : "",
    signatoryTitle:
      typeof input.signatoryTitle === "string" && input.signatoryTitle.trim()
        ? input.signatoryTitle
        : undefined,
    displayedHash: typeof input.displayedHash === "string" ? input.displayedHash : undefined,
    templateVersion: before.document.templateVersion,
  });
  // A re-sign of the BAA in force stays a BAA whatever the covered-entity
  // answer: a practice that answered "No" and holds a BAA keeps it once the
  // DPA is released, since a BAA is never replaced by a DPA.
  const options = before.reason === "baa_version" ? { reacceptsBaa: true } : {};
  let prepared: ReturnType<typeof prepareSigning>;
  try {
    validateSignRequest(request, options);
    // Never BAA→DPA: the agreement a covered or unsure practice signs is the BAA.
    if (agreementKindForRequest(request, options) !== "baa") {
      return {
        status: "refused",
        message: "This practice signs the business associate agreement.",
      };
    }
    prepared = prepareSigning(request, effectiveDateOf(now), options);
  } catch (error) {
    if (error instanceof AgreementError) {
      return { status: "refused", message: error.message, field: error.field };
    }
    throw error;
  }
  if (prepared.kind !== "baa") {
    return { status: "refused", message: "This practice signs the business associate agreement." };
  }
  if (request.displayedHash && request.displayedHash.toLowerCase() !== prepared.hash) {
    return {
      status: "refused",
      message:
        "The agreement on your screen doesn't match our copy. Please reload the page and read it again — nothing has been recorded.",
      field: "displayedHash",
    };
  }

  const actor: ActorContext = { type: "service", serviceName: "agreement-resign" };
  const signed = await unsafeDb
    .transaction(async (db) => {
      const audit = new AuditRecorder(read.clinicId, actor, context);
      const tenant: TenantTx = { db, audit, clinicId: read.clinicId };
      const setTenant = (clinicId: string) =>
        db.execute(sql`select set_config(${TENANT_GUC}, ${clinicId}, true)`);

      await setTenant(read.clinicId);
      const link = await readLink(tenant, read.resignId, true);
      if (!link.ok) return { status: "closed" as const, reason: link.reason };
      // The answers may have moved since the page was drawn: sign only what it showed.
      if (JSON.stringify(link.document) !== JSON.stringify(before.document)) {
        return {
          status: "refused" as const,
          message:
            "Your agreement changed while it was open. Please reload the page and read it again.",
        };
      }

      // Service context: an unbound acceptance is written, read and bound only here.
      await setTenant("");
      const acceptance = await recordAcceptance(db, prepared, context);
      const superseded = await supersedeAgreement(
        read.clinicId,
        acceptance.id,
        prepared.signatoryEmail,
        db,
      );
      // The BAA is the location's calendar terms from now on: recorded under
      // it here, or the location reads `needs_election` and the calendar
      // watch takes its Google connection away within five minutes.
      const calendarTerms = await recordSupersedingTerms(db, {
        clinicId: read.clinicId,
        agreementId: acceptance.id,
        actor,
        request: context,
      });

      await setTenant(read.clinicId);
      await db
        .update(agreementResigns)
        .set({
          status: "signed",
          signedAt: acceptance.acceptedAt,
          supersedingAgreementId: acceptance.id,
          resolvedAt: now,
          resolvedBy: prepared.signatoryEmail.slice(0, 254),
        })
        .where(and(eq(agreementResigns.id, link.resign.id), eq(agreementResigns.status, "open")));
      const lifted = await releaseAyaPause(tenant, link.resign, "agreement signed", now);
      audit.record({
        action: "update",
        resourceType: "agreement_resign",
        resourceId: link.resign.id,
        metadata: {
          status: "signed",
          agreementId: acceptance.id,
          supersededAgreementId: superseded.supersededAgreementId,
          calendarElectionId: calendarTerms?.electionId ?? null,
          pauseLifted: lifted,
        },
      });
      await recordSecurityEvent(db, {
        event: "agreement_resign_signed",
        actorLabel: prepared.signatoryEmail,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        metadata: {
          clinicId: read.clinicId,
          resignId: link.resign.id,
          fromAgreementId: superseded.supersededAgreementId,
          toAgreementId: acceptance.id,
          version: prepared.version,
        },
      });
      await audit.flush(db);
      return {
        status: "signed" as const,
        agreementId: acceptance.id,
        acceptedAt: acceptance.acceptedAt,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof SupersedeError) {
        return { status: "refused" as const, message: error.message };
      }
      throw error;
    });
  if (signed.status !== "signed") return signed;

  // After commit, as signAgreement sends it: never fatal, and bounded.
  const copy = await deliverSignatureCopy(signed.agreementId, context);
  return {
    status: "signed",
    agreementId: signed.agreementId,
    version: prepared.version,
    text: prepared.text,
    acceptedAt: signed.acceptedAt,
    copy,
  };
}

// -----------------------------------------------------------------------------
// Billing
// -----------------------------------------------------------------------------

/** Billing's view of the clinic's re-sign: whether one is open, since when, why, and whether AYA waits on it. */
export async function readOpenResign(
  clinicId: string,
  actor: ActorContext,
): Promise<{
  id: string;
  startedAt: Date;
  reason: AgreementResignReason;
  holdsPause: boolean;
} | null> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const open = await openResign(tx);
    return open && resignOpenToPractice(open.reason)
      ? {
          id: open.id,
          startedAt: open.startedAt,
          reason: open.reason,
          holdsPause: await openResignHoldsPause(tx),
        }
      : null;
  });
}

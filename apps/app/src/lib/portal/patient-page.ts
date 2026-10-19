import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import { auditLog } from "@/db/schema";
import { assertNoPhi, type RequestContext } from "@/lib/audit";
import { clientIp } from "@/lib/client-ip";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { requirePortal, type PortalContext } from "./access";
import { requireStepUp, type StepUp } from "./step-up";

/**
 * The door to every portal page that shows a patient (plan Part D2-D4; spec,
 * "Account access and credentials": a passkey before any conversation or
 * booking opens, and an access log naming the device). Server only: it reads
 * the request's headers and the database.
 *
 * A patient page does three things, all here:
 *
 * 1. `requirePatientPage(slug)` at the top of the page, route or action: the
 *    clinic's sign-in (requirePortal: another clinic's sign-in gets "not
 *    found"), then a live passkey step-up on this session for
 *    "patient_pages" (15 minutes idle, extended by activity, 8 hours at
 *    most). Without one the browser goes to the step-up page and comes back.
 *    The authenticator backup never satisfies it.
 * 2. `withPatientPage(page, read)` around the read, with `logPatientAccess`
 *    inside it: one audit_log row per open, in the transaction that reads,
 *    naming the passkey and the device. A read that logs nothing throws
 *    before it returns, and the transaction rolls back, so no record leaves
 *    here without its row.
 * 3. `<PatientPageGuard {...patientGuardProps(page)}>` around what it shows
 *    (app/c/[slug]/PatientPageGuard.tsx), which shows nothing until the
 *    server says this step-up is still live, and closes the page when it
 *    lapses.
 *
 * Only a page this module issued opens anything: requirePatientPage freezes
 * what it returns and remembers it, and withPatientPage and logPatientAccess
 * refuse any other object, however it is shaped. The row holds ids and
 * nothing else: the actor's label is the device's name as staff gave it, the
 * metadata the passkey's and the step-up's ids, the request id the page's
 * own, and the resource a fixed type and UUIDs, every one that was shown. A
 * patient's name, number or words cannot be passed in.
 *
 * An access row is a person opening a record, so nothing that runs without
 * one may call withPatientPage: a Link to a patient page never prefetches it
 * (`prefetch={false}`; "auto" renders no page and is safe, `true` renders it
 * and would write a row nobody saw), and no timer, poll or auto-refresh
 * re-reads one. A patient page is `export const dynamic = "force-dynamic"`,
 * which Next answers with Cache-Control no-store, and tests/portal-shell
 * holds every file under conversations/ and bookings/ to these rules.
 */

export type PatientPage = {
  readonly portal: Readonly<PortalContext>;
  /** The live passkey step-up that opened the page: which passkey, which device, until when. */
  readonly stepUp: Readonly<StepUp>;
  /** The request: its own id (which the guard uses), and its address and browser. Never identity. */
  readonly request: Readonly<RequestContext & { requestId: string }>;
};

/** The pages requirePatientPage issued in this process. Any other object opens nothing. */
const issued = new WeakSet<PatientPage>();

/**
 * The clinic's context and the passkey step-up behind it, or a redirect: to
 * sign in with no session, to the step-up page (and back to `returnTo`, or
 * the path the proxy saw) with no live passkey step-up, and "not found" for
 * a slug this sign-in does not open. redirect() and notFound() throw, so a
 * caller never runs on without both.
 *
 * Every call counts as activity on the step-up. The page is frozen: change
 * its clinic or its passkey and it is no longer the page that was issued.
 */
export async function requirePatientPage(
  slug: string,
  opts: { returnTo?: string } = {},
): Promise<PatientPage> {
  const portal = await requirePortal(slug);
  const stepUp = await requireStepUp(portal, "patient_pages", { returnTo: opts.returnTo });
  const incoming = await headers();
  const page: PatientPage = Object.freeze({
    portal: Object.freeze({ ...portal }),
    stepUp: Object.freeze({ ...stepUp }),
    request: Object.freeze({
      requestId: randomUUID(),
      ipAddress: clientIp(incoming),
      userAgent: incoming.get("user-agent")?.slice(0, 512) || undefined,
    }),
  });
  issued.add(page);
  return page;
}

/**
 * What PatientPageGuard needs, and nothing it could count down from on its
 * own: the clinic, the step-up the page was rendered under, and this render's
 * id. The guard asks the server for the deadline every time it shows the
 * page, so a payload replayed from the router's cache has no clock to restart.
 */
export function patientGuardProps(page: PatientPage): {
  slug: string;
  stepUpId: string;
  renderId: string;
} {
  assertIssued(page);
  return {
    slug: page.portal.clinicSlug,
    stepUpId: page.stepUp.stepUpId,
    renderId: page.request.requestId,
  };
}

/**
 * What an access-log row may name. Add a type here when a patient page shows
 * a new kind of record; never a free-form string.
 */
export const PATIENT_RECORD_TYPES = [
  /** A call, web chat or DM: its outcome and booking link (Conversations). */
  "conversation",
  /** A transcript's delivery receipt, and "Send again" (Conversations). */
  "transcript_email",
  /** A booking request: Needs you, Missed (Bookings). */
  "booking_request",
  /** A booking AYA made: Booked by AYA (Bookings). */
  "appointment",
  /** Someone asked AYA for a person: Needs you, and Mark handled (Bookings). */
  "handover",
  /** The clinic's whole export. */
  "clinic_bundle",
  /** One person's export, from a conversation (Conversations), named by their contact ids. */
  "patient_bundle",
  /** Who an incident affected, as the incident's page shows them (L29), named by their contact ids. */
  "incident_affected",
] as const;
export type PatientRecordType = (typeof PATIENT_RECORD_TYPES)[number];

/**
 * The most ids one row names. A list longer than this is a page that should
 * paginate: the row keeps every id it shows, never a sample.
 */
export const MAX_PATIENT_IDS_PER_ROW = 1000;

/**
 * One open of patient data: one record (`resourceId`), or one list as shown
 * (`resourceIds`, every id on screen, in one row). `export` is a download.
 */
export type PatientAccess = {
  action: "read" | "export";
  resourceType: PatientRecordType;
} & ({ resourceId: string; resourceIds?: never } | { resourceIds: string[]; resourceId?: never });

/** A tenant transaction opened by withPatientPage: RLS-scoped to its clinic, carrying its page. */
export type PatientTx = TenantTx & { readonly page: PatientPage };

export class PatientAccessNotLoggedError extends Error {
  constructor() {
    super(
      "A patient page read without logPatientAccess. Every open of patient data writes an " +
        "access-log row naming the passkey, in the same transaction (lib/portal/patient-page.ts).",
    );
    this.name = "PatientAccessNotLoggedError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The transactions withPatientPage opened, and those that have written their access row. */
const patientTxs = new WeakSet<PatientTx>();
const logged = new WeakSet<PatientTx>();

function assertIssued(page: PatientPage): void {
  if (!issued.has(page)) {
    throw new Error(
      "Not a page requirePatientPage issued: a patient read needs a passkey step-up.",
    );
  }
}

/**
 * Run `read` in one transaction scoped to the page's clinic, with the device
 * as the actor. `read` must call logPatientAccess at least once, before or
 * after it reads (a list's ids are known only afterwards); if it does not,
 * this throws and the transaction rolls back, so the result never reaches
 * the page. If `read` throws, its access row rolls back with it: nothing was
 * shown. Refuses a page requirePatientPage did not issue.
 */
export async function withPatientPage<T>(
  page: PatientPage,
  read: (tx: PatientTx) => Promise<T>,
): Promise<T> {
  assertIssued(page);
  return withTenant(
    {
      clinicId: page.portal.clinicId,
      actor: { type: "user", userId: page.portal.userId, label: page.stepUp.deviceLabel },
      request: page.request,
    },
    async (tenant) => {
      const tx: PatientTx = Object.freeze({ ...tenant, page });
      patientTxs.add(tx);
      const result = await read(tx);
      if (!logged.has(tx)) throw new PatientAccessNotLoggedError();
      return result;
    },
  );
}

/**
 * Write the access-log row for one open, now, inside `tx`: action, record
 * type and every id shown, the device's name as the actor, the passkey's and
 * the step-up's ids in metadata, and the page's request id. Throws, writing
 * nothing, on a transaction withPatientPage did not open, a record type not
 * in PATIENT_RECORD_TYPES, an id that is not a UUID, or a list longer than
 * MAX_PATIENT_IDS_PER_ROW, so nothing of the patient's can be logged in place
 * of an id and no open hides behind a truncated list.
 */
export async function logPatientAccess(tx: PatientTx, access: PatientAccess): Promise<void> {
  if (!patientTxs.has(tx)) {
    throw new Error("An access row is written only in a transaction withPatientPage opened.");
  }
  const { page } = tx;
  assertIssued(page);
  if (tx.clinicId !== page.portal.clinicId) {
    throw new Error("An access row must be written in its own clinic's transaction.");
  }
  if (access.action !== "read" && access.action !== "export") {
    throw new Error("A patient page's access is a read or an export.");
  }
  if (!(PATIENT_RECORD_TYPES as readonly string[]).includes(access.resourceType)) {
    throw new Error("Not a patient record type the access log knows.");
  }
  const ids = access.resourceIds;
  const one = access.resourceId;
  if (ids === undefined ? typeof one !== "string" : one !== undefined || !Array.isArray(ids)) {
    throw new Error("An access names one record or one list of records.");
  }
  if (![...(ids ?? []), ...(one === undefined ? [] : [one])].every((id) => UUID.test(id))) {
    throw new Error("An access row names records by id only.");
  }
  if (ids && ids.length > MAX_PATIENT_IDS_PER_ROW) {
    throw new Error(
      `A list of more than ${MAX_PATIENT_IDS_PER_ROW} records is too long for one page: paginate.`,
    );
  }

  const metadata = { passkeyId: page.stepUp.passkeyId, stepUpId: page.stepUp.stepUpId };
  assertNoPhi(metadata);
  // Written directly, not through AuditRecorder, which keeps only the first
  // 50 ids of a list: here every id shown is in the row.
  await tx.db.insert(auditLog).values({
    clinicId: tx.clinicId,
    actorType: "user",
    actorUserId: page.portal.userId,
    actorLabel: page.stepUp.deviceLabel,
    action: access.action,
    resourceType: access.resourceType,
    resourceId: one ?? null,
    resourceIds: ids ? [...ids] : null,
    resultCount: ids ? ids.length : null,
    requestId: page.request.requestId,
    ipAddress: page.request.ipAddress ?? null,
    userAgent: page.request.userAgent ?? null,
    metadata,
  });
  logged.add(tx);
}

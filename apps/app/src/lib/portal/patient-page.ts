import { headers } from "next/headers";

import { AuditRecorder, type ActorContext, type RequestContext } from "@/lib/audit";
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
 * A patient page does two things, both here:
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
 *
 * The row holds ids and nothing else: the actor's label is the device's name
 * as staff gave it, the metadata the passkey's and the step-up's ids, and the
 * resource a fixed type and a UUID. A patient's name, number or words cannot
 * be passed in.
 */

export type PatientPage = {
  portal: PortalContext;
  /** The live passkey step-up that opened the page: which passkey, which device, how long left. */
  stepUp: StepUp;
  /** The address and browser behind the request, for the access log. Never identity. */
  request: RequestContext;
};

/**
 * The clinic's context and the passkey step-up behind it, or a redirect: to
 * sign in with no session, to the step-up page (and back to `returnTo`, or
 * the path the proxy saw) with no live passkey step-up, and "not found" for
 * a slug this sign-in does not open. redirect() and notFound() throw, so a
 * caller never runs on without both.
 *
 * Every call counts as activity on the step-up. `stepUp.expiresInMs` is what
 * PatientPageGuard counts down from.
 */
export async function requirePatientPage(
  slug: string,
  opts: { returnTo?: string } = {},
): Promise<PatientPage> {
  const portal = await requirePortal(slug);
  const stepUp = await requireStepUp(portal, "patient_pages", { returnTo: opts.returnTo });
  const incoming = await headers();
  return {
    portal,
    stepUp,
    request: {
      ipAddress: clientIp(incoming),
      userAgent: incoming.get("user-agent")?.slice(0, 512) || undefined,
    },
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
  /** The clinic's whole export. */
  "clinic_bundle",
] as const;
export type PatientRecordType = (typeof PATIENT_RECORD_TYPES)[number];

/**
 * One open of patient data: one record (`resourceId`), or one list as shown
 * (`resourceIds`, one row for the whole list; audit.ts caps how many ids it
 * keeps and records the count). `export` is a download.
 */
export type PatientAccess = {
  action: "read" | "export";
  resourceType: PatientRecordType;
} & ({ resourceId: string; resourceIds?: never } | { resourceIds: string[]; resourceId?: never });

/** A tenant transaction opened for a patient page: RLS-scoped to its clinic, carrying its step-up. */
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

/** The transactions that have written their access row. */
const logged = new WeakSet<PatientTx>();

/** Who the access log says opened it: the sign-in, by the device whose passkey is live. */
function actorFor(page: PatientPage): ActorContext {
  return { type: "user", userId: page.portal.userId, label: page.stepUp.deviceLabel };
}

/**
 * Run `read` in one transaction scoped to the page's clinic, with the device
 * as the actor. `read` must call logPatientAccess at least once, before or
 * after it reads (a list's ids are known only afterwards); if it does not,
 * this throws and the transaction rolls back, so the result never reaches
 * the page. If `read` throws, its access row rolls back with it: nothing was
 * shown.
 */
export async function withPatientPage<T>(
  page: PatientPage,
  read: (tx: PatientTx) => Promise<T>,
): Promise<T> {
  return withTenant(
    { clinicId: page.portal.clinicId, actor: actorFor(page), request: page.request },
    async (tenant) => {
      const tx: PatientTx = { ...tenant, page };
      const result = await read(tx);
      if (!logged.has(tx)) throw new PatientAccessNotLoggedError();
      return result;
    },
  );
}

/**
 * Write the access-log row for one open, now, inside `tx`: action, record
 * type and id(s), the device's name as the actor, and the passkey's and the
 * step-up's ids in metadata. Throws, writing nothing, on a record type not
 * in PATIENT_RECORD_TYPES or an id that is not a UUID, so nothing of the
 * patient's can be logged in place of an id.
 */
export async function logPatientAccess(tx: PatientTx, access: PatientAccess): Promise<void> {
  const { page } = tx;
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

  const recorder = new AuditRecorder(tx.clinicId, actorFor(page), page.request);
  recorder.record({
    action: access.action,
    resourceType: access.resourceType,
    ...(ids ? { resourceIds: ids, resultCount: ids.length } : { resourceId: one }),
    metadata: { passkeyId: page.stepUp.passkeyId, stepUpId: page.stepUp.stepUpId },
  });
  await recorder.flush(tx.db);
  logged.add(tx);
}

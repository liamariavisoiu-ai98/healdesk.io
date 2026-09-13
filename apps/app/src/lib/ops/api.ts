import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  baaAcceptances,
  connectionLinks,
  providerConnections,
  scheduledJobs,
} from "@/db/schema";
import {
  deliverSignedCopy,
  getAgreement,
  listCopyDeliveries,
  type CopyTrigger,
} from "@/lib/agreements";
import {
  AgreementSearchError,
  searchAgreements,
  type AgreementFilter,
  type AgreementStatus,
} from "@/lib/agreements/search";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { issueConnectionLink } from "@/lib/connections/links";
import { sendConnectLink } from "@/lib/email/connect-link";
import { env } from "@/lib/env";
import {
  burnRecoveryCode,
  enrolAdminTotp,
  getAdminTotpState,
  proposeAdminTotp,
  verifyAdminTotpCode,
} from "@/lib/ops/admin-totp";
import {
  blockersFor,
  listClinics as listClinicOverviews,
  type ClinicBlocker,
} from "@/lib/ops/clinics";
import {
  getTransport,
  type DeliveryTarget,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";
import { getJob, listJobs as listJobRecords } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";
import { log } from "@/lib/log";

/**
 * The inward operations API: everything the admin console needs, behind one
 * signed door, so that the console itself never needs a database.
 *
 * ## Why this file exists at all
 *
 * healdesk.io/admin lives in apps/web, and apps/web has no database driver.
 * That is not an oversight to be fixed by adding one — it is the property that
 * lets the marketing site deploy anywhere and the reason the audit of this
 * codebase can state flatly that the public site cannot reach patient data.
 * Putting the console on that surface therefore cannot mean putting the queries
 * there with it. It means the console asks, and this answers.
 *
 * The transport is the HMAC already used by `/api/provision` and
 * `/api/agreements/[id]/pdf`: a signature over the body and a timestamp, keyed
 * on HEALDESK_PROVISION_SECRET, verified before anything is parsed. One scheme,
 * three callers, one place to get it right. See packages/catalog/request-signing.
 *
 * ## Who the operator is now, and where the user id went
 *
 * There is exactly ONE administrator. HEALDESK_ADMIN_EMAIL is the username, a
 * scrypt hash is the password, a TOTP code is the second factor, and there is
 * no user store behind any of it: no invitations, no team, no roles, and
 * therefore no `member` row to re-check on each call.
 *
 * The previous version of this file took the operator's identity from the
 * signed envelope and re-checked it against Better Auth's `member` table on
 * every request, so that `lib/audit.ts` could keep naming a real person on a
 * surface that issues credentials, resends executed contracts and starts a
 * six-year retention clock. **A reader will look for that and should know why
 * it is gone.** It is gone because the question it answered — "which of our
 * several operators is this?" — no longer has more than one possible answer.
 * There is one operator; the operator is HEALDESK_ADMIN_EMAIL; and the identity
 * therefore comes from the environment rather than from the request.
 *
 * Concretely, in every audit row this file writes:
 *
 *   - `actorUserId` is **null**. Not a placeholder, not a fabricated id: there
 *     is no user, and `security_events.user_id` is a foreign key to `user`, so
 *     a made-up value would fail the INSERT and lose the row entirely.
 *   - `actorLabel` is the administrator's email, read from the environment and
 *     never from the request body. The envelope cannot name somebody it is not,
 *     because the envelope does not name anybody at all.
 *
 * That is a weaker attribution than a per-person user id, and it is honest
 * about being weaker: what it asserts is "the holder of the single admin
 * credential did this", which is exactly what is true. 45 CFR 164.312(b) wants
 * the act recorded and attributable to the account that performed it, and with
 * one account that is what this is. The moment a second operator exists, this
 * is the file that has to change first.
 *
 * ## What the envelope carries, and what it does not
 *
 * `{ op, args, context? }`. `context` is optional and holds the OPERATOR'S
 * BROWSER as apps/web observed it — without it the only address available here
 * is apps/web's own egress IP, and recording a server's address in the column
 * that answers "where was this operator" is not a smaller lie for being an easy
 * one. It is inside the signature like everything else, so it cannot be edited
 * in flight; it remains a claim by apps/web, which is the only party that saw
 * the browser.
 *
 * There is no `operator` field any more. A request that still sends one is not
 * refused — extra properties are ignored, the same way /api/provision ignores
 * them — but nothing in it is read, which is the point: no request can choose
 * who an action is attributed to.
 *
 * ## What is deliberately not here
 *
 * `listTeam`, `inviteTeammate`, `revokeInvitation`. Team management is being
 * removed along with the invitation system: there is nobody to invite into a
 * product with one login. Better Auth's tables stay — `clinics.organizationId`
 * is NOT NULL and references `organization`, so organisations remain a data
 * concept — but nothing here creates an invitation any more.
 *
 * And no generic "run this query", no dispatch through an object lookup.
 * Operations are a closed list checked with `includes`, dispatched through an
 * exhaustive `switch` on a string-literal union, so a crafted `op` has nowhere
 * to walk: not `constructor`, not `__proto__`, not a helper that happened to be
 * exported. An unrecognised `op` is a 400 that names nothing.
 */

// -----------------------------------------------------------------------------
// The wire contract
// -----------------------------------------------------------------------------

/**
 * A body larger than this is not one of ours.
 *
 * The signature covers the body, so the body has to be read before the caller
 * is authenticated — the one window in which an unauthenticated stranger
 * chooses how much memory this process allocates. The largest real envelope is
 * an operator's search string, or an enrolment proposal, inside a small JSON
 * object; 16 KB is generous by orders of magnitude and still closes the window.
 * Twice the PDF route's cap for exactly that reason: that route carries one
 * UUID.
 *
 * Enforced WHILE reading — see `readBoundedBody`.
 */
export const MAX_BODY_BYTES = 16_384;

/**
 * Every operation this API will perform, and there is no fourteenth.
 *
 * A closed list rather than a map of handlers: a map is an object, an object
 * has a prototype, and "look the op up on an object" is how a request for
 * `constructor` becomes a call to something nobody wrote a handler for. The
 * membership test below narrows an untrusted string to this union, and the
 * dispatch is a `switch` the compiler checks for exhaustiveness.
 */
const OPERATIONS = [
  "listClinics",
  "listJobs",
  "toggleJob",
  "issueConnectLink",
  "resendAgreementCopy",
  "markAgreementTerminated",
  "searchAgreements",
  "getAgreement",
  "getAdminTotpState",
  "enrolAdminTotp",
  "verifyAdminTotpStep",
  "burnRecoveryCode",
  "sendSignInAlert",
] as const;

export type OpName = (typeof OPERATIONS)[number];

/** The mutating half of the list. These, and only these, write an audit row. */
const MUTATING_OPERATIONS: ReadonlySet<OpName> = new Set<OpName>([
  "toggleJob",
  "issueConnectLink",
  "resendAgreementCopy",
  "markAgreementTerminated",
  "enrolAdminTotp",
  // Mutating because it spends a step. A verification that changed nothing
  // would be a verification a code could pass twice.
  "verifyAdminTotpStep",
  "burnRecoveryCode",
  // It sends mail and writes the sign-in event. Nothing in the database changes
  // that a retry could undo, which is exactly why the failure copy for a
  // mutating op ("reload before trying again") is the right thing to show.
  "sendSignInAlert",
]);

export function isOpName(value: unknown): value is OpName {
  return (
    typeof value === "string" &&
    (OPERATIONS as readonly string[]).includes(value)
  );
}

export function isMutating(op: OpName): boolean {
  return MUTATING_OPERATIONS.has(op);
}

/**
 * The browser apps/web saw, as it reported it. Optional, and absent means the
 * audit row records nothing rather than something untrue.
 */
export type OpsContext = {
  ipAddress?: string;
  userAgent?: string;
};

/**
 * The administrator, as the environment defines them.
 *
 * No id, because there is no user row. The email IS the identity and it is
 * frozen into `actorLabel` on every row this file writes.
 */
export type Operator = {
  email: string;
  request: RequestContext;
};

export type OpsEnvelope = {
  op: OpName;
  args: Record<string, unknown>;
  context: OpsContext;
};

/**
 * The machine-readable half of every failure.
 *
 * The console has to tell the administrator whether to sign in again, fix their
 * input, or call someone. Branching on the status code alone stops working at
 * the second 400; branching on the message breaks at the first reword. So the
 * code is the contract and the message is prose.
 */
export type OpsProblemCode =
  | "unavailable"
  | "too_large"
  | "unauthorized"
  | "invalid_body"
  | "unknown_operation"
  | "invalid_args"
  | "failed";

export type OpsOutcome =
  | { status: 200; body: { data: unknown } }
  | { status: number; body: { error: string; code: OpsProblemCode } };

export function opsProblem(
  message: string,
  status: number,
  code: OpsProblemCode,
): OpsOutcome {
  return { status, body: { error: message, code } };
}

function ok<T>(data: T): OpsOutcome {
  return { status: 200, body: { data } };
}

// -----------------------------------------------------------------------------
// Reading the request
// -----------------------------------------------------------------------------

/**
 * The request body, or null when it is bigger than one of ours could be.
 *
 * Lifted from `api/agreements/[id]/pdf/route.ts`, whose header explains the
 * reasoning at length and whose copy cannot be imported: Next validates the
 * export surface of a `route.ts` and rejects anything that is not a handler or
 * a segment option, so a shared helper cannot live in one. It lives here, where
 * both could eventually share it; the duplication is noted rather than hidden.
 *
 * The short version. `await request.text()` resolves only once the whole body
 * is in memory, so a length check on its result runs after the allocation it
 * was meant to prevent. `Content-Length` is absent on a chunked request and is
 * a claim in any case. So the stream is read with a running total and cancelled
 * the moment it exceeds the cap. BYTES, not characters — `String.length` counts
 * UTF-16 code units, so 16384 astral characters are 64 KB of them. Decoded in
 * stream mode so a multi-byte character split across two chunks still decodes
 * to the one character it is: the string handed back has to be byte-for-byte
 * what the caller signed, or every valid request fails its own signature.
 */
export async function readBoundedBody(
  request: Request,
  cap: number,
): Promise<string | null> {
  const stream = request.body;
  // No body at all is a legitimate shape to reject later, not to throw on now.
  if (stream === null) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total > cap) {
        // Stop pulling. Whatever is still upstream is the sender's problem.
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
}

/** One idea of "an address" per app. Same shape the console has always used. */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const UUID_SHAPED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A date input's value: YYYY-MM-DD, and nothing else. */
const DATE_SHAPED = /^\d{4}-\d{2}-\d{2}$/;

const MAX_ID_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;

/** Free text an operator can type. Long enough for any real search. */
const MAX_QUERY_LENGTH = 200;

/**
 * An enrolment proposal is base64url(JSON) + "." + a base64url HMAC. A 20-byte
 * secret and a timestamp make roughly 120 characters; the cap is well clear of
 * that and still bounds what reaches a MAC and a JSON parser.
 */
const MAX_PROPOSAL_LENGTH = 512;

/**
 * Turn the verified body into an envelope, or say why it is not one.
 *
 * Runs only after the signature has verified, so a malformed shape here is our
 * own caller being wrong rather than an attacker probing — which is why these
 * messages are specific where the 401 above them is deliberately vague.
 */
export function parseEnvelope(
  raw: string,
): { ok: true; envelope: OpsEnvelope } | { ok: false; outcome: OpsOutcome } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      outcome: opsProblem("Invalid request body.", 400, "invalid_body"),
    };
  }

  const body = asRecord(parsed);

  // Narrowed FIRST: an unknown op must cost no database work, no decryption and
  // no mail. Nothing is echoed back — not the op, not a "did you mean".
  const op = body.op;
  if (!isOpName(op)) {
    return {
      ok: false,
      outcome: opsProblem("Unknown operation.", 400, "unknown_operation"),
    };
  }

  const context = asRecord(body.context);

  return {
    ok: true,
    envelope: {
      op,
      // Unknown properties inside `args` are ignored rather than rejected, the
      // same way /api/provision ignores extras: the caller is our own console
      // and may carry more than one op reads. Every value used below is read
      // out by name and validated on the way.
      args: asRecord(body.args),
      context: {
        ipAddress: boundedText(context.ipAddress, 64),
        userAgent: boundedText(context.userAgent, 256),
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A string that will end up in a log, an audit column or an email, clamped. */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  max = MAX_ID_LENGTH,
): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function booleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A number, passed on exactly as it arrived.
 *
 * Deliberately NOT truncated. The only number any operation takes is a page
 * limit, and `lib/agreements/search.ts` documents that it refuses a
 * non-integer rather than rounding one — a limit of 3.7 is a bug in the caller
 * and a silent `3` hides it behind a page of results that looks fine. Rounding
 * here would quietly overrule that decision from the outside.
 */
function numberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

// -----------------------------------------------------------------------------
// The operator
// -----------------------------------------------------------------------------

export type OperatorResolution =
  | { ok: true; operator: Operator }
  | { ok: false; outcome: OpsOutcome };

/**
 * Who this request is attributed to. One environment read, and no database.
 *
 * The old version of this function was a join against `member` and `user`,
 * re-checked per request so that an operator revoked this morning lost access
 * on their next click rather than when their session expired. That check has no
 * subject now: there is no membership to revoke, and revoking THIS operator
 * means changing HEALDESK_ADMIN_PASSWORD_HASH, which takes effect at the next
 * sign-in because apps/web has no other way in.
 *
 * An unset or malformed HEALDESK_ADMIN_EMAIL is a 503, not a fallback. Every
 * audit row this file writes carries that address as its ONLY statement of who
 * acted; a default, a placeholder or an empty string would produce rows that
 * look attributed and are not, which is worse than a console that refuses to
 * work until it is configured.
 */
export function resolveOperator(context: OpsContext): OperatorResolution {
  /**
   * `env.adminEmail()` and not `required("HEALDESK_ADMIN_EMAIL")`.
   *
   * `required()` warns and returns "" outside production, which is right for a
   * secret whose absence breaks one feature and wrong for the value that names
   * the actor in an audit trail: an empty label would be written to every row
   * without anything failing. `adminEmail()` returns null instead, and the
   * reasoning is written out at the accessor.
   */
  const configured = env.adminEmail();

  if (!configured || !EMAIL_SHAPED.test(configured)) {
    log.error(
      "HEALDESK_ADMIN_EMAIL is not set or is not an address; the ops API cannot attribute anything",
    );
    return {
      ok: false,
      outcome: opsProblem(
        "The operations API is unavailable.",
        503,
        "unavailable",
      ),
    };
  }

  return {
    ok: true,
    operator: {
      email: configured,
      request: {
        requestId: randomUUID(),
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
    },
  };
}

/**
 * The actor for anything that writes through `lib/audit.ts`'s recorder.
 *
 * A "service" actor and not a "user" one, and the reason is a foreign key
 * rather than a preference: a "user" actor writes its id into
 * `audit_log.actor_user_id`, which references `user`, and there is no user row
 * to reference. `labelFor()` returns `serviceName` for this actor type, so
 * `actor_label` still reads as the administrator's address — the field anybody
 * auditing these rows actually reads, and the only one that can be true here.
 *
 * `actor_type` therefore says "service" about a human act, which is the one
 * imprecision in this trade and is worth naming: the enum has five values and
 * none of them means "the sole administrator". "service" is the closest, the
 * label disambiguates it, and inventing a sixth value is a schema change
 * nobody asked for.
 *
 * The other visible cost is `connection_links.issued_by`, which becomes null
 * where it used to hold an ops user id: `links.ts` fills that column only for a
 * "user" actor. It is not a foreign key, and its column comment already
 * anticipates this case — "nullable because a link issued by a script has no
 * human behind it, and a fabricated attribution would be worse than an absent
 * one". The security event written beside it names the administrator.
 */
function actorFor(operator: Operator): ActorContext {
  return { type: "service", serviceName: operator.email };
}

/**
 * Record what the administrator did, and never let recording it lose the result.
 *
 * Two failure modes, and they pull in opposite directions. Letting a failed
 * audit write become a 500 discards the outcome — for `issueConnectLink` that
 * outcome is the only copy of a token that will ever exist on our side, so the
 * link would be unrecoverable and a second one would be minted. Letting it pass
 * silently is worse in a different way: these acts are meant to be
 * attributable, and an unrecorded act that looks recorded is the exact failure
 * the trail exists to prevent.
 *
 * So the write is attempted, the failure is logged unmissably, and the answer
 * to "was this recorded" travels back to the console as `auditRecorded`. The
 * operator sees an action that worked and a warning that it is not in the log,
 * which is the only honest description of that state.
 *
 * `userId` is not passed at all. See the header: there is no user row, and
 * `security_events.user_id` is a foreign key, so anything other than null would
 * fail the INSERT and lose the row.
 *
 * Only the error's NAME is logged. A drizzle failure carries the attempted
 * statement and its bound parameters as own properties.
 */
async function audit(
  operator: Operator,
  event: string,
  metadata: Record<string, unknown>,
  organizationId: string | null = null,
): Promise<boolean> {
  try {
    await recordSecurityEvent(unsafeDb, {
      event,
      // From the environment, never from the request. The body has no field
      // that could name an actor, which is the line this whole design draws.
      actorLabel: operator.email,
      userId: null,
      organizationId,
      ipAddress: operator.request.ipAddress ?? null,
      userAgent: operator.request.userAgent ?? null,
      metadata,
    });
    return true;
  } catch (error) {
    log.error("ops api: could not record event", {
      event,
      error: error instanceof Error ? error.name : "unknown error",
    });
    return false;
  }
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

/**
 * Run one operation for the administrator.
 *
 * An exhaustive `switch` over a string-literal union. Adding a name to
 * `OPERATIONS` without adding a case here is a compile error at the `never`
 * below, so the list and the dispatch cannot drift apart.
 */
export async function runOperation(
  op: OpName,
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  switch (op) {
    case "listClinics":
      return opListClinics(args, operator);
    case "listJobs":
      return opListJobs();
    case "toggleJob":
      return opToggleJob(args, operator);
    case "issueConnectLink":
      return opIssueConnectLink(args, operator);
    case "resendAgreementCopy":
      return opResendAgreementCopy(args, operator);
    case "markAgreementTerminated":
      return opMarkAgreementTerminated(args, operator);
    case "searchAgreements":
      return opSearchAgreements(args);
    case "getAgreement":
      return opGetAgreement(args);
    case "getAdminTotpState":
      return opGetAdminTotpState();
    case "enrolAdminTotp":
      return opEnrolAdminTotp(args, operator);
    case "verifyAdminTotpStep":
      return opVerifyAdminTotpStep(args, operator);
    case "burnRecoveryCode":
      return opBurnRecoveryCode(args, operator);
    case "sendSignInAlert":
      return opSendSignInAlert(args, operator);
    default: {
      // Unreachable, and it is the compiler's job to keep it that way: adding a
      // name to OPERATIONS without a case above fails to assign here. The
      // runtime answer is still the one a stranger gets, naming nothing.
      const unreachable: never = op;
      void unreachable;
      return opsProblem("Unknown operation.", 400, "unknown_operation");
    }
  }
}

// -----------------------------------------------------------------------------
// Clinics
// -----------------------------------------------------------------------------

/** Whether a clinic can be reached for verified attribution, or needs a link. */
export type ClinicConnection =
  | "connected"
  | "outstanding"
  | "none"
  /** Past the cap below. Not checked — which is not the same as "not connected". */
  | "unknown";

export type OpsClinicRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  specialty: string;
  plan: string | null;
  attributionMode: "estimated" | "verified";
  dataClassification: "synthetic" | "production";
  isCoveredEntity: boolean | null;
  /** UTC calendar dates. These are dates everywhere they are shown. */
  baaSignedOn: string | null;
  createdOn: string;
  blockers: ClinicBlocker[];
  connection: ClinicConnection;
};

/**
 * How many clinics get their connection state read on one call.
 *
 * Each one costs its own transaction — `connection_links` and
 * `provider_connections` are FORCE RLS, so the tenant has to be declared before
 * the select and the GUC holds one id at a time. The list is newest first and
 * the clinics still needing a link are the recent ones, so the cap falls on the
 * rows least likely to be acted on. Everything past it is reported as
 * "unknown", never as "none" — guessing would send an operator to issue a
 * second credential for a clinic that already has one.
 */
const CONNECTION_STATE_LIMIT = 50;

async function opListClinics(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const overviews = await listClinicOverviews();

  /**
   * Opt-out rather than opt-in. The clinic list is where connection links get
   * issued, and a list that cannot say which clinics lack one is a list nobody
   * can act on — so the default is the useful answer, and a caller that only
   * wants names and blockers can decline the N transactions.
   */
  const wantsConnection = booleanArg(args, "connectionState") ?? true;

  const connections = wantsConnection
    ? await readConnectionStates(
        overviews.map((clinic) => clinic.id),
        actorFor(operator),
        operator.request,
      )
    : new Map<string, ClinicConnection>();

  const clinics: OpsClinicRow[] = overviews.map((clinic) => ({
    id: clinic.id,
    slug: clinic.slug,
    name: clinic.name,
    timezone: clinic.timezone,
    specialty: clinic.specialty,
    plan: clinic.plan,
    attributionMode: clinic.attributionMode,
    dataClassification: clinic.dataClassification,
    isCoveredEntity: clinic.isCoveredEntity,
    baaSignedOn: clinic.baaSignedAt ? asDate(clinic.baaSignedAt) : null,
    createdOn: asDate(clinic.createdAt),
    // Computed here rather than shipped as raw columns for the console to
    // re-derive: `blockersFor` is the one statement of what stands between a
    // clinic and real patient data, and a second copy of it in apps/web would
    // be a second answer to that question.
    blockers: blockersFor(clinic),
    connection: connections.get(clinic.id) ?? "unknown",
  }));

  return ok({ clinics, connectionStateLimit: CONNECTION_STATE_LIMIT });
}

async function readConnectionStates(
  clinicIds: string[],
  actor: ActorContext,
  request: RequestContext,
): Promise<Map<string, ClinicConnection>> {
  const states = new Map<string, ClinicConnection>();

  for (const clinicId of clinicIds.slice(0, CONNECTION_STATE_LIMIT)) {
    const state = await withTenant(
      { clinicId, actor, request },
      async (tx): Promise<ClinicConnection> => {
        // The clinic filter is redundant under RLS and written anyway: the
        // application filters, the database refuses. Two locks, as everywhere
        // else that touches a tenant table.
        const [credential] = await tx.db
          .select({ id: providerConnections.id })
          .from(providerConnections)
          .where(
            and(
              eq(providerConnections.clinicId, clinicId),
              // A revoked credential is not a connection. It is a clinic that
              // needs a new link, which is what this column is for.
              ne(providerConnections.status, "revoked"),
            ),
          )
          .limit(1);

        if (credential) return "connected";

        const [link] = await tx.db
          .select({ id: connectionLinks.id })
          .from(connectionLinks)
          .where(
            and(
              eq(connectionLinks.clinicId, clinicId),
              isNull(connectionLinks.usedAt),
              // Postgres' clock, the same one that stamped expires_at and that
              // consumption will judge against. An app-side Date would let skew
              // decide whether a link counts as outstanding.
              gt(connectionLinks.expiresAt, sql`now()`),
            ),
          )
          .limit(1);

        return link ? "outstanding" : "none";
      },
    );

    states.set(clinicId, state);
  }

  return states;
}

// -----------------------------------------------------------------------------
// Scheduled jobs
// -----------------------------------------------------------------------------

export type OpsJobRow = {
  name: string;
  enabled: boolean;
  cadence: string;
  /** ISO 8601, or null. Formatting is the console's business, not this one's. */
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunNote: string | null;
  runningSince: string | null;
  updatedAt: string;
};

async function opListJobs(): Promise<OpsOutcome> {
  const jobs = await listJobRecords();

  /**
   * Projected rather than returned whole. `scheduled_jobs.updated_by` is a
   * staff user id from the era when there were staff users, and the console
   * does not render it — a column crossing an app boundary because it happened
   * to be on the row is how responses grow past what anyone needed. Who last
   * flipped a job is a question for `security_events`, where the answer is an
   * address rather than an id.
   */
  const rows: OpsJobRow[] = jobs.map((job) => ({
    name: job.name,
    enabled: job.enabled,
    cadence: job.cadence,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    lastRunStatus: job.lastRunStatus,
    lastRunNote: job.lastRunNote,
    runningSince: job.runningSince?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  }));

  return ok({ jobs: rows });
}

export type ToggleJobState =
  | { status: "updated"; name: string; enabled: boolean; auditRecorded: boolean }
  | { status: "error"; message: string };

async function opToggleJob(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const name = stringArg(args, "name", 100);
  const enabled = booleanArg(args, "enabled");

  if (!name) {
    return opsProblem("Missing job name.", 400, "invalid_args");
  }
  if (enabled === undefined) {
    return opsProblem("Missing enabled flag.", 400, "invalid_args");
  }

  /**
   * Read the job first, which the console's action did not.
   *
   * The UPDATE below has no way to report an unknown name — it affects zero
   * rows and says nothing — and the console then wrote a security event saying
   * an operator had enabled a job that does not exist. An audit row asserting
   * something that never happened is its own kind of wrong, and the harder kind
   * to notice.
   */
  const job = await getJob(name);
  if (!job) {
    return ok({ status: "error", message: "No such job." } satisfies ToggleJobState);
  }

  /**
   * Written here rather than through `setJobEnabled()`, and only for this.
   *
   * That function's third parameter is `userId: string`, and it writes the
   * value into `scheduled_jobs.updated_by`, which is a foreign key to `user`.
   * There is no user row now, so the only honest value is null and the
   * signature cannot express it. Everything else about jobs still comes from
   * `lib/scheduler/jobs.ts` — `getJob` above, `listJobs` next door — because a
   * second idea of what a job is would be a genuine duplication; this is one
   * statement standing in for one parameter.
   *
   * The one-word change that would remove this ( `userId: string | null` ) is
   * in a file outside this slice, so it is named rather than made.
   */
  await unsafeDb
    .update(scheduledJobs)
    .set({ enabled, updatedBy: null, updatedAt: new Date() })
    .where(eq(scheduledJobs.name, name));

  // Enabling a job that mails customers is exactly the kind of act that needs
  // an answer to "who turned this on, and when".
  const auditRecorded = await audit(
    operator,
    enabled ? "job_enabled" : "job_disabled",
    { job: name },
  );

  return ok({
    status: "updated",
    name,
    enabled,
    auditRecorded,
  } satisfies ToggleJobState);
}

// -----------------------------------------------------------------------------
// Connection links
// -----------------------------------------------------------------------------

/** What the mailer actually did, reported rather than assumed. */
export type ConnectLinkDelivery =
  | { attempted: false }
  | { attempted: true; status: "sent" }
  | { attempted: true; status: "skipped" | "failed"; reason: string };

export type IssueConnectLinkState =
  | {
      status: "issued";
      /**
       * The one-time URL.
       *
       * It travels to apps/web, from there to the operator's browser, and stops
       * there. It is not persisted, not logged, and not written to any audit
       * row — the database holds SHA-256 of the token and nothing else, so once
       * this value is dropped it cannot be recovered by anyone, us included.
       * Re-issuing is the only recovery, and it is cheap; a link that could be
       * re-displayed would be a credential we had stored after all.
       */
      url: string;
      /** Pre-formatted, so the console renders it without re-deciding a format. */
      expiresAt: string;
      delivery: ConnectLinkDelivery;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

/**
 * Mint a single-use connection link for one clinic.
 *
 * Clinics do not sign in. There is no account, no password and no console for
 * them, so nothing in the product can create this link on their behalf — if ops
 * cannot issue one, a clinic has no way to grant the read-only access that
 * turns estimated attribution into verified attribution.
 *
 * The token, the digest and the TTL all belong to `lib/connections/links.ts`,
 * which stores a hash, clamps the window and lets Postgres stamp the clock.
 * What this supplies is what only an authenticated surface can: that somebody
 * authorised is issuing, and which clinic.
 */
async function opIssueConnectLink(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId");
  const recipientEmail = stringArg(args, "recipientEmail", MAX_EMAIL_LENGTH);

  if (!clinicId || !UUID_SHAPED.test(clinicId)) {
    return ok({
      status: "error",
      message: "That is not a clinic id.",
    } satisfies IssueConnectLinkState);
  }

  const to = recipientEmail?.toLowerCase();
  if (to !== undefined && !EMAIL_SHAPED.test(to)) {
    // Validated before minting, not after. The token is unrecoverable, so a
    // typo caught on the far side of issuance costs a live link that then sits
    // unused for a fortnight.
    return ok({
      status: "error",
      message: "That doesn't look like an email address.",
    } satisfies IssueConnectLinkState);
  }

  // Existence check and clinic name in one read. listClinics() is the SECURITY
  // DEFINER overview, because the runtime role genuinely cannot SELECT a clinic
  // with no tenant declared. Scanning the list to find one row is fine at
  // operator scale and wrong at any other, which is a reason for this to stay
  // on the ops path and nowhere else.
  const clinic = (await listClinicOverviews()).find((c) => c.id === clinicId);
  if (!clinic) {
    return ok({
      status: "error",
      message: "No such clinic.",
    } satisfies IssueConnectLinkState);
  }

  const { token, expiresAt } = await issueConnectionLink(
    clinic.id,
    {},
    { actor: actorFor(operator), request: operator.request },
  );

  const url = `${env.betterAuthUrl().replace(/\/$/, "")}/connect/${token}`;

  let delivery: ConnectLinkDelivery = { attempted: false };

  if (to) {
    const result = await sendConnectLink({
      to,
      clinicId: clinic.id,
      clinicName: clinic.name,
      url,
      expiresAt,
    });

    delivery =
      result.status === "sent"
        ? { attempted: true, status: "sent" }
        : { attempted: true, status: result.status, reason: result.reason };
  }

  /**
   * links.ts already wrote the clinic-scoped audit_log row for the issuance.
   * This is the identity-plane counterpart — the question security events
   * answer is "what did this operator do, from where", and handing out a
   * credential that grants read access to a clinic's booking system is squarely
   * that. It also records the one fact links.ts cannot know: whether we tried
   * to mail it, and what came back.
   *
   * Deliberately absent: the token, the URL that contains it, the recipient
   * address and the clinic's name. The first two because an audit row that
   * yields a working credential is worse than no audit row; the last two
   * because `assertNoPhi()` refuses both. The clinic id is a UUID and
   * identifies the clinic exactly.
   */
  const auditRecorded = await audit(operator, "connect_link_issued", {
    clinicId: clinic.id,
    // An integer, not a timestamp. assertNoPhi() reads an ISO date as a
    // phone-shaped string and would refuse the whole write.
    expiresInHours: Math.round((expiresAt.getTime() - Date.now()) / 3_600_000),
    delivery: delivery.attempted ? delivery.status : "not_attempted",
  });

  return ok({
    status: "issued",
    url,
    expiresAt: `${expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
    delivery,
    auditRecorded,
  } satisfies IssueConnectLinkState);
}

// -----------------------------------------------------------------------------
// Signed agreements
// -----------------------------------------------------------------------------

export type ResendCopyState =
  /** Delivered. `firstCopy` is false when a copy had already reached them. */
  | { status: "sent"; firstCopy: boolean; auditRecorded: boolean }
  | { status: "not_sent"; reason: string; auditRecorded: boolean }
  | { status: "error"; message: string };

/**
 * Send the signer their copy again.
 *
 * Every reason this is needed is a reason it must be cheap: the transport was
 * unconfigured at signature, the address bounced and was fixed, the office
 * manager left and took the mailbox with them, or their counsel asked for it.
 * Nothing here re-signs anything — the document, its hash and its signature
 * block all come from the row.
 *
 * ## Why this writes its own audit row, where the previous version did not
 *
 * `deliverSignedCopy` traces the delivery itself, taking `actorLabel` and
 * `userId` from the trigger. Its `CopyTrigger` types that user id as a required
 * `string`, and `security_events.user_id` is a foreign key to `user` — so under
 * a design with no user rows there is no value that both type-checks and
 * inserts. Its trace therefore fails on the resend path and is swallowed by its
 * own catch, which would leave the one act on this surface that re-sends an
 * executed contract with no security event at all.
 *
 * So the authoritative row is written here, with the administrator's address
 * and a null user id like every other row in this file, and `auditRecorded`
 * reports honestly whether it landed. The one-word fix that would let
 * `deliverSignedCopy` record it instead — `userId: string | null` on
 * `CopyTrigger` — is in `lib/agreements.ts`, which another workflow owns; it is
 * named here rather than made. Until then a caught FK error is logged per
 * resend, which is noisy and is not a lost record.
 *
 * `baa_acceptances.copy_sent_at` and the delivery's digest are written by
 * `deliverSignedCopy` in a separate statement and are unaffected by any of this.
 */
async function opResendAgreementCopy(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const agreementId = stringArg(args, "agreementId");

  if (!agreementId || !UUID_SHAPED.test(agreementId)) {
    return ok({
      status: "error",
      message: "That is not an agreement id.",
    } satisfies ResendCopyState);
  }

  const trigger: CopyTrigger = {
    kind: "resend",
    actorLabel: operator.email,
    /**
     * Null, because there is no user. Not "" and not an invented id: both are
     * claims about a person where this is the absence of one, and both fail the
     * `security_events.user_id` foreign key — which `traceCopy` catches and
     * swallows, so the only symptom was one logged error per resend and a
     * missing trace row. `actorLabel` above carries the attribution that exists.
     */
    userId: null,
  };

  const delivery = await deliverSignedCopy(
    agreementId,
    trigger,
    operator.request,
  );

  switch (delivery.status) {
    case "sent": {
      const auditRecorded = await audit(operator, "baa_copy_resent", {
        agreementId,
        firstCopy: delivery.firstCopy,
      });
      return ok({
        status: "sent",
        firstCopy: delivery.firstCopy,
        auditRecorded,
      } satisfies ResendCopyState);
    }
    case "not_found":
      return ok({
        status: "error",
        message: "No such agreement.",
      } satisfies ResendCopyState);
    default: {
      // A refusal is as much a fact about this agreement as a delivery: "the
      // signer still has no copy, and somebody tried" is the sentence an
      // auditor is looking for. The reason is one of a fixed set produced by
      // the delivery path, not free text from a transport.
      const auditRecorded = await audit(operator, "baa_copy_resend_failed", {
        agreementId,
        outcome: delivery.status,
      });
      return ok({
        status: "not_sent",
        reason: delivery.reason,
        auditRecorded,
      } satisfies ResendCopyState);
    }
  }
}

export type MarkTerminatedState =
  | {
      status: "recorded";
      /** YYYY-MM-DD, as recorded. */
      terminatedOn: string;
      /** The floor this just created, so the operator sees what they did. */
      retainUntil: string;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

/**
 * Record the date a BAA stopped being in effect.
 *
 * ## Why this is not reversible, and why that is deliberate
 *
 * 45 CFR 164.530(j)(2) requires documentation to be retained six years "from
 * the date of its creation or the date when it last was in effect, whichever is
 * later", and 164.316(b)(2)(i) says the same for the security-rule
 * documentation. For an agreement, "last in effect" is termination — so writing
 * this date starts a six-year clock that runs from it, and a clinic that stayed
 * three years is a record we hold for nine.
 *
 * The application cannot clear the column again: the grant that lets this
 * statement run is column-scoped, and there is no path in this codebase that
 * sets `terminated_at` back to null. Undoing a mistake means a human with the
 * migrator role, deliberately. The console must say so before it fires, because
 * an operator who learns that afterwards has learned it too late.
 */
async function opMarkAgreementTerminated(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const agreementId = stringArg(args, "agreementId");
  // Bounded well above a date rather than AT one: clamping to ten characters
  // would turn "2026-09-071" into the valid-looking "2026-09-07" and record a
  // termination the operator never typed, on a column nothing can correct.
  // DATE_SHAPED refuses the whole string instead.
  const terminationDate = stringArg(args, "terminationDate", 64);

  if (!agreementId || !UUID_SHAPED.test(agreementId)) {
    return ok({
      status: "error",
      message: "That is not an agreement id.",
    } satisfies MarkTerminatedState);
  }

  const terminatedAt = terminationDate ? endOfUtcDay(terminationDate) : null;
  if (!terminationDate || !terminatedAt) {
    return ok({
      status: "error",
      message: "That is not a real date.",
    } satisfies MarkTerminatedState);
  }

  /**
   * Only a date that has already passed, and this is the guard that matters
   * most on this action.
   *
   * A notice period makes a future termination date knowable, and recording it
   * early is tempting. But this column is write-once and the application cannot
   * correct it — so an agreement whose notice is withdrawn, or whose clinic
   * renews, is left permanently stamped with a termination that never happened.
   * That is not merely untidy: retention runs from
   * greatest(accepted_at, terminated_at), so a premature date sets the floor
   * years EARLIER than the real one and re-creates, by another route, exactly
   * the error this feature exists to prevent — a live agreement that looks
   * eligible for destruction.
   *
   * Compared as a calendar date so that "today" is always recordable, even
   * though the instant stored for today is later this evening.
   *
   * Checked BEFORE the row is read. It is a statement about what the operator
   * typed and needs no row to be true, so making the database answer first only
   * buys a read — and it means an unrecordable date on an id that does not
   * exist is answered with "no such agreement", which says more about our table
   * than the refusal it replaced.
   */
  if (terminationDate > asDate(new Date())) {
    return ok({
      status: "error",
      message:
        "That date is in the future. Record a termination once it has happened, because this cannot be undone and a date that never comes true would shorten the retention clock.",
    } satisfies MarkTerminatedState);
  }

  /**
   * Read directly rather than through `getAgreement()`, which is called
   * everywhere else in this file: its projection does not carry `terminatedAt`,
   * and this is the one operation whose entire behaviour turns on that column.
   * Three columns, under their own names.
   */
  const [row] = await unsafeDb
    .select({
      acceptedAt: baaAcceptances.acceptedAt,
      terminatedAt: baaAcceptances.terminatedAt,
      version: baaAcceptances.documentVersion,
    })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, agreementId))
    .limit(1);

  if (!row) {
    return ok({
      status: "error",
      message: "No such agreement.",
    } satisfies MarkTerminatedState);
  }

  if (row.terminatedAt) {
    return ok({
      status: "error",
      message: `Already recorded as terminated on ${asDate(row.terminatedAt)}. Nothing in this console can change that.`,
    } satisfies MarkTerminatedState);
  }

  if (terminatedAt.getTime() < row.acceptedAt.getTime()) {
    return ok({
      status: "error",
      message: `It was signed on ${asDate(row.acceptedAt)}. An agreement cannot stop being in effect before it started.`,
    } satisfies MarkTerminatedState);
  }

  /**
   * `is null` in the predicate, not just in the check above.
   *
   * Between the read and this write another request can have recorded a
   * different date, and the whole point of this column is that the first answer
   * stands. Postgres decides, not the gap between two statements.
   */
  const [updated] = await unsafeDb
    .update(baaAcceptances)
    .set({ terminatedAt })
    .where(
      and(
        eq(baaAcceptances.id, agreementId),
        isNull(baaAcceptances.terminatedAt),
      ),
    )
    // The floor comes back from the database that just recomputed it.
    // retention_eligible_at is GENERATED ALWAYS, so this is the six-year rule
    // as the schema states it rather than a second version written here.
    .returning({
      id: baaAcceptances.id,
      retentionEligibleAt: baaAcceptances.retentionEligibleAt,
    });

  if (!updated) {
    return ok({
      status: "error",
      message:
        "Someone recorded a termination date for this agreement a moment ago. Reload to see it.",
    } satisfies MarkTerminatedState);
  }

  const auditRecorded = await audit(operator, "baa_terminated", {
    agreementId,
    version: row.version,
    // Epoch milliseconds, an integer, because assertNoPhi() reads "2026-09-07"
    // as a phone-shaped string and would refuse the whole write. Same reason
    // the connect link records hours rather than a timestamp.
    terminatedAtEpochMs: terminatedAt.getTime(),
  });

  return ok({
    status: "recorded",
    terminatedOn: terminationDate,
    // The consequence, in the operator's face, taken from the column Postgres
    // generated rather than from six added to a year here.
    retainUntil: asDate(updated.retentionEligibleAt),
    auditRecorded,
  } satisfies MarkTerminatedState);
}

// -----------------------------------------------------------------------------
// The agreements register
// -----------------------------------------------------------------------------

/**
 * The searchable register of signed business associate agreements.
 *
 * The query itself belongs to `lib/agreements/search.ts` and is called, never
 * reimplemented: a second query over `baa_acceptances` is a second answer to
 * "which agreements do we hold" and to what "terminated" means, and the one
 * thing a register must not have is two answers. What is done here is the part
 * that belongs at an app boundary — validating an untrusted filter, and
 * choosing what crosses.
 */

/** The three the register partitions rows into. Anything else is a typo. */
const AGREEMENT_STATUSES: readonly AgreementStatus[] = [
  "in_effect",
  "terminated",
  "retention_review",
];

function statusArg(
  args: Record<string, unknown>,
): { ok: true; status?: AgreementStatus } | { ok: false } {
  const raw = stringArg(args, "status", 32);
  if (raw === undefined) return { ok: true };

  const match = AGREEMENT_STATUSES.find((status) => status === raw);
  // Refused rather than ignored. A filter that silently does nothing shows an
  // operator the whole register under a heading that says otherwise, and the
  // way they find out is by acting on a row they thought was filtered out.
  return match ? { ok: true, status: match } : { ok: false };
}

/**
 * A base64url `<instant>|<uuid>`, ~92 characters. Bounded because it reaches a
 * decoder and a log line, and neither wants a megabyte of caller-chosen text.
 */
const MAX_CURSOR_LENGTH = 256;

/**
 * One row of the register as it crosses to the console.
 *
 * Projected rather than passed through, and the projection is the point: dates
 * become ISO strings here, once, so the console is not left inferring the wire
 * shape from a type it cannot import. Note what is NOT in it — `renderedText`,
 * the evidentiary document itself, which `AgreementRow` does not carry and a
 * list operation must never grow. Fifty contracts do not cross an app boundary
 * to render fifty rows; `getAgreement` fetches one, by id, when an operator
 * asks for it.
 */
export type OpsAgreementRow = {
  id: string;
  clinicLegalName: string | null;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
  version: string;
  documentHash: string;
  acceptedAt: string;
  copySent: boolean;
  copySentAt: string | null;
  terminatedAt: string | null;
  /** Earliest this row could EVER become eligible. Never a deletion date. */
  retentionFloorAt: string;
  /** Null while the agreement is in effect: an honest absence, not a guess. */
  eligibleAt: string | null;
  status: AgreementStatus;
};

async function opSearchAgreements(
  args: Record<string, unknown>,
): Promise<OpsOutcome> {
  const status = statusArg(args);
  if (!status.ok) {
    return opsProblem("Unknown agreement status.", 400, "invalid_args");
  }

  const filter: AgreementFilter = {
    query: stringArg(args, "query", MAX_QUERY_LENGTH),
    signedFrom: stringArg(args, "signedFrom", 40),
    signedTo: stringArg(args, "signedTo", 40),
    version: stringArg(args, "version", 64),
    status: status.status,
    copySent: booleanArg(args, "copySent"),
    // Left to the register to clamp and to refuse: it documents 50 by default,
    // 200 at most, and a non-integer as a bug rather than something to round.
    // Passing an integer or nothing is this layer's whole responsibility.
    limit: numberArg(args, "limit"),
    cursor: stringArg(args, "cursor", MAX_CURSOR_LENGTH),
  };

  let found;
  try {
    found = await searchAgreements(filter);
  } catch (error) {
    if (error instanceof AgreementSearchError) {
      /**
       * The module refuses input it will not silently reinterpret — an
       * unparseable date, a malformed cursor, a limit of zero. That is a 400
       * about what the operator typed, not a 500 about us, and the distinction
       * decides whether they fix the date or call somebody. Its messages are
       * written for an operator and carry only the field name, so they are
       * safe to pass on verbatim.
       */
      return opsProblem(error.message, 400, "invalid_args");
    }
    throw error;
  }

  const rows: OpsAgreementRow[] = found.rows.map((row) => ({
    id: row.id,
    clinicLegalName: row.clinicLegalName,
    signatoryName: row.signatoryName,
    signatoryEmail: row.signatoryEmail,
    signatoryTitle: row.signatoryTitle,
    version: row.version,
    documentHash: row.documentHash,
    acceptedAt: row.acceptedAt.toISOString(),
    copySent: row.copySent,
    copySentAt: row.copySentAt?.toISOString() ?? null,
    terminatedAt: row.terminatedAt?.toISOString() ?? null,
    retentionFloorAt: row.retentionFloorAt.toISOString(),
    eligibleAt: row.eligibleAt?.toISOString() ?? null,
    status: row.status,
  }));

  return ok({ rows, nextCursor: found.nextCursor, total: found.total });
}

/**
 * One agreement, and the record of what was delivered against it.
 *
 * The text IS included here, and only here. This is the register's detail view:
 * an operator opening one row to read what a practice actually signed, having
 * authenticated with a password and a second factor on this very session. The
 * bulk disclosure the list operation avoids is fifty of these at once, not one
 * asked for by id.
 *
 * The delivery history comes with it because the two questions an operator has
 * on this screen are "what does it say" and "can the counterparty produce their
 * own copy" — and the second is what sends them to the resend button next door.
 * `listCopyDeliveries` is the existing answer, capped by its own default; a
 * second reading of those events here would be a second opinion about which
 * file we sent.
 */
export type OpsAgreementDetail = {
  id: string;
  version: string;
  /** SHA-256 of the text below. The link between the record and the document. */
  hash: string;
  text: string;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
  acceptedAt: string;
  /** Whether the agreement was ever bound to a paying organization. */
  bound: boolean;
  deliveries: {
    deliveredAt: string;
    /** Of the PDF handed to the transport. Null means "not recorded". */
    sha256: string | null;
    firstCopy: boolean;
    trigger: string;
  }[];
};

async function opGetAgreement(
  args: Record<string, unknown>,
): Promise<OpsOutcome> {
  const agreementId = stringArg(args, "agreementId");

  if (!agreementId || !UUID_SHAPED.test(agreementId)) {
    // Same answer as an id that simply is not there. Whether a given string was
    // ever a well-formed id of ours is not a fact this endpoint gives away.
    return ok({ agreement: null });
  }

  const row = await getAgreement(agreementId);
  if (!row) return ok({ agreement: null });

  const deliveries = await listCopyDeliveries(agreementId);

  const agreement: OpsAgreementDetail = {
    id: row.id,
    version: row.version,
    hash: row.hash,
    text: row.text,
    signatoryName: row.acceptedByName,
    signatoryEmail: row.acceptedByEmail,
    signatoryTitle: row.acceptedByTitle,
    acceptedAt: row.acceptedAt.toISOString(),
    // The organization id itself does not cross: it is an internal key the
    // console has nothing to do with, and whether the deal closed is the only
    // part of it anyone reads off this screen.
    bound: row.organizationId !== null,
    deliveries: deliveries.map((delivery) => ({
      deliveredAt: delivery.deliveredAt.toISOString(),
      sha256: delivery.sha256,
      firstCopy: delivery.firstCopy,
      trigger: delivery.trigger,
    })),
  };

  return ok({ agreement });
}

// -----------------------------------------------------------------------------
// The second factor
// -----------------------------------------------------------------------------

/**
 * How many second-factor attempts one process will judge in a window.
 *
 * A six-digit code is a million possibilities and a 90-second window, which is
 * brute-forceable in an afternoon by anything that can submit codes freely.
 * Three things stand in the way, and this is the third:
 *
 *   1. The HMAC. Nothing reaches this API without HEALDESK_PROVISION_SECRET, so
 *      the attacker has to be apps/web or hold its key.
 *   2. The audit row per rejection, which makes a run of failures visible in
 *      `security_events` rather than merely quiet.
 *   3. This counter, which caps the rate at something a person can obviously
 *      exceed only on purpose.
 *
 * It is deliberately in memory and deliberately per process: a database counter
 * would need a column this table does not have, and a shared cache is
 * infrastructure this app does not run. That means N processes multiply the
 * ceiling and a restart clears it — so it is a speed bump, stated as one, and
 * the rate limit that actually matters belongs on the sign-in form in apps/web
 * where the attempts originate. The number is generous: there is one
 * administrator, and a legitimate sign-in is one attempt.
 */
const MAX_SECOND_FACTOR_FAILURES = 10;
const SECOND_FACTOR_WINDOW_MS = 5 * 60_000;

let secondFactorFailures: { since: number; count: number } = {
  since: 0,
  count: 0,
};

function secondFactorThrottled(now = Date.now()): boolean {
  if (now - secondFactorFailures.since > SECOND_FACTOR_WINDOW_MS) return false;
  return secondFactorFailures.count >= MAX_SECOND_FACTOR_FAILURES;
}

function recordSecondFactorFailure(now = Date.now()): void {
  if (now - secondFactorFailures.since > SECOND_FACTOR_WINDOW_MS) {
    secondFactorFailures = { since: now, count: 1 };
    return;
  }
  secondFactorFailures.count += 1;
}

/** A success ends the window. One right answer is not a suspicious pattern. */
function clearSecondFactorFailures(): void {
  secondFactorFailures = { since: 0, count: 0 };
}

async function opGetAdminTotpState(): Promise<OpsOutcome> {
  // Never the secret, never a digest. See getAdminTotpState: the projection
  // does not include the ciphertext column at all, so this cannot leak it even
  // if somebody later spreads the row into the response.
  return ok(await getAdminTotpState());
}

export type EnrolAdminTotpState =
  | {
      status: "proposed";
      /** ⚠️ The enrolment secret. Show it, never store it. */
      secret: string;
      /** ⚠️ Contains the secret. The QR payload. */
      otpauthUri: string;
      /** ⚠️ Contains the secret. Hand it straight back with the code. */
      proposal: string;
      expiresInMs: number;
    }
  | {
      status: "enrolled";
      /** Shown once and never again. Only digests are stored. */
      recoveryCodes: string[];
      enrolledAt: string;
      auditRecorded: boolean;
    }
  | { status: "error"; message: string };

/**
 * Enrol the second factor, in two calls of one operation.
 *
 * With no `code`, this proposes: a secret is generated, returned for the QR,
 * and stored nowhere. With `code` and the `proposal` it came with, it enrols,
 * but only if the code proves the authenticator actually holds the secret. See
 * lib/ops/admin-totp.ts for why enrolling an unproved factor is the failure
 * worth avoiding.
 *
 * Once enrolled, this operation cannot replace anything: the INSERT is
 * conditional on a singleton primary key and the application has neither DELETE
 * nor UPDATE on the secret column. An attacker holding the signing key and full
 * command of apps/web still cannot re-point the second factor at a phone of
 * their own, which is the property that makes it a second factor rather than a
 * second copy of the first.
 */
async function opEnrolAdminTotp(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const code = stringArg(args, "code", 16);
  const proposal = stringArg(args, "proposal", MAX_PROPOSAL_LENGTH);

  if (!code) {
    // The propose phase. Refused outright if a factor already exists, so that
    // the QR for a secret that can never be enrolled is not even generated.
    const state = await getAdminTotpState();
    if (state.enrolled) {
      return ok({
        status: "error",
        message:
          "A second factor is already enrolled. Removing it is a deliberate act with the migrator role, not something this console can do.",
      } satisfies EnrolAdminTotpState);
    }

    const proposed = proposeAdminTotp(operator.email);

    // The proposal itself is never recorded, only that one was made. A row that
    // held the proposal would hold the secret.
    await audit(operator, "admin_totp_enrolment_proposed", {});

    return ok({
      status: "proposed",
      secret: proposed.secret,
      otpauthUri: proposed.otpauthUri,
      proposal: proposed.proposal,
      expiresInMs: proposed.expiresInMs,
    } satisfies EnrolAdminTotpState);
  }

  if (!proposal) {
    return opsProblem(
      "Enrolment takes two steps: call enrolAdminTotp with no code to get a proposal, then call it again with that proposal and a code from the authenticator.",
      400,
      "invalid_args",
    );
  }

  const result = await enrolAdminTotp(proposal, code);

  switch (result.status) {
    case "enrolled": {
      const auditRecorded = await audit(operator, "admin_totp_enrolled", {
        recoveryCodesIssued: result.recoveryCodes.length,
      });
      return ok({
        status: "enrolled",
        recoveryCodes: result.recoveryCodes,
        enrolledAt: result.enrolledAt,
        auditRecorded,
      } satisfies EnrolAdminTotpState);
    }
    case "already_enrolled":
      return ok({
        status: "error",
        message:
          "A second factor is already enrolled. Removing it is a deliberate act with the migrator role, not something this console can do.",
      } satisfies EnrolAdminTotpState);
    default:
      await audit(operator, "admin_totp_enrolment_rejected", {
        reason: result.reason,
      });
      return ok({
        status: "error",
        message:
          result.reason === "proposal_expired"
            ? "That enrolment has expired. Start again to get a new QR code."
            : "That code is not right. Check the clock on your phone and try the next one.",
      } satisfies EnrolAdminTotpState);
  }
}

export type VerifyTotpState =
  | { ok: true }
  | {
      ok: false;
      reason: "not_enrolled" | "incorrect" | "already_used" | "unreadable" | "throttled";
      message: string;
    };

/**
 * Check one code and spend it.
 *
 * Returns 200 with `ok: false` rather than a 401, on purpose. This is an answer
 * to a question apps/web asked on somebody's behalf, not a judgement on
 * apps/web's own authority, and mapping a wrong code onto the same status as a
 * bad signature would have the console tell the administrator to check its
 * configuration when the truth is that they mistyped six digits.
 *
 * Every outcome is audited, success and failure alike. A run of failures on the
 * only account in the system is the thing somebody needs to be able to find
 * later, and `already_used` on a code the administrator submitted once is the
 * signature of a relay.
 */
async function opVerifyAdminTotpStep(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const code = stringArg(args, "code", 16);

  if (!code) {
    return opsProblem("Missing code.", 400, "invalid_args");
  }

  if (secondFactorThrottled()) {
    await audit(operator, "admin_totp_throttled", {});
    return ok({
      ok: false,
      reason: "throttled",
      message:
        "Too many attempts. Wait a few minutes before trying the next code.",
    } satisfies VerifyTotpState);
  }

  const result = await verifyAdminTotpCode(code);

  if (result.ok) {
    clearSecondFactorFailures();
    // The step is recorded, and it is not a secret: knowing which 30-second
    // window a code belonged to yields nothing without the secret that
    // generates codes for it. It is what makes a replay visible in the log.
    await audit(operator, "admin_totp_verified", { step: result.step });
    return ok({ ok: true } satisfies VerifyTotpState);
  }

  recordSecondFactorFailure();
  await audit(operator, "admin_totp_rejected", { reason: result.reason });

  return ok({
    ok: false,
    reason: result.reason,
    message: verifyMessage(result.reason),
  } satisfies VerifyTotpState);
}

function verifyMessage(
  reason: "not_enrolled" | "incorrect" | "already_used" | "unreadable",
): string {
  switch (reason) {
    case "not_enrolled":
      return "No second factor is enrolled yet.";
    case "already_used":
      return "That code has already been used. Wait for the next one.";
    case "unreadable":
      return "The stored second factor could not be read. This needs someone with database access, not another attempt.";
    case "incorrect":
      return "That code is not right. Check the clock on your phone and try the next one.";
  }
}

export type BurnRecoveryCodeState =
  | { ok: true; remaining: number; auditRecorded: boolean }
  | {
      ok: false;
      reason: "not_enrolled" | "incorrect" | "throttled";
      message: string;
    };

/**
 * Spend a recovery code, when the authenticator is gone.
 *
 * This is the whole second factor in one string, so it is treated exactly like
 * a code: throttled on the same counter, audited on every outcome, and spent
 * atomically so the same code cannot be used twice at once.
 *
 * `remaining` is returned because the number matters to the person using it.
 * Running out is not recoverable from this console — there is no operation that
 * issues more, by design, since minting recovery codes is minting credentials —
 * so somebody who is down to their last one needs to know before they need it.
 */
async function opBurnRecoveryCode(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const code = stringArg(args, "code", 64);

  if (!code) {
    return opsProblem("Missing recovery code.", 400, "invalid_args");
  }

  if (secondFactorThrottled()) {
    await audit(operator, "admin_totp_throttled", {});
    return ok({
      ok: false,
      reason: "throttled",
      message: "Too many attempts. Wait a few minutes before trying again.",
    } satisfies BurnRecoveryCodeState);
  }

  const result = await burnRecoveryCode(code);

  if (result.ok) {
    clearSecondFactorFailures();
    const auditRecorded = await audit(operator, "admin_recovery_code_used", {
      remaining: result.remaining,
    });
    return ok({
      ok: true,
      remaining: result.remaining,
      auditRecorded,
    } satisfies BurnRecoveryCodeState);
  }

  recordSecondFactorFailure();
  await audit(operator, "admin_recovery_code_rejected", {
    reason: result.reason,
  });

  return ok({
    ok: false,
    reason: result.reason,
    message:
      result.reason === "not_enrolled"
        ? "No second factor is enrolled yet."
        : "That recovery code is not one of yours, or it has already been used.",
  } satisfies BurnRecoveryCodeState);
}

// -----------------------------------------------------------------------------
// The sign-in alert
// -----------------------------------------------------------------------------

export type SignInAlertState = {
  delivery: "sent" | "skipped" | "failed";
  /** Why, when it was not sent. Safe to show: it names configuration, not data. */
  reason?: string;
  auditRecorded: boolean;
};

/**
 * Tell the administrator that somebody signed in as them.
 *
 * With one account and no colleagues, there is nobody to notice an unfamiliar
 * session in a list. This email is the entire detection surface: the only way
 * the person who owns the credential finds out that it was used without them.
 * So it goes out on every success, not on "suspicious" ones, because a filter
 * that decides which sign-ins are worth mentioning is a filter that will one
 * day decline to mention the one that mattered.
 *
 * ## What is in it, and what must never be
 *
 * The time in UTC, the address it came from, the browser string, and what to do
 * if it was not them. No session id, no token, no code, no password, no link
 * to click. A sign-in alert that carries a credential is a phishing template
 * with our domain on it, and one that carries a link teaches the recipient to
 * click links in emails about their own account.
 *
 * `phiClass: "none"` and therefore Resend: it names one business address and an
 * IP, and there is no patient in it and nowhere for one to appear.
 *
 * ## Where this belongs
 *
 * Beside `lib/email/connect-link.ts` and `lib/email/agreement-copy.ts`, as
 * `lib/email/sign-in-alert.ts`. That directory is outside this slice, so the
 * message is rendered here and the move is noted rather than made.
 */
async function opSendSignInAlert(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const at = stringArg(args, "at", 40);
  const when = at ? new Date(at) : new Date();

  if (Number.isNaN(when.getTime())) {
    // Refused rather than quietly replaced with "now". The time is the one fact
    // in this email the recipient checks against their own memory, and a
    // silently substituted one would make a stale alert look current.
    return opsProblem("That is not a time.", 400, "invalid_args");
  }

  /**
   * The browser's address and agent, from the arguments rather than from the
   * envelope's `context`.
   *
   * They are the CONTENT of this message, not ambient request metadata, and
   * reading them from two places would let the email say one thing and the
   * audit row another about the same sign-in. So this operation takes them as
   * arguments and uses the same values for both.
   */
  const ipAddress = stringArg(args, "ipAddress", 64) ?? operator.request.ipAddress;
  const userAgent =
    stringArg(args, "userAgent", 256) ?? operator.request.userAgent;

  const message: OutgoingEmail = {
    ...renderSignInAlert({ at: when, ipAddress, userAgent }),
    phiClass: "none",
  };

  const target: DeliveryTarget = {
    to: operator.email,
    // No clinic. This is the identity plane, and the transport uses these two
    // for its own logging only. Same sentinel the deleted invite mailer used.
    clinicId: "",
    clinicName: "healdesk operations",
  };

  let delivery: SignInAlertState["delivery"] = "failed";
  let reason: string | undefined;

  try {
    const result = await getTransport(message.phiClass).send(target, message);
    delivery = result.status === "sent" ? "sent" : result.status;
    if (result.status !== "sent") reason = result.reason;
  } catch (error) {
    // Message, not the object: a transport error can carry the request it
    // attempted, and that request contains the recipient address.
    reason = error instanceof Error ? error.message : "Unknown error";
  }

  /**
   * The security event is written whether or not the mail went out, and it is
   * the more important of the two: the email can be blocked, filtered or
   * unread, but this row is the durable record that the single administrative
   * credential was used at a particular moment from a particular address.
   *
   * The address and the browser go into their own COLUMNS, not into metadata —
   * `assertNoPhi()` reads an IP as a phone-shaped string and would refuse the
   * whole write, and those columns exist for exactly this.
   */
  const auditRecorded = await audit(
    { email: operator.email, request: { ...operator.request, ipAddress, userAgent } },
    "admin_sign_in",
    { alert: delivery },
  );

  // The `reason` key is absent rather than null when there is nothing to say.
  // A console rendering "could not send: null" would be reporting a failure
  // that did not happen.
  return ok(
    reason === undefined
      ? ({ delivery, auditRecorded } satisfies SignInAlertState)
      : ({ delivery, reason, auditRecorded } satisfies SignInAlertState),
  );
}

function renderSignInAlert(event: {
  at: Date;
  ipAddress: string | undefined;
  userAgent: string | undefined;
}): { subject: string; text: string; html: string } {
  const when = `${event.at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  // "not recorded" rather than a blank line. An absent value and an unknown one
  // read identically in an email, and only one of them is true here.
  const from = event.ipAddress ?? "not recorded";
  const browser = event.userAgent ?? "not recorded";

  const subject = `healdesk admin: signed in at ${when}`;

  const text = [
    `Someone signed in to the healdesk admin console.`,
    ``,
    `Time:    ${when}`,
    `Address: ${from}`,
    `Browser: ${browser}`,
    ``,
    `If that was you, there is nothing to do.`,
    ``,
    `If it was not, both factors are compromised, because there is only one`,
    `account and both are needed to reach this point. Change the admin password`,
    `and rotate the signing secret, then have someone with database access`,
    `disenrol the authenticator. The console cannot do that itself, which is`,
    `deliberate.`,
    ``,
    `healdesk will never email you a code, a password, or a link to sign in.`,
    `This message contains none of those, and any message that does is not from`,
    `us.`,
  ].join("\n");

  const html = [
    `<p>Someone signed in to the healdesk admin console.</p>`,
    `<table cellpadding="0" cellspacing="0"><tbody>`,
    `<tr><td><strong>Time</strong></td><td>&nbsp;${escapeHtml(when)}</td></tr>`,
    `<tr><td><strong>Address</strong></td><td>&nbsp;${escapeHtml(from)}</td></tr>`,
    // Escaped, and it matters here more than anywhere else on this page: the
    // user agent is a header the browser chose, so it is the one string in this
    // message that somebody else wrote.
    `<tr><td><strong>Browser</strong></td><td>&nbsp;${escapeHtml(browser)}</td></tr>`,
    `</tbody></table>`,
    `<p>If that was you, there is nothing to do.</p>`,
    `<p>If it was not, both factors are compromised, because there is only one `,
    `account and both are needed to reach this point. Change the admin password `,
    `and rotate the signing secret, then have someone with database access `,
    `disenrol the authenticator. The console cannot do that itself, which is `,
    `deliberate.</p>`,
    `<p>healdesk will never email you a code, a password, or a link to sign in. `,
    `This message contains none of those, and any message that does is not from `,
    `us.</p>`,
  ].join("");

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

/**
 * "2026-09-07" → the last instant of that UTC day, or null.
 *
 * The end of the day, not its start, because the regulation counts from the
 * date the agreement last WAS in effect: if it ended on 7 September it was in
 * effect for all of 7 September, so six years from that instant lands at the
 * end of the corresponding day rather than a day early. Midnight would make
 * every retention floor in the system twenty-four hours short of the statute.
 *
 * Round-tripped through toISOString because `new Date("2026-02-31")` is a valid
 * Date in JavaScript — it is 3 March — and a termination date that silently
 * moves is not something anyone would notice on a confirmation screen.
 */
function endOfUtcDay(date: string): Date | null {
  if (!DATE_SHAPED.test(date)) return null;

  const at = new Date(`${date}T23:59:59.999Z`);
  if (Number.isNaN(at.getTime())) return null;
  if (at.toISOString().slice(0, 10) !== date) return null;

  return at;
}

/** UTC calendar date. These are dates, not moments, everywhere they are shown. */
function asDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

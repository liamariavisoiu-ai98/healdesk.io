import { randomUUID } from "node:crypto";

import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  appointments,
  auditLog,
  baaAcceptances,
  bookingRequests,
  clinics,
  connectionLinks,
  providerConnections,
  recordAmendments,
  reportDeliveries,
  scheduledJobs,
  type PhiBasis,
} from "@/db/schema";
import {
  deliverSignedCopy,
  getAgreement,
  listCopyDeliveries,
  type CopyTrigger,
} from "@/lib/agreements";
import { agreementInEffectFor } from "@/lib/agreements/in-effect";
import { agreementTemplateReleased } from "@/lib/agreements/kind";
import { endServicesAfterTermination, type TerminationEffect } from "@/lib/agreements/termination";
import {
  AgreementSearchError,
  searchAgreements,
  type AgreementFilter,
  type AgreementStatus,
} from "@/lib/agreements/search";
import {
  BOOKING_FIELDS,
  cleanProfileText,
  CLINIC_PROFILE_LIMITS,
  EXCLUDED_FIELDS,
  findClinicalContent,
  forwardingInstructions,
  getConnectionGuide,
  isAgreementTerminationReason,
  isCarrier,
  isOnboardingStep,
  isServicePriceKind,
  isSpecialtyId,
  ONBOARDING_LABELS,
  ONBOARDING_STEPS,
  resolveBookingRequirements,
  serviceNameScreen,
  type ForwardingInstruction,
  type OnboardingState,
} from "@healdesk/catalog";

import {
  assertNoPhi,
  PhiInAuditError,
  recordSecurityEvent,
  type ActorContext,
  type RequestContext,
} from "@/lib/audit";
import {
  listIncidents,
  markNotified,
  openIncident,
  resolveIncident,
  type IncidentClass,
} from "@/lib/incidents/incidents";
import { applyEmailEvent, isDeliveryStatus } from "@/lib/email/events";
import { KIND_SHAPE } from "@/lib/email/kind-rules";
import {
  destructionPlan,
  markExportDelivered,
  recordVoiceVendorDeletion,
  startOffboarding,
  voiceVendorDeletionOf,
  type DestructionBasis,
  type DestructionRule,
} from "@/lib/offboarding/offboarding";
import { sweepCalendarTerms } from "@/lib/connections/google-calendar";
import {
  opDisconnectCalendar,
  opIssueCalendarLink,
  opSetAutoConfirm,
  OPS_SWITCH_LABEL,
  readBookingProjection,
  type BookingProjection,
} from "@/lib/ops/calendar-ops";
import { readMetaPlatformSwitches, setMetaPlatformEnabled } from "@/lib/channels/meta-platforms";
import { startForwardingTest } from "@/lib/onboarding/forwarding-test";
import {
  ERASURE_STEP_OUTCOMES,
  isErasureStepOutcome,
  isErasureVendorStep,
  listErasureRequests,
  stampErasureVendorStep,
  type ErasureVendorStepId,
} from "@/lib/patient-rights/erasure";
import { listConnections } from "@/lib/connections/store";
import { selfCheckCredentialKey, type CredentialKeySelfCheck } from "@/lib/crypto/envelope";
import { credentialKeyConfiguration, type CredentialKeyConfiguration } from "@/lib/crypto/kms";
import { bookingRequestCounts } from "@/lib/meta/booking-requests";
import {
  attachMetaChannel,
  isMetaPlatform,
  META_PROVIDERS,
  MetaAssetTakenError,
  setMetaFrontDoor,
} from "@/lib/meta/channels";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { clinicHealth, recordTouch, type ClinicHealth } from "@/lib/ops/health";
import { addRecipient, listRecipients, removeRecipient } from "@/lib/reporting/recipients";
import { issueConnectionLink } from "@/lib/connections/links";
import { sendConnectLink } from "@/lib/email/connect-link";
import { sendSetupLink } from "@/lib/email/setup-link";
import { env } from "@/lib/env";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { writeToCalendar, type CalendarWriteOutcome } from "@/lib/booking/calendar";
import { isDemoClinic } from "@/lib/booking/terms";
import { applyBookingRequirementDefaultsFor, setBookingRequirementsWithin } from "@/lib/onboarding/requirements";
import {
  burnRecoveryCode,
  enrolAdminTotp,
  getAdminTotpState,
  proposeAdminTotp,
  verifyAdminTotpCode,
} from "@/lib/ops/admin-totp";
import {
  opCloseUnfinishedSetup,
  opCommitRefund,
  opDisconnectStripeConnect,
  opExtendSetupDeadline,
  opGetClinicBilling,
  opIssueStripeConnectLink,
  opLiftSuspension,
  opPreviewRefund,
  opReplayBillingEvent,
  opReplayConnectEvent,
  opRetryBillingRequest,
  opRetryLocationSetup,
  opRetryOverageInvoice,
  opSetAutoRenew,
  opSetClinicSettings,
  opSetDepositSettings,
  opSetOverageMode,
  opSetUsageAlerts,
} from "@/lib/ops/billing";
import {
  blockersFor,
  listClinics as listClinicOverviews,
  type ClinicBlocker,
} from "@/lib/ops/clinics";
import {
  getTransport,
  isSendableAddress,
  type DeliveryTarget,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";
import {
  AgentConfigError,
  approveAgentConfig,
  getAgentConfig,
  updateAgentConfig,
  type AgentConfigInput,
} from "@/lib/onboarding/agent-config";
import { goLive, goLivePreconditions } from "@/lib/onboarding/go-live";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { completeStep, reopenStep } from "@/lib/onboarding/steps";
import { getJob, listJobs as listJobRecords, PHASE_TWO_JOBS } from "@/lib/scheduler/jobs";
import { SETUP_CLOSURE_REASON } from "@/lib/setup/closure-email";
import { moveSetupDeadlineToZone } from "@/lib/setup/practice";
import { toCents } from "@/lib/setup/prices";
import { withTenant, type TenantTx } from "@/lib/tenant";
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
  // Onboarding (lib/onboarding): configuration, never patient data.
  "getOnboarding",
  "completeOnboardingStep",
  "reopenOnboardingStep",
  "setPhoneSettings",
  "updateAgentConfig",
  "approveAgentConfig",
  "goLive",
  // Care (lib/reporting, lib/incidents, lib/offboarding): who gets mail, what
  // was sent, what went wrong, and the end of the relationship. Never a
  // patient: the export that carries one is a script on the app host.
  "getClinicCare",
  "addReportRecipient",
  "removeReportRecipient",
  "openIncident",
  "markIncidentNotified",
  "resolveIncident",
  "startOffboarding",
  "markExportDelivered",
  "markVoiceVendorDataDeleted",
  // Deletion on request (lib/patient-rights/erasure.ts; BAA 1.3.0 release gate
  // 6): the subcontractor step's stamp, a closed outcome, never typed. The
  // deletion itself, and amendments and corrections (release gate 8), take a
  // patient's identifiers or words in, so they are not operations here at
  // all: they run in apps/app's own shell (lib/ops/patient-entry.ts, npm run
  // ops:erase-person, ops:amend-record, ops:amend-contact), and nothing of a
  // patient crosses apps/web (review of 12 October 2026).
  "markErasureVendorDeleted",
  // The billing panel (lib/ops/billing.ts; build spec §7 E, R35): one clinic's
  // subscription, usage, switches and the billing engine's ledgers, and the
  // support actions on them. Ids, counts, cents and codes; never a payload.
  "getClinicBilling",
  "previewRefund",
  "setOverageMode",
  "setUsageAlerts",
  "replayBillingEvent",
  "commitRefund",
  "setClinicSettings",
  // Auto-confirm, the clinic's own booking switch, beside its other switches
  // (lib/ops/calendar-ops.ts, plan §10). The owner's kill switch is an
  // environment variable, and no operation sets it.
  "setAutoConfirm",
  "setDepositSettings",
  "disconnectStripeConnect",
  "issueStripeConnectLink",
  "retryBillingRequest",
  "liftSuspension",
  "extendSetupDeadline",
  "retryLocationSetup",
  "retryOverageInvoice",
  "closeUnfinishedSetup",
  "replayConnectEvent",
  "setAutoRenew",
  // Phase 8: the forwarding test, the first-weeks view, human touches.
  "startForwardingTest",
  "listClinicHealth",
  "recordClinicTouch",
  // The Meta front door: a sealed token per platform, the per-clinic switch,
  // and the clinic's own Instagram, Messenger and WhatsApp switches beneath it.
  "attachMetaChannel",
  "setMetaFrontDoor",
  "setMetaPlatform",
  // Booking hand-off (design of 23 September 2026, §B.4, §H.5).
  // Configuration and write ledgers; never a patient. The call-back switch
  // and the WhatsApp template name went with v1's inbound-only rule, and the
  // direct-booking switch with v1's derived booking mode (plan C17): a
  // location books directly when its terms, its Google Calendar,
  // Auto-confirm and the owner's kill switch all allow it
  // (lib/booking/mode.ts), and Auto-confirm is the only one of those the
  // console sets.
  "setBookingRequirements",
  "setClinicTimezone",
  "setConnectionPhiBasis",
  "issueSetupLink",
  "retryCalendarWrite",
  "listCalendarWrites",
  // The Google Calendar connection (plan §10): mail the location's calendar
  // link to the practice's own address (never to one the console names),
  // and disconnect its calendar. Neither returns a link, but for the demo
  // clinic's.
  "issueCalendarLink",
  "disconnectCalendar",
  // The email platform (Annex X3): a Resend webhook event for mail this app
  // sent, relayed by apps/web's one webhook. Machine to machine: the relay's
  // caller verified Resend's signature, and the event carries ids, a status and
  // a timestamp, never an address. It writes the delivery ledger, which is its
  // record, and no audit row, so it is not in MUTATING_OPERATIONS.
  "emailEvent",
  // The credential key (lib/crypto): which wrapper, the tail of which key, and
  // a live seal-and-open of a throwaway value. Never the key's full ARN, never
  // a credential, never an AWS error message.
  "getCredentialKeyStatus",
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
  "completeOnboardingStep",
  "reopenOnboardingStep",
  "setPhoneSettings",
  "updateAgentConfig",
  "approveAgentConfig",
  "goLive",
  "addReportRecipient",
  "removeReportRecipient",
  "openIncident",
  "markIncidentNotified",
  "resolveIncident",
  "startOffboarding",
  "markExportDelivered",
  "markVoiceVendorDataDeleted",
  "markErasureVendorDeleted",
  // The billing panel's writes. getClinicBilling and previewRefund are reads:
  // the preview asks Stripe and writes nothing but its audit row.
  "setOverageMode",
  "setUsageAlerts",
  "replayBillingEvent",
  "commitRefund",
  "setClinicSettings",
  "setAutoConfirm",
  "setDepositSettings",
  "disconnectStripeConnect",
  "issueStripeConnectLink",
  "retryBillingRequest",
  "liftSuspension",
  "extendSetupDeadline",
  "retryLocationSetup",
  "retryOverageInvoice",
  "closeUnfinishedSetup",
  "replayConnectEvent",
  "setAutoRenew",
  "startForwardingTest",
  "recordClinicTouch",
  "attachMetaChannel",
  "setMetaFrontDoor",
  "setMetaPlatform",
  "setBookingRequirements",
  "setClinicTimezone",
  "setConnectionPhiBasis",
  "issueSetupLink",
  // Mutating because it moves the appointment's calendar columns and may
  // create a booking in the clinic's calendar.
  "retryCalendarWrite",
  // Mutating: a link minted and mailed, or a calendar disconnected and its
  // grant revoked at Google.
  "issueCalendarLink",
  "disconnectCalendar",
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

export function ok<T>(data: T): OpsOutcome {
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

export const UUID_SHAPED =
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

export function stringArg(
  args: Record<string, unknown>,
  key: string,
  max = MAX_ID_LENGTH,
): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function booleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A number, passed on exactly as it arrived.
 *
 * Deliberately NOT truncated. The numbers operations take are a page limit
 * and the billing panel's days, minutes and cents, and the code behind each
 * refuses a non-integer rather than rounding one: `lib/agreements/search.ts`
 * documents it for the limit, where 3.7 is a bug in the caller and a silent
 * `3` hides it behind a page of results that looks fine. Rounding here would
 * quietly overrule those decisions from the outside.
 */
export function numberArg(
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
export function actorFor(operator: Operator): ActorContext {
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
export async function audit(
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
    case "getOnboarding":
      return opGetOnboarding(args, operator);
    case "completeOnboardingStep":
      return opCompleteOnboardingStep(args, operator, false);
    case "reopenOnboardingStep":
      return opCompleteOnboardingStep(args, operator, true);
    case "setPhoneSettings":
      return opSetPhoneSettings(args, operator);
    case "updateAgentConfig":
      return opUpdateAgentConfig(args, operator);
    case "approveAgentConfig":
      return opApproveAgentConfig(args, operator);
    case "goLive":
      return opGoLive(args, operator);
    case "getClinicCare":
      return opGetClinicCare(args, operator);
    case "addReportRecipient":
      return opAddReportRecipient(args, operator);
    case "removeReportRecipient":
      return opRemoveReportRecipient(args, operator);
    case "openIncident":
      return opOpenIncident(args, operator);
    case "markIncidentNotified":
      return opMarkIncidentNotified(args, operator);
    case "resolveIncident":
      return opResolveIncident(args, operator);
    case "startOffboarding":
      return opStartOffboarding(args, operator);
    case "markExportDelivered":
      return opMarkExportDelivered(args, operator);
    case "markVoiceVendorDataDeleted":
      return opMarkVoiceVendorDataDeleted(args, operator);
    case "markErasureVendorDeleted":
      return opMarkErasureVendorDeleted(args, operator);
    case "getClinicBilling":
      return opGetClinicBilling(args, operator);
    case "previewRefund":
      return opPreviewRefund(args, operator);
    case "setOverageMode":
      return opSetOverageMode(args, operator);
    case "setUsageAlerts":
      return opSetUsageAlerts(args, operator);
    case "replayBillingEvent":
      return opReplayBillingEvent(args, operator);
    case "commitRefund":
      return opCommitRefund(args, operator);
    case "setClinicSettings":
      return opSetClinicSettings(args, operator);
    case "setAutoConfirm":
      return opSetAutoConfirm(args, operator);
    case "setDepositSettings":
      return opSetDepositSettings(args, operator);
    case "disconnectStripeConnect":
      return opDisconnectStripeConnect(args, operator);
    case "issueStripeConnectLink":
      return opIssueStripeConnectLink(args, operator);
    case "retryBillingRequest":
      return opRetryBillingRequest(args, operator);
    case "liftSuspension":
      return opLiftSuspension(args, operator);
    case "extendSetupDeadline":
      return opExtendSetupDeadline(args, operator);
    case "retryLocationSetup":
      return opRetryLocationSetup(args, operator);
    case "retryOverageInvoice":
      return opRetryOverageInvoice(args, operator);
    case "closeUnfinishedSetup":
      return opCloseUnfinishedSetup(args, operator);
    case "replayConnectEvent":
      return opReplayConnectEvent(args, operator);
    case "setAutoRenew":
      return opSetAutoRenew(args, operator);
    case "startForwardingTest":
      return opStartForwardingTest(args, operator);
    case "listClinicHealth":
      return opListClinicHealth(operator);
    case "recordClinicTouch":
      return opRecordClinicTouch(args, operator);
    case "attachMetaChannel":
      return opAttachMetaChannel(args, operator);
    case "setMetaFrontDoor":
      return opSetMetaFrontDoor(args, operator);
    case "setMetaPlatform":
      return opSetMetaPlatform(args, operator);
    case "setBookingRequirements":
      return opSetBookingRequirements(args, operator);
    case "setClinicTimezone":
      return opSetClinicTimezone(args, operator);
    case "setConnectionPhiBasis":
      return opSetConnectionPhiBasis(args, operator);
    case "issueSetupLink":
      return opIssueSetupLink(args, operator);
    case "retryCalendarWrite":
      return opRetryCalendarWrite(args, operator);
    case "listCalendarWrites":
      return opListCalendarWrites(args, operator);
    case "issueCalendarLink":
      return opIssueCalendarLink(args, operator);
    case "disconnectCalendar":
      return opDisconnectCalendar(args, operator);
    case "emailEvent":
      return opEmailEvent(args);
    case "getCredentialKeyStatus":
      return opGetCredentialKeyStatus();
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
  /**
   * Phase two (attribution) and fenced in this environment: runJob() will
   * not run it and toggleJob will not switch it on. The console says so.
   */
  phaseTwo: boolean;
};

/** A phase-two job in an environment where phase two is off. */
function fencedJob(name: string): boolean {
  return PHASE_TWO_JOBS.has(name) && !env.phaseTwoAttribution();
}

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
    phaseTwo: fencedJob(job.name),
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
  // Phase two is fenced out of v1: the monthly revenue report and the POS
  // sync never run for a v1 clinic, so the switch cannot be turned on here.
  // Switching one off is always allowed.
  if (enabled && fencedJob(name)) {
    return ok({
      status: "error",
      message: "That job is phase two (attribution) and does not run in v1. It stays off until HEALDESK_PHASE_TWO_ATTRIBUTION is \"true\".",
    } satisfies ToggleJobState);
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
  | { status: "error"; message: string; reason?: "baa_lacks_calendar_write" };

/**
 * Mint a single-use connection link for one clinic.
 *
 * PHASE TWO: attribution read-back. The link hands over a pasted read-only
 * credential for a POS or booking system, which v1 neither reads nor asks
 * for (v1 spec, onboarding principle 2: "Every connection is a login
 * button"). Refused unless HEALDESK_PHASE_TWO_ATTRIBUTION is "true", so no
 * v1 clinic is mailed a link that promises it a revenue figure. The v1 clinic
 * portal, where clinics do sign in, is not built yet.
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

  if (!env.phaseTwoAttribution()) {
    return ok({
      status: "error",
      message: "Connect links are phase two (attribution read-back) and are not issued in v1. Nothing was minted or sent.",
    } satisfies IssueConnectLinkState);
  }

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

  // §B.5: a link to a guide that WRITES into the clinic's calendar is only
  // issued when the agreement in effect says healdesk may. See
  // agreementCarriesVendorCalendarWrite() for what "says" can mean today.
  const writeGuard = await refuseCalendarWriteLinkWithout(clinic.id, actorFor(operator), operator.request);
  if (writeGuard) return ok(writeGuard);

  // Before minting: a link committed with no origin to put it on is a live
  // credential nobody receives.
  const originProblem = publicOriginProblem();
  if (originProblem) return ok({ status: "error", message: originProblem } satisfies IssueConnectLinkState);

  const { token, expiresAt } = await issueConnectionLink(
    clinic.id,
    {},
    { actor: actorFor(operator), request: operator.request },
  );

  const url = publicUrl(`/connect/${token}`);

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

/**
 * The phase-two vendor clause: healdesk may write appointments into the
 * booking system it reads (Cal.com, under the 1.1.0 draft). Not v1's Google
 * Calendar clauses, which are another matter entirely (below).
 */
const VENDOR_CALENDAR_WRITE_CLAUSE = "calendar-write";

/**
 * Whether the organisation's agreement in effect carries the phase-two
 * VENDOR calendar-write clause (design of 23 September 2026, §B.5, §I.2):
 * what a read-write connection guide for a booking system needs before its
 * link is issued (refuseCalendarWriteLinkWithout, below).
 *
 * What "carries" can honestly mean. `signAgreement` records, on every
 * acceptance row, `variables.appliedClauses`, the clause ids the rendered
 * document actually contained, so the test is a fact about the document the
 * practice signed, not about which template is current: its applied clauses
 * include `calendar-write`. A row whose clause list was not recorded (before
 * `appliedClauses` existed) falls back to the 1.1.0 draft's selection,
 * `variables.calendarWrite`, being set. Only Cal.com under 1.1.0-draft ever
 * had either, and it was never offered, so no organisation passes this
 * today: the design's stated intent, that no clinic stores a vendor
 * credential that writes until the practice signs a released template with
 * the clause.
 *
 * Never the Google Calendar clauses: 1.2.x's `google-calendar` and 1.3.0's
 * `google-calendar-covered`, `-uncovered` and `-not-used` govern the
 * location's own Google Calendar through its calendar terms
 * (lib/booking/terms.ts), and none of them lets healdesk write into a
 * booking system it reads. Only a business associate agreement counts: a
 * data protection agreement's terms are written for a practice outside
 * HIPAA and carry no vendor write (the funnel's plan of 6 October asks that
 * this be aware of the agreement kind).
 *
 * "The agreement in effect" is app_agreement_in_effect() (drizzle/0048),
 * through agreementInEffectFor, and never a query of its own here: an
 * unbound acceptance (signed, never paid) and a terminated one count for
 * nothing.
 */
export async function agreementCarriesVendorCalendarWrite(
  organizationId: string,
): Promise<boolean> {
  const agreement = await agreementInEffectFor(unsafeDb, organizationId);
  if (!agreement || agreement.agreementKind !== "baa") return false;
  const variables = agreement.variables as { appliedClauses?: unknown; calendarWrite?: unknown };
  if (Array.isArray(variables.appliedClauses)) {
    return variables.appliedClauses.includes(VENDOR_CALENDAR_WRITE_CLAUSE);
  }
  return typeof variables.calendarWrite === "object" && variables.calendarWrite !== null;
}

/**
 * The refusal opIssueConnectLink returns for a read-write guide with no
 * calendar-write agreement behind it, or null when the link may be issued.
 * The clinic's platform and organisation live on the clinic row, which the
 * overview does not project, so they are read under the tenant policy.
 */
async function refuseCalendarWriteLinkWithout(
  clinicId: string,
  actor: ActorContext,
  request: RequestContext,
): Promise<IssueConnectLinkState | null> {
  const clinic = await withTenant({ clinicId, actor, request }, async (tx) => {
    const [row] = await tx.db
      .select({ bookingProvider: clinics.bookingProvider, organizationId: clinics.organizationId })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return row ?? null;
  });
  if (!clinic?.bookingProvider) return null;
  const guide = getConnectionGuide(clinic.bookingProvider);
  if (!guide || guide.scope !== "read_write") return null;
  if (await agreementCarriesVendorCalendarWrite(clinic.organizationId)) return null;
  return {
    status: "error",
    reason: "baa_lacks_calendar_write",
    message:
      "This platform writes into the clinic's calendar, and the agreement in effect does not carry the calendar-write clause. The practice signs a template that includes it first; no connect link is issued until then.",
  };
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
      /**
       * What it did to the Services (lib/agreements/termination.ts):
       * `services_ended` when no agreement is left in effect for the
       * practice, so its locations are offboarding and its subscriptions
       * are being cancelled with a refund; `agreement_in_effect` when
       * another agreement still covers it; `unbound` when the agreement was
       * never bound to a practice.
       */
      services: TerminationEffect["status"];
      /**
       * Clause 17 ¶3 refunds this ending and the Services ended with it: ops
       * was told to preview and confirm the refund on Billing.
       */
      refundDue: boolean;
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
 *
 * ## What it ends
 *
 * Every ending of the agreement ends the Services, and the Fees, on the same
 * day (BAA 1.3.0 clauses 1, 17 and 20). The operator records who ended it and
 * why, from the closed set in @healdesk/catalog, in the same write as the
 * date (both write-once, drizzle/0066), because the reason decides the
 * refund: clause 17 ¶3 refunds the fees paid for time after the day only
 * where the practice ended it because healdesk violated a material term, or
 * under the Subcontractors clause.
 *
 * Once the date is committed, and only then, a practice left with no
 * agreement in effect has its locations offboarded and its subscriptions
 * cancelled at once without proration (endServicesAfterTermination), and for
 * those two reasons ops is told to preview and confirm the refund on the
 * clinic's Billing page; the answer gate and the database's patient-data gate
 * already refuse it, since both read the agreements. The termination is
 * recorded first so that no failure after it can leave the agreement looking
 * live: a step that fails is retried or put in front of ops, never rolled
 * back into a live agreement.
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
  const terminationReason = stringArg(args, "terminationReason", 64);

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

  // Who ended it and why, from the closed set. Checked before the row is
  // read, like the date: it is a statement about what the operator chose.
  if (!isAgreementTerminationReason(terminationReason)) {
    return ok({
      status: "error",
      message:
        "Say who ended the agreement and why. It decides whether the practice is refunded, and it cannot be changed once recorded.",
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
      organizationId: baaAcceptances.organizationId,
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
    .set({ terminatedAt, terminationReason })
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
    terminationReason,
  });

  // A terminated agreement voids every location's calendar terms (plan
  // §2.7): each of the organisation's locations loses its Google Calendar
  // now, rather than at the watch's next run, and its grant is revoked when
  // unused. Every live calendar is swept, since a location's organisation is
  // its own tenant's to read; the sweep reads each location's terms afresh,
  // so every other location, and one still under an agreement in effect,
  // keeps its calendar. Never throws.
  await sweepCalendarTerms(undefined, { actor: actorFor(operator) });

  // The Services end with the agreement (see "What it ends" above). Never
  // throws; a step it could not take is in front of ops.
  const services = await endServicesAfterTermination({
    agreementId,
    organizationId: row.organizationId,
    terminatedAt,
    reason: terminationReason,
    actor: actorFor(operator),
    request: operator.request,
  });

  return ok({
    status: "recorded",
    terminatedOn: terminationDate,
    // The consequence, in the operator's face, taken from the column Postgres
    // generated rather than from six added to a year here.
    retainUntil: asDate(updated.retentionEligibleAt),
    auditRecorded,
    services: services.status,
    refundDue: services.status === "services_ended" && services.refundDue,
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


// -----------------------------------------------------------------------------
// Onboarding
// -----------------------------------------------------------------------------

/**
 * Everything the operator needs for one clinic's onboarding call, in one read:
 * the checklist with labels, the phone facts and the forwarding codes they
 * imply, the agent's current words, and what go-live would refuse on. All of
 * it is clinic configuration — the same class of data the overview function
 * already exposes — read inside the clinic's tenant so the agent config row
 * (RLS forced) is visible and the read is audited.
 */
export type OnboardingView = {
  clinic: {
    id: string;
    slug: string;
    name: string;
    specialty: string;
    timezone: string;
    dataClassification: "synthetic" | "production";
    attributionMode: "estimated" | "verified";
    isCoveredEntity: boolean | null;
    phoneSystemType: "landline" | "voip" | "unknown";
    callRouting: "conditional" | "always";
    callRoutingConfirmedAt: string | null;
    carrier: string | null;
    synthflowNumberE164: string | null;
    publishedPhoneE164: string | null;
    openingHoursPresent: boolean;
    wentLiveAt: string | null;
  };
  steps: { id: string; title: string; why: string; required: boolean; completedAt: string | null }[];
  /** The forwarding test: an open window, or what the last one saw. */
  forwardingTest: {
    windowUntil: string | null;
    observed: { arrivedAt: string; callerIdPreserved: boolean; condition: string } | null;
  };
  /** Stripe Connect for deposits: linked, or the link to do it, or neither. */
  stripeConnect: { accountId: string | null; connectedAt: string | null; authorizeUrl: string | null };
  /** The Meta front door: the per-clinic switch and the channels attached. */
  meta: {
    enabled: boolean;
    /**
     * The clinic's own switch for each platform (Settings), beneath the front
     * door: both must be on for a message to be answered. Three flags.
     */
    platforms: Record<MetaPlatform, boolean>;
    channels: { platform: MetaPlatform; externalId: string; label: string | null; status: string }[];
    /** Last 30 days, counts only; the requests live behind the desk's single-use link. */
    bookingRequests: { waiting: number; accepted: number; confirmed: number; declined: number };
  };
  forwarding: ForwardingInstruction | null;
  agent: {
    version: number;
    greeting: string;
    services: unknown[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
    depositPolicy: { required: boolean; amountUsd: number | null; collection: "front_desk" | "stripe_connect" } | null;
    approvedAt: string | null;
    approvedByLabel: string | null;
  } | null;
  goLive: { ok: true } | { ok: false; missing: string[] };
  /** §H.5: the booking requirement set — resolved ids (locked ones included), who settled it, when. */
  requirements: {
    fields: string[];
    confirmedAt: string | null;
    source: "practice" | "operator" | "defaults" | null;
    /** True while an unspent, unexpired setup link exists. */
    setupLinkOutstanding: boolean;
    /** The closed catalogue, so the console renders the same checkboxes the practice saw. */
    catalogue: { id: string; label: string; locked: boolean; phoneOnly: boolean }[];
    neverAsked: string[];
  };
  /** The clinic's zone and whether anyone confirmed it, or it is still the provisioning default. */
  timezoneConfirmedAt: string | null;
  timezone: string;
  /** §B.4: every appointment with a calendar write attempted. No name, phone or service. */
  calendarWrites: CalendarWriteRow[];
  /**
   * Plan §10: the booking mode and every reason for it, Auto-confirm, the
   * kill switch, the calendar terms and the Google Calendar connection, the
   * only account of booking the console gets. The direct-booking addendum's
   * keys (`bookingMode`, `directBooking*`) and the vendor connection's PHI
   * basis (`calendarConnection`) went in plan C17: the mode is derived, and
   * nothing they described decides it any more.
   */
  booking: BookingProjection;
};

export type CalendarWriteRow = {
  appointmentId: string;
  slotAt: string;
  status: "writing" | "written" | "failed" | "unknown";
  error: string | null;
  requestChannel: "voice" | "meta";
};

function stepsView(state: OnboardingState) {
  return ONBOARDING_STEPS.map((id) => ({
    id,
    title: ONBOARDING_LABELS[id].title,
    why: ONBOARDING_LABELS[id].why,
    required: ONBOARDING_LABELS[id].required,
    completedAt: state[id] ?? null,
  }));
}

export async function clinicById(clinicId: string | undefined) {
  if (!clinicId || !UUID_SHAPED.test(clinicId)) return undefined;
  return (await listClinicOverviews()).find((c) => c.id === clinicId);
}

async function opGetOnboarding(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");

  const { agent, metaChannels, metaPlatforms, bookingRequests, booking, bookingView } = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      tx.audit.record({ action: "read", resourceType: "agent_config", resourceId: tx.clinicId });
      const connections = await listConnections(tx.db, tx.clinicId);
      return {
        agent: await getAgentConfig(tx),
        metaPlatforms: await readMetaPlatformSwitches(tx.db, tx.clinicId),
        bookingRequests: await bookingRequestCounts(tx),
        booking: await readBookingState(tx),
        bookingView: await readBookingProjection(tx, clinic.timezone),
        metaChannels: connections
          .filter((c) => c.provider.startsWith("meta-"))
          .map((c) => {
            const meta = (c.metadata ?? {}) as { externalId?: unknown; label?: unknown };
            const platform = (Object.keys(META_PROVIDERS) as MetaPlatform[]).find((p) => META_PROVIDERS[p] === c.provider) ?? "messenger";
            return {
              platform,
              externalId: typeof meta.externalId === "string" ? meta.externalId : "",
              label: typeof meta.label === "string" ? meta.label : null,
              status: c.status,
            };
          }),
      };
    },
  );

  const view: OnboardingView = {
    clinic: {
      id: clinic.id,
      slug: clinic.slug,
      name: clinic.name,
      specialty: clinic.specialty,
      timezone: clinic.timezone,
      dataClassification: clinic.dataClassification,
      attributionMode: clinic.attributionMode,
      isCoveredEntity: clinic.isCoveredEntity,
      phoneSystemType: clinic.phoneSystemType,
      callRouting: clinic.callRouting,
      callRoutingConfirmedAt: clinic.callRoutingConfirmedAt?.toISOString() ?? null,
      carrier: clinic.carrier,
      synthflowNumberE164: clinic.synthflowNumberE164,
      publishedPhoneE164: clinic.publishedPhoneE164,
      openingHoursPresent: clinic.openingHoursPresent,
      wentLiveAt: clinic.wentLiveAt?.toISOString() ?? null,
    },
    steps: stepsView(clinic.onboarding),
    forwardingTest: {
      windowUntil:
        clinic.forwardingTestUntil && clinic.forwardingTestUntil.getTime() > Date.now()
          ? clinic.forwardingTestUntil.toISOString()
          : null,
      observed: clinic.forwardingTestObserved
        ? {
            arrivedAt: clinic.forwardingTestObserved.arrivedAt,
            callerIdPreserved: clinic.forwardingTestObserved.callerIdPreserved,
            condition: clinic.forwardingTestObserved.condition,
          }
        : null,
    },
    stripeConnect: {
      accountId: clinic.stripeConnectAccountId,
      connectedAt: clinic.stripeConnectConnectedAt?.toISOString() ?? null,
      authorizeUrl: null,
    },
    // Counts only. The requests themselves live behind the desk's link.
    meta: { enabled: clinic.metaFrontDoorEnabled, platforms: metaPlatforms, channels: metaChannels, bookingRequests },
    forwarding: clinic.synthflowNumberE164
      ? forwardingInstructions({
          carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
          phoneSystemType: clinic.phoneSystemType,
          routing: clinic.callRouting,
          destinationE164: clinic.synthflowNumberE164,
        })
      : null,
    agent: agent
      ? {
          version: agent.version,
          greeting: agent.greeting,
          services: agent.services,
          escalationPhone: agent.escalationPhone,
          escalationHours: agent.escalationHours,
          notes: agent.notes,
          depositPolicy: agent.depositPolicy ?? null,
          approvedAt: agent.approvedAt?.toISOString() ?? null,
          approvedByLabel: agent.approvedByLabel,
        }
      : null,
    goLive: goLivePreconditions(clinic),
    requirements: {
      fields: resolveBookingRequirements(clinic.specialty, clinic.bookingRequirements).map((f) => f.id),
      confirmedAt: clinic.bookingRequirementsConfirmedAt?.toISOString() ?? null,
      source: clinic.bookingRequirementsSource,
      setupLinkOutstanding: booking.setupLinkOutstanding,
      catalogue: BOOKING_FIELDS.map((f) => ({ id: f.id, label: f.label, locked: f.locked, phoneOnly: !f.metaEligible })),
      neverAsked: [...EXCLUDED_FIELDS],
    },
    timezoneConfirmedAt: clinic.timezoneConfirmedAt?.toISOString() ?? null,
    timezone: clinic.timezone,
    calendarWrites: booking.calendarWrites,
    booking: bookingView,
  };
  return ok(view);
}

/**
 * The booking-side state of one clinic, read inside the tenant transaction
 * opGetOnboarding already opens (§A.14): whether a setup link is out, and
 * the calendar-write ledger. The booking mode and the calendar are
 * readBookingProjection's (lib/ops/calendar-ops.ts).
 *
 * Nothing here is a patient. The calendar rows carry an appointment id, a
 * slot, a status and a short vendor status; tests/ops.test.ts asserts that
 * no `firstName` or `phone` key ever appears in this reply.
 */
async function readBookingState(tx: TenantTx) {
  const [outstanding] = await tx.db
    .select({ id: connectionLinks.id })
    .from(connectionLinks)
    .where(and(eq(connectionLinks.purpose, "setup"), isNull(connectionLinks.usedAt), gt(connectionLinks.expiresAt, sql`now()`)))
    .limit(1);

  return {
    setupLinkOutstanding: Boolean(outstanding),
    calendarWrites: await listCalendarWritesWithin(tx),
  };
}

const CALENDAR_WRITE_ROWS = 40;

/** §B.4's console projection: appointment id, slot, status, short error, channel. Never a name, phone or service. */
async function listCalendarWritesWithin(tx: TenantTx): Promise<CalendarWriteRow[]> {
  const rows = await tx.db
    .select({
      appointmentId: appointments.id,
      slotAt: appointments.scheduledFor,
      status: appointments.calendarWriteStatus,
      error: appointments.calendarWriteError,
      requestChannel: bookingRequests.channel,
    })
    .from(appointments)
    .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
    .where(and(eq(appointments.clinicId, tx.clinicId), ne(appointments.calendarWriteStatus, "none")))
    .orderBy(desc(appointments.scheduledFor))
    .limit(CALENDAR_WRITE_ROWS);
  return rows.map((row) => ({
    appointmentId: row.appointmentId,
    slotAt: row.slotAt.toISOString(),
    status: row.status as CalendarWriteRow["status"],
    error: row.error ? row.error.slice(0, 200) : null,
    requestChannel: row.requestChannel,
  }));
}

export type OnboardingMutationState =
  | { status: "updated"; steps: OnboardingView["steps"]; auditRecorded: boolean }
  | { status: "error"; message: string };

async function opCompleteOnboardingStep(
  args: Record<string, unknown>,
  operator: Operator,
  reopen: boolean,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  const step = stringArg(args, "step", 64);
  const note = stringArg(args, "note", 200);
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies OnboardingMutationState);
  if (!isOnboardingStep(step)) {
    return ok({ status: "error", message: "Unknown onboarding step." } satisfies OnboardingMutationState);
  }
  const state = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) =>
      reopen
        ? reopenStep(tx, step, note ?? "reopened by operator")
        : completeStep(tx, step, { note }),
  );
  const auditRecorded = await audit(operator, reopen ? "onboarding_step_reopened" : "onboarding_step_completed", {
    clinicSlug: clinic.slug,
    step,
  });
  return ok({ status: "updated", steps: stepsView(state), auditRecorded } satisfies OnboardingMutationState);
}

export type PhoneSettingsState =
  | { status: "updated"; auditRecorded: boolean }
  | { status: "error"; message: string };

async function opSetPhoneSettings(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies PhoneSettingsState);

  const phoneSystemType = stringArg(args, "phoneSystemType", 16);
  const callRouting = stringArg(args, "callRouting", 16);
  const carrier = args.carrier === null ? null : stringArg(args, "carrier", 32);
  const synthflowNumberE164 =
    args.synthflowNumberE164 === null ? null : stringArg(args, "synthflowNumberE164", 20);
  const publishedPhoneE164 =
    args.publishedPhoneE164 === null ? null : stringArg(args, "publishedPhoneE164", 20);

  if (phoneSystemType !== undefined && !["landline", "voip", "unknown"].includes(phoneSystemType)) {
    return ok({ status: "error", message: "Unknown phone system type." } satisfies PhoneSettingsState);
  }
  if (callRouting !== undefined && !["conditional", "always"].includes(callRouting)) {
    return ok({ status: "error", message: "Unknown call routing." } satisfies PhoneSettingsState);
  }
  if (carrier !== undefined && carrier !== null && !isCarrier(carrier)) {
    return ok({ status: "error", message: "Unknown carrier." } satisfies PhoneSettingsState);
  }

  try {
    await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) =>
        setPhoneSettings(tx, {
          phoneSystemType: phoneSystemType as "landline" | "voip" | "unknown" | undefined,
          callRouting: callRouting as "conditional" | "always" | undefined,
          carrier: carrier as never,
          synthflowNumberE164,
          publishedPhoneE164,
        }),
    );
  } catch (error) {
    return ok({
      status: "error",
      message: error instanceof Error ? error.message : "Could not save.",
    } satisfies PhoneSettingsState);
  }
  const auditRecorded = await audit(operator, "clinic_phone_updated", {
    clinicSlug: clinic.slug,
    callRouting,
    phoneSystemType,
  });
  return ok({ status: "updated", auditRecorded } satisfies PhoneSettingsState);
}

export type AgentConfigState =
  | { status: "updated"; version: number; approvedAt: string | null; auditRecorded: boolean }
  | { status: "error"; message: string };

function readAgentInput(args: Record<string, unknown>, specialty: string): AgentConfigInput | string {
  const greeting = stringArg(args, "greeting", 600);
  if (!greeting) return "The greeting is required.";
  const rawServices = Array.isArray(args.services) ? args.services : [];
  // Prices to the cent, as the wizard stores them ("$14.50 per pulse"):
  // rounding to whole dollars rewrote the clinic's own prices on every save.
  const dollars = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? toCents(v) : null);
  const minutes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const services = rawServices.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const depositNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      name: typeof r.name === "string" ? r.name.trim().slice(0, 120) : "",
      priceFromUsd: dollars(r.priceFromUsd),
      priceToUsd: dollars(r.priceToUsd),
      durationMinutes: minutes(r.durationMinutes),
      // What the wizard and Knowledge add to a service (0056), which the
      // console carries and does not edit. Kept as sent; left out or
      // malformed, it stays undefined and updateAgentConfig takes the stored
      // service's own (lib/setup/prices.ts).
      priceKind: r.priceKind === null ? null : isServicePriceKind(r.priceKind) ? r.priceKind : undefined,
      unit:
        r.unit === null
          ? null
          : typeof r.unit === "string"
            ? cleanProfileText(r.unit, CLINIC_PROFILE_LIMITS.unit) || null
            : undefined,
      // Carried through, or every operator save would wipe the per-service
      // deposits (BD27); validateAgentConfig checks the range. Left out, it
      // stays out, and updateAgentConfig takes the stored service's own.
      ...(r.depositUsd === undefined ? {} : { depositUsd: depositNum(r.depositUsd) }),
    };
  });
  // A unit is words AYA says ("$14.50 per pulse"), screened as the wizard
  // screens it: by the specialty's own rule for its menu.
  const units = findClinicalContent(
    Object.fromEntries(services.flatMap((s, i) => (s.unit ? [[`services[${i}].unit`, `per ${s.unit}`]] : []))),
    serviceNameScreen(isSpecialtyId(specialty) ? specialty : null),
  );
  if (units.length > 0) {
    return `A service's unit mentions ${units[0]!.label} ("${units[0]!.excerpt}"). Name it the way the menu does.`;
  }
  return {
    greeting,
    services,
    escalationPhone: stringArg(args, "escalationPhone", 20) ?? null,
    escalationHours: stringArg(args, "escalationHours", 200) ?? null,
    notes: stringArg(args, "notes", 1000) ?? null,
    depositPolicy: readDepositPolicy(args.depositPolicy),
  };
}

function readDepositPolicy(raw: unknown): AgentConfigInput["depositPolicy"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.required !== true) return null;
  const amount = typeof r.amountUsd === "number" && Number.isFinite(r.amountUsd) ? Math.round(r.amountUsd) : null;
  return {
    required: true,
    amountUsd: amount,
    collection: r.collection === "stripe_connect" ? "stripe_connect" : "front_desk",
  };
}

async function opUpdateAgentConfig(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies AgentConfigState);
  const input = readAgentInput(args, clinic.specialty);
  if (typeof input === "string") return ok({ status: "error", message: input } satisfies AgentConfigState);

  try {
    const row = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => updateAgentConfig(tx, input),
    );
    const auditRecorded = await audit(operator, "agent_config_updated", {
      clinicSlug: clinic.slug,
      version: row.version,
    });
    return ok({
      status: "updated",
      version: row.version,
      approvedAt: null,
      auditRecorded,
    } satisfies AgentConfigState);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      return ok({ status: "error", message: error.message } satisfies AgentConfigState);
    }
    throw error;
  }
}

async function opApproveAgentConfig(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  const approvedBy = stringArg(args, "approvedBy", 200);
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies AgentConfigState);
  if (!approvedBy) {
    return ok({
      status: "error",
      message: "Name who at the clinic approved the script.",
    } satisfies AgentConfigState);
  }
  try {
    const row = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => approveAgentConfig(tx, `${approvedBy} (recorded by ${operator.email})`),
    );
    const auditRecorded = await audit(operator, "agent_config_approved", {
      clinicSlug: clinic.slug,
      version: row.version,
    });
    return ok({
      status: "updated",
      version: row.version,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      auditRecorded,
    } satisfies AgentConfigState);
  } catch (error) {
    if (error instanceof AgentConfigError) {
      return ok({ status: "error", message: error.message } satisfies AgentConfigState);
    }
    throw error;
  }
}

export type GoLiveState =
  | { status: "live"; baaSignedOn: string }
  | { status: "refused"; message: string; missing: string[] }
  | { status: "error"; message: string };

async function opGoLive(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId");
  if (!clinicId || !UUID_SHAPED.test(clinicId)) {
    return ok({ status: "error", message: "That is not a clinic id." } satisfies GoLiveState);
  }
  // A demo clinic is healdesk's own fictional practice (scripts/demo-clinic.ts,
  // owner decision Q6), under an agreement the operator signed for it, on
  // which draft calendar terms count. It never handles a real patient, so it
  // never goes live: the flip would put a fictional signature behind a
  // production clinic. Asked before anything else is touched, and of the
  // database's own marker (app_clinic_is_demo), which is false for any clinic
  // with a Stripe id.
  const demo = await withTenant(
    { clinicId, actor: actorFor(operator), request: operator.request },
    (tx) => isDemoClinic(tx),
  );
  if (demo) {
    return ok({
      status: "refused",
      message: "This is a demo clinic, and a demo clinic never goes live.",
      missing: [
        "A demo clinic is healdesk's own fictional practice and never handles a real patient. Provision the real practice through checkout instead.",
      ],
    } satisfies GoLiveState);
  }
  // §H.5, "whichever comes first": a setup link that expired unspent has the
  // specialty defaults stamped now rather than at the next hourly tick, so
  // the operator on the call is not blocked by a step nobody can answer. The
  // same rule as the tick — an outstanding link, or a clinic with no link
  // inside its fourteen-day grace, still leaves the step open and go-live
  // refuses as before. Never fatal: go-live judges the row as it finds it.
  try {
    await applyBookingRequirementDefaultsFor(clinicId);
  } catch (error) {
    log.warn("ops api: could not apply booking requirement defaults before go-live", {
      clinicId,
      error: error instanceof Error ? error.name : "unknown error",
    });
  }
  const result = await goLive(clinicId, {
    label: operator.email,
    ipAddress: operator.request.ipAddress,
    userAgent: operator.request.userAgent,
  });
  switch (result.status) {
    case "live":
      return ok({ status: "live", baaSignedOn: asDate(result.baaSignedAt) } satisfies GoLiveState);
    case "refused":
      return ok({ status: "refused", message: result.reason, missing: result.missing } satisfies GoLiveState);
    case "not_found":
      return ok({ status: "error", message: "No such clinic." } satisfies GoLiveState);
  }
}


// -----------------------------------------------------------------------------
// Care: recipients, deliveries, incidents, offboarding
// -----------------------------------------------------------------------------

/**
 * One clinic's care view: who gets its mail, what was sent, what went wrong,
 * and where it is on the way out. Configuration and ledgers, never a patient.
 * An incident's summary is written by the operator and PHI-scanned on the
 * way in (see opOpenIncident) so this view cannot carry one by accident.
 */
export type CareView = {
  clinic: {
    id: string;
    slug: string;
    name: string;
    dataClassification: "synthetic" | "production";
    isCoveredEntity: boolean | null;
    wentLiveAt: string | null;
    offboardingStartedAt: string | null;
    exportDeliveredAt: string | null;
    destroyAfter: string | null;
    destroyedAt: string | null;
    /**
     * The destruction plan by the agreement the service ended under
     * (destructionPlan in lib/offboarding), or null while the clinic is not
     * offboarding. ISO instants, and the rule's name; contract metadata.
     */
    destruction: {
      rule: DestructionRule;
      basis: DestructionBasis;
      agreementVersion: string | null;
      exportDueBy: string;
      destroyDueAt: string;
      latestDestroyAt: string;
    } | null;
    /**
     * The operator step at the voice vendor: the clinic's calls and agent
     * deleted at Retell by the time its data is destroyed here (destroyDueAt),
     * outstanding until recorded. Null while the clinic is not offboarding.
     */
    voiceVendorDeletion: {
      deadline: string;
      recordedAt: string | null;
      recordedBy: string | null;
      how: string | null;
    } | null;
  };
  /**
   * The clinic's deletion requests (lib/patient-rights/erasure.ts), newest
   * first: who asked (one of three, as the console says it), the dates, the counts and each
   * subcontractor step, outstanding until stamped, with the deadline. Never a
   * number, an address or a reference to one.
   */
  /**
   * How many amendments the practice has directed at this clinic, and how
   * many contact corrections: counts only. Both are entered in apps/app's
   * shell (lib/ops/patient-entry.ts), never here.
   */
  patientRights: { amendments: number; corrections: number };
  deletionRequests: {
    id: string;
    requestedBy: string;
    receivedAt: string;
    dueBy: string;
    erasedAt: string;
    deleted: Record<string, number>;
    /** When the record's restore references are emptied; null once they have been. */
    restoreRecordUntil: string | null;
    /** `how` is the closed outcome's label (ERASURE_STEP_OUTCOMES), never typed text. */
    steps: { id: string; label: string; stampedAt: string | null; stampedBy: string | null; how: string | null }[];
  }[];
  recipients: { email: string; label: string | null; addedBy: string; addedAt: string }[];
  deliveries: {
    kind: string;
    periodKey: string;
    recipient: string;
    status: string;
    reason: string | null;
    attemptedAt: string;
  }[];
  incidents: {
    id: string;
    class: IncidentClass;
    summary: string;
    conversationId: string | null;
    discoveredAt: string;
    notifyBy: string;
    ftcNotifyBy: string | null;
    notifiedAt: string | null;
    notifiedHow: string | null;
    resolvedAt: string | null;
    resolution: string | null;
    openedBy: string;
  }[];
};

const DELIVERY_ROWS = 40;

async function opGetClinicCare(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const plan = destructionPlan(clinic);
  const vendorDeletion = plan ? await voiceVendorDeletionOf(clinic.id) : null;

  const view = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx): Promise<CareView> => {
      const recipients = await listRecipients(tx);
      const deliveries = await tx.db
        .select()
        .from(reportDeliveries)
        .where(eq(reportDeliveries.clinicId, tx.clinicId))
        .orderBy(desc(reportDeliveries.attemptedAt))
        .limit(DELIVERY_ROWS);
      const incidents = await listIncidents(tx);
      tx.audit.record({ action: "read", resourceType: "incident", resultCount: incidents.length, metadata: { purpose: "care_view" } });
      const deletionRequests = await listErasureRequests(tx);
      const [amendmentCount] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(recordAmendments)
        .where(eq(recordAmendments.clinicId, tx.clinicId));
      const [correctionCount] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(eq(auditLog.clinicId, tx.clinicId), eq(auditLog.resourceType, "contact_amendment")));
      return {
        clinic: {
          id: clinic.id,
          slug: clinic.slug,
          name: clinic.name,
          dataClassification: clinic.dataClassification,
          isCoveredEntity: clinic.isCoveredEntity,
          wentLiveAt: clinic.wentLiveAt?.toISOString() ?? null,
          offboardingStartedAt: clinic.offboardingStartedAt?.toISOString() ?? null,
          exportDeliveredAt: clinic.exportDeliveredAt?.toISOString() ?? null,
          destroyAfter: clinic.destroyAfter?.toISOString() ?? null,
          destroyedAt: clinic.destroyedAt?.toISOString() ?? null,
          destruction: plan
            ? {
                rule: plan.rule,
                basis: plan.basis,
                agreementVersion: plan.agreementVersion,
                exportDueBy: plan.exportDueBy.toISOString(),
                destroyDueAt: plan.destroyDueAt.toISOString(),
                latestDestroyAt: plan.latestDestroyAt.toISOString(),
              }
            : null,
          voiceVendorDeletion: plan
            ? {
                deadline: plan.destroyDueAt.toISOString(),
                recordedAt: vendorDeletion?.recordedAt.toISOString() ?? null,
                recordedBy: vendorDeletion?.recordedBy ?? null,
                how: vendorDeletion?.how ?? null,
              }
            : null,
        },
        patientRights: { amendments: amendmentCount?.n ?? 0, corrections: correctionCount?.n ?? 0 },
        deletionRequests: deletionRequests.map((d) => ({
          id: d.id,
          requestedBy: d.requestedBy,
          receivedAt: d.receivedAt.toISOString(),
          dueBy: d.dueBy.toISOString(),
          erasedAt: d.erasedAt.toISOString(),
          deleted: d.deleted,
          restoreRecordUntil: d.restoreRecordUntil?.toISOString() ?? null,
          steps: d.steps.map((step) => ({
            id: step.id,
            label: step.label,
            stampedAt: step.stamp?.at ?? null,
            stampedBy: step.stamp?.by ?? null,
            how: step.stamp ? (isErasureStepOutcome(step.stamp.how) ? ERASURE_STEP_OUTCOMES[step.stamp.how] : "Recorded") : null,
          })),
        })),
        recipients: recipients.map((r) => ({
          email: r.email,
          label: r.label,
          addedBy: r.addedBy,
          addedAt: r.createdAt.toISOString(),
        })),
        deliveries: deliveries.map((d) => ({
          kind: d.kind,
          periodKey: d.periodKey,
          recipient: d.recipient,
          status: d.status,
          reason: d.reason,
          attemptedAt: d.attemptedAt.toISOString(),
        })),
        incidents: incidents
          .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())
          .map((i) => ({
            id: i.id,
            class: i.class,
            summary: i.summary,
            conversationId: i.conversationId,
            discoveredAt: i.discoveredAt.toISOString(),
            notifyBy: i.notifyBy.toISOString(),
            ftcNotifyBy: i.ftcNotifyBy?.toISOString() ?? null,
            notifiedAt: i.notifiedAt?.toISOString() ?? null,
            notifiedHow: i.notifiedHow,
            resolvedAt: i.resolvedAt?.toISOString() ?? null,
            resolution: i.resolution,
            openedBy: i.openedBy,
          })),
      };
    },
  );
  return ok(view);
}

export type CareOutcome = { status: "updated" } | { status: "error"; message: string };

const care = {
  updated: () => ok({ status: "updated" } satisfies CareOutcome),
  error: (message: string) => ok({ status: "error", message } satisfies CareOutcome),
};

async function opAddReportRecipient(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const email = stringArg(args, "email", 254)?.toLowerCase();
  if (!email || !isSendableAddress(email)) return care.error("That is not an email address we can send to.");
  const label = stringArg(args, "label", 120) ?? undefined;
  await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => addRecipient(tx, { email, label, addedBy: operator.email }),
  );
  await audit(operator, "report_recipient_added", { clinicSlug: clinic.slug });
  return care.updated();
}

async function opRemoveReportRecipient(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const email = stringArg(args, "email", 254);
  if (!email) return care.error("Which address?");
  const removed = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => removeRecipient(tx, email, "removed from the ops console"),
  );
  if (!removed) return care.error("That address is not on the list.");
  await audit(operator, "report_recipient_removed", { clinicSlug: clinic.slug });
  return care.updated();
}

const INCIDENT_CLASSES: readonly IncidentClass[] = [
  "security_incident",
  "improper_use_or_disclosure",
  "breach",
  "service_complaint",
];

/**
 * The summary is prose an operator typed under pressure, and it is the one
 * field on this page that could carry a patient by accident. It goes through
 * the same scanner the audit log uses: a phone number, an email address or a
 * denylisted word refuses the whole incident with the reason, and the
 * operator rewrites it in ids. A conversation id is the pointer to the
 * evidence; the transcript is never the summary.
 *
 * `scanKey` is the key the value is scanned under, when the operator's word
 * for the field is itself on the guard's denylist. "note" is: scanned as
 * `{ note }`, every note was refused as a "PHI-shaped field name" whatever
 * it said (F1). Such a field is scanned, and recorded, as `remark`, the key
 * the rest of the codebase uses for operator prose (lib/onboarding/steps.ts).
 */
function incidentText(
  value: string | undefined,
  field: string,
  scanKey: string = field,
): string | { error: string } {
  if (!value) return { error: `${field} is required.` };
  try {
    assertNoPhi({ [scanKey]: value }, scanKey);
    return value;
  } catch (error) {
    if (error instanceof PhiInAuditError) {
      return { error: `The ${field} looks like it carries patient details (${error.message}). Describe the event in ids and counts; the conversation id points to the evidence.` };
    }
    throw error;
  }
}

export type OpenIncidentOutcome =
  | { status: "opened"; id: string; notifyBy: string; ftcNotifyBy: string | null }
  | { status: "error"; message: string };

async function opOpenIncident(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies OpenIncidentOutcome);
  const cls = stringArg(args, "class", 40);
  if (!cls || !INCIDENT_CLASSES.includes(cls as IncidentClass)) {
    return ok({ status: "error", message: "Pick one of the four incident classes." } satisfies OpenIncidentOutcome);
  }
  const summary = incidentText(stringArg(args, "summary", 2000), "summary");
  if (typeof summary !== "string") return ok({ status: "error", message: summary.error } satisfies OpenIncidentOutcome);
  const conversationId = stringArg(args, "conversationId");
  if (conversationId && !UUID_SHAPED.test(conversationId)) {
    return ok({ status: "error", message: "The conversation id is not an id." } satisfies OpenIncidentOutcome);
  }
  const discoveredRaw = stringArg(args, "discoveredAt", 40);
  const discoveredAt = discoveredRaw ? new Date(discoveredRaw) : new Date();
  if (Number.isNaN(discoveredAt.getTime()) || discoveredAt.getTime() > Date.now() + 60_000) {
    return ok({ status: "error", message: "When was it discovered? A past date and time." } satisfies OpenIncidentOutcome);
  }

  const row = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) =>
      openIncident(tx, {
        class: cls as IncidentClass,
        summary,
        conversationId: conversationId ?? null,
        discoveredAt,
        openedBy: operator.email,
        isCoveredEntity: clinic.isCoveredEntity,
      }),
  );
  await audit(operator, "incident_opened", { clinicSlug: clinic.slug, class: cls, incidentId: row.id });
  return ok({
    status: "opened",
    id: row.id,
    notifyBy: row.notifyBy.toISOString(),
    ftcNotifyBy: row.ftcNotifyBy?.toISOString() ?? null,
  } satisfies OpenIncidentOutcome);
}

async function opMarkIncidentNotified(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const id = stringArg(args, "incidentId");
  if (!id || !UUID_SHAPED.test(id)) return care.error("Which incident?");
  const how = incidentText(stringArg(args, "how", 500), "how");
  if (typeof how !== "string") return care.error(how.error);
  const row = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => markNotified(tx, id, `${how} (recorded by ${operator.email})`),
  );
  if (!row) return care.error("No such incident at this clinic.");
  await audit(operator, "incident_clinic_notified", { clinicSlug: clinic.slug, incidentId: id });
  return care.updated();
}

async function opResolveIncident(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const id = stringArg(args, "incidentId");
  if (!id || !UUID_SHAPED.test(id)) return care.error("Which incident?");
  const resolution = incidentText(stringArg(args, "resolution", 2000), "resolution");
  if (typeof resolution !== "string") return care.error(resolution.error);
  const row = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => resolveIncident(tx, id, `${resolution} (resolved by ${operator.email})`),
  );
  if (!row) return care.error("No open incident with that id at this clinic.");
  await audit(operator, "incident_resolved", { clinicSlug: clinic.slug, incidentId: id });
  return care.updated();
}

async function opStartOffboarding(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  if (clinic.destroyedAt) return care.error("This clinic's data has already been destroyed.");
  const reason = incidentText(stringArg(args, "reason", 300), "reason");
  if (typeof reason !== "string") return care.error(reason.error);
  // The setup closure's reason belongs to Package C's deletion handler: on it,
  // startOffboarding queues the clinic's "your account has closed" email
  // (lib/setup/closure-email.ts), once per clinic. Typed here it would send
  // that with nothing cancelled, and hold back the real one later.
  if (reason.toLowerCase() === SETUP_CLOSURE_REASON) {
    return care.error(
      `"${SETUP_CLOSURE_REASON}" is kept for the setup window's own closure, which emails the clinic that its account has closed. To close an unfinished setup, use Billing's "Close the unfinished setup". Here, say why the clinic is leaving.`,
    );
  }
  await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => startOffboarding(tx, reason),
  );
  await audit(operator, "offboarding_started", { clinicSlug: clinic.slug });
  // Google access ends when offboarding starts, not at destruction (owner,
  // Q7): the calendar is disconnected and its grant revoked when unused.
  await sweepCalendarTerms([clinic.id], { actor: actorFor(operator) });
  return care.updated();
}

/**
 * The operator's record that the export reached the practice: what
 * "delivered" means on this path. It refuses until a whole-clinic bundle has
 * been produced since offboarding started (exportClinic writes the audit row
 * it looks for), so a delivery cannot be recorded for an export nobody made,
 * and producing one records nothing: the operator hands it over, then
 * records how. The stamp is the database's, at this moment
 * (app_mark_export_delivered).
 */
async function opMarkExportDelivered(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const startedAt = clinic.offboardingStartedAt;
  if (!startedAt) return care.error("Start offboarding first; the export is part of leaving.");
  if (clinic.destroyedAt) return care.error("This clinic's data has already been destroyed.");
  if (clinic.exportDeliveredAt) return care.error(`The export was recorded as delivered on ${asDate(clinic.exportDeliveredAt)}.`);
  const how = incidentText(stringArg(args, "how", 200), "how");
  if (typeof how !== "string") return care.error(how.error);
  const delivered = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const [produced] = await tx.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.clinicId, tx.clinicId),
            eq(auditLog.action, "export"),
            eq(auditLog.resourceType, "clinic_bundle"),
            gt(auditLog.occurredAt, startedAt),
          ),
        )
        .limit(1);
      if (!produced) return false;
      await markExportDelivered(tx, how);
      return true;
    },
  );
  if (!delivered) {
    return care.error(
      "No return bundle has been produced since offboarding started. Produce it in AWS CloudShell (bash run-task.sh patient-export <clinic id>), hand it over, then record the handover here.",
    );
  }
  await audit(operator, "offboarding_export_delivered", { clinicSlug: clinic.slug });
  return care.updated();
}

/**
 * The operator's record that the clinic's calls and agent were deleted at the
 * voice vendor (Retell), in the vendor's console: nothing in apps/app talks
 * to the vendor yet. The care view shows the step outstanding, with its
 * deadline, until this is recorded; it is recorded once, as a security event
 * naming the operator (recordVoiceVendorDeletion in lib/offboarding).
 */
async function opMarkVoiceVendorDataDeleted(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  if (!clinic.offboardingStartedAt) return care.error("Start offboarding first; the vendor's copy goes on the way out.");
  const earlier = await voiceVendorDeletionOf(clinic.id);
  if (earlier) return care.error(`Already recorded on ${asDate(earlier.recordedAt)} by ${earlier.recordedBy}.`);
  const how = incidentText(stringArg(args, "how", 200), "how");
  if (typeof how !== "string") return care.error(how.error);
  await recordVoiceVendorDeletion({
    clinicId: clinic.id,
    clinicSlug: clinic.slug,
    how,
    actorLabel: operator.email,
    ipAddress: operator.request.ipAddress ?? null,
    userAgent: operator.request.userAgent ?? null,
  });
  return care.updated();
}

// -----------------------------------------------------------------------------
// Deletion on request: the subcontractor steps
// -----------------------------------------------------------------------------

/**
 * The operator's stamp that a subcontractor deleted what it held about the
 * person, in its own console. Once per step. How it went is one of a closed
 * set (ERASURE_STEP_OUTCOMES), never typed: the stamp outlives the person,
 * and a line typed here could name them. The deletion itself, and
 * amendments and corrections, are not operations of this envelope: they run
 * in apps/app's shell (lib/ops/patient-entry.ts), so no patient's identifier
 * or words cross apps/web.
 */
async function opMarkErasureVendorDeleted(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const erasureId = stringArg(args, "erasureId");
  if (!erasureId || !UUID_SHAPED.test(erasureId)) return care.error("Which deletion request?");
  const step = stringArg(args, "step", 40);
  if (!isErasureVendorStep(step)) return care.error("Which subcontractor step?");
  const how = stringArg(args, "how", 40);
  if (!isErasureStepOutcome(how)) {
    return care.error(`How did it go? One of: ${Object.keys(ERASURE_STEP_OUTCOMES).join(", ")}.`);
  }
  const outcome = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => stampErasureVendorStep(tx, { erasureId, step: step as ErasureVendorStepId, by: operator.email, how }),
  );
  if (outcome === "not_found") return care.error("No such deletion request at this clinic.");
  if (outcome === "already_stamped") return care.error("That step is already recorded.");
  await audit(operator, "erasure_vendor_step_recorded", { clinicSlug: clinic.slug, erasureId, step, how });
  return care.updated();
}

// -----------------------------------------------------------------------------
// Phase 8: forwarding test, first-weeks health, human touches
// -----------------------------------------------------------------------------

export type ForwardingTestOutcome = { status: "started"; windowUntil: string } | { status: "error"; message: string };

async function opStartForwardingTest(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies ForwardingTestOutcome);
  if (!clinic.synthflowNumberE164) {
    return ok({ status: "error", message: "Enter the Synthflow number first; there is nothing to forward to." } satisfies ForwardingTestOutcome);
  }
  if (!clinic.publishedPhoneE164) {
    return ok({
      status: "error",
      message: "Enter the clinic's own published number first; the test checks the caller ID against it.",
    } satisfies ForwardingTestOutcome);
  }
  const until = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => startForwardingTest(tx),
  );
  await audit(operator, "forwarding_test_started", { clinicSlug: clinic.slug });
  return ok({ status: "started", windowUntil: until.toISOString() } satisfies ForwardingTestOutcome);
}

async function opListClinicHealth(operator: Operator): Promise<OpsOutcome> {
  const rows: ClinicHealth[] = await clinicHealth(new Date(), { type: "service", serviceName: operator.email });
  return ok({ clinics: rows });
}

async function opRecordClinicTouch(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const kind = stringArg(args, "kind", 16);
  if (kind !== "call" && kind !== "email" && kind !== "note") return care.error("A touch is a call, an email or a note.");
  const summary = incidentText(stringArg(args, "summary", 2000), "summary");
  if (typeof summary !== "string") return care.error(summary.error);
  const outcomeRaw = stringArg(args, "outcome", 500);
  const outcome = outcomeRaw ? incidentText(outcomeRaw, "outcome") : null;
  if (outcome && typeof outcome !== "string") return care.error(outcome.error);
  await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => recordTouch(tx, { kind, summary, outcome: outcome as string | null, byLabel: operator.email }),
  );
  await audit(operator, "clinic_touch_recorded", { clinicSlug: clinic.slug, kind });
  return care.updated();
}


// -----------------------------------------------------------------------------
// The Meta front door
// -----------------------------------------------------------------------------

async function opAttachMetaChannel(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const platform = stringArg(args, "platform", 16);
  if (!isMetaPlatform(platform)) return care.error("The platform is messenger, instagram or whatsapp.");
  const externalId = stringArg(args, "externalId", 64);
  if (!externalId || !/^\d{5,32}$/.test(externalId)) {
    return care.error("The page id, Instagram account id or WhatsApp phone number id is a number.");
  }
  const accessToken = stringArg(args, "accessToken", 1024);
  if (!accessToken || accessToken.length < 20) return care.error("Paste the page or WhatsApp access token.");
  const label = stringArg(args, "label", 120);
  try {
    await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => attachMetaChannel(tx, { platform, externalId, accessToken, label }),
    );
  } catch (error) {
    if (error instanceof MetaAssetTakenError) return care.error(error.message);
    throw error;
  }
  await audit(operator, "meta_channel_attached", { clinicSlug: clinic.slug, platform });
  return care.updated();
}

async function opSetMetaFrontDoor(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const enabled = booleanArg(args, "enabled");
  if (enabled === undefined) return care.error("On or off?");
  if (enabled && clinic.dataClassification !== "production") {
    return care.error("Go live first: the front door answers real people.");
  }
  if (enabled && !clinic.publishedPhoneE164) {
    return care.error("Enter the clinic's published number first; the front door hands off to it.");
  }
  // BAA 1.3.0 release gate 19 (docs/counsel/agreement-changes.md §12.14):
  // the front door answers real people on Instagram, Messenger and
  // WhatsApp, so it goes on only for a clinic held to an agreement a
  // practice may sign: an acceptable BAA version or a released DPA. The
  // screen it rests on, every inbound message checked for clinical and
  // urgent content before the model (gate 4), runs unconditionally.
  if (enabled && !(clinic.baaVersion && agreementTemplateReleased(clinic.baaVersion))) {
    return care.error(
      "The clinic's agreement in effect must be a released version before the front door goes on.",
    );
  }
  await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => setMetaFrontDoor(tx, enabled),
  );
  await audit(operator, enabled ? "meta_front_door_enabled" : "meta_front_door_disabled", { clinicSlug: clinic.slug });
  return care.updated();
}

/**
 * One of the clinic's Instagram, Messenger and WhatsApp switches, as Settings
 * sets it and through the same writer (lib/channels/meta-platforms.ts), so
 * the Meta channel's own switch and its record follow exactly as they do for
 * the clinic. No release gate: the switch is beneath the front door, which
 * keeps them, and On answers nobody while the door is shut. The flip is
 * recorded under the console's name for itself, as Auto-confirm's is.
 */
async function opSetMetaPlatform(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return care.error("No such clinic.");
  const platform = stringArg(args, "platform");
  if (!isMetaPlatform(platform)) return care.error("Instagram, Messenger or WhatsApp?");
  const enabled = booleanArg(args, "enabled");
  if (enabled === undefined) return care.error("On or off?");
  const { changed } = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    (tx) => setMetaPlatformEnabled(tx, platform, enabled, OPS_SWITCH_LABEL),
  );
  if (changed) {
    await audit(operator, enabled ? "meta_platform_enabled" : "meta_platform_disabled", {
      clinicSlug: clinic.slug,
      platform,
    });
  }
  return care.updated();
}


// -----------------------------------------------------------------------------
// Booking hand-off and direct booking (design of 23 September 2026)
// -----------------------------------------------------------------------------

export type BookingRequirementsState =
  | { status: "updated"; fields: string[]; auditRecorded: boolean }
  | { status: "error"; message: string };

/** §H.5: the operator's override, `source = 'operator'`. Locked ids are kept whatever was sent. */
async function opSetBookingRequirements(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies BookingRequirementsState);
  const raw = args.fields;
  if (!Array.isArray(raw) || raw.length > 40 || raw.some((v) => typeof v !== "string")) {
    return ok({ status: "error", message: "fields is a list of catalogue ids." } satisfies BookingRequirementsState);
  }
  let fields: string[];
  try {
    fields = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => setBookingRequirementsWithin(tx, raw),
    );
  } catch (error) {
    return ok({ status: "error", message: error instanceof Error ? error.message : "Could not save." } satisfies BookingRequirementsState);
  }
  const auditRecorded = await audit(operator, "booking_requirements_set", { clinicSlug: clinic.slug, count: fields.length, source: "operator" });
  return ok({ status: "updated", fields, auditRecorded } satisfies BookingRequirementsState);
}

export type SwitchState = { status: "updated"; auditRecorded: boolean } | { status: "error"; message: string };

export type TimezoneState = { status: "updated"; timezone: string; auditRecorded: boolean } | { status: "error"; message: string };

/** An IANA zone the runtime's Intl data knows. "EST" and "UTC+5" are refused. */
export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,3}$|^UTC$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** §A.5: confirm the clinic's zone. Until stamped, `timezone` is the provisioning default, a guess rather than the clinic's answer. */
async function opSetClinicTimezone(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies TimezoneState);
  const timezone = stringArg(args, "timezone", 64);
  if (!timezone || !isIanaTimeZone(timezone)) {
    return ok({ status: "error", message: "That is not an IANA time zone (for example America/New_York)." } satisfies TimezoneState);
  }
  await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const now = new Date();
      const [before] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
      await tx.db.update(clinics).set({ timezone, timezoneConfirmedAt: now, updatedAt: now }).where(eq(clinics.id, tx.clinicId));
      // The setup window's last day stays the day the emails named, on the
      // clinic's corrected calendar (lib/setup/practice.ts).
      if (before) await moveSetupDeadlineToZone(tx, before.timezone, timezone, now);
      tx.audit.record({ action: "update", resourceType: "clinic_timezone", resourceId: tx.clinicId, metadata: { timezone, confirmed: true } });
    },
  );
  const auditRecorded = await audit(operator, "clinic_timezone_confirmed", { clinicSlug: clinic.slug, timezone });
  return ok({ status: "updated", timezone, auditRecorded } satisfies TimezoneState);
}

const PHI_BASES: readonly PhiBasis[] = ["vendor_baa", "practice_account"];

/**
 * §B.3: record the lawful basis on which a name, a service and a time may
 * reach a calendar vendor — its own BAA with us, or the practice's own
 * account under the practice's own agreement. NULL clears it, and a
 * connection with none is never written to. The note is PHI-scanned like an
 * incident summary: it is prose an operator typed.
 *
 * Refused for a Google Calendar connection (plan §4.8). What may reach a
 * location's Google Calendar is decided by its calendar terms, the signed
 * agreement and the practice's own elections (lib/booking/terms.ts), which
 * only the practice can change; a basis an operator typed onto the row
 * would be a second answer to the same question, and the legacy write path
 * reads exactly this column.
 */
async function opSetConnectionPhiBasis(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies SwitchState);
  const connectionId = stringArg(args, "connectionId");
  if (!connectionId || !UUID_SHAPED.test(connectionId)) return ok({ status: "error", message: "That is not a connection id." } satisfies SwitchState);
  const basisRaw = args.basis === null ? null : stringArg(args, "basis", 32);
  if (basisRaw !== null && !PHI_BASES.includes(basisRaw as PhiBasis)) {
    return ok({ status: "error", message: "The basis is vendor_baa, practice_account, or null to clear it." } satisfies SwitchState);
  }
  const basis = basisRaw as PhiBasis | null;
  const noteRaw = stringArg(args, "note", 500);
  const note = noteRaw ? incidentText(noteRaw, "note", "remark") : null;
  if (note && typeof note !== "string") return ok({ status: "error", message: note.error } satisfies SwitchState);
  const found = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const where = and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.clinicId, tx.clinicId),
      );
      const [current] = await tx.db
        .select({ provider: providerConnections.provider })
        .from(providerConnections)
        .where(where)
        .limit(1);
      if (!current) return null;
      if (current.provider === GOOGLE_CALENDAR_PROVIDER) return "calendar_terms" as const;
      const [row] = await tx.db
        .update(providerConnections)
        .set({ phiBasis: basis, updatedAt: new Date() })
        .where(and(where, ne(providerConnections.provider, GOOGLE_CALENDAR_PROVIDER)))
        .returning({ id: providerConnections.id, provider: providerConnections.provider });
      if (!row) return null;
      tx.audit.record({
        action: "update",
        resourceType: "provider_connection",
        resourceId: row.id,
        // `remark`, never `note`: the audit guard refuses a key named note
        // whatever its value, even null, and the throw rolled the basis back (F1).
        metadata: { provider: row.provider, phiBasis: basis, remark: note as string | null },
      });
      return row;
    },
  );
  if (!found) return ok({ status: "error", message: "No such connection on this clinic." } satisfies SwitchState);
  if (found === "calendar_terms") {
    return ok({
      status: "error",
      message:
        "A Google Calendar connection takes no PHI basis: what may reach it is decided by the location's calendar terms (its agreement and the practice's calendar elections). Nothing was changed.",
    } satisfies SwitchState);
  }
  const auditRecorded = await audit(operator, "connection_phi_basis_set", { clinicSlug: clinic.slug, provider: found.provider, phiBasis: basis });
  return ok({ status: "updated", auditRecorded } satisfies SwitchState);
}

/** §H.2: resend (or issue for the first time) the setup link. Same shape and same care as the connect link. */
async function opIssueSetupLink(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies IssueConnectLinkState);
  const to = stringArg(args, "to", MAX_EMAIL_LENGTH)?.toLowerCase();
  if (to !== undefined && !EMAIL_SHAPED.test(to)) {
    return ok({ status: "error", message: "That doesn't look like an email address." } satisfies IssueConnectLinkState);
  }
  const originProblem = publicOriginProblem();
  if (originProblem) return ok({ status: "error", message: originProblem } satisfies IssueConnectLinkState);
  const { token, expiresAt } = await issueConnectionLink(
    clinic.id,
    { purpose: "setup" },
    { actor: actorFor(operator), request: operator.request },
  );
  const url = publicUrl(`/setup/${token}`);
  let delivery: ConnectLinkDelivery = { attempted: false };
  if (to) {
    const result = await sendSetupLink({ to, clinicId: clinic.id, clinicName: clinic.name, specialty: clinic.specialty, url, expiresAt });
    delivery = result.status === "sent" ? { attempted: true, status: "sent" } : { attempted: true, status: result.status, reason: result.reason };
  }
  const auditRecorded = await audit(operator, "setup_link_issued", {
    clinicId: clinic.id,
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

export type RetryCalendarWriteState =
  | { status: "retried"; outcome: CalendarWriteOutcome; auditRecorded: boolean }
  | { status: "error"; message: string };

/** §B.4: re-run a calendar write from `failed` or `unknown`, read-back first (writeToCalendar does that). */
async function opRetryCalendarWrite(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return ok({ status: "error", message: "No such clinic." } satisfies RetryCalendarWriteState);
  const appointmentId = stringArg(args, "appointmentId");
  if (!appointmentId || !UUID_SHAPED.test(appointmentId)) {
    return ok({ status: "error", message: "That is not an appointment id." } satisfies RetryCalendarWriteState);
  }
  let outcome: CalendarWriteOutcome;
  try {
    outcome = await writeToCalendar(clinic.id, appointmentId, { fromFailed: true, actor: actorFor(operator) });
  } catch (error) {
    return ok({ status: "error", message: error instanceof Error ? error.message.slice(0, 200) : "Could not retry." } satisfies RetryCalendarWriteState);
  }
  const auditRecorded = await audit(operator, "calendar_write_retried", { clinicSlug: clinic.slug, appointmentId, outcome });
  return ok({ status: "retried", outcome, auditRecorded } satisfies RetryCalendarWriteState);
}

/** §B.4: the calendar-write ledger on its own, for a refresh after a retry. */
async function opListCalendarWrites(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const writes = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      tx.audit.record({ action: "read", resourceType: "appointment_calendar_write", resourceId: tx.clinicId });
      return listCalendarWritesWithin(tx);
    },
  );
  return ok({ writes });
}

// -----------------------------------------------------------------------------
// The email platform: Resend's webhook, relayed (Annex X3)
// -----------------------------------------------------------------------------

/**
 * One delivery event for mail this app sent, as apps/web relays it: the type
 * in the ledger's vocabulary, the event's timestamp, and the tags this app put
 * on the email (clinic, delivery, kind). Every value is checked for shape
 * before anything is opened; nothing else in `args` is read, so an address
 * that strayed into the envelope goes nowhere.
 */
async function opEmailEvent(args: Record<string, unknown>): Promise<OpsOutcome> {
  const type = stringArg(args, "type", 32);
  if (!type || !isDeliveryStatus(type)) {
    return opsProblem("A delivery event type is required.", 400, "invalid_args");
  }
  const atRaw = stringArg(args, "at", 40);
  const at = atRaw ? new Date(atRaw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return opsProblem("The event's timestamp is required.", 400, "invalid_args");
  }
  const clinic = stringArg(args, "clinic", 64);
  const delivery = stringArg(args, "delivery", 64);
  const kind = stringArg(args, "kind", 64);
  if (
    (clinic && !UUID_SHAPED.test(clinic)) ||
    (delivery && !UUID_SHAPED.test(delivery)) ||
    (kind && !KIND_SHAPE.test(kind))
  ) {
    return opsProblem("The event's tags are not ids.", 400, "invalid_args");
  }
  const result = await applyEmailEvent({
    type,
    at,
    ...(clinic ? { clinic } : {}),
    ...(delivery ? { delivery } : {}),
    ...(kind ? { kind } : {}),
  });
  return ok(result);
}

// -----------------------------------------------------------------------------
// The credential key
// -----------------------------------------------------------------------------

export type CredentialKeyStatus = CredentialKeyConfiguration & {
  selfCheck: CredentialKeySelfCheck;
};

/**
 * Whether this deployment can seal and open a clinic's credentials, asked now.
 *
 * Live rather than the worker's start-up result, because the operator's
 * question is "now", and the worker may have started before the task role or
 * the key policy was put right. A read, so unaudited like the other reads: it
 * writes nothing, and on KMS its two calls are CloudTrail events already.
 *
 * The self-check keeps to its own budget, inside the twelve seconds apps/web's
 * ops client waits, so a KMS that does not answer comes back as `timeout`
 * rather than as a caller that gave up. What crosses is the projection in
 * kms.ts and a category word — never the full ARN, which names the account,
 * and never an AWS error message.
 *
 * Nothing in apps/web calls this yet: its ops client has no function for it
 * and /admin no card. Until one does, it answers only a request signed with
 * the provision secret, and the worker's start-up log line is the check an
 * operator can read.
 */
async function opGetCredentialKeyStatus(): Promise<OpsOutcome> {
  return ok({
    ...credentialKeyConfiguration(),
    selfCheck: await selfCheckCredentialKey(),
  } satisfies CredentialKeyStatus);
}

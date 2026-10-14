/**
 * The one place apps/web talks to the ops API in apps/app.
 *
 * ## Why this file exists at all
 *
 * apps/web has no database driver and must never get one. That is not an
 * oversight: it is the reason the marketing site can deploy anywhere and the
 * reason the audit of this codebase can say, in one sentence, that this app
 * cannot reach patient data. Moving the ops console here would be the obvious
 * moment to add an ORM and a connection string "just for the console", and
 * doing so would quietly end that property for every route in the app, forever.
 *
 * So every read and every action crosses the network to apps/app over the same
 * HMAC that `/api/provision` already uses. This
 * module is the only holder of that secret in the admin area, and the only
 * place the upstream origin is read.
 *
 * ## Server-side only, and why that is enforced rather than documented
 *
 * `HEALDESK_PROVISION_SECRET` grants the ability to provision accounts, mint
 * connection links and render executed agreements. A single accidental import
 * from a "use client" file would bundle it into JavaScript served to browsers.
 * The `@healdesk/catalog` import below already pulls `node:crypto`, which makes
 * such a bundle fail rather than succeed quietly; the module-scope throw below
 * is belt and braces for the day that stops being true.
 *
 * ## The session check in this file is the only door
 *
 * The envelope carries NO identity, and that is the ops API's design rather
 * than an omission here. There is one administrator, apps/app resolves them
 * from its own `HEALDESK_ADMIN_EMAIL`, and it freezes that address into
 * `audit_log.actorLabel`. An id from this app would be a claim; an address from
 * this app would be a claim. The far side takes neither, which is why its
 * attribution cannot be moved by anything a caller sends.
 *
 * The consequence is worth stating plainly rather than leaving to be worked
 * out: because the HMAC alone satisfies the ops API, `requireOperator()` inside
 * `callOps` is the ONLY thing standing between a visitor and a connection link.
 * Not a defence in depth, not one of two checks. There is no parameter for the
 * operator and no way for a page, a component or a future server action to skip
 * it, and a server action reached by a bare POST with no cookie stops on that
 * line. That is also why the sign-in operations, which deliberately do not have
 * it, live behind their own function and their own five-name union below.
 *
 * What DOES travel is `context`: the browser's apparent address and user agent,
 * as claims, so an audit row can say where a request came from rather than
 * recording this server's egress IP. Signed, so they cannot be edited in
 * flight; still claims, and treated as such on both sides.
 *
 * ## What crosses back, and what never does
 *
 * A NON-2XX body never reaches a browser. It describes our internal topology
 * and on some paths it names the record. What the operator reads instead is one
 * of our own codes and one of our own sentences, written next to the screen
 * that shows it.
 *
 * A 200 is different in kind. The ops API answers domain outcomes with 200 and
 * a sentence, "Already recorded as terminated on 4 March", "Not emailed: the
 * transport is not configured", and those sentences carry facts this side
 * cannot compute and must not paraphrase. So they are carried across, through
 * `text()`, which strips control characters and bidirectional overrides and
 * caps the length. That is the whole of the exception: 200 only, sanitised
 * always, and never an error body.
 *
 * ## Timeouts are not silence
 *
 * A read that times out showed nothing. A WRITE that times out is genuinely
 * ambiguous: the transaction on the far side may well have committed. That
 * hazard did not exist when the console ran in the same process as the
 * database, and pretending it still does not exist is how an operator issues a
 * second connection link, or records a second termination, because the first
 * attempt "failed". So `callOps` knows whether it is performing a read or a
 * write, and says something different in each case.
 */

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  getPlan,
  sign,
  type AgreementTerminationReason,
} from "@healdesk/catalog";
import { headers } from "next/headers";

import { requireOperator } from "@/lib/admin/operator";
import { INCIDENT_CLASSES, type IncidentClass } from "@/lib/admin/incident-classes";
import { clientKey } from "@/lib/rate-limit";

/**
 * A module-scope refusal rather than a comment.
 *
 * `server-only` is not a dependency of this app and adding one is not this
 * slice's to add, so this is the enforcement that is available. It runs when
 * the module is first evaluated, which in a client bundle is at page load, and
 * it is impossible to miss in review or in a browser console.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "lib/admin/ops-client is server-side only: it holds HEALDESK_PROVISION_SECRET.",
  );
}

/**
 * Long enough for a cold start in apps/app plus a query, short enough that an
 * operator gets an answer rather than a spinner. Deliberately above the eight
 * seconds `/api/agreement/pdf` allows itself: that route sits in front of a
 * buyer mid-checkout with a fallback to offer, and this one has no fallback but
 * does have somebody willing to wait a moment longer for the truth.
 */
const UPSTREAM_TIMEOUT_MS = 12_000;

/**
 * A response larger than this is not one of ours.
 *
 * The biggest legitimate payload is a full page of the agreement register: two
 * hundred rows of short strings. The cap is generous by an order of magnitude
 * and still refuses to buffer something unbounded from a host that has, by
 * then, only proved it answers on the address we were configured with.
 */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * Display strings that arrive over the wire are capped here.
 *
 * Long enough for a mailer's reason or a refusal that names a date, short
 * enough that no single field can push the rest of a row off the screen.
 */
const MAX_TEXT = 400;

/**
 * How many agreements one register page asks for.
 *
 * `lib/agreements/search.ts` documents 50 by default and 200 as its ceiling, so
 * this is the largest honest page. The register does not paginate; when there
 * are more matches than this it says so and the answer is a narrower filter,
 * not a bigger number. A cursor in the URL would show page two with no page one
 * beside it and no way to act on both at once.
 */
export const REGISTER_LIMIT = 200;

// -----------------------------------------------------------------------------
// The wire contract
// -----------------------------------------------------------------------------

/**
 * The operations an ADMINISTRATOR performs, named exactly as the ops API names
 * them.
 *
 * A closed union rather than a string: the op travels inside the SIGNED body,
 * and every one of these is a literal written here, so nothing an operator
 * types can become an operation. The team operations that API also exposes are
 * deliberately absent, staff invitations and team management were removed with
 * the clinic console, and a client that cannot ask for them is a stronger
 * statement than a screen that does not draw them.
 *
 * Every one of these goes through `callOps`, which will not sign a request
 * without a session.
 */
type OperatorOp =
  | "listClinics"
  | "listJobs"
  | "toggleJob"
  | "issueConnectLink"
  | "searchAgreements"
  | "resendAgreementCopy"
  | "markAgreementTerminated"
  | "getOnboarding"
  | "completeOnboardingStep"
  | "reopenOnboardingStep"
  | "setPhoneSettings"
  | "updateAgentConfig"
  | "approveAgentConfig"
  | "goLive"
  | "getClinicCare"
  | "addReportRecipient"
  | "removeReportRecipient"
  | "openIncident"
  | "markIncidentNotified"
  | "resolveIncident"
  | "startOffboarding"
  | "markExportDelivered"
  | "markVoiceVendorDataDeleted"
  // Deletion on request (BAA 1.3.0 release gate 6): the subcontractor step's
  // stamp, ids and a closed outcome. The deletion itself, and amendments and
  // corrections (release gate 8), carry a patient's identifiers or words, so
  // they are not operations here: they run in apps/app's shell
  // (lib/admin/patient-rights.ts names the scripts), never through apps/web.
  | "markErasureVendorDeleted"
  // The billing panel (build spec §7 E, R35).
  | "getClinicBilling"
  | "setOverageMode"
  | "setUsageAlerts"
  | "replayBillingEvent"
  | "previewRefund"
  | "commitRefund"
  | "setClinicSettings"
  | "setDepositSettings"
  | "disconnectStripeConnect"
  | "issueStripeConnectLink"
  | "retryBillingRequest"
  | "liftSuspension"
  | "extendSetupDeadline"
  | "retryLocationSetup"
  | "retryOverageInvoice"
  | "closeUnfinishedSetup"
  | "replayConnectEvent"
  | "setAutoRenew"
  | "startForwardingTest"
  | "listClinicHealth"
  | "recordClinicTouch"
  | "attachMetaChannel"
  | "setMetaFrontDoor"
  | "setMetaPlatform"
  | "setBookingRequirements"
  | "setClinicTimezone"
  | "setConnectionPhiBasis"
  | "issueSetupLink"
  | "retryCalendarWrite"
  | "listCalendarWrites"
  // The booking mode and the Google Calendar (plan §10): Auto-confirm, the
  // calendar link mailed to the practice's own address, and a disconnect.
  | "setAutoConfirm"
  | "issueCalendarLink"
  | "disconnectCalendar";

/**
 * The operations that happen BEFORE there is a session, and there are exactly
 * five of them.
 *
 * These are the sign-in path itself. "Is an authenticator enrolled", "is this
 * six-digit code valid", "turn this secret on", "tell the owner somebody just
 * signed in", all four are asked while the browser holds no session, because
 * answering them is what decides whether it gets one. Requiring a session for
 * them would deadlock first sign-in: no session until the code is checked, and
 * no code check until there is a session.
 *
 * So `callPreSessionOps` skips `requireOperator()`, and this union is what
 * keeps that from spreading. It is a separate type with a separate function,
 * which means no clinic list, no connection link and no termination can be
 * asked for without a session however a future caller is written. Adding an op
 * to this list is a deliberate decision to expose it to anybody who can reach
 * `/api/admin/session`, and should be argued for in a comment beside it.
 *
 * The authority for these is the HMAC alone, and it is the right authority: it
 * proves the healdesk web app is asking, which is exactly the claim "check this
 * code for the one account" needs. What protects the account is that the ops
 * API refuses a bad code, refuses a replayed one, and refuses to stage a second
 * secret over an enrolled one, none of which this app can do for it, since
 * this app deliberately does not hold the secret.
 */
type PreSessionOp =
  | "getAdminTotpState"
  | "enrolAdminTotp"
  | "verifyAdminTotpStep"
  | "burnRecoveryCode"
  | "sendSignInAlert";

/**
 * The operations a MACHINE asks for, with no browser behind them, and there is
 * exactly one: relaying a Resend webhook event for mail apps/app sent.
 *
 * The account has one webhook, on this app, and it sees both apps' mail
 * (Annex X3 of docs/design/funnel-onboarding-portal-2026-10-06.md). The route
 * verifies Resend's Svix signature before it relays anything, which is the
 * authority here, as the HMAC is for the sign-in operations; there is no
 * operator session to check. What crosses is an event type, a timestamp and
 * the tags apps/app put on its own email (ids and a kind), never an address,
 * so the worst a forged call could do is mark one of apps/app's ledger rows,
 * and a forged call needs HEALDESK_PROVISION_SECRET.
 */
type RelayOp = "emailEvent" | "welcomeHandoff";

type OpName = OperatorOp | PreSessionOp | RelayOp;

/** Why a call did not produce data. Never the upstream body, never the URL. */
export type OpsErrorCode =
  /** No administrator session on this browser. The caller sends them to sign in. */
  | "unauthenticated"
  /** The far side has the address and does not accept it as the administrator. */
  | "forbidden"
  /** Secret or upstream origin missing from the environment. */
  | "unconfigured"
  | "timeout"
  | "unreachable"
  /** A filter this page sent was refused. The operator can fix this one. */
  | "invalid_filter"
  /** Upstream answered, and it was not a success. The status is in our logs. */
  | "refused"
  /**
   * Upstream answered with a server error (500, 503 or any 5xx). Unlike a
   * refusal, a write may have partly happened, and the message says so.
   */
  | "failed"
  /** Upstream answered with something this file could not read. */
  | "malformed";

export type OpsFailure = {
  ok: false;
  code: OpsErrorCode;
  /** One sentence, written here, safe to render. */
  message: string;
};

export type OpsResult<T> = { ok: true; data: T } | OpsFailure;

// -----------------------------------------------------------------------------
// What the reads return
// -----------------------------------------------------------------------------

/** What the console can cheaply say about a clinic's connection. */
export type ConnectionState =
  /** A credential is stored: nothing more is owed by this clinic. */
  | "connected"
  /** A link is out there, unused and unexpired. */
  | "outstanding"
  /** Neither. This is the list ops works from. */
  | "none"
  /**
   * Not looked up on this call. apps/app caps how many it checks, and reports
   * the ones past the cap as unknown rather than as "none", guessing would
   * send an operator to issue a second credential for a clinic that has one.
   */
  | "unknown";

/** Something an operator has to act on before this clinic can go live. */
export type ClinicBlocker = { level: "blocked" | "attention"; message: string };

/**
 * A clinic, as the console needs it.
 *
 * The blocker WORDING is computed upstream by `blockersFor()` and carried
 * across verbatim. Re-deriving it here would put a second implementation of
 * "what stops this clinic handling patient data" into a repository whose whole
 * claim is that there is one, and this copy would live in the app that is not
 * allowed to look at the data it is reasoning about.
 */
export type OpsClinic = {
  id: string;
  name: string;
  specialty: string;
  timezone: string;
  dataClassification: "synthetic" | "production";
  attributionMode: "estimated" | "verified";
  /** Null means "not determined", which is a blocker rather than a default. */
  isCoveredEntity: boolean | null;
  /** The date on the signed BAA, or null when there is none. */
  baaSignedOn: string | null;
  blockers: ClinicBlocker[];
  connection: ConnectionState;
};

export type OpsClinics = {
  clinics: OpsClinic[];
  /**
   * How many clinics had their connection state read. Everything past it is
   * `unknown`, and the console says so rather than letting a cap look like an
   * answer.
   */
  connectionStateLimit: number;
};

/** A scheduled job and what it last did. */
export type OpsJob = {
  name: string;
  cadence: string;
  enabled: boolean;
  /** "2026-09-07 14:32 UTC", or null when it has never run. */
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** Free text from the job itself. Sanitised on arrival. */
  lastRunNote: string | null;
  /** Set while a run is in flight, which is the one thing a toggle cannot stop. */
  runningSince: string | null;
  /** Phase two (attribution) and fenced upstream: it does not run in v1 and cannot be switched on. */
  phaseTwo: boolean;
};

/**
 * The three states the register partitions rows into, named as the ops API
 * names them.
 *
 * They do not overlap, and `terminated` is narrower than it sounds: it is an
 * agreement that has ended AND is still inside the six-year retention floor.
 * One that is past the floor is `retention_review`. Every filter and every
 * label on the register has to honour that, because a row can only be in one.
 */
export type AgreementStatus = "in_effect" | "terminated" | "retention_review";

/**
 * What may honestly be said about one agreement's retention.
 *
 * The live branch carries no date, deliberately. `retention_eligible_at` is NOT
 * NULL upstream, so a live agreement has a value in it, signature plus six
 * years, because that is all the column can compute while the end date is
 * unknown, and printing it is the classic way this rule is got wrong. The
 * floor runs from the later of signature and termination, so for an agreement
 * still in effect the true date is at least six years from today and moves
 * further away every day the clinic stays.
 */
export type AgreementRetention =
  | { state: "live" }
  | { state: "terminated"; on: string; until: string; reached: boolean };

export type OpsAgreement = {
  id: string;
  /**
   * The practice as named in the document itself, not as named in a clinic row,
   * and null when the stored document carried no legal name. An unbound
   * agreement has no clinic, and a clinic that has since renamed itself did not
   * rename the contract.
   */
  clinicName: string | null;
  version: string;
  /** "Alex Chen, Owner", the frozen signature block, title included when given. */
  signatory: string;
  signatoryEmail: string;
  /** "2026-08-18 14:32 UTC". A signature is a moment, so it keeps its time. */
  signedAt: string;
  /** "2026-08-18". The same moment as a calendar date, for filtering and sorting. */
  signedOn: string;
  /** Date the counterparty's copy first reached them, or null if it never did. */
  copySentOn: string | null;
  retention: AgreementRetention;
  status: AgreementStatus;
  /** SHA-256 of the rendered document. Hex, lower case. */
  documentHash: string;
};

/** The filter row, as the ops API's own search takes it. */
export type AgreementQuery = {
  /** Free text over clinic name, signatory, signatory email and the hash. */
  query?: string;
  /** Inclusive UTC calendar days, YYYY-MM-DD. */
  signedFrom?: string;
  signedTo?: string;
  /** Exact template version. */
  version?: string;
  status?: AgreementStatus;
  copySent?: boolean;
};

export type OpsAgreements = {
  rows: OpsAgreement[];
  /** How many agreements match the filters, which is not how many are listed. */
  total: number;
  /** True when there are more matches than this page carries. */
  truncated: boolean;
  /**
   * Today, in UTC, from THIS server's clock.
   *
   * It bounds the date pickers so an operator cannot offer tomorrow, and that
   * is all it is for. The authority on whether a termination date is in the
   * future is apps/app, which compares against its own clock before it writes;
   * a picker that is a second out cannot turn into a recorded date that is.
   */
  today: string;
};

// -----------------------------------------------------------------------------
// What the writes return
//
// Every one of them has the same shape: it either happened, or it did not and
// the ops API said why in a sentence written for an operator. `refused` is a
// 200, the far side understood, decided, and declined, and is a different
// thing entirely from an `OpsFailure`, which means the call did not land.
// -----------------------------------------------------------------------------

/**
 * Whether the audit row was written alongside the act.
 *
 * The ops API reports this rather than assuming it, because an unrecorded act
 * that looks recorded is exactly the failure an audit trail exists to prevent.
 * A screen that hides a `false` here is lying by omission, so every caller of
 * these three writes shows it.
 */
type Audited = { auditRecorded: boolean };

export type ToggleJobOutcome =
  | ({ status: "updated"; enabled: boolean } & Audited)
  | { status: "refused"; message: string };

/** What the mailer actually did, reported rather than assumed. */
export type ConnectLinkDelivery =
  | { attempted: false }
  | { attempted: true; status: "sent" }
  | { attempted: true; status: "skipped" | "failed"; reason: string };

export type IssueLinkOutcome =
  | ({
      status: "issued";
      /**
       * The one-time URL, composed upstream from apps/app's own public origin.
       *
       * Not built here, deliberately: this file knows an internal address
       * (`HEALDESK_APP_URL`) which may not be the origin a clinic can reach, and
       * which is precisely the value that must not appear in a browser. What
       * arrives is a link apps/app is willing to stand behind.
       */
      url: string;
      /** Pre-formatted for display, so nothing downstream parses a date. */
      expiresAt: string;
      delivery: ConnectLinkDelivery;
    } & Audited)
  | { status: "refused"; message: string };

export type ResendOutcome =
  | ({ status: "sent"; firstCopy: boolean } & Audited)
  /** `reason` is the transport's own words. Sanitised, never interpreted. */
  | ({ status: "not_sent"; reason: string } & Audited)
  | { status: "refused"; message: string };

export type TerminateOutcome =
  | ({
      status: "recorded";
      terminatedOn: string;
      retainUntil: string;
      /**
       * Whether the practice's service ended with it: no agreement is left in
       * effect, so the assistant has stopped, its locations are offboarding
       * and its subscription is being cancelled. False when another agreement
       * still covers it, or the agreement was never bound.
       */
      servicesEnded: boolean;
      /** The agreement refunds this ending: ops is told to preview and confirm it on Billing. */
      refundDue: boolean;
    } & Audited)
  /**
   * Already terminated, signed later than the date given, dated in the future,
   * not a real date, gone, or beaten to it by a second operator.
   *
   * All six arrive as one sentence, and the sentence is carried rather than
   * re-derived because three of them name a date this side does not hold. The
   * wording that matters most, what recording a termination COSTS, is written
   * on the confirmation screen, before the button, where it can still change a
   * mind.
   */
  | { status: "refused"; message: string };

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export function fetchClinics(): Promise<OpsResult<OpsClinics>> {
  return callOps("listClinics", "read", {}, (value) => {
    const data = object(value, "listClinics");
    return {
      clinics: list(data.clinics, "listClinics.clinics").map(readClinic),
      connectionStateLimit: count(
        data.connectionStateLimit,
        "listClinics.connectionStateLimit",
      ),
    };
  });
}

export function fetchJobs(): Promise<OpsResult<OpsJob[]>> {
  return callOps("listJobs", "read", {}, (value) =>
    list(object(value, "listJobs").jobs, "listJobs.jobs").map(readJob),
  );
}

/**
 * One page of the register, filtered by the ops API rather than by the browser.
 *
 * The alternative, pull the newest page and filter it here, was what the
 * console it replaces did, and it is wrong for a register: a free-text search
 * that silently only searches the most recent two hundred rows answers "which
 * agreement has this fingerprint?" with "no such agreement" as soon as the
 * table outgrows the page. `lib/agreements/search.ts` exists precisely so that
 * the filter and the count describe the whole table, and this is its caller.
 */
export function fetchAgreements(
  query: AgreementQuery = {},
): Promise<OpsResult<OpsAgreements>> {
  const args: Record<string, unknown> = { limit: REGISTER_LIMIT };
  // Blank is not a filter. Upstream trims and ignores empty strings anyway;
  // dropping them here keeps the signed body a description of what was asked.
  if (query.query) args.query = query.query;
  if (query.signedFrom) args.signedFrom = query.signedFrom;
  if (query.signedTo) args.signedTo = query.signedTo;
  if (query.version) args.version = query.version;
  if (query.status) args.status = query.status;
  if (query.copySent !== undefined) args.copySent = query.copySent;

  return callOps("searchAgreements", "read", args, (value) => {
    const data = object(value, "searchAgreements");
    const rows = list(data.rows, "searchAgreements.rows").map(readAgreement);

    return {
      rows,
      total: count(data.total, "searchAgreements.total"),
      // A cursor means the far side has more it did not send. Read from the
      // cursor rather than from `rows.length === limit`, which is the same
      // guess the console it replaces made and got wrong on an exact multiple.
      truncated: data.nextCursor !== null && data.nextCursor !== undefined,
      today: new Date().toISOString().slice(0, 10),
    };
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export function toggleJob(
  name: string,
  enabled: boolean,
): Promise<OpsResult<ToggleJobOutcome>> {
  return callOps("toggleJob", "write", { name, enabled }, (value) => {
    const data = object(value, "toggleJob");
    if (state(data, "toggleJob") !== "updated") return refusal(data, "toggleJob");

    return {
      status: "updated",
      enabled: bool(data.enabled, "toggleJob.enabled"),
      auditRecorded: bool(data.auditRecorded, "toggleJob.auditRecorded"),
    };
  });
}

export function issueConnectLink(
  clinicId: string,
  recipientEmail: string | null,
): Promise<OpsResult<IssueLinkOutcome>> {
  const args: Record<string, unknown> = { clinicId };
  if (recipientEmail) args.recipientEmail = recipientEmail;

  return callOps("issueConnectLink", "write", args, (value) => {
    const data = object(value, "issueConnectLink");
    if (state(data, "issueConnectLink") !== "issued") {
      return refusal(data, "issueConnectLink");
    }

    return {
      status: "issued",
      // Not put through `text()`: a URL is not prose, and collapsing its
      // whitespace would corrupt a credential shown exactly once. It is checked
      // for being an absolute http(s) URL instead, which is the property that
      // matters before it goes in front of an operator.
      url: url(data.url, "issueConnectLink.url"),
      expiresAt: text(data.expiresAt, "issueConnectLink.expiresAt"),
      delivery: readDelivery(data.delivery),
      auditRecorded: bool(
        data.auditRecorded,
        "issueConnectLink.auditRecorded",
      ),
    };
  });
}

export function resendAgreementCopy(
  agreementId: string,
): Promise<OpsResult<ResendOutcome>> {
  return callOps("resendAgreementCopy", "write", { agreementId }, (value) => {
    const data = object(value, "resendAgreementCopy");

    switch (state(data, "resendAgreementCopy")) {
      case "sent":
        return {
          status: "sent",
          firstCopy: bool(data.firstCopy, "resendAgreementCopy.firstCopy"),
          auditRecorded: bool(
            data.auditRecorded,
            "resendAgreementCopy.auditRecorded",
          ),
        };
      case "not_sent":
        return {
          status: "not_sent",
          reason: text(data.reason, "resendAgreementCopy.reason"),
          auditRecorded: bool(
            data.auditRecorded,
            "resendAgreementCopy.auditRecorded",
          ),
        };
      default:
        return refusal(data, "resendAgreementCopy");
    }
  });
}

export function markAgreementTerminated(
  agreementId: string,
  /** YYYY-MM-DD from a date input. Termination is a date, not a moment. */
  terminationDate: string,
  /** Who ended it and why: AGREEMENT_TERMINATION_REASONS in @healdesk/catalog. */
  terminationReason: AgreementTerminationReason,
): Promise<OpsResult<TerminateOutcome>> {
  return callOps(
    "markAgreementTerminated",
    "write",
    { agreementId, terminationDate, terminationReason },
    (value) => {
      const data = object(value, "markAgreementTerminated");
      if (state(data, "markAgreementTerminated") !== "recorded") {
        return refusal(data, "markAgreementTerminated");
      }

      return {
        status: "recorded",
        terminatedOn: date(
          data.terminatedOn,
          "markAgreementTerminated.terminatedOn",
        ),
        retainUntil: date(
          data.retainUntil,
          "markAgreementTerminated.retainUntil",
        ),
        auditRecorded: bool(
          data.auditRecorded,
          "markAgreementTerminated.auditRecorded",
        ),
        servicesEnded: data.services === "services_ended",
        refundDue: data.refundDue === true,
      };
    },
  );
}

// -----------------------------------------------------------------------------
// Sign-in, which happens before there is a session
//
// The second factor lives in apps/app and never comes back here. This app holds
// the password hash, because the password is what its own form collects; the
// TOTP secret, the last-used step and the recovery-code digests are all
// upstream, so what crosses is six digits and a verdict. That split is what
// keeps a compromise of this app's environment from being a compromise of the
// second factor: `HEALDESK_ADMIN_PASSWORD_HASH` leaking is one factor lost, and
// a second factor stored beside it would have been none.
//
// The one exception is enrolment, where a proposed secret crosses once, in the
// answer that offers it, because the owner has to see it to scan it. apps/web
// never chooses it and never stores it.
// -----------------------------------------------------------------------------

/** What apps/app will say about the one account's second factor. */
export type AdminTotpState = {
  enrolled: boolean;
  /** ISO instant, or null when nothing is enrolled. Passed through unformatted. */
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
};

/** Whether an authenticator has been enrolled, and what is left of the codes. */
export function getAdminTotpState(): Promise<OpsResult<AdminTotpState>> {
  return callPreSessionOps("getAdminTotpState", "read", {}, (value) => {
    const data = object(value, "totpState");
    return {
      enrolled: bool(data.enrolled, "totpState.enrolled"),
      enrolledAt: optionalIsoInstant(data.enrolledAt, "totpState.enrolledAt"),
      recoveryCodesRemaining: count(
        data.recoveryCodesRemaining,
        "totpState.recoveryCodesRemaining",
      ),
    };
  });
}

export type EnrolTotpOutcome =
  /** A candidate, not a second factor. Nothing is enrolled until a code proves it. */
  | {
      status: "proposed";
      /** Base32, shown to the owner. The only time this value crosses. */
      secret: string;
      /** `otpauth://totp/...`, for the QR the enrolment route renders. */
      otpauthUri: string;
      /** Opaque handle naming this proposal on the way back. */
      proposal: string;
      expiresInMs: number;
    }
  | {
      status: "enrolled";
      /** Shown once and never obtainable again, from here or from upstream. */
      recoveryCodes: string[];
      enrolledAt: string;
      auditRecorded: boolean;
    }
  /** Already enrolled, proposal expired, or the code was wrong. Upstream's words. */
  | { status: "error"; message: string };

/**
 * Both halves of enrolment, in one operation because they are one decision.
 *
 * `{}` asks for a candidate. `{ code, proposal }` proves the candidate reached
 * an authenticator and turns it on. Splitting them is what stops the owner
 * being locked out by a QR nobody scanned or a phone that was wiped: until a
 * code derived from the proposal comes back, the account still opens on the
 * password alone.
 *
 * Refusing a second enrolment is upstream's job and cannot be done here. Only
 * the far side can hold that line when two requests arrive at once, and if it
 * ever stops holding it, "enrol again" becomes "replace the second factor with
 * one I chose", which is a takeover for anybody holding the password.
 */
export function enrolAdminTotp(args: {
  code?: string;
  proposal?: string;
}): Promise<OpsResult<EnrolTotpOutcome>> {
  const payload: Record<string, unknown> = {};
  if (args.code !== undefined) payload.code = args.code;
  if (args.proposal !== undefined) payload.proposal = args.proposal;

  return callPreSessionOps(
    "enrolAdminTotp",
    // A write even when it only proposes: the far side stores the candidate, so
    // a call that times out may have left one behind.
    "write",
    payload,
    (value) => {
      const data = object(value, "enrolTotp");
      const status = literal(
        data.status,
        ["proposed", "enrolled", "error"] as const,
        "enrolTotp.status",
      );

      if (status === "proposed") {
        return {
          status,
          secret: credential(data.secret, "enrolTotp.secret"),
          otpauthUri: otpauth(data.otpauthUri, "enrolTotp.otpauthUri"),
          proposal: credential(data.proposal, "enrolTotp.proposal"),
          expiresInMs: count(data.expiresInMs, "enrolTotp.expiresInMs"),
        };
      }

      if (status === "enrolled") {
        return {
          status,
          recoveryCodes: recoveryCodes(data.recoveryCodes),
          enrolledAt: isoInstant(data.enrolledAt, "enrolTotp.enrolledAt"),
          auditRecorded: bool(data.auditRecorded, "enrolTotp.auditRecorded"),
        };
      }

      return { status, message: text(data.message, "enrolTotp.message") };
    },
  );
}

/**
 * Why a second-factor attempt was refused.
 *
 * `already_used` is told apart from `incorrect` on purpose, and the one bit it
 * leaks is worth what it buys: to an attacker it confirms a code they already
 * hold was once valid, about a step that is now spent; to the owner it explains
 * why the app on their phone is showing a code the console will not take.
 */
export type SecondFactorRefusal =
  | "not_enrolled"
  | "incorrect"
  | "already_used"
  | "unreadable"
  | "throttled";

export type TotpVerdict =
  | { ok: true }
  | { ok: false; reason: SecondFactorRefusal; message: string };

/**
 * Check six digits against the enrolled secret.
 *
 * A write, and not only for the wording of a timeout: accepting a code burns
 * that thirty-second step upstream, which is what makes a replay refusable. A
 * call that times out may have spent the code the owner just typed.
 */
export function verifyAdminTotpStep(args: {
  code: string;
}): Promise<OpsResult<TotpVerdict>> {
  return callPreSessionOps(
    "verifyAdminTotpStep",
    "write",
    { code: args.code },
    (value) => {
      const data = object(value, "totpStep");
      if (bool(data.ok, "totpStep.ok")) return { ok: true };

      return {
        ok: false,
        reason: literal(
          data.reason,
          [
            "not_enrolled",
            "incorrect",
            "already_used",
            "unreadable",
            "throttled",
          ] as const,
          "totpStep.reason",
        ),
        message: text(data.message, "totpStep.message"),
      };
    },
  );
}

export type RecoveryVerdict =
  | { ok: true; remaining: number; auditRecorded: boolean }
  | {
      ok: false;
      reason: Extract<
        SecondFactorRefusal,
        "not_enrolled" | "incorrect" | "throttled"
      >;
      message: string;
    };

/**
 * Spend one recovery code.
 *
 * Separate from the TOTP check because the consequences differ: a step comes
 * back in thirty seconds, a recovery code never does. `remaining` exists so the
 * screen can say how few are left while it still matters, since nothing in this
 * console issues more.
 */
export function burnRecoveryCode(args: {
  code: string;
}): Promise<OpsResult<RecoveryVerdict>> {
  return callPreSessionOps(
    "burnRecoveryCode",
    "write",
    { code: args.code },
    (value) => {
      const data = object(value, "recoveryCode");

      if (bool(data.ok, "recoveryCode.ok")) {
        return {
          ok: true,
          remaining: count(data.remaining, "recoveryCode.remaining"),
          auditRecorded: bool(
            data.auditRecorded,
            "recoveryCode.auditRecorded",
          ),
        };
      }

      return {
        ok: false,
        reason: literal(
          data.reason,
          ["not_enrolled", "incorrect", "throttled"] as const,
          "recoveryCode.reason",
        ),
        message: text(data.message, "recoveryCode.message"),
      };
    },
  );
}

export type SignInAlertOutcome = {
  delivery: "sent" | "skipped" | "failed";
  /** The transport's own words, when it gave any. */
  reason?: string;
  auditRecorded: boolean;
};

/**
 * Tell the owner that somebody just signed in as them.
 *
 * Who it goes to is deliberately NOT an argument. apps/app addresses it to the
 * operator it resolves from its own `HEALDESK_ADMIN_EMAIL`, so an attacker with
 * full command of this app cannot redirect the one notification that would tell
 * the owner they are there. What crosses is when, and the browser's apparent
 * address and user agent, which are claims by whoever made the request and are
 * labelled as such on both sides.
 *
 * The result says what the mailer did rather than asserting it went. An alert
 * that fails quietly is worse than no alert.
 */
export function sendSignInAlert(args: {
  /** ISO instant, from the route that saw the sign-in. */
  at: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<OpsResult<SignInAlertOutcome>> {
  const payload: Record<string, unknown> = { at: args.at };
  if (args.ipAddress !== undefined) payload.ipAddress = args.ipAddress;
  if (args.userAgent !== undefined) payload.userAgent = args.userAgent;

  return callPreSessionOps("sendSignInAlert", "write", payload, (value) => {
    const data = object(value, "signInAlert");
    const reason = optionalText(data.reason, "signInAlert.reason");

    return {
      delivery: literal(
        data.delivery,
        ["sent", "skipped", "failed"] as const,
        "signInAlert.delivery",
      ),
      ...(reason !== null ? { reason } : {}),
      auditRecorded: bool(data.auditRecorded, "signInAlert.auditRecorded"),
    };
  });
}

// -----------------------------------------------------------------------------
// The webhook relay
// -----------------------------------------------------------------------------

/** A Resend event for mail apps/app sent, in the ledger's vocabulary. */
export type EmailEventRelay = {
  type: "sent" | "delivered" | "delayed" | "bounced" | "complained" | "suppressed";
  /** The event's own ISO timestamp. */
  at: string;
  /** The tags apps/app put on the email: a clinic id, a ledger row id, a kind. */
  clinic?: string;
  delivery?: string;
  kind?: string;
};

/**
 * Hand one `app=app` delivery event to apps/app, which updates its ledger and
 * alerts ops when a clinic's address cannot be reached. No session (see
 * RelayOp), and no browser context: the request on this side came from Resend,
 * and recording Resend's address as the actor's would be untrue.
 */
export function relayEmailEvent(
  event: EmailEventRelay,
): Promise<OpsResult<{ recorded: boolean }>> {
  const args: Record<string, unknown> = { type: event.type, at: event.at };
  if (event.clinic) args.clinic = event.clinic;
  if (event.delivery) args.delivery = event.delivery;
  if (event.kind) args.kind = event.kind;
  return send(
    "emailEvent",
    "write",
    (value) => ({ recorded: bool(object(value, "emailEvent").recorded, "emailEvent.recorded") }),
    args,
    { context: false },
  );
}

// -----------------------------------------------------------------------------
// The paying browser's way back
// -----------------------------------------------------------------------------

/** Whether apps/app has the purchase and an answer for the browser that paid, and the page that gives it. */
export type WelcomeHandoff = { ready: false } | { ready: true; url: string };

/**
 * Ask apps/app whether the purchase `ref`, paid through Checkout Session
 * `sessionId`, is there yet with something to tell the paying browser, and
 * where (app/welcome/route.ts). A relay op like emailEvent: no session and no
 * browser context, because the request on this side is a buyer's browser
 * that has not signed in to anything, and the answer names nothing about the
 * purchase. The URL is composed upstream from BETTER_AUTH_URL; this never
 * builds one. A short timeout: while the host is in standby this is expected
 * to fail, and the buyer's page must not wait on it.
 */
export function welcomeHandoff(ref: string, sessionId: string): Promise<OpsResult<WelcomeHandoff>> {
  return send(
    "welcomeHandoff",
    "read",
    (value) => {
      const data = object(value, "welcomeHandoff");
      return bool(data.ready, "welcomeHandoff.ready")
        ? { ready: true, url: url(data.url, "welcomeHandoff.url") }
        : { ready: false };
    },
    { ref, sessionId },
    { context: false, timeoutMs: WELCOME_HANDOFF_TIMEOUT_MS },
  );
}

const WELCOME_HANDOFF_TIMEOUT_MS = 4_000;

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

/**
 * Whether a failed call could have changed anything on the far side.
 *
 * The difference is the whole reason this parameter exists. See the note on
 * timeouts in the file header.
 */
type CallKind = "read" | "write";

/**
 * Thrown by the readers below when a response is not the shape this file
 * expects. Caught in one place and turned into `malformed`, so no reader has to
 * carry an error channel of its own and no caller sees a half-read object.
 */
class ShapeError extends Error {}

const MALFORMED =
  "The ops API answered with something this page could not read. Nothing is shown rather than a guess at what it meant.";

/**
 * Everything an administrator asks for, and the session check that gates it.
 *
 * The answer is thrown away on purpose: the far side does not take an identity
 * from us and would ignore one. What this line does is decide whether the
 * request is made at all, and since the ops API is satisfied by the HMAC, it is
 * the only thing that does. See the file header.
 */
async function callOps<T>(
  op: OperatorOp,
  kind: CallKind,
  args: Record<string, unknown>,
  read: (value: unknown) => T,
): Promise<OpsResult<T>> {
  if (!(await requireOperator())) {
    return {
      ok: false,
      code: "unauthenticated",
      message: "Your session has ended. Sign in again to continue.",
    };
  }

  return send(op, kind, read, args);
}

/**
 * The five sign-in operations, sent on the HMAC alone.
 *
 * Deliberately no `requireOperator()`: these run while the browser is proving
 * who it is, so there is nothing to check. The union on `op` is what confines
 * that, and the reasoning is written out on `PreSessionOp`.
 *
 * The envelope carries no `operator` at all, which is the honest shape. During
 * sign-in the address is a claim by somebody who has not finished proving
 * anything, and putting an unproven address in the field the audit trail reads
 * as "who did this" is how an attempt becomes an actor.
 */
async function callPreSessionOps<T>(
  op: PreSessionOp,
  kind: CallKind,
  args: Record<string, unknown>,
  read: (value: unknown) => T,
): Promise<OpsResult<T>> {
  return send(op, kind, read, args);
}

async function send<T>(
  op: OpName,
  kind: CallKind,
  read: (value: unknown) => T,
  args: Record<string, unknown>,
  options: { context?: boolean; timeoutMs?: number } = {},
): Promise<OpsResult<T>> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;
  if (!secret || !target) {
    console.error(
      "[healdesk] admin ops: HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return {
      ok: false,
      code: "unconfigured",
      message:
        "The ops API is not configured for this deployment, so nothing can be read or changed from here.",
    };
  }

  // `{ op, args, context }` is the whole envelope the ops API reads. The op is
  // in the signed body and not only in a path, so a captured pair of headers
  // cannot be replayed against a different operation inside the skew window.
  const body = JSON.stringify({
    op,
    args,
    ...(options.context === false ? {} : { context: await browser() }),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let upstream: Response;
  try {
    upstream = await fetch(new URL("/api/ops", target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, secret),
      },
      body,
      // Nothing about an ops read is cacheable, and a cached write would be a
      // different kind of wrong entirely.
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) {
      console.error(`[healdesk] admin ops: ${op} timed out`);
      return {
        ok: false,
        code: "timeout",
        message:
          kind === "write"
            ? "The ops API did not answer in time. It may still have carried this out. Reload and check before trying again."
            : "The ops API did not answer in time, so nothing below could be read.",
      };
    }
    // The error object can name the host we tried. It goes to our log, not to
    // the browser.
    console.error(`[healdesk] admin ops: ${op} unreachable`, error);
    return {
      ok: false,
      code: "unreachable",
      message:
        kind === "write"
          ? "Could not reach the ops API. It probably did not carry this out, but reload and check before trying again."
          : "Could not reach the ops API, so nothing below could be read.",
    };
  }

  if (!upstream.ok) return refused(upstream, op, kind);

  let parsed: unknown;
  try {
    parsed = await readBoundedJson(upstream);
  } catch (error) {
    if (isTimeout(error)) {
      console.error(`[healdesk] admin ops: ${op} timed out mid-body`);
      return {
        ok: false,
        code: "timeout",
        message:
          kind === "write"
            ? "The ops API started answering and then stopped. It may still have carried this out. Reload and check before trying again."
            : "The ops API started answering and then stopped, so nothing below could be read.",
      };
    }
    console.error(`[healdesk] admin ops: ${op} body unreadable`, error);
    return { ok: false, code: "malformed", message: MALFORMED };
  }

  try {
    // The success envelope is `{ data }`. There is no `ok` flag to check: the
    // status was the flag, and it has already been checked above.
    return { ok: true, data: read(object(parsed, op).data) };
  } catch (error) {
    if (error instanceof ShapeError) {
      console.error(
        `[healdesk] admin ops: ${op} answered an unexpected shape at`,
        error.message,
      );
      return { ok: false, code: "malformed", message: MALFORMED };
    }
    throw error;
  }
}

/**
 * The envelope's `context`: whose browser this request is on behalf of, as a
 * claim.
 *
 * apps/app records these on its audit and security rows so that "where did this
 * come from" has an answer other than this server's egress IP, which is a fact
 * about our hosting and not about the person. Both come from request headers,
 * which means the caller picks them unless a proxy overwrites them. That is why
 * they travel inside the SIGNED body as something we said, and why nothing on
 * either side treats them as more than a label.
 *
 * `headers()` throws outside a request scope. Nothing here has a fallback worth
 * inventing, so the fields are simply absent and apps/app records nothing
 * rather than something untrue.
 */
async function browser(): Promise<{ ipAddress?: string; userAgent?: string }> {
  try {
    const incoming = await headers();
    const ipAddress = clientKey(incoming);
    const userAgent = incoming.get("user-agent");

    return {
      ...(ipAddress && ipAddress !== "unknown" ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * A non-2xx answer, turned into one of our codes and one of our sentences.
 *
 * The upstream body is read for its machine-readable `code` and then thrown
 * away. Two conditions are worth telling apart, because they are the two an
 * operator can act on: the far side does not accept this address as the
 * administrator, and a filter this page sent was refused. Everything else, a
 * bad signature, clock skew, a 500, is our problem and is described as one.
 *
 * A server error is not a refusal (F12). apps/app answers 500 when an
 * operation threw partway through, after a commit that may already have
 * happened, and a 503 can come from whatever stands in front of it after the
 * work began. Telling an operator "nothing was changed" then invites the
 * second refund or the second link, so a write answered with any 5xx says it
 * may have been carried out. "Nothing was changed" is kept for the 4xx
 * answers, which apps/app gives before it runs anything.
 */
async function refused(
  upstream: Response,
  op: OpName,
  kind: CallKind,
): Promise<OpsFailure> {
  const code = await upstreamCode(upstream);
  console.error(
    `[healdesk] admin ops: ${op} refused upstream:`,
    upstream.status,
    code ?? "no code",
  );

  if (upstream.status === 403 || code === "forbidden") {
    return {
      ok: false,
      code: "forbidden",
      message:
        "The ops API does not accept this account as the administrator. Check HEALDESK_ADMIN_EMAIL against the operator the application knows about.",
    };
  }

  /**
   * Only on the search. `invalid_args` means "this app sent something the far
   * side would not accept", and on every other operation that is our bug and
   * nothing an operator can do anything about, the ids come from rows we
   * rendered. On the register it is a filter somebody typed, which is the one
   * case where naming it helps.
   */
  if (code === "invalid_args" && op === "searchAgreements") {
    return {
      ok: false,
      code: "invalid_filter",
      message:
        "The ops API refused one of these filters. Check the dates and the version, then try again.",
    };
  }

  if (upstream.status >= 500) {
    return {
      ok: false,
      code: "failed",
      message:
        kind === "write"
          ? "The ops API failed partway through. It may have carried this out, in whole or in part: reload and check before trying again."
          : "The ops API failed while answering, so nothing below could be read.",
    };
  }

  return {
    ok: false,
    code: "refused",
    message:
      kind === "write"
        ? "The ops API refused this. The reason is in our logs; nothing was changed."
        : "The ops API refused this read. The reason is in our logs.",
  };
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError`, which undici may hand
 * back nested under `cause`. Both shapes are the same event.
 */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.name === "TimeoutError";
}

/**
 * The body, refused before it is buffered if it claims to be too big and
 * refused after if it lied.
 *
 * A `Content-Length` is a claim, and is absent on a chunked response, so it is
 * worth checking and not worth trusting, which is why the decoded length is
 * checked as well.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("ops response over cap");
  }

  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new Error("ops response over cap");

  return JSON.parse(raw) as unknown;
}

/**
 * The upstream `code`, for our logs and for the two branches above.
 *
 * Pattern-checked before it goes near a log line: it arrives over the network,
 * and a string with a newline in it writes a second, forged log entry. An
 * unrecognised value is null, which lands on the generic branch, the safe
 * direction to be wrong in.
 */
async function upstreamCode(response: Response): Promise<string | null> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }

  try {
    const raw = await response.text();
    if (raw.length > 4_096) return null;
    const parsed: unknown = JSON.parse(raw);
    const value = (parsed as { code?: unknown } | null)?.code;
    return typeof value === "string" && /^[a-z_]{1,40}$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Readers
//
// Everything below runs on bytes chosen by another host. TypeScript has nothing
// to say about them, so each field is checked rather than asserted: a response
// that is one field short renders an error state, not `undefined` in the middle
// of a row about a legal agreement.
// -----------------------------------------------------------------------------

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(at);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(at);
  return value;
}

function bool(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new ShapeError(at);
  return value;
}

/** A count. Bounded and integral, because it is rendered as one. */
function count(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ShapeError(at);
  }
  return value;
}

function literal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ShapeError(at);
  }
  return value as T;
}

/**
 * The `status` on a write outcome, as a plain string.
 *
 * Deliberately not narrowed to a union here: each caller knows the one status
 * that means "it happened" and treats every other as a refusal, so a status the
 * ops API adds later degrades into a refusal with its own sentence attached
 * rather than into a shape error that shows the operator nothing.
 */
function state(data: Record<string, unknown>, at: string): string {
  const value = data.status;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new ShapeError(`${at}.status`);
  }
  return value;
}

/**
 * A refusal, carrying the sentence the ops API wrote for it.
 *
 * This is the one place upstream prose crosses, and it crosses only on a 200:
 * the far side understood, decided, and declined, and the reason is a fact
 * about the record rather than about our topology. Sanitised like every other
 * display string. A refusal with no sentence still refuses, silence would be
 * the worst of the three possible outcomes.
 */
function refusal(
  data: Record<string, unknown>,
  at: string,
): { status: "refused"; message: string } {
  const message = optionalText(data.message, `${at}.message`);
  return {
    status: "refused",
    message:
      message ??
      "The ops API declined to do that and did not say why. The reason may be in our logs.",
  };
}

/**
 * A display string, normalised before anything renders it.
 *
 * React escapes markup, so this is not about injection into the page. It is
 * about the other two things an upstream-authored string can do to a screen:
 * carry control characters and bidirectional overrides that reorder the text
 * around them, and run long enough to push the rest of a row out of view. Both
 * are removed here, once, rather than at each of the dozen places a string is
 * printed.
 */
function text(value: unknown, at: string): string {
  if (typeof value !== "string") throw new ShapeError(at);
  return clean(value);
}

function optionalText(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = text(value, at);
  return cleaned === "" ? null : cleaned;
}

function clean(value: string): string {
  return (
    value
      // C0 and C1 controls, plus the bidirectional overrides and isolates.
      .replace(
        /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT)
  );
}

/** The agent's greeting, as apps/app stores and validates it (agent-config.ts). */
const MAX_GREETING = 600;

/**
 * Text a person edits and saves back, read without reflowing it.
 *
 * `text()` collapses every run of whitespace into one space and stops at
 * MAX_TEXT, which is right for a label and wrong for a field the console puts
 * in a textarea and then re-sends. The agent's greeting is stored with its
 * line breaks, up to 600 characters; read through `text()` the textarea got a
 * flattened copy cut at 400, and the next "Save script" wrote that back as a
 * new version, silently losing text and clearing the clinic's approval (F2).
 * So this keeps line breaks and tabs, normalises Windows line ends, strips the
 * other control characters and the bidirectional overrides as `clean()` does,
 * and caps at the field's own upstream limit, which a stored value never
 * exceeds.
 */
function editable(value: unknown, at: string, max: number): string {
  if (typeof value !== "string") throw new ShapeError(at);
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);
}

/** A UUID, because every id here is one and every id here ends up in a URL. */
function id(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new ShapeError(at);
  }
  return value;
}

/** "YYYY-MM-DD", checked rather than parsed: these are compared, not computed. */
function date(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ShapeError(at);
  }
  return value;
}

/**
 * An ISO instant from `toISOString()`, split into the two forms this app shows.
 *
 * Matched against the exact shape `toISOString()` produces rather than handed
 * to `new Date()`. The point is that nothing here converts a timezone: the
 * upstream instant is UTC, the register compares dates as strings, and an
 * operator in Los Angeles must not see a signature slide onto the previous day.
 * A value that is not what `toISOString()` emits is a shape error, because the
 * only producer of this field is `toISOString()`.
 */
function instant(value: unknown, at: string): { on: string; at: string } {
  if (typeof value !== "string") throw new ShapeError(at);

  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/.exec(
    value,
  );
  if (!match) throw new ShapeError(at);

  // Both groups exist whenever the pattern matched, and the pattern is written
  // three lines up. `noUncheckedIndexedAccess` does not know that.
  return { on: match[1]!, at: `${match[1]!} ${match[2]!} UTC` };
}

function optionalInstant(
  value: unknown,
  at: string,
): { on: string; at: string } | null {
  if (value === null || value === undefined) return null;
  return instant(value, at);
}

/**
 * The same check, returning the instant unchanged.
 *
 * For the two fields nothing on a screen reads: they are handed back to the
 * caller as the ISO string upstream sent, because a timestamp that is going to
 * be compared or logged should not have been through a display formatter first.
 */
function isoInstant(value: unknown, at: string): string {
  // The `typeof` is what makes this a narrowing rather than an assertion:
  // `instant()` would already have thrown, and a cast here would be a claim
  // about that rather than a check.
  if (typeof value !== "string") throw new ShapeError(at);
  instant(value, at);
  return value;
}

function optionalIsoInstant(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  return isoInstant(value, at);
}

/**
 * A credential, or an opaque handle, checked for shape and then left alone.
 *
 * Deliberately not `text()`. Everything else that arrives from upstream is
 * prose and gets its whitespace collapsed; these are values somebody types back
 * or hands back verbatim, and one silently reshaped on its way to the single
 * screen that will ever show it is one that will then be refused. So the check
 * is printable ASCII, a sane length, and nothing else.
 *
 * The FORM is upstream's to choose, and it is not second-guessed here: a base32
 * secret grouped with spaces for readability is as valid as one without, and a
 * client that rejected it would break enrolment over a formatting opinion.
 */
function credential(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 1_024 ||
    !/^[\x20-\x7E]+$/.test(value)
  ) {
    throw new ShapeError(at);
  }
  return value;
}

/**
 * An `otpauth://totp/` URI and nothing else.
 *
 * This string is rendered into a QR code that the owner points a phone at, so
 * the scheme is checked at the boundary rather than trusted. A URI of any other
 * scheme arriving here would be a picture of a link this console vouched for,
 * pointed at whatever the answer said.
 */
function otpauth(value: unknown, at: string): string {
  if (
    typeof value !== "string" ||
    value.length > 2_048 ||
    !/^otpauth:\/\/totp\/[\x21-\x7E]+$/.test(value)
  ) {
    throw new ShapeError(at);
  }
  return value;
}

/**
 * An absolute http(s) URL and nothing else.
 *
 * The connection link reaches the browser and gets pasted into a chat window or
 * an email by an operator. A `javascript:` or `data:` value arriving here would
 * be rendered as a link this console vouched for, so the scheme is checked at
 * the boundary rather than at the place it is displayed.
 */
function url(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ShapeError(at);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ShapeError(at);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ShapeError(at);
  }
  return parsed.toString();
}

function readClinic(value: unknown): OpsClinic {
  const row = object(value, "clinic");

  return {
    id: id(row.id, "clinic.id"),
    name: text(row.name, "clinic.name"),
    specialty: text(row.specialty, "clinic.specialty"),
    timezone: text(row.timezone, "clinic.timezone"),
    dataClassification: literal(
      row.dataClassification,
      ["synthetic", "production"],
      "clinic.dataClassification",
    ),
    attributionMode: literal(
      row.attributionMode,
      ["estimated", "verified"],
      "clinic.attributionMode",
    ),
    isCoveredEntity:
      row.isCoveredEntity === null || row.isCoveredEntity === undefined
        ? null
        : bool(row.isCoveredEntity, "clinic.isCoveredEntity"),
    baaSignedOn:
      row.baaSignedOn === null || row.baaSignedOn === undefined
        ? null
        : date(row.baaSignedOn, "clinic.baaSignedOn"),
    blockers: list(row.blockers, "clinic.blockers").map((entry) => {
      const blocker = object(entry, "clinic.blocker");
      return {
        level: literal(
          blocker.level,
          ["blocked", "attention"],
          "clinic.blocker.level",
        ),
        message: text(blocker.message, "clinic.blocker.message"),
      };
    }),
    connection: literal(
      row.connection,
      ["connected", "outstanding", "none", "unknown"],
      "clinic.connection",
    ),
  };
}

function readJob(value: unknown): OpsJob {
  const row = object(value, "job");
  const lastRun = optionalInstant(row.lastRunAt, "job.lastRunAt");
  const running = optionalInstant(row.runningSince, "job.runningSince");

  return {
    name: text(row.name, "job.name"),
    cadence: text(row.cadence, "job.cadence"),
    enabled: bool(row.enabled, "job.enabled"),
    lastRunAt: lastRun?.at ?? null,
    lastRunStatus: optionalText(row.lastRunStatus, "job.lastRunStatus"),
    lastRunNote: optionalText(row.lastRunNote, "job.lastRunNote"),
    runningSince: running?.at ?? null,
    // Absent from an older apps/app means not fenced, which is what it was.
    phaseTwo: row.phaseTwo === true,
  };
}

/**
 * One register row.
 *
 * The retention state is assembled here from three upstream fields rather than
 * trusted as one: `status` says which of the three buckets the row is in, and
 * a terminated row must carry both the date it ended and the floor that follows
 * from it. A row that claims to be terminated with no termination date is a
 * shape error and takes the whole page to an error state, which is the right
 * outcome, half a retention answer on a screen about legal records is worse
 * than none.
 */
function readAgreement(value: unknown): OpsAgreement {
  const row = object(value, "agreement");
  const signed = instant(row.acceptedAt, "agreement.acceptedAt");
  const name = text(row.signatoryName, "agreement.signatoryName");
  const title = optionalText(row.signatoryTitle, "agreement.signatoryTitle");
  const status = literal(
    row.status,
    ["in_effect", "terminated", "retention_review"],
    "agreement.status",
  );

  return {
    id: id(row.id, "agreement.id"),
    clinicName: optionalText(row.clinicLegalName, "agreement.clinicLegalName"),
    version: text(row.version, "agreement.version"),
    signatory: title ? `${name}, ${title}` : name,
    signatoryEmail: text(row.signatoryEmail, "agreement.signatoryEmail"),
    signedAt: signed.at,
    signedOn: signed.on,
    // From the timestamp, not from the `copySent` boolean that travels beside
    // it. Upstream derives that boolean as `copySentAt !== null` for exactly
    // this reason: one definition, so the badge on the row and the `copySent`
    // filter cannot disagree about what "delivered" means.
    copySentOn:
      optionalInstant(row.copySentAt, "agreement.copySentAt")?.on ?? null,
    retention: readRetention(row, status),
    status,
    documentHash: hash(row.documentHash, "agreement.documentHash"),
  };
}

function readRetention(
  row: Record<string, unknown>,
  status: AgreementStatus,
): AgreementRetention {
  if (status === "in_effect") return { state: "live" };

  const terminated = optionalInstant(row.terminatedAt, "agreement.terminatedAt");
  const eligible = optionalInstant(row.eligibleAt, "agreement.eligibleAt");
  if (!terminated || !eligible) throw new ShapeError("agreement.retention");

  return {
    state: "terminated",
    on: terminated.on,
    until: eligible.on,
    // Upstream's own partition decides this, not a comparison made here against
    // a clock in a different process.
    reached: status === "retention_review",
  };
}

/**
 * A SHA-256 in hex, normalised to lower case.
 *
 * Checked rather than printed as it arrives, because this string is the one
 * thing on the register an operator may one day read out to a lawyer. A field
 * that is merely "a string" can be blank, or truncated, or a sentence
 * apologising for itself, and any of those shown under the heading
 * "fingerprint" is worse than an error state.
 */
function hash(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new ShapeError(at);
  }
  return value.toLowerCase();
}

/**
 * The recovery codes, checked and passed through untouched.
 *
 * Deliberately NOT run through `text()`. Everything else that arrives from
 * upstream is prose and gets its whitespace collapsed; these are credentials,
 * and a code silently reshaped on the way to the one screen that will ever show
 * it is a code the owner types back and gets refused. So the check is a shape
 * check, printable ASCII, a sane length, a bounded count, and what passes it
 * is rendered exactly as it arrived.
 *
 * An empty list is a shape error rather than an empty screen: "enrolled, with
 * no way back in if you lose the phone" is not a state to render quietly.
 */
function recoveryCodes(value: unknown): string[] {
  const codes = list(value, "activateTotp.recoveryCodes");
  if (codes.length === 0 || codes.length > 32) {
    throw new ShapeError("activateTotp.recoveryCodes");
  }

  return codes.map((code) => {
    if (typeof code !== "string" || !/^[\x21-\x7E]{4,128}$/.test(code)) {
      throw new ShapeError("activateTotp.recoveryCode");
    }
    return code;
  });
}

function readDelivery(value: unknown): ConnectLinkDelivery {
  const row = object(value, "delivery");
  if (!bool(row.attempted, "delivery.attempted")) return { attempted: false };

  const status = literal(
    row.status,
    ["sent", "skipped", "failed"],
    "delivery.status",
  );

  return status === "sent"
    ? { attempted: true, status }
    : { attempted: true, status, reason: text(row.reason, "delivery.reason") };
}

// -----------------------------------------------------------------------------
// Onboarding
// -----------------------------------------------------------------------------

export type OnboardingStepView = {
  id: string;
  title: string;
  why: string;
  required: boolean;
  completedAt: string | null;
};

export type AgentService = {
  name: string;
  /** Dollars, to the cent. */
  priceFromUsd: number | null;
  priceToUsd: number | null;
  durationMinutes: number | null;
  /**
   * What the clinic's setup and Knowledge add to a service: how the price is
   * stated, a per-unit price's unit and the deposit. The console shows them
   * and sends them back as it got them; it does not edit them. apps/app also
   * keeps the stored ones for a service sent without them.
   */
  priceKind?: ServicePriceKind | null;
  unit?: string | null;
  /** The service's own deposit in dollars; null or absent means the clinic default. */
  depositUsd?: number | null;
};

export type ServicePriceKind = "exact" | "from" | "range" | "per_unit";
const SERVICE_PRICE_KINDS: readonly ServicePriceKind[] = ["exact", "from", "range", "per_unit"];

/**
 * One service from getOnboarding, keeping what the clinic set beyond the
 * console's four fields. Dropping them here used to send every service back
 * without its kind, unit and deposit, and a greeting edit erased them.
 */
export function readAgentService(entry: unknown): AgentService {
  const row = object(entry, "service");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const service: AgentService = {
    name: text(row.name, "service.name"),
    priceFromUsd: num(row.priceFromUsd),
    priceToUsd: num(row.priceToUsd),
    durationMinutes: num(row.durationMinutes),
  };
  // Kept only when present and well formed, so what the console sends back
  // is what it was given, and a key it never had stays absent for apps/app
  // to fill from the stored service.
  if (row.priceKind === null || SERVICE_PRICE_KINDS.includes(row.priceKind as ServicePriceKind)) {
    service.priceKind = row.priceKind as ServicePriceKind | null;
  }
  if (row.unit === null) service.unit = null;
  else if (typeof row.unit === "string") service.unit = text(row.unit, "service.unit");
  if (row.depositUsd === null || num(row.depositUsd) !== null) {
    service.depositUsd = num(row.depositUsd);
  }
  return service;
}

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
  steps: OnboardingStepView[];
  forwardingTest: {
    windowUntil: string | null;
    observed: { arrivedAt: string; callerIdPreserved: boolean; condition: string } | null;
  };
  stripeConnect: { accountId: string | null; connectedAt: string | null; authorizeUrl: string | null };
  meta: {
    enabled: boolean;
    /**
     * The clinic's own Instagram, Messenger and WhatsApp switches (Settings),
     * beneath the front door: both must be on for a message to be answered.
     * Null from an apps/app that predates them.
     */
    platforms: Record<MetaPlatform, boolean> | null;
    channels: { platform: MetaPlatform; externalId: string; label: string | null; status: string }[];
    /** Booking requests handed to the desk in the last 30 days. Counts only; the requests live behind the desk's link. */
    bookingRequests: { waiting: number; accepted: number; confirmed: number; declined: number };
  };
  forwarding: {
    steps: { label: string; dial: string }[];
    undo: { label: string; dial: string }[];
    notes: string[];
    needsCarrierHelp: boolean;
  } | null;
  agent: {
    version: number;
    greeting: string;
    services: AgentService[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
    depositPolicy: DepositPolicy | null;
    approvedAt: string | null;
    approvedByLabel: string | null;
  } | null;
  goLive: { ok: true } | { ok: false; missing: string[] };
  /** The booking requirement set: resolved ids, who settled it, and the catalogue to edit it with. */
  requirements: {
    fields: string[];
    confirmedAt: string | null;
    source: "practice" | "operator" | "defaults" | null;
    setupLinkOutstanding: boolean;
    catalogue: { id: string; label: string; locked: boolean; phoneOnly: boolean }[];
    neverAsked: string[];
  };
  timezoneConfirmedAt: string | null;
  timezone: string;
  calendarWrites: CalendarWriteRow[];
  /**
   * The location's booking mode and every reason for it, Auto-confirm, the
   * kill switch, the calendar terms and the Google Calendar connection, as
   * apps/app derives them (plan §10). Null only from an apps/app older than
   * the projection; "unreadable" when apps/app sent one this console could
   * not read. Either way the two cards say so rather than guessing a mode,
   * and the rest of the page still shows.
   */
  booking: BookingView | "unreadable" | null;
};

/** One reason a location takes requests: apps/app's code, and its sentence in the clinic's words. */
export type BookingReason = { code: string; sentence: string };

export type CalendarTermsKind = "none" | "needs_election" | "covered" | "uncovered" | "not_used";
const CALENDAR_TERMS_KINDS: readonly CalendarTermsKind[] = ["none", "needs_election", "covered", "uncovered", "not_used"];

export type CalendarConnectionStatus = "pending" | "active" | "degraded" | "error" | "revoked";
const CALENDAR_CONNECTION_STATUSES: readonly CalendarConnectionStatus[] = ["pending", "active", "degraded", "error", "revoked"];

/**
 * getOnboarding's `booking`. Configuration and counts: never the Google
 * account's address or the calendar's own zone, which apps/app keeps back.
 * Instants are the "YYYY-MM-DD HH:MM UTC" this console shows.
 */
export type BookingView = {
  /**
   * `live`: the location's settings allow booking straight into its calendar;
   * which channels can is not this field's to say. `manual`: every booking is
   * a request.
   */
  mode: "live" | "manual";
  /** Real free times are on offer, whether the chosen one is booked or requested. */
  canOfferTimes: boolean;
  /** Every reason that applies, in apps/app's order; empty exactly when live. */
  reasons: BookingReason[];
  autoConfirm: boolean;
  autoConfirmChangedAt: string | null;
  /** HEALDESK_DIRECT_BOOKING_ENABLED, the owner's: shown, never set from here. */
  killSwitchOn: boolean;
  demo: boolean;
  terms: {
    kind: CalendarTermsKind;
    source: "agreement" | "calendar_link" | "portal" | null;
    clauseId: string | null;
    documentVersion: string | null;
    /** Null when no terms are in effect. */
    documentReleased: boolean | null;
    electedAt: string | null;
    /** Why no terms are in effect; null when they are. */
    reason: string | null;
  };
  calendar: {
    connectionId: string;
    status: CalendarConnectionStatus;
    accountKind: "workspace" | "personal" | null;
    hostedDomain: string | null;
    timeZoneMatches: boolean | null;
    disclosureCurrent: boolean;
    connectedAt: string | null;
    lastVerifiedAt: string | null;
    lastError: string | null;
    brokenAt: string | null;
  } | null;
  calendarLinkOutstanding: boolean;
  pendingAssistantWrites: number;
};

export type PhiBasis = "vendor_baa" | "practice_account";
export type CalendarWriteRow = {
  appointmentId: string;
  slotAt: string;
  status: "writing" | "written" | "failed" | "unknown";
  error: string | null;
  requestChannel: "voice" | "meta" | "web_chat";
};

export type DepositPolicy = { required: boolean; amountUsd: number | null; collection: "front_desk" | "stripe_connect" };
export type MetaPlatform = "messenger" | "instagram" | "whatsapp";
export const META_PLATFORMS: readonly MetaPlatform[] = ["messenger", "instagram", "whatsapp"];

export type SimpleOutcome = { status: "updated" } | { status: "refused"; message: string };
export type GoLiveOutcome =
  | { status: "live"; baaSignedOn: string }
  | { status: "refused"; message: string; missing: string[] };

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOnboardingView(value: unknown): OnboardingView {
  const data = object(value, "getOnboarding");
  const clinic = object(data.clinic, "getOnboarding.clinic");
  const forwarding = data.forwarding ? object(data.forwarding, "getOnboarding.forwarding") : null;
  const agent = data.agent ? object(data.agent, "getOnboarding.agent") : null;
  const goLiveRaw = object(data.goLive, "getOnboarding.goLive");
  const pair = (entry: unknown) => {
    const row = object(entry, "forwarding.step");
    return { label: text(row.label, "forwarding.label"), dial: typeof row.dial === "string" ? row.dial : "" };
  };
  return {
    clinic: {
      id: id(clinic.id, "clinic.id"),
      slug: text(clinic.slug, "clinic.slug"),
      name: text(clinic.name, "clinic.name"),
      specialty: text(clinic.specialty, "clinic.specialty"),
      timezone: text(clinic.timezone, "clinic.timezone"),
      dataClassification: literal(clinic.dataClassification, ["synthetic", "production"], "clinic.dataClassification"),
      attributionMode: literal(clinic.attributionMode, ["estimated", "verified"], "clinic.attributionMode"),
      isCoveredEntity: typeof clinic.isCoveredEntity === "boolean" ? clinic.isCoveredEntity : null,
      phoneSystemType: literal(clinic.phoneSystemType, ["landline", "voip", "unknown"], "clinic.phoneSystemType"),
      callRouting: literal(clinic.callRouting, ["conditional", "always"], "clinic.callRouting"),
      callRoutingConfirmedAt: optionalString(clinic.callRoutingConfirmedAt),
      carrier: optionalString(clinic.carrier),
      synthflowNumberE164: optionalString(clinic.synthflowNumberE164),
      publishedPhoneE164: optionalString(clinic.publishedPhoneE164),
      openingHoursPresent: bool(clinic.openingHoursPresent, "clinic.openingHoursPresent"),
      wentLiveAt: optionalString(clinic.wentLiveAt),
    },
    forwardingTest: (() => {
      const ft = object(data.forwardingTest ?? {}, "getOnboarding.forwardingTest");
      const observed = ft.observed ? object(ft.observed, "forwardingTest.observed") : null;
      return {
        windowUntil: optionalString(ft.windowUntil),
        observed: observed
          ? {
              arrivedAt: text(observed.arrivedAt, "forwardingTest.arrivedAt"),
              callerIdPreserved: bool(observed.callerIdPreserved, "forwardingTest.callerIdPreserved"),
              condition: text(observed.condition, "forwardingTest.condition"),
            }
          : null,
      };
    })(),
    stripeConnect: (() => {
      const sc = object(data.stripeConnect ?? {}, "getOnboarding.stripeConnect");
      const url = optionalString(sc.authorizeUrl);
      return {
        accountId: optionalString(sc.accountId),
        connectedAt: optionalString(sc.connectedAt),
        authorizeUrl: url && url.startsWith("https://connect.stripe.com/") ? url : null,
      };
    })(),
    meta: (() => {
      const m = object(data.meta ?? {}, "getOnboarding.meta");
      const br = object(m.bookingRequests ?? {}, "meta.bookingRequests");
      const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
      const platforms =
        m.platforms === undefined || m.platforms === null
          ? null
          : (() => {
              const p = object(m.platforms, "meta.platforms");
              return {
                instagram: bool(p.instagram, "meta.platforms.instagram"),
                messenger: bool(p.messenger, "meta.platforms.messenger"),
                whatsapp: bool(p.whatsapp, "meta.platforms.whatsapp"),
              };
            })();
      return {
        enabled: m.enabled === true,
        platforms,
        bookingRequests: { waiting: count(br.waiting), accepted: count(br.accepted), confirmed: count(br.confirmed), declined: count(br.declined) },
        channels: list(m.channels ?? [], "meta.channels").map((entry) => {
          const ch = object(entry, "meta.channel");
          return {
            platform: literal(ch.platform, META_PLATFORMS, "meta.channel.platform"),
            externalId: text(ch.externalId, "meta.channel.externalId"),
            label: optionalText(ch.label, "meta.channel.label"),
            status: text(ch.status, "meta.channel.status"),
          };
        }),
      };
    })(),
    steps: list(data.steps, "getOnboarding.steps").map((entry) => {
      const row = object(entry, "step");
      return {
        id: text(row.id, "step.id"),
        title: text(row.title, "step.title"),
        why: text(row.why, "step.why"),
        required: bool(row.required, "step.required"),
        completedAt: optionalString(row.completedAt),
      };
    }),
    forwarding: forwarding
      ? {
          steps: list(forwarding.steps, "forwarding.steps").map(pair),
          undo: list(forwarding.undo, "forwarding.undo").map(pair),
          notes: list(forwarding.notes, "forwarding.notes").map((n) => text(n, "forwarding.note")),
          needsCarrierHelp: bool(forwarding.needsCarrierHelp, "forwarding.needsCarrierHelp"),
        }
      : null,
    agent: agent
      ? {
          version: count(agent.version, "agent.version"),
          greeting: editable(agent.greeting, "agent.greeting", MAX_GREETING),
          // Read back with what the clinic set beyond the console's four
          // fields, its deposit included, so a save of the script carries
          // them rather than wiping them (readAgentService).
          services: list(agent.services, "agent.services").map(readAgentService),
          escalationPhone: optionalString(agent.escalationPhone),
          escalationHours: optionalString(agent.escalationHours),
          notes: optionalString(agent.notes),
          depositPolicy: (() => {
            const d = agent.depositPolicy && typeof agent.depositPolicy === "object" ? (agent.depositPolicy as Record<string, unknown>) : null;
            if (!d || d.required !== true) return null;
            return {
              required: true,
              amountUsd: typeof d.amountUsd === "number" ? d.amountUsd : null,
              collection: d.collection === "stripe_connect" ? ("stripe_connect" as const) : ("front_desk" as const),
            };
          })(),
          approvedAt: optionalString(agent.approvedAt),
          approvedByLabel: optionalString(agent.approvedByLabel),
        }
      : null,
    goLive: goLiveRaw.ok === true
      ? { ok: true }
      : { ok: false, missing: list(goLiveRaw.missing, "goLive.missing").map((m) => text(m, "goLive.missing")) },
    requirements: (() => {
      const r = object(data.requirements ?? {}, "getOnboarding.requirements");
      const src = optionalString(r.source);
      return {
        fields: list(r.fields ?? [], "requirements.fields").map((f) => text(f, "requirements.field")),
        confirmedAt: optionalString(r.confirmedAt),
        source: src === "practice" || src === "operator" || src === "defaults" ? src : null,
        setupLinkOutstanding: r.setupLinkOutstanding === true,
        catalogue: list(r.catalogue ?? [], "requirements.catalogue").map((entry) => {
          const f = object(entry, "requirements.catalogue.field");
          return { id: text(f.id, "field.id"), label: text(f.label, "field.label"), locked: f.locked === true, phoneOnly: f.phoneOnly === true };
        }),
        neverAsked: list(r.neverAsked ?? [], "requirements.neverAsked").map((n) => text(n, "requirements.neverAsked")),
      };
    })(),
    timezoneConfirmedAt: optionalString(data.timezoneConfirmedAt),
    timezone: optionalString(data.timezone) ?? text(clinic.timezone, "clinic.timezone"),
    calendarWrites: list(data.calendarWrites ?? [], "getOnboarding.calendarWrites").map(readCalendarWrite),
    booking: data.booking === undefined ? null : readBookingOrUnreadable(data.booking),
  };
}

/**
 * The booking card's state on its own: a shape it cannot read leaves the two
 * cards that show it saying so, not the whole onboarding page blank, and
 * still never a mode guessed from what was readable.
 */
function readBookingOrUnreadable(value: unknown): BookingView | "unreadable" {
  try {
    return readBookingView(value);
  } catch (error) {
    if (!(error instanceof ShapeError)) throw error;
    console.error("[healdesk] admin ops: getOnboarding answered an unexpected shape at", error.message);
    return "unreadable";
  }
}

/** A code apps/app names a reason or a state by: lower-case words and underscores. */
function code(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new ShapeError(at);
  return value;
}

function optionalBool(value: unknown, at: string): boolean | null {
  return value === null || value === undefined ? null : bool(value, at);
}

function readReasons(value: unknown, at: string): BookingReason[] {
  return list(value, at).map((entry) => {
    const r = object(entry, `${at}.reason`);
    return { code: code(r.code, `${at}.code`), sentence: text(r.sentence, `${at}.sentence`) };
  });
}

/**
 * Strict, field by field: this card tells an operator whether a clinic's
 * patients are booked straight into its calendar, so a reply it cannot read
 * is an error on the page, never a mode guessed from what is missing.
 */
function readBookingView(value: unknown): BookingView {
  const b = object(value, "booking");
  const t = object(b.terms, "booking.terms");
  const c = b.calendar === null ? null : object(b.calendar, "booking.calendar");
  const source = t.source === null ? null : literal(t.source, ["agreement", "calendar_link", "portal"], "booking.terms.source");
  return {
    mode: literal(b.mode, ["live", "manual"], "booking.mode"),
    canOfferTimes: bool(b.canOfferTimes, "booking.canOfferTimes"),
    reasons: readReasons(b.reasons, "booking.reasons"),
    autoConfirm: bool(b.autoConfirm, "booking.autoConfirm"),
    autoConfirmChangedAt: optionalInstant(b.autoConfirmChangedAt, "booking.autoConfirmChangedAt")?.at ?? null,
    killSwitchOn: bool(b.killSwitchOn, "booking.killSwitchOn"),
    demo: bool(b.demo, "booking.demo"),
    terms: {
      kind: literal(t.kind, CALENDAR_TERMS_KINDS, "booking.terms.kind"),
      source,
      clauseId: optionalText(t.clauseId, "booking.terms.clauseId"),
      documentVersion: optionalText(t.documentVersion, "booking.terms.documentVersion"),
      documentReleased: optionalBool(t.documentReleased, "booking.terms.documentReleased"),
      electedAt: optionalInstant(t.electedAt, "booking.terms.electedAt")?.at ?? null,
      reason: t.reason === null || t.reason === undefined ? null : code(t.reason, "booking.terms.reason"),
    },
    calendar: c
      ? {
          connectionId: id(c.connectionId, "booking.calendar.connectionId"),
          status: literal(c.status, CALENDAR_CONNECTION_STATUSES, "booking.calendar.status"),
          accountKind: c.accountKind === null ? null : literal(c.accountKind, ["workspace", "personal"] as const, "booking.calendar.accountKind"),
          hostedDomain: optionalText(c.hostedDomain, "booking.calendar.hostedDomain"),
          timeZoneMatches: optionalBool(c.timeZoneMatches, "booking.calendar.timeZoneMatches"),
          disclosureCurrent: bool(c.disclosureCurrent, "booking.calendar.disclosureCurrent"),
          connectedAt: optionalInstant(c.connectedAt, "booking.calendar.connectedAt")?.at ?? null,
          lastVerifiedAt: optionalInstant(c.lastVerifiedAt, "booking.calendar.lastVerifiedAt")?.at ?? null,
          lastError: optionalText(c.lastError, "booking.calendar.lastError"),
          brokenAt: optionalInstant(c.brokenAt, "booking.calendar.brokenAt")?.at ?? null,
        }
      : null,
    calendarLinkOutstanding: bool(b.calendarLinkOutstanding, "booking.calendarLinkOutstanding"),
    pendingAssistantWrites: count(b.pendingAssistantWrites, "booking.pendingAssistantWrites"),
  };
}

function readCalendarWrite(entry: unknown): CalendarWriteRow {
  const w = object(entry, "calendarWrite");
  return {
    appointmentId: id(w.appointmentId, "calendarWrite.appointmentId"),
    slotAt: text(w.slotAt, "calendarWrite.slotAt"),
    status: literal(w.status, ["writing", "written", "failed", "unknown"], "calendarWrite.status"),
    error: optionalText(w.error, "calendarWrite.error"),
    requestChannel: literal(w.requestChannel, ["voice", "meta", "web_chat"], "calendarWrite.requestChannel"),
  };
}

export function fetchOnboarding(clinicId: string): Promise<OpsResult<OnboardingView>> {
  return callOps("getOnboarding", "read", { clinicId }, readOnboardingView);
}

function simple(op: OperatorOp, args: Record<string, unknown>): Promise<OpsResult<SimpleOutcome>> {
  return callOps(op, "write", args, (value) => {
    const data = object(value, op);
    if (state(data, op) !== "updated") return refusal(data, op);
    return { status: "updated" };
  });
}

export function completeOnboardingStep(clinicId: string, step: string, note?: string) {
  return simple("completeOnboardingStep", { clinicId, step, ...(note ? { note } : {}) });
}

export function reopenOnboardingStep(clinicId: string, step: string, note?: string) {
  return simple("reopenOnboardingStep", { clinicId, step, ...(note ? { note } : {}) });
}

export function setPhoneSettings(
  clinicId: string,
  settings: {
    phoneSystemType?: "landline" | "voip" | "unknown";
    callRouting?: "conditional" | "always";
    carrier?: string | null;
    synthflowNumberE164?: string | null;
    publishedPhoneE164?: string | null;
  },
) {
  return simple("setPhoneSettings", { clinicId, ...settings });
}

export function updateAgentConfig(
  clinicId: string,
  input: {
    greeting: string;
    services: AgentService[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
    depositPolicy: DepositPolicy | null;
  },
) {
  return simple("updateAgentConfig", { clinicId, ...input });
}

export function approveAgentConfig(clinicId: string, approvedBy: string) {
  return simple("approveAgentConfig", { clinicId, approvedBy });
}

export function goLive(clinicId: string): Promise<OpsResult<GoLiveOutcome>> {
  return callOps("goLive", "write", { clinicId }, (value) => {
    const data = object(value, "goLive");
    const s = state(data, "goLive");
    if (s === "live") return { status: "live", baaSignedOn: date(data.baaSignedOn, "goLive.baaSignedOn") };
    if (s === "refused") {
      return {
        status: "refused",
        message: text(data.message, "goLive.message"),
        missing: list(data.missing ?? [], "goLive.missing").map((m) => text(m, "goLive.missing")),
      };
    }
    throw new Error(text(data.message, "goLive.message"));
  });
}


// -----------------------------------------------------------------------------
// Care: recipients, deliveries, incidents, offboarding
// -----------------------------------------------------------------------------

/**
 * One clinic's care view. Configuration and ledgers, never a patient: the
 * incident summaries were PHI-scanned by the ops API before they were stored,
 * and the patient-rights export is a script on the app host, not a page here.
 */
export type CareView = {
  clinic: {
    id: string;
    slug: string;
    name: string;
    dataClassification: "synthetic" | "production";
    isCoveredEntity: boolean | null;
    wentLiveOn: string | null;
    offboardingStartedOn: string | null;
    exportDeliveredOn: string | null;
    destroyAfterOn: string | null;
    destroyedOn: string | null;
    /**
     * When the clinic's data goes, by the rule of the agreement its service
     * ended under (destructionPlan in apps/app's lib/offboarding), as
     * "YYYY-MM-DD HH:MM UTC". Null while it is not offboarding.
     */
    destruction: {
      rule: "thirty_days" | "export_or_ninety";
      basis: "agreement" | "no_agreement" | "unknown_version";
      agreementVersion: string | null;
      exportDueAt: string;
      destroyDueAt: string;
      latestDestroyAt: string;
    } | null;
    /** The clinic's calls and agent deleted at the voice vendor: outstanding until recordedAt. */
    voiceVendorDeletion: {
      deadline: string;
      recordedAt: string | null;
      recordedBy: string | null;
      how: string | null;
    } | null;
  };
  /**
   * The clinic's deletion requests (apps/app lib/patient-rights/erasure.ts),
   * newest first: who asked (one of three, as a label), the dates as "YYYY-MM-DD HH:MM
   * UTC", the counts, and each subcontractor step, outstanding until stamped.
   * Nothing here names the person: apps/app sends no number, address or
   * reference to one.
   */
  /** How many amendments and contact corrections the practice has directed: counts only. */
  patientRights: { amendments: number; corrections: number };
  deletionRequests: {
    id: string;
    /** One of REQUESTER_LABELS (lib/admin/patient-rights.ts); the reader refuses anything else. */
    requestedBy: (typeof REQUESTER_LABELS)[number];
    receivedAt: string;
    dueBy: string;
    erasedAt: string;
    /** Rows deleted, summed across the tables the deletion reached. */
    rows: number;
    /** When the restore references are emptied, or null once they have been. */
    restoreRecordUntil: string | null;
    steps: {
      id: "retell";
      label: string;
      stampedAt: string | null;
      stampedBy: string | null;
      /** One of ERASURE_STEP_OUTCOMES' labels, never typed text; the reader refuses anything else. */
      how: (typeof ERASURE_STEP_OUTCOMES)[ErasureStepOutcome] | null;
    }[];
  }[];
  recipients: { email: string; label: string | null; addedBy: string; addedOn: string }[];
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

// Defined in lib/admin/incident-classes.ts so client components never import
// a value from this server-only module; re-exported here for server callers.
export { INCIDENT_CLASSES, type IncidentClass } from "@/lib/admin/incident-classes";
import {
  ERASURE_STEP_OUTCOMES,
  REQUESTER_LABELS,
  type ErasureStepOutcome,
} from "@/lib/admin/patient-rights";

function readCareView(value: unknown): CareView {
  const data = object(value, "getClinicCare");
  const clinic = object(data.clinic, "getClinicCare.clinic");
  const on = (v: unknown, at: string) => optionalInstant(v, at)?.on ?? null;
  return {
    clinic: {
      id: id(clinic.id, "care.clinic.id"),
      slug: text(clinic.slug, "care.clinic.slug"),
      name: text(clinic.name, "care.clinic.name"),
      dataClassification: literal(clinic.dataClassification, ["synthetic", "production"], "care.clinic.dataClassification"),
      isCoveredEntity:
        clinic.isCoveredEntity === null || clinic.isCoveredEntity === undefined
          ? null
          : bool(clinic.isCoveredEntity, "care.clinic.isCoveredEntity"),
      wentLiveOn: on(clinic.wentLiveAt, "care.clinic.wentLiveAt"),
      offboardingStartedOn: on(clinic.offboardingStartedAt, "care.clinic.offboardingStartedAt"),
      exportDeliveredOn: on(clinic.exportDeliveredAt, "care.clinic.exportDeliveredAt"),
      destroyAfterOn: on(clinic.destroyAfter, "care.clinic.destroyAfter"),
      destroyedOn: on(clinic.destroyedAt, "care.clinic.destroyedAt"),
      destruction: readDestruction(clinic.destruction),
      voiceVendorDeletion: readVoiceVendorDeletion(clinic.voiceVendorDeletion),
    },
    patientRights: readPatientRights(data.patientRights),
    deletionRequests: list(data.deletionRequests ?? [], "care.deletionRequests").map((entry) => {
      const d = object(entry, "care.deletionRequest");
      const deleted = object(d.deleted, "care.deletionRequest.deleted");
      return {
        id: id(d.id, "care.deletionRequest.id"),
        requestedBy: literal(d.requestedBy, REQUESTER_LABELS, "care.deletionRequest.requestedBy"),
        receivedAt: instant(d.receivedAt, "care.deletionRequest.receivedAt").at,
        dueBy: instant(d.dueBy, "care.deletionRequest.dueBy").at,
        erasedAt: instant(d.erasedAt, "care.deletionRequest.erasedAt").at,
        rows: Object.entries(deleted).reduce((sum, [key, n]) => sum + count(n, `care.deletionRequest.deleted.${key}`), 0),
        restoreRecordUntil: optionalInstant(d.restoreRecordUntil, "care.deletionRequest.restoreRecordUntil")?.on ?? null,
        steps: list(d.steps, "care.deletionRequest.steps").map((value) => {
          const step = object(value, "care.deletionRequest.step");
          return {
            id: literal(step.id, ["retell"] as const, "care.deletionRequest.step.id"),
            label: text(step.label, "care.deletionRequest.step.label"),
            stampedAt: optionalInstant(step.stampedAt, "care.deletionRequest.step.stampedAt")?.at ?? null,
            stampedBy: optionalText(step.stampedBy, "care.deletionRequest.step.stampedBy"),
            how:
              step.how === null || step.how === undefined
                ? null
                : literal(step.how, Object.values(ERASURE_STEP_OUTCOMES), "care.deletionRequest.step.how"),
          };
        }),
      };
    }),
    recipients: list(data.recipients, "care.recipients").map((entry) => {
      const r = object(entry, "care.recipient");
      return {
        email: text(r.email, "care.recipient.email"),
        label: optionalText(r.label, "care.recipient.label"),
        addedBy: text(r.addedBy, "care.recipient.addedBy"),
        addedOn: instant(r.addedAt, "care.recipient.addedAt").on,
      };
    }),
    deliveries: list(data.deliveries, "care.deliveries").map((entry) => {
      const d = object(entry, "care.delivery");
      return {
        kind: text(d.kind, "care.delivery.kind"),
        periodKey: text(d.periodKey, "care.delivery.periodKey"),
        recipient: text(d.recipient, "care.delivery.recipient"),
        status: text(d.status, "care.delivery.status"),
        reason: optionalText(d.reason, "care.delivery.reason"),
        attemptedAt: instant(d.attemptedAt, "care.delivery.attemptedAt").at,
      };
    }),
    incidents: list(data.incidents, "care.incidents").map((entry) => {
      const i = object(entry, "care.incident");
      return {
        id: id(i.id, "care.incident.id"),
        class: literal(i.class, INCIDENT_CLASSES, "care.incident.class"),
        summary: text(i.summary, "care.incident.summary"),
        conversationId: i.conversationId === null || i.conversationId === undefined ? null : id(i.conversationId, "care.incident.conversationId"),
        discoveredAt: instant(i.discoveredAt, "care.incident.discoveredAt").at,
        notifyBy: instant(i.notifyBy, "care.incident.notifyBy").at,
        ftcNotifyBy: optionalInstant(i.ftcNotifyBy, "care.incident.ftcNotifyBy")?.on ?? null,
        notifiedAt: optionalInstant(i.notifiedAt, "care.incident.notifiedAt")?.at ?? null,
        notifiedHow: optionalText(i.notifiedHow, "care.incident.notifiedHow"),
        resolvedAt: optionalInstant(i.resolvedAt, "care.incident.resolvedAt")?.at ?? null,
        resolution: optionalText(i.resolution, "care.incident.resolution"),
        openedBy: text(i.openedBy, "care.incident.openedBy"),
      };
    }),
  };
}

function readPatientRights(value: unknown): CareView["patientRights"] {
  if (value === null || value === undefined) return { amendments: 0, corrections: 0 };
  const p = object(value, "care.patientRights");
  return {
    amendments: count(p.amendments, "care.patientRights.amendments"),
    corrections: count(p.corrections, "care.patientRights.corrections"),
  };
}

function readDestruction(value: unknown): CareView["clinic"]["destruction"] {
  if (value === null || value === undefined) return null;
  const d = object(value, "care.clinic.destruction");
  return {
    rule: literal(d.rule, ["thirty_days", "export_or_ninety"], "care.clinic.destruction.rule"),
    basis: literal(d.basis, ["agreement", "no_agreement", "unknown_version"], "care.clinic.destruction.basis"),
    agreementVersion: optionalText(d.agreementVersion, "care.clinic.destruction.agreementVersion"),
    exportDueAt: instant(d.exportDueBy, "care.clinic.destruction.exportDueBy").at,
    destroyDueAt: instant(d.destroyDueAt, "care.clinic.destruction.destroyDueAt").at,
    latestDestroyAt: instant(d.latestDestroyAt, "care.clinic.destruction.latestDestroyAt").at,
  };
}

function readVoiceVendorDeletion(value: unknown): CareView["clinic"]["voiceVendorDeletion"] {
  if (value === null || value === undefined) return null;
  const d = object(value, "care.clinic.voiceVendorDeletion");
  return {
    deadline: instant(d.deadline, "care.clinic.voiceVendorDeletion.deadline").at,
    recordedAt: optionalInstant(d.recordedAt, "care.clinic.voiceVendorDeletion.recordedAt")?.at ?? null,
    recordedBy: optionalText(d.recordedBy, "care.clinic.voiceVendorDeletion.recordedBy"),
    how: optionalText(d.how, "care.clinic.voiceVendorDeletion.how"),
  };
}

export function fetchClinicCare(clinicId: string): Promise<OpsResult<CareView>> {
  return callOps("getClinicCare", "read", { clinicId }, readCareView);
}

export type CareOutcome = { status: "updated" } | { status: "refused"; message: string };

function careWrite(op: OperatorOp, args: Record<string, unknown>): Promise<OpsResult<CareOutcome>> {
  return callOps(op, "write", args, (value) => {
    const data = object(value, op);
    if (state(data, op) !== "updated") return refusal(data, op);
    return { status: "updated" };
  });
}

export function addReportRecipient(clinicId: string, email: string, label?: string) {
  return careWrite("addReportRecipient", { clinicId, email, ...(label ? { label } : {}) });
}
export function removeReportRecipient(clinicId: string, email: string) {
  return careWrite("removeReportRecipient", { clinicId, email });
}
export function markIncidentNotified(clinicId: string, incidentId: string, how: string) {
  return careWrite("markIncidentNotified", { clinicId, incidentId, how });
}
export function resolveIncident(clinicId: string, incidentId: string, resolution: string) {
  return careWrite("resolveIncident", { clinicId, incidentId, resolution });
}
export function startOffboarding(clinicId: string, reason: string) {
  return careWrite("startOffboarding", { clinicId, reason });
}
export function markExportDelivered(clinicId: string, how: string) {
  return careWrite("markExportDelivered", { clinicId, how });
}
export function markVoiceVendorDataDeleted(clinicId: string, how: string) {
  return careWrite("markVoiceVendorDataDeleted", { clinicId, how });
}

/**
 * The operator's record that a subcontractor deleted what it held about a
 * person: the request's id, the step and a closed outcome, nothing typed.
 * The deletion itself runs in apps/app's shell, never here.
 */
export function markErasureVendorDeleted(
  clinicId: string,
  erasureId: string,
  step: "retell",
  how: ErasureStepOutcome,
) {
  return careWrite("markErasureVendorDeleted", { clinicId, erasureId, step, how });
}


export type OpenIncidentOutcome =
  | { status: "opened"; id: string; notifyBy: string; ftcNotifyBy: string | null }
  | { status: "refused"; message: string };

export function openIncident(
  clinicId: string,
  input: { class: IncidentClass; summary: string; conversationId?: string; discoveredAt?: string },
): Promise<OpsResult<OpenIncidentOutcome>> {
  return callOps("openIncident", "write", { clinicId, ...input }, (value) => {
    const data = object(value, "openIncident");
    if (state(data, "openIncident") !== "opened") return refusal(data, "openIncident");
    return {
      status: "opened",
      id: id(data.id, "openIncident.id"),
      notifyBy: instant(data.notifyBy, "openIncident.notifyBy").at,
      ftcNotifyBy: optionalInstant(data.ftcNotifyBy, "openIncident.ftcNotifyBy")?.on ?? null,
    };
  });
}

// -----------------------------------------------------------------------------
// Billing: one clinic's subscription, usage, switches and the billing engine's
// ledgers (build spec §7 E, R35)
//
// The projection is apps/app's (lib/ops/billing.ts): no event or notice
// payload ever crosses, parked events arrive as ids, types and codes, money as
// integer cents. Every field is still checked here, because a page that offers
// a refund button must not render half an answer: one field out of shape and
// the panel shows the malformed state instead.
// -----------------------------------------------------------------------------

export type BillingStatus =
  | "demo"
  | "provisioning"
  | "active"
  | "past_due"
  | "suspended"
  | "paused"
  | "canceling"
  | "canceled"
  | "purged";
const BILLING_STATUSES: readonly BillingStatus[] = [
  "demo",
  "provisioning",
  "active",
  "past_due",
  "suspended",
  "paused",
  "canceling",
  "canceled",
  "purged",
];

export type BillingChannel = "web" | "meta" | "voice";
const BILLING_CHANNELS: readonly BillingChannel[] = ["web", "meta", "voice"];
export type ChannelStatusWord = "off" | "paused" | "live" | "waiting" | "setting_up";
export type ChannelWaitingOn =
  "setup" | "forwarding" | "snippet" | "meta_connect" | "whatsapp_payment_method";
const CHANNEL_WAITING_ON: readonly ChannelWaitingOn[] = [
  "setup",
  "forwarding",
  "snippet",
  "meta_connect",
  "whatsapp_payment_method",
];
export type BillingRequestKind = "plan_start" | "step_up" | "close_setup" | "cancel_now";
const REQUEST_OUTCOMES = ["done", "skipped", "dead_letter"] as const;
export type RefundKind = "first_period_cancel" | "guarantee" | "agreement_terminated";
export type DepositUncollectable = "book_and_flag" | "hold_and_alert" | "decline_and_alert";
export type UsageMeter = "voice_minutes" | "chat_conversations";

/** A catalog package: its id as stored, and its name for the screen (the id again when the catalog no longer sells it). */
export type PlanRef = { id: string; name: string };

export type ClinicBillingView = {
  clinic: {
    id: string;
    slug: string;
    name: string;
    dataClassification: "synthetic" | "production";
    /** The clinic holding the subscription: this one, or the one this location is billed on. */
    billingClinicId: string;
    isLocation: boolean;
  };
  /** The billing clinic and every location billed on it, billing clinic first. */
  group: {
    clinicId: string;
    slug: string | null;
    name: string | null;
    isBillingClinic: boolean;
    channels: {
      channel: BillingChannel;
      enabled: boolean;
      status: ChannelStatusWord;
      readyOn: string | null;
      waitingOn: ChannelWaitingOn | null;
      liveOn: string | null;
      firstAnswerOn: string | null;
    }[];
  }[];
  channelsInService: BillingChannel[];
  /** Null when the clinic has no billing row (synthetic, demo). */
  entitlements: {
    status: BillingStatus;
    boughtPlan: PlanRef | null;
    billedPlan: PlanRef;
    isLegacy: boolean;
    interval: "month" | "year";
    locations: number;
    planStartedAt: string | null;
    planStartAppliedAt: string | null;
    isPlanStarted: boolean;
    paidThroughOn: string | null;
    graceEndsAt: string | null;
    cancelAt: string | null;
    closesOn: string | null;
    overageMode: "allow" | "hard_cap";
    usageAlertsEnabled: boolean;
    firstPeriodRefundedAt: string | null;
    setupDeadlineAt: string | null;
    /** The instant exactly as upstream sent it: extending the window sends it back as its precondition. */
    setupDeadlineIso: string | null;
    openInvoice: { url: string | null; amountCents: number | null } | null;
    hasSubscription: boolean;
    isMutationInFlight: boolean;
  } | null;
  usage: {
    meter: UsageMeter;
    used: number;
    included: number;
    remaining: number;
    overUnits: number;
    overageCents: number;
    percent: number | null;
    windowStartOn: string | null;
    windowEndOn: string | null;
    isWindowOpen: boolean;
  }[];
  transitions: {
    fromStatus: BillingStatus | null;
    toStatus: BillingStatus;
    actor: "system" | "client" | "support";
    reason: string;
    at: string;
  }[];
  notices: {
    kind: string;
    createdAt: string;
    sendAfter: string;
    sentAt: string | null;
    attempts: number;
    recipientsCount: number | null;
    lastError: string | null;
  }[];
  requests: {
    id: string;
    kind: BillingRequestKind;
    channel: BillingChannel | null;
    reason: "first_answer" | "waiting" | "deadline" | "ops" | "reconcile";
    requestedAt: string;
    nextAttemptAt: string;
    attempts: number;
    isInFlight: boolean;
    doneAt: string | null;
    outcome: "done" | "skipped" | "dead_letter" | null;
    outcomeReason: string | null;
    lastError: string | null;
    isStuck: boolean;
    isHeldBySwitch: boolean;
  }[];
  overageInvoices: {
    /** The instant exactly as upstream sent it: the retry names the month by it. */
    windowStartIso: string;
    windowStartOn: string;
    windowEndOn: string;
    voiceUnits: number;
    chatUnits: number;
    amountCents: number;
    status: "pending" | "invoiced" | "failed" | "skipped";
    invoicedOn: string | null;
    code: string | null;
  }[];
  attentionEvents: {
    source: "billing" | "connect";
    stripeEventId: string;
    type: string;
    outcome: "failed" | "dead_letter";
    failures: number;
    receivedAt: string;
    code: string;
  }[];
  settings: {
    isPaused: boolean;
    pausedAt: string | null;
    pausedUntil: string | null;
    pausedByLabel: string | null;
    directLineE164: string | null;
    directLineSetOn: string | null;
  };
  deposits: {
    depositsEnabled: boolean;
    bookVoiceWithoutDeposit: boolean;
    bookChatWithoutDeposit: boolean;
    depositUncollectable: DepositUncollectable;
    depositHoldMinutes: number;
    defaultAmountUsd: number | null;
    hasDepositAmount: boolean;
    canEnable: boolean;
  };
  connect: {
    isConnected: boolean;
    accountLabel: string | null;
    connectedOn: string | null;
    disconnectedOn: string | null;
  };
  flags: {
    refundWindowOpen: boolean;
    refundEligibleUntil: string | null;
    refundDue: boolean;
    stuckRequests: number;
    pendingLocation: { locationNumber: number; chargedOn: string | null } | null;
    /** A plan change whose outcome was lost, not finished yet; the hourly reconcile finishes or drops it. */
    pendingPlanChange: { plan: PlanRef; interval: "month" | "year" } | null;
  };
};

/**
 * A short machine word: a notice kind, an event type, a closed error code,
 * an outcome reason. Shape-checked rather than run through `text()`, because
 * each is a vocabulary upstream owns and anything outside the shape is a
 * contract breach, not prose to tidy up.
 */
function token(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) {
    throw new ShapeError(at);
  }
  return value;
}

function optionalToken(value: unknown, at: string): string | null {
  return value === null || value === undefined ? null : token(value, at);
}

/** A Stripe event id, which is also what the replay buttons send back. */
function stripeEventId(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(value)) {
    throw new ShapeError(at);
  }
  return value;
}

function optionalCount(value: unknown, at: string): number | null {
  return value === null || value === undefined ? null : count(value, at);
}

/** Dollars, which may carry cents: a finite number, never negative. */
function dollars(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ShapeError(at);
  }
  return value;
}

/** A clinic line in E.164, as settings.ts stores it. */
function e164(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^\+[1-9][0-9]{6,14}$/.test(value)) {
    throw new ShapeError(at);
  }
  return value;
}

/**
 * Stripe's hosted invoice page, or null. The panel renders it as a link, so
 * only Stripe's invoice hosts pass, the same allowlist the billing emails use
 * upstream; apps/app already drops anything else before it sends.
 */
function stripeInvoiceUrl(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  const checked = url(value, at);
  const host = new URL(checked).hostname;
  if (
    !checked.startsWith("https://") ||
    (host !== "invoice.stripe.com" && host !== "pay.stripe.com")
  ) {
    throw new ShapeError(at);
  }
  return checked;
}

/**
 * A plan id and the name the console shows for it: the catalog's name for a
 * step plan ("AYA Voice + Web Chat, 500 minutes and 300 conversations"), and
 * the id itself for one the catalog no longer parses, a 5 October package
 * still billing a clinic, so the panel never shows a blank.
 */
function planRef(value: unknown, at: string): PlanRef {
  const planId = token(value, at);
  return { id: planId, name: getPlan(planId)?.name ?? planId };
}

function planName(planId: string | null): string | null {
  return planId === null ? null : (getPlan(planId)?.name ?? planId);
}

function readClinicBillingView(value: unknown): ClinicBillingView {
  const data = object(value, "getClinicBilling");
  const clinic = object(data.clinic, "billing.clinic");
  const on = (v: unknown, at: string) => optionalInstant(v, at)?.on ?? null;
  const at = (v: unknown, where: string) => optionalInstant(v, where)?.at ?? null;
  const entitlements = data.entitlements ? object(data.entitlements, "billing.entitlements") : null;
  const settings = object(data.settings, "billing.settings");
  const deposits = object(data.deposits, "billing.deposits");
  const connect = object(data.connect, "billing.connect");
  const flags = object(data.flags, "billing.flags");
  const pendingLocation = flags.pendingLocation
    ? object(flags.pendingLocation, "billing.flags.pendingLocation")
    : null;
  // Absent from an apps/app deployed before it: read as none.
  const pendingPlanChange = flags.pendingPlanChange
    ? object(flags.pendingPlanChange, "billing.flags.pendingPlanChange")
    : null;
  const openInvoice = entitlements?.openInvoice
    ? object(entitlements.openInvoice, "billing.openInvoice")
    : null;

  return {
    clinic: {
      id: id(clinic.id, "billing.clinic.id"),
      slug: text(clinic.slug, "billing.clinic.slug"),
      name: text(clinic.name, "billing.clinic.name"),
      dataClassification: literal(
        clinic.dataClassification,
        ["synthetic", "production"],
        "billing.clinic.dataClassification",
      ),
      billingClinicId: id(clinic.billingClinicId, "billing.clinic.billingClinicId"),
      isLocation: bool(clinic.isLocation, "billing.clinic.isLocation"),
    },
    group: list(data.group, "billing.group").map((entry) => {
      const member = object(entry, "billing.group.clinic");
      return {
        clinicId: id(member.clinicId, "billing.group.clinicId"),
        slug: optionalText(member.slug, "billing.group.slug"),
        name: optionalText(member.name, "billing.group.name"),
        isBillingClinic: bool(member.isBillingClinic, "billing.group.isBillingClinic"),
        channels: list(member.channels, "billing.group.channels").map((row) => {
          const c = object(row, "billing.group.channel");
          return {
            channel: literal(c.channel, BILLING_CHANNELS, "billing.channel.channel"),
            enabled: bool(c.enabled, "billing.channel.enabled"),
            status: literal(
              c.status,
              ["off", "paused", "live", "waiting", "setting_up"],
              "billing.channel.status",
            ),
            readyOn: on(c.readyAt, "billing.channel.readyAt"),
            waitingOn:
              c.waitingOn === null || c.waitingOn === undefined
                ? null
                : literal(c.waitingOn, CHANNEL_WAITING_ON, "billing.channel.waitingOn"),
            liveOn: on(c.liveAt, "billing.channel.liveAt"),
            firstAnswerOn: on(c.firstAnswerAt, "billing.channel.firstAnswerAt"),
          };
        }),
      };
    }),
    channelsInService: list(data.channelsInService, "billing.channelsInService").map((c) =>
      literal(c, BILLING_CHANNELS, "billing.channelsInService"),
    ),
    entitlements: entitlements
      ? {
          status: literal(entitlements.status, BILLING_STATUSES, "billing.status"),
          boughtPlan:
            entitlements.boughtPlanId === null || entitlements.boughtPlanId === undefined
              ? null
              : planRef(entitlements.boughtPlanId, "billing.boughtPlanId"),
          billedPlan: planRef(entitlements.billedPlanId, "billing.billedPlanId"),
          isLegacy: bool(entitlements.isLegacy, "billing.isLegacy"),
          interval: literal(entitlements.interval, ["month", "year"], "billing.interval"),
          locations: count(entitlements.locations, "billing.locations"),
          planStartedAt: at(entitlements.planStartedAt, "billing.planStartedAt"),
          planStartAppliedAt: at(entitlements.planStartAppliedAt, "billing.planStartAppliedAt"),
          isPlanStarted: bool(entitlements.isPlanStarted, "billing.isPlanStarted"),
          paidThroughOn: on(entitlements.paidThrough, "billing.paidThrough"),
          graceEndsAt: at(entitlements.graceEndsAt, "billing.graceEndsAt"),
          cancelAt: at(entitlements.cancelAt, "billing.cancelAt"),
          closesOn: on(entitlements.closesAt, "billing.closesAt"),
          overageMode: literal(
            entitlements.overageMode,
            ["allow", "hard_cap"],
            "billing.overageMode",
          ),
          usageAlertsEnabled: bool(entitlements.usageAlertsEnabled, "billing.usageAlertsEnabled"),
          firstPeriodRefundedAt: at(
            entitlements.firstPeriodRefundedAt,
            "billing.firstPeriodRefundedAt",
          ),
          setupDeadlineAt: at(entitlements.setupDeadlineAt, "billing.setupDeadlineAt"),
          setupDeadlineIso: optionalIsoInstant(
            entitlements.setupDeadlineAt,
            "billing.setupDeadlineAt",
          ),
          openInvoice: openInvoice
            ? {
                url: stripeInvoiceUrl(openInvoice.url, "billing.openInvoice.url"),
                amountCents: optionalCount(
                  openInvoice.amountCents,
                  "billing.openInvoice.amountCents",
                ),
              }
            : null,
          hasSubscription: bool(entitlements.hasSubscription, "billing.hasSubscription"),
          isMutationInFlight: bool(entitlements.isMutationInFlight, "billing.isMutationInFlight"),
        }
      : null,
    usage: list(data.usage, "billing.usage").map((entry) => {
      const u = object(entry, "billing.usage.meter");
      return {
        meter: literal(u.meter, ["voice_minutes", "chat_conversations"], "billing.usage.meter"),
        used: count(u.used, "billing.usage.used"),
        included: count(u.included, "billing.usage.included"),
        remaining: count(u.remaining, "billing.usage.remaining"),
        overUnits: count(u.overUnits, "billing.usage.overUnits"),
        overageCents: count(u.overageCents, "billing.usage.overageCents"),
        percent: optionalCount(u.percent, "billing.usage.percent"),
        windowStartOn: on(u.windowStart, "billing.usage.windowStart"),
        windowEndOn: on(u.windowEnd, "billing.usage.windowEnd"),
        isWindowOpen: bool(u.isWindowOpen, "billing.usage.isWindowOpen"),
      };
    }),
    transitions: list(data.transitions, "billing.transitions").map((entry) => {
      const t = object(entry, "billing.transition");
      return {
        fromStatus:
          t.fromStatus === null || t.fromStatus === undefined
            ? null
            : literal(t.fromStatus, BILLING_STATUSES, "billing.transition.fromStatus"),
        toStatus: literal(t.toStatus, BILLING_STATUSES, "billing.transition.toStatus"),
        actor: literal(t.actor, ["system", "client", "support"], "billing.transition.actor"),
        reason: text(t.reason, "billing.transition.reason"),
        at: instant(t.createdAt, "billing.transition.createdAt").at,
      };
    }),
    notices: list(data.notices, "billing.notices").map((entry) => {
      const n = object(entry, "billing.notice");
      return {
        kind: token(n.kind, "billing.notice.kind"),
        createdAt: instant(n.createdAt, "billing.notice.createdAt").at,
        sendAfter: instant(n.sendAfter, "billing.notice.sendAfter").at,
        sentAt: at(n.sentAt, "billing.notice.sentAt"),
        attempts: count(n.attempts, "billing.notice.attempts"),
        recipientsCount: optionalCount(n.recipientsCount, "billing.notice.recipientsCount"),
        lastError: optionalText(n.lastError, "billing.notice.lastError"),
      };
    }),
    requests: list(data.requests, "billing.requests").map((entry) => {
      const r = object(entry, "billing.request");
      return {
        id: id(r.id, "billing.request.id"),
        kind: literal(
          r.kind,
          ["plan_start", "step_up", "close_setup", "cancel_now"],
          "billing.request.kind",
        ),
        channel:
          r.channel === null || r.channel === undefined
            ? null
            : literal(r.channel, BILLING_CHANNELS, "billing.request.channel"),
        reason: literal(
          r.reason,
          ["first_answer", "waiting", "deadline", "ops", "reconcile"],
          "billing.request.reason",
        ),
        requestedAt: instant(r.requestedAt, "billing.request.requestedAt").at,
        nextAttemptAt: instant(r.nextAttemptAt, "billing.request.nextAttemptAt").at,
        attempts: count(r.attempts, "billing.request.attempts"),
        isInFlight: bool(r.isInFlight, "billing.request.isInFlight"),
        doneAt: at(r.doneAt, "billing.request.doneAt"),
        outcome:
          r.outcome === null || r.outcome === undefined
            ? null
            : literal(r.outcome, REQUEST_OUTCOMES, "billing.request.outcome"),
        outcomeReason: optionalToken(r.outcomeReason, "billing.request.outcomeReason"),
        lastError: optionalText(r.lastError, "billing.request.lastError"),
        isStuck: bool(r.isStuck, "billing.request.isStuck"),
        isHeldBySwitch: bool(r.isHeldBySwitch, "billing.request.isHeldBySwitch"),
      };
    }),
    overageInvoices: list(data.overageInvoices, "billing.overageInvoices").map((entry) => {
      const o = object(entry, "billing.overage");
      return {
        windowStartIso: isoInstant(o.windowStart, "billing.overage.windowStart"),
        windowStartOn: instant(o.windowStart, "billing.overage.windowStart").on,
        windowEndOn: instant(o.windowEnd, "billing.overage.windowEnd").on,
        voiceUnits: count(o.voiceUnits, "billing.overage.voiceUnits"),
        chatUnits: count(o.chatUnits, "billing.overage.chatUnits"),
        amountCents: count(o.amountCents, "billing.overage.amountCents"),
        status: literal(
          o.status,
          ["pending", "invoiced", "failed", "skipped"],
          "billing.overage.status",
        ),
        invoicedOn: on(o.invoicedAt, "billing.overage.invoicedAt"),
        code: optionalToken(o.code, "billing.overage.code"),
      };
    }),
    attentionEvents: list(data.attentionEvents, "billing.attentionEvents").map((entry) => {
      const e = object(entry, "billing.event");
      return {
        source: literal(e.source, ["billing", "connect"], "billing.event.source"),
        stripeEventId: stripeEventId(e.stripeEventId, "billing.event.stripeEventId"),
        type: token(e.type, "billing.event.type"),
        outcome: literal(e.outcome, ["failed", "dead_letter"], "billing.event.outcome"),
        failures: count(e.failures, "billing.event.failures"),
        receivedAt: instant(e.receivedAt, "billing.event.receivedAt").at,
        code: token(e.code, "billing.event.code"),
      };
    }),
    settings: {
      isPaused: bool(settings.isPaused, "billing.settings.isPaused"),
      pausedAt: at(settings.pausedAt, "billing.settings.pausedAt"),
      pausedUntil: at(settings.pausedUntil, "billing.settings.pausedUntil"),
      pausedByLabel: optionalText(settings.pausedByLabel, "billing.settings.pausedByLabel"),
      directLineE164:
        settings.directLineE164 === null || settings.directLineE164 === undefined
          ? null
          : e164(settings.directLineE164, "billing.settings.directLineE164"),
      directLineSetOn: on(settings.directLineSetAt, "billing.settings.directLineSetAt"),
    },
    deposits: {
      depositsEnabled: bool(deposits.depositsEnabled, "billing.deposits.depositsEnabled"),
      bookVoiceWithoutDeposit: bool(
        deposits.bookVoiceWithoutDeposit,
        "billing.deposits.bookVoiceWithoutDeposit",
      ),
      bookChatWithoutDeposit: bool(
        deposits.bookChatWithoutDeposit,
        "billing.deposits.bookChatWithoutDeposit",
      ),
      depositUncollectable: literal(
        deposits.depositUncollectable,
        ["book_and_flag", "hold_and_alert", "decline_and_alert"],
        "billing.deposits.depositUncollectable",
      ),
      depositHoldMinutes: count(deposits.depositHoldMinutes, "billing.deposits.depositHoldMinutes"),
      defaultAmountUsd:
        deposits.defaultAmountUsd === null || deposits.defaultAmountUsd === undefined
          ? null
          : dollars(deposits.defaultAmountUsd, "billing.deposits.defaultAmountUsd"),
      hasDepositAmount: bool(deposits.hasDepositAmount, "billing.deposits.hasDepositAmount"),
      canEnable: bool(deposits.canEnable, "billing.deposits.canEnable"),
    },
    connect: {
      isConnected: bool(connect.isConnected, "billing.connect.isConnected"),
      accountLabel: optionalText(connect.accountLabel, "billing.connect.accountLabel"),
      connectedOn: on(connect.connectedAt, "billing.connect.connectedAt"),
      disconnectedOn: on(connect.disconnectedAt, "billing.connect.disconnectedAt"),
    },
    flags: {
      refundWindowOpen: bool(flags.refundWindowOpen, "billing.flags.refundWindowOpen"),
      refundEligibleUntil:
        flags.refundEligibleUntil === null || flags.refundEligibleUntil === undefined
          ? null
          : date(flags.refundEligibleUntil, "billing.flags.refundEligibleUntil"),
      refundDue: bool(flags.refundDue, "billing.flags.refundDue"),
      stuckRequests: count(flags.stuckRequests, "billing.flags.stuckRequests"),
      pendingLocation: pendingLocation
        ? {
            locationNumber: count(pendingLocation.locationNumber, "billing.pendingLocation.number"),
            chargedOn: on(pendingLocation.chargedAt, "billing.pendingLocation.chargedAt"),
          }
        : null,
      pendingPlanChange: pendingPlanChange
        ? {
            plan: planRef(pendingPlanChange.planId, "billing.pendingPlanChange.planId"),
            interval: literal(
              pendingPlanChange.interval,
              ["month", "year"],
              "billing.pendingPlanChange.interval",
            ),
          }
        : null,
    },
  };
}

export function fetchClinicBilling(clinicId: string): Promise<OpsResult<ClinicBillingView>> {
  return callOps("getClinicBilling", "read", { clinicId }, readClinicBillingView);
}

/** A switch on the panel: whether it changed anything, and whether that is on record. */
export type BillingSwitchOutcome =
  ({ status: "updated"; changed: boolean } & Audited) | { status: "refused"; message: string };

function billingSwitch(
  op: OperatorOp,
  args: Record<string, unknown>,
): Promise<OpsResult<BillingSwitchOutcome>> {
  return callOps(op, "write", args, (value) => {
    const data = object(value, op);
    if (state(data, op) !== "updated") return refusal(data, op);
    return {
      status: "updated",
      changed: bool(data.changed, `${op}.changed`),
      auditRecorded: bool(data.auditRecorded, `${op}.auditRecorded`),
    };
  });
}

export function setOverageMode(clinicId: string, mode: "allow" | "hard_cap") {
  return billingSwitch("setOverageMode", { clinicId, mode });
}

export function setUsageAlerts(clinicId: string, on: boolean) {
  return billingSwitch("setUsageAlerts", { clinicId, on });
}

/** Pause AI (with an optional end, an ISO instant) and the direct line; absent fields are left alone. */
export function setClinicSettings(
  clinicId: string,
  input: { directLineE164?: string | null; aiPaused?: boolean; aiPausedUntil?: string | null },
) {
  return billingSwitch("setClinicSettings", { ...input, clinicId });
}

/**
 * The page's clinic is spread last in the writes below that take an input
 * object: a server action's argument comes from the browser, and an input
 * that carried its own `clinicId` must not be able to point the write at a
 * different clinic from the one the page is for.
 */
export type DepositSettingsInput = Partial<{
  depositsEnabled: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
}>;

export function setDepositSettings(clinicId: string, input: DepositSettingsInput) {
  return billingSwitch("setDepositSettings", { ...input, clinicId });
}

export type ReplayEventOutcome =
  | ({ status: "replayed"; outcome: "processed" | "ignored" | "dead_letter" } & Audited)
  | { status: "refused"; message: string };

function replayEvent(
  op: "replayBillingEvent" | "replayConnectEvent",
  eventId: string,
): Promise<OpsResult<ReplayEventOutcome>> {
  return callOps(op, "write", { eventId }, (value) => {
    const data = object(value, op);
    if (state(data, op) !== "replayed") return refusal(data, op);
    return {
      status: "replayed",
      outcome: literal(data.outcome, ["processed", "ignored", "dead_letter"], `${op}.outcome`),
      auditRecorded: bool(data.auditRecorded, `${op}.auditRecorded`),
    };
  });
}

export function replayBillingEvent(eventId: string) {
  return replayEvent("replayBillingEvent", eventId);
}

export function replayConnectEvent(eventId: string) {
  return replayEvent("replayConnectEvent", eventId);
}

export type RefundPreviewOutcome =
  | {
      status: "ok";
      kind: RefundKind;
      amountCents: number;
      cancelsPlan: boolean;
      planStartedOn: string | null;
      windowEndsOn: string | null;
      /**
       * Invoices the refund covers that were paid without a card payment
       * (marked paid out of band): not in `amountCents`, for the operator to
       * settle by hand. Null when there are none.
       */
      settleByHand: { amountCents: number; invoiceIds: string[] } | null;
    }
  | { status: "refused"; message: string };

/** A Stripe invoice id, shown to the operator to look up. */
function invoiceId(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^in_[A-Za-z0-9_]{1,64}$/.test(value)) {
    throw new ShapeError(at);
  }
  return value;
}

/** What a refund would pay back. A read: Stripe is asked, nothing is written but the audit row. */
export function previewRefund(
  clinicId: string,
  kind: RefundKind,
): Promise<OpsResult<RefundPreviewOutcome>> {
  return callOps("previewRefund", "read", { clinicId, kind }, (value) => {
    const data = object(value, "previewRefund");
    if (state(data, "previewRefund") !== "ok") return refusal(data, "previewRefund");
    const optionalDate = (v: unknown, where: string) =>
      v === null || v === undefined ? null : date(v, where);
    return {
      status: "ok",
      kind: literal(
        data.kind,
        ["first_period_cancel", "guarantee", "agreement_terminated"],
        "previewRefund.kind",
      ),
      amountCents: count(data.amountCents, "previewRefund.amountCents"),
      cancelsPlan: bool(data.cancelsPlan, "previewRefund.cancelsPlan"),
      planStartedOn: optionalDate(data.planStartedOn, "previewRefund.planStartedOn"),
      windowEndsOn: optionalDate(data.windowEndsOn, "previewRefund.windowEndsOn"),
      settleByHand: readSettleByHand(data.settleByHand),
    };
  });
}

function readSettleByHand(
  value: unknown,
): { amountCents: number; invoiceIds: string[] } | null {
  if (value === null || value === undefined) return null;
  const data = object(value, "previewRefund.settleByHand");
  return {
    amountCents: count(data.amountCents, "previewRefund.settleByHand.amountCents"),
    invoiceIds: list(data.invoiceIds, "previewRefund.settleByHand.invoiceIds")
      .slice(0, 50)
      .map((entry) => invoiceId(entry, "previewRefund.settleByHand.invoiceIds")),
  };
}

export type RefundOutcome =
  | ({
      status: "refunded";
      amountCents: number;
      refundedAt: string;
      isCancelRequested: boolean;
    } & Audited)
  | { status: "refused"; message: string };

/**
 * Refund under Terms § 5, or the fees paid for time after a terminated
 * agreement ended (BAA 1.3.0 clause 17). A write in the fullest sense: on a timeout or a
 * server error the sentence says it may have gone through, and the operator
 * checks Stripe before asking again (apps/app reuses any part already made).
 */
export function commitRefund(
  clinicId: string,
  input: { kind: RefundKind; confirmAmountCents: number; reason: string },
): Promise<OpsResult<RefundOutcome>> {
  return callOps("commitRefund", "write", { ...input, clinicId }, (value) => {
    const data = object(value, "commitRefund");
    if (state(data, "commitRefund") !== "refunded") return refusal(data, "commitRefund");
    return {
      status: "refunded",
      amountCents: count(data.amountCents, "commitRefund.amountCents"),
      refundedAt: instant(data.refundedAt, "commitRefund.refundedAt").at,
      isCancelRequested: bool(data.isCancelRequested, "commitRefund.isCancelRequested"),
      auditRecorded: bool(data.auditRecorded, "commitRefund.auditRecorded"),
    };
  });
}

export type StripeConnectLinkOutcome =
  | ({ status: "issued"; url: string; expiresAt: string } & Audited)
  | { status: "refused"; message: string };

/**
 * Stripe's authorize page with a single-use state, minted upstream and shown
 * once. Only a link on connect.stripe.com is accepted: anything else would be
 * a link this console vouched for, sent to a clinic, pointed somewhere else.
 */
export function issueStripeConnectLink(
  clinicId: string,
): Promise<OpsResult<StripeConnectLinkOutcome>> {
  return callOps("issueStripeConnectLink", "write", { clinicId }, (value) => {
    const data = object(value, "issueStripeConnectLink");
    if (state(data, "issueStripeConnectLink") !== "issued") {
      return refusal(data, "issueStripeConnectLink");
    }
    const link = url(data.url, "issueStripeConnectLink.url");
    if (!link.startsWith("https://connect.stripe.com/")) {
      throw new ShapeError("issueStripeConnectLink.url");
    }
    return {
      status: "issued",
      url: link,
      expiresAt: text(data.expiresAt, "issueStripeConnectLink.expiresAt"),
      auditRecorded: bool(data.auditRecorded, "issueStripeConnectLink.auditRecorded"),
    };
  });
}

export type DisconnectOutcome =
  | ({
      status: "disconnected";
      deauthorized: boolean;
      shared: boolean;
      cancelledLinks: number;
      paidLinks: number;
      uncheckedLinks: number;
    } & Audited)
  | { status: "refused"; message: string };

export function disconnectStripeConnect(clinicId: string): Promise<OpsResult<DisconnectOutcome>> {
  return callOps("disconnectStripeConnect", "write", { clinicId }, (value) => {
    const data = object(value, "disconnectStripeConnect");
    if (state(data, "disconnectStripeConnect") !== "disconnected") {
      return refusal(data, "disconnectStripeConnect");
    }
    return {
      status: "disconnected",
      deauthorized: bool(data.deauthorized, "disconnectStripeConnect.deauthorized"),
      shared: bool(data.shared, "disconnectStripeConnect.shared"),
      cancelledLinks: count(data.cancelledLinks, "disconnectStripeConnect.cancelledLinks"),
      paidLinks: count(data.paidLinks, "disconnectStripeConnect.paidLinks"),
      uncheckedLinks: count(data.uncheckedLinks, "disconnectStripeConnect.uncheckedLinks"),
      auditRecorded: bool(data.auditRecorded, "disconnectStripeConnect.auditRecorded"),
    };
  });
}

export type RetryRequestOutcome =
  | ({ status: "retried"; kind: BillingRequestKind } & Audited)
  | { status: "refused"; message: string };

export function retryBillingRequest(
  clinicId: string,
  requestId: string,
): Promise<OpsResult<RetryRequestOutcome>> {
  return callOps("retryBillingRequest", "write", { clinicId, requestId }, (value) => {
    const data = object(value, "retryBillingRequest");
    if (state(data, "retryBillingRequest") !== "retried") {
      return refusal(data, "retryBillingRequest");
    }
    return {
      status: "retried",
      kind: literal(
        data.kind,
        ["plan_start", "step_up", "close_setup", "cancel_now"],
        "retryBillingRequest.kind",
      ),
      auditRecorded: bool(data.auditRecorded, "retryBillingRequest.auditRecorded"),
    };
  });
}

export type LiftSuspensionOutcome =
  ({ status: "lifted" } & Audited) | { status: "refused"; message: string };

export function liftSuspension(
  clinicId: string,
  reason: string,
): Promise<OpsResult<LiftSuspensionOutcome>> {
  return callOps("liftSuspension", "write", { clinicId, reason }, (value) => {
    const data = object(value, "liftSuspension");
    if (state(data, "liftSuspension") !== "lifted") return refusal(data, "liftSuspension");
    return {
      status: "lifted",
      auditRecorded: bool(data.auditRecorded, "liftSuspension.auditRecorded"),
    };
  });
}

export type ExtendDeadlineOutcome =
  | ({ status: "extended"; setupDeadlineAt: string } & Audited)
  | { status: "refused"; message: string };

/**
 * More time to finish setup. `fromDeadline` is the deadline the page showed,
 * exactly as it arrived (`setupDeadlineIso`): apps/app refuses once it has
 * moved, so a repeated click or a replayed request cannot add the days twice.
 */
export function extendSetupDeadline(
  clinicId: string,
  input: { days: number; fromDeadline: string },
): Promise<OpsResult<ExtendDeadlineOutcome>> {
  return callOps("extendSetupDeadline", "write", { ...input, clinicId }, (value) => {
    const data = object(value, "extendSetupDeadline");
    if (state(data, "extendSetupDeadline") !== "extended") {
      return refusal(data, "extendSetupDeadline");
    }
    return {
      status: "extended",
      setupDeadlineAt: instant(data.setupDeadlineAt, "extendSetupDeadline.setupDeadlineAt").at,
      auditRecorded: bool(data.auditRecorded, "extendSetupDeadline.auditRecorded"),
    };
  });
}

export type LocationSetupOutcome =
  | ({ status: "added"; clinicId: string; slug: string } & Audited)
  | ({ status: "cleared" } & Audited)
  | { status: "refused"; message: string };

export function retryLocationSetup(clinicId: string): Promise<OpsResult<LocationSetupOutcome>> {
  return callOps("retryLocationSetup", "write", { clinicId }, (value) => {
    const data = object(value, "retryLocationSetup");
    const status = state(data, "retryLocationSetup");
    const auditRecorded = () => bool(data.auditRecorded, "retryLocationSetup.auditRecorded");
    if (status === "added") {
      return {
        status: "added",
        clinicId: id(data.clinicId, "retryLocationSetup.clinicId"),
        slug: text(data.slug, "retryLocationSetup.slug"),
        auditRecorded: auditRecorded(),
      };
    }
    if (status === "cleared") return { status: "cleared", auditRecorded: auditRecorded() };
    return refusal(data, "retryLocationSetup");
  });
}

export type OverageRetryOutcome =
  | ({ status: "invoiced"; amountCents: number; hostedInvoiceUrl: string | null } & Audited)
  | ({ status: "skipped"; reason: string } & Audited)
  | { status: "refused"; message: string };

export function retryOverageInvoice(
  clinicId: string,
  windowStart: string,
): Promise<OpsResult<OverageRetryOutcome>> {
  return callOps("retryOverageInvoice", "write", { clinicId, windowStart }, (value) => {
    const data = object(value, "retryOverageInvoice");
    const status = state(data, "retryOverageInvoice");
    if (status === "invoiced") {
      return {
        status: "invoiced",
        amountCents: count(data.amountCents, "retryOverageInvoice.amountCents"),
        hostedInvoiceUrl: stripeInvoiceUrl(
          data.hostedInvoiceUrl,
          "retryOverageInvoice.hostedInvoiceUrl",
        ),
        auditRecorded: bool(data.auditRecorded, "retryOverageInvoice.auditRecorded"),
      };
    }
    if (status === "skipped") {
      return {
        status: "skipped",
        reason: token(data.reason, "retryOverageInvoice.reason"),
        auditRecorded: bool(data.auditRecorded, "retryOverageInvoice.auditRecorded"),
      };
    }
    return refusal(data, "retryOverageInvoice");
  });
}

export type SetupClosureOutcome =
  | ({ status: "recorded"; isNew: boolean; isSwitchOn: boolean } & Audited)
  | { status: "refused"; message: string };

/** Destructive: the panel asks for a ticked box, and apps/app refuses without `confirm: true`. */
export function closeUnfinishedSetup(clinicId: string): Promise<OpsResult<SetupClosureOutcome>> {
  return callOps("closeUnfinishedSetup", "write", { clinicId, confirm: true }, (value) => {
    const data = object(value, "closeUnfinishedSetup");
    if (state(data, "closeUnfinishedSetup") !== "recorded") {
      return refusal(data, "closeUnfinishedSetup");
    }
    return {
      status: "recorded",
      isNew: bool(data.isNew, "closeUnfinishedSetup.isNew"),
      isSwitchOn: bool(data.isSwitchOn, "closeUnfinishedSetup.isSwitchOn"),
      auditRecorded: bool(data.auditRecorded, "closeUnfinishedSetup.auditRecorded"),
    };
  });
}

export type AutoRenewOutcome =
  | ({ status: "ok"; closesOn: string | null; changed: boolean } & Audited)
  | { status: "refused"; message: string };

/**
 * Auto-renew on the clinic's behalf. `changed` is false when it was already
 * as asked: apps/app then answers from the record and Stripe is not called.
 */
export function setAutoRenew(clinicId: string, on: boolean): Promise<OpsResult<AutoRenewOutcome>> {
  return callOps("setAutoRenew", "write", { clinicId, on }, (value) => {
    const data = object(value, "setAutoRenew");
    if (state(data, "setAutoRenew") !== "ok") return refusal(data, "setAutoRenew");
    return {
      status: "ok",
      closesOn:
        data.closesOn === null || data.closesOn === undefined
          ? null
          : date(data.closesOn, "setAutoRenew.closesOn"),
      changed: bool(data.changed, "setAutoRenew.changed"),
      auditRecorded: bool(data.auditRecorded, "setAutoRenew.auditRecorded"),
    };
  });
}

// -----------------------------------------------------------------------------
// Phase 8: forwarding test, first-weeks health, touches
// -----------------------------------------------------------------------------

export type ForwardingTestOutcome = { status: "started"; windowUntil: string } | { status: "refused"; message: string };

export function startForwardingTest(clinicId: string): Promise<OpsResult<ForwardingTestOutcome>> {
  return callOps("startForwardingTest", "write", { clinicId }, (value) => {
    const data = object(value, "startForwardingTest");
    if (state(data, "startForwardingTest") !== "started") return refusal(data, "startForwardingTest");
    return { status: "started", windowUntil: instant(data.windowUntil, "startForwardingTest.windowUntil").at };
  });
}

export type HealthFlag = "no_calls_after_day_7" | "first_win" | "quiet_week" | "near_allowance";
export const HEALTH_FLAGS: readonly HealthFlag[] = ["no_calls_after_day_7", "first_win", "quiet_week", "near_allowance"];

export type ClinicHealth = {
  clinicId: string;
  slug: string;
  name: string;
  /**
   * The plan's name ("AYA Voice, 500 minutes"), from the plan id apps/app
   * sends; the id itself for one the catalog no longer knows (the seven
   * packages of 5 October), so the row still says what was bought.
   */
  plan: string | null;
  wentLiveOn: string;
  daysLive: number;
  conversations: { total: number; last7: number };
  recovered: { total: number; last7: number };
  bookings: number;
  firstRecoveredBookingOn: string | null;
  lastConversationAt: string | null;
  recipients: number;
  forwardingTested: boolean;
  connected: boolean;
  usage: { voiceMinutesUsed: number; voiceMinutesIncluded: number; chatUsed: number; chatIncluded: number } | null;
  touches: { touchedAt: string; byLabel: string; kind: "call" | "email" | "note"; summary: string; outcome: string | null }[];
  flags: HealthFlag[];
};

function readHealth(value: unknown): ClinicHealth[] {
  const data = object(value, "listClinicHealth");
  return list(data.clinics, "health.clinics").map((entry) => {
    const h = object(entry, "health.clinic");
    const pair = (v: unknown, at: string) => {
      const o = object(v, at);
      return { total: count(o.total, `${at}.total`), last7: count(o.last7, `${at}.last7`) };
    };
    const usage = h.usage ? object(h.usage, "health.usage") : null;
    return {
      clinicId: id(h.clinicId, "health.clinicId"),
      slug: text(h.slug, "health.slug"),
      name: text(h.name, "health.name"),
      plan: planName(optionalText(h.plan, "health.plan")),
      wentLiveOn: instant(h.wentLiveAt, "health.wentLiveAt").on,
      daysLive: count(h.daysLive, "health.daysLive"),
      conversations: pair(h.conversations, "health.conversations"),
      recovered: pair(h.recovered, "health.recovered"),
      bookings: count(h.bookings, "health.bookings"),
      firstRecoveredBookingOn: optionalInstant(h.firstRecoveredBookingAt, "health.firstRecoveredBookingAt")?.on ?? null,
      lastConversationAt: optionalInstant(h.lastConversationAt, "health.lastConversationAt")?.at ?? null,
      recipients: count(h.recipients, "health.recipients"),
      forwardingTested: bool(h.forwardingTested, "health.forwardingTested"),
      connected: bool(h.connected, "health.connected"),
      usage: usage
        ? {
            voiceMinutesUsed: Number(usage.voiceMinutesUsed) || 0,
            voiceMinutesIncluded: count(usage.voiceMinutesIncluded, "health.usage.voiceMinutesIncluded"),
            chatUsed: count(usage.chatUsed, "health.usage.chatUsed"),
            chatIncluded: count(usage.chatIncluded, "health.usage.chatIncluded"),
          }
        : null,
      touches: list(h.touches, "health.touches").map((t) => {
        const o = object(t, "health.touch");
        return {
          touchedAt: instant(o.touchedAt, "health.touch.touchedAt").at,
          byLabel: text(o.byLabel, "health.touch.byLabel"),
          kind: literal(o.kind, ["call", "email", "note"], "health.touch.kind"),
          summary: text(o.summary, "health.touch.summary"),
          outcome: optionalText(o.outcome, "health.touch.outcome"),
        };
      }),
      flags: list(h.flags, "health.flags").map((f) => literal(f, HEALTH_FLAGS, "health.flag")),
    };
  });
}

export function fetchClinicHealth(): Promise<OpsResult<ClinicHealth[]>> {
  return callOps("listClinicHealth", "read", {}, readHealth);
}

export function recordClinicTouch(clinicId: string, input: { kind: "call" | "email" | "note"; summary: string; outcome?: string }) {
  return careWrite("recordClinicTouch", { clinicId, ...input });
}

export function attachMetaChannel(
  clinicId: string,
  input: { platform: MetaPlatform; externalId: string; accessToken: string; label?: string },
) {
  return careWrite("attachMetaChannel", { clinicId, ...input });
}

export function setMetaFrontDoor(clinicId: string, enabled: boolean) {
  return careWrite("setMetaFrontDoor", { clinicId, enabled });
}

/** One of the clinic's own platform switches, beneath the front door. */
export function setMetaPlatform(clinicId: string, platform: MetaPlatform, enabled: boolean) {
  return careWrite("setMetaPlatform", { clinicId, platform, enabled });
}


// -----------------------------------------------------------------------------
// Booking hand-off (design of 23 September 2026). The call-back switch and
// the WhatsApp template op went with v1's inbound-only rule, and the
// direct-booking switch with v1's derived booking mode (below).
// -----------------------------------------------------------------------------

export function setBookingRequirements(clinicId: string, fields: string[]) {
  return simple("setBookingRequirements", { clinicId, fields });
}

export function setClinicTimezone(clinicId: string, timezone: string) {
  return simple("setClinicTimezone", { clinicId, timezone });
}

export function setConnectionPhiBasis(clinicId: string, input: { connectionId: string; basis: PhiBasis | null; note?: string }) {
  return simple("setConnectionPhiBasis", { clinicId, connectionId: input.connectionId, basis: input.basis, ...(input.note ? { note: input.note } : {}) });
}

/** Same shape as the connect link: the URL comes back once, composed upstream. */
export function issueSetupLink(clinicId: string, to: string | null): Promise<OpsResult<IssueLinkOutcome>> {
  const args: Record<string, unknown> = { clinicId };
  if (to) args.to = to;
  return callOps("issueSetupLink", "write", args, (value) => {
    const data = object(value, "issueSetupLink");
    if (state(data, "issueSetupLink") !== "issued") return refusal(data, "issueSetupLink");
    return {
      status: "issued",
      url: url(data.url, "issueSetupLink.url"),
      expiresAt: text(data.expiresAt, "issueSetupLink.expiresAt"),
      delivery: readDelivery(data.delivery),
      auditRecorded: bool(data.auditRecorded, "issueSetupLink.auditRecorded"),
    };
  });
}

export type RetryCalendarWriteOutcome =
  | { status: "retried"; outcome: "written" | "failed" | "unknown" | "not-connected" }
  | { status: "refused"; message: string };

export function retryCalendarWrite(clinicId: string, appointmentId: string): Promise<OpsResult<RetryCalendarWriteOutcome>> {
  return callOps("retryCalendarWrite", "write", { clinicId, appointmentId }, (value) => {
    const data = object(value, "retryCalendarWrite");
    if (state(data, "retryCalendarWrite") !== "retried") return refusal(data, "retryCalendarWrite");
    return { status: "retried", outcome: literal(data.outcome, ["written", "failed", "unknown", "not-connected"], "retryCalendarWrite.outcome") };
  });
}

export function fetchCalendarWrites(clinicId: string): Promise<OpsResult<CalendarWriteRow[]>> {
  return callOps("listCalendarWrites", "read", { clinicId }, (value) => {
    const data = object(value, "listCalendarWrites");
    return list(data.writes ?? [], "listCalendarWrites.writes").map(readCalendarWrite);
  });
}

// -----------------------------------------------------------------------------
// The booking mode and the Google Calendar (plan §10). The mode is derived in
// apps/app; the console switches only Auto-confirm, the clinic's own switch.
// The owner's kill switch is an environment variable, and no operation sets it.
// -----------------------------------------------------------------------------

export type AutoConfirmOutcome =
  | ({
      status: "updated";
      /** False when Auto-confirm already was where it was asked to be. */
      changed: boolean;
      autoConfirm: boolean;
      /** The mode it leaves, and every reason for it. */
      mode: "live" | "manual";
      reasons: BookingReason[];
    } & Audited)
  | { status: "refused"; message: string };

export function setAutoConfirm(clinicId: string, on: boolean): Promise<OpsResult<AutoConfirmOutcome>> {
  return callOps("setAutoConfirm", "write", { clinicId, on }, (value) => {
    const data = object(value, "setAutoConfirm");
    if (state(data, "setAutoConfirm") !== "updated") return refusal(data, "setAutoConfirm");
    return {
      status: "updated",
      changed: bool(data.changed, "setAutoConfirm.changed"),
      autoConfirm: bool(data.autoConfirm, "setAutoConfirm.autoConfirm"),
      mode: literal(data.mode, ["live", "manual"], "setAutoConfirm.mode"),
      reasons: readReasons(data.reasons, "setAutoConfirm.reasons"),
      auditRecorded: bool(data.auditRecorded, "setAutoConfirm.auditRecorded"),
    };
  });
}

export type CalendarLinkOutcome =
  | ({
      status: "issued";
      expiresAt: string;
      delivery: { sent: number; failed: number; recipients: number };
      /** healdesk's demo clinic only, for Google's verification video; mailed otherwise, never shown. */
      url: string | null;
    } & Audited)
  | { status: "refused"; message: string };

/**
 * Mail the location's calendar link to the practice's own address. It takes
 * no recipient: a calendar link is a capability, so apps/app sends it only
 * where the practice receives its calendar mail, and refuses when the link
 * page would have nothing for the clinic to do.
 */
export function issueCalendarLink(clinicId: string): Promise<OpsResult<CalendarLinkOutcome>> {
  return callOps("issueCalendarLink", "write", { clinicId }, (value) => {
    const data = object(value, "issueCalendarLink");
    if (state(data, "issueCalendarLink") !== "issued") return refusal(data, "issueCalendarLink");
    const delivery = object(data.delivery, "issueCalendarLink.delivery");
    return {
      status: "issued",
      expiresAt: text(data.expiresAt, "issueCalendarLink.expiresAt"),
      delivery: {
        sent: count(delivery.sent, "issueCalendarLink.delivery.sent"),
        failed: count(delivery.failed, "issueCalendarLink.delivery.failed"),
        recipients: count(delivery.recipients, "issueCalendarLink.delivery.recipients"),
      },
      url: data.url === undefined ? null : url(data.url, "issueCalendarLink.url"),
      auditRecorded: bool(data.auditRecorded, "issueCalendarLink.auditRecorded"),
    };
  });
}

export type DisconnectCalendarOutcome =
  | ({ status: "disconnected"; revokedAtGoogle: boolean } & Audited)
  | { status: "not_connected" }
  | { status: "refused"; message: string };

/**
 * Disconnect the location's Google Calendar, erasing its token, and revoke
 * healdesk's grant at Google unless another location uses that account.
 * `revokedAtGoogle` is false then, and when Google could not be asked or did
 * not answer.
 */
export function disconnectCalendar(clinicId: string): Promise<OpsResult<DisconnectCalendarOutcome>> {
  return callOps("disconnectCalendar", "write", { clinicId }, (value) => {
    const data = object(value, "disconnectCalendar");
    const status = state(data, "disconnectCalendar");
    if (status === "not_connected") return { status: "not_connected" };
    if (status !== "disconnected") return refusal(data, "disconnectCalendar");
    return {
      status: "disconnected",
      revokedAtGoogle: bool(data.revokedAtGoogle, "disconnectCalendar.revokedAtGoogle"),
      auditRecorded: bool(data.auditRecorded, "disconnectCalendar.auditRecorded"),
    };
  });
}

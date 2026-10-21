import { createHash, randomUUID } from "node:crypto";

import { SENDER_IDENTITY } from "@healdesk/catalog";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { emailEvents } from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { billingDetailMatches, type BillingDetail } from "@/lib/billing/billing-detail";
import { stripeCustomerOf } from "@/lib/billing/customer-email";
import { stripeConfigured } from "@/lib/billing/stripe-client";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import {
  renderAccessRequest,
  type AccessRequestCode,
  type AccessRequestPayload,
} from "@/lib/email/templates/access_request";
import { renderSignInHelpLink, SIGN_IN_HELP_REASON } from "@/lib/email/templates/sign_in_help_link";
import { SUPPORT_REASON } from "@/lib/email/templates/support_escalation";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { portalGrants } from "@/lib/portal/access";
import { signInAudience } from "@/lib/portal/audience";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";

import { issueSignInLink, maskEmail, SIGN_IN_LINK_TTL_MS } from "./links";
import { looksLikeEmail, normaliseSignInEmail } from "./request";

/**
 * "I can't get in" (plan Part D5; spec, "Losing access"): /sign-in/help.
 *
 * The person gives the clinic's address, the clinic's name and one billing
 * detail: the card's last four digits and expiry, or an invoice number. The
 * detail is checked against the account's Stripe customer on the server
 * (lib/billing/billing-detail.ts). On a match, O6 sends a sign-in link to the
 * address already on the account, and only there; it never adds a device,
 * and patient pages still need a passkey. Anything else sends no link. An
 * address with no account is recorded in the security log and counted in
 * the 07:00 ops digest, and nothing is mailed. An address that is an
 * account's tells ops once a UTC day per code and clinic (notifyOpsOnce,
 * the day in its identity, the name typed out of it), and hello@ also gets
 * I3's access request (plan D5: "Anything else emails hello@ with structured
 * fields"; Annex X5's I3): a code, the clinic's id, whether the name typed
 * matched, which kind of billing detail was offered and the address masked,
 * never what was typed, with the account's address as reply-to. It goes at
 * most once a day per clinic and code, and ACCESS_REQUEST_DAILY_CAP times a
 * day in all, counted in the database, because the form is unauthenticated
 * and its own limits are per process: an address with no account sends
 * hello@ nothing, so made-up addresses cannot spend the day's 100 emails that
 * sign-in links and urgent alerts need.
 *
 * The page answers every well-formed request the same way, at once, and this
 * runs after the answer has gone (the action hands it to after()), so
 * neither the words nor the time taken say whether the address has an
 * account or the detail matched. The outcome is for the log and the tests.
 *
 * Losing the address itself is not this form's case: that goes to a person
 * (a call back to the published number, then ops' changeClinicEmail, with 72
 * hours' notice to both addresses).
 */

export type SignInHelpRequest = {
  email: string;
  /** The clinic's name as typed: a signal for ops, never sent anywhere as text. */
  clinic: string;
  detail: BillingDetail;
};

export type SignInHelpField = "email" | "clinic" | "detail";

export type SignInHelpParse =
  { ok: true; request: SignInHelpRequest } | { ok: false; field: SignInHelpField; message: string };

const LAST4 = /^\d{4}$/;
const EXPIRY = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/;
/** A Stripe invoice number: the account's prefix, a dash, a sequence ("ABCD1234-0001"). */
const INVOICE = /^[A-Za-z0-9]{3,12}-\d{1,8}$/;

/**
 * The form's fields, checked for shape only, which says nothing about any
 * account: a malformed card number is malformed whoever owns the address.
 */
export function parseSignInHelp(form: {
  email: unknown;
  clinic: unknown;
  kind: unknown;
  last4?: unknown;
  expiry?: unknown;
  invoice?: unknown;
}): SignInHelpParse {
  const email = normaliseSignInEmail(String(form.email ?? ""));
  if (!looksLikeEmail(email)) {
    return {
      ok: false,
      field: "email",
      message: "Enter the email address your clinic uses with healdesk.",
    };
  }
  const clinic = String(form.clinic ?? "").trim();
  if (clinic.length < 2 || clinic.length > 120) {
    return { ok: false, field: "clinic", message: "Enter your clinic's name." };
  }
  if (form.kind === "card") {
    const last4 = String(form.last4 ?? "").replace(/\s/g, "");
    const expiry = EXPIRY.exec(String(form.expiry ?? "").trim());
    const month = expiry ? Number(expiry[1]) : 0;
    const year = expiry ? Number(expiry[2]!.length === 2 ? `20${expiry[2]}` : expiry[2]) : 0;
    if (!LAST4.test(last4) || month < 1 || month > 12 || year < 2000) {
      return {
        ok: false,
        field: "detail",
        message: "Enter the card's last four digits and its expiry, like 04/28.",
      };
    }
    return {
      ok: true,
      request: { email, clinic, detail: { kind: "card", last4, expMonth: month, expYear: year } },
    };
  }
  if (form.kind === "invoice") {
    const number = String(form.invoice ?? "").trim();
    if (!INVOICE.test(number)) {
      return {
        ok: false,
        field: "detail",
        message: "Enter an invoice number as it appears on the invoice, like ABCD1234-0001.",
      };
    }
    return { ok: true, request: { email, clinic, detail: { kind: "invoice", number } } };
  }
  return { ok: false, field: "detail", message: "Choose a card or an invoice number." };
}

export type SignInHelpOutcome =
  /** O6 went to the address on the account. */
  | "sent"
  /** The address belongs to no clinic. */
  | "no_account"
  /** The clinic has no Stripe customer to check against yet. */
  | "no_billing"
  /** The detail matched nothing of the account's. */
  | "no_match"
  /** Stripe could not be asked. */
  | "billing_unavailable"
  /** No public origin to build a link on. */
  | "unavailable"
  /** The link was minted and the email did not go. */
  | "failed";

const HELP_ACTOR: ActorContext = { type: "service", serviceName: "sign-in-help" };

export async function runSignInHelp(
  request: SignInHelpRequest,
  context: RequestContext = {},
  options: SendEmailOptions = {},
): Promise<SignInHelpOutcome> {
  const trace = { ipAddress: context.ipAddress ?? null, userAgent: context.userAgent ?? null };
  const unmatched = async (
    code: AccessRequestCode,
    fields: {
      userId?: string | null;
      clinicId?: string | null;
      clinicNamed?: boolean;
      /** The account's own address, when the address typed is one: the I3 email's reply-to. */
      accountEmail?: string | null;
    } = {},
  ): Promise<SignInHelpOutcome> => {
    const signal =
      fields.clinicNamed === undefined
        ? null
        : fields.clinicNamed
          ? "clinic_named"
          : "clinic_not_named";
    await recordSecurityEvent(unsafeDb, {
      event: "sign_in_help_unmatched",
      actorLabel: "sign-in-help",
      userId: fields.userId ?? null,
      ...trace,
      metadata: {
        code,
        ...(fields.clinicId ? { clinicId: fields.clinicId } : {}),
        ...(signal ? { signal } : {}),
      },
    }).catch((error) => log.error("sign-in help not recorded", { error: describeError(error) }));
    // An address with no account is anyone's to type: the security event is
    // its record and the 07:00 digest counts it, and nothing is mailed. One
    // that is an account's alerts ops once a UTC day per code and clinic,
    // whatever was typed as the name (the event keeps that), so the form
    // cannot farm the hourly alert into the day's Resend sending.
    if (code !== "no_account" && fields.clinicId) {
      await notifyOpsOnce("sign_in_help_unmatched", {
        code,
        clinicId: fields.clinicId,
        windowStart: (options.now ?? new Date()).toISOString().slice(0, 10),
      });
    }
    // I3 to hello@ only for an address that is an account's.
    if (fields.clinicId) {
      await sendAccessRequest(
        {
          requestId: randomUUID(),
          code,
          clinicId: fields.clinicId,
          signal,
          detail: request.detail.kind,
          addressMasked: maskEmail(request.email),
          hasReplyAddress: Boolean(fields.accountEmail),
        },
        fields.accountEmail ?? null,
        options,
      );
    }
    return code;
  };

  const [account] = await unsafeDb
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${request.email}`)
    .limit(1);
  const grants = account ? await portalGrants(account.id) : [];
  if (!account || grants.length === 0) return unmatched("no_account");

  const clinicNamed = grants.some((g) => sameName(g.name, request.clinic));
  const firstClinic = grants[0]!.clinicId;
  const customers = new Set<string>();
  for (const grant of grants) {
    const customer = await stripeCustomerOf(grant.clinicId, HELP_ACTOR);
    if (customer) customers.add(customer);
  }
  if (customers.size === 0) {
    return unmatched("no_billing", { userId: account.id, clinicId: firstClinic, clinicNamed, accountEmail: account.email });
  }
  if (!stripeConfigured()) {
    return unmatched("billing_unavailable", {
      userId: account.id,
      clinicId: firstClinic,
      clinicNamed,
      accountEmail: account.email,
    });
  }

  let matched = false;
  try {
    for (const customer of customers) {
      if (await billingDetailMatches(customer, request.detail)) {
        matched = true;
        break;
      }
    }
  } catch (error) {
    log.error("sign-in help: Stripe could not be asked", { error: describeError(error) });
    return unmatched("billing_unavailable", {
      userId: account.id,
      clinicId: firstClinic,
      clinicNamed,
      accountEmail: account.email,
    });
  }
  if (!matched) {
    return unmatched("no_match", { userId: account.id, clinicId: firstClinic, clinicNamed, accountEmail: account.email });
  }

  const originProblem = publicOriginProblem();
  if (originProblem) {
    log.error("sign-in help link not sent: no public origin", { reason: originProblem });
    return "unavailable";
  }
  const link = await issueSignInLink({
    userId: account.id,
    purpose: "sign_in",
    issuedBy: "sign_in_help",
  });
  if (!link) throw new Error("A sign-in link without a source cannot already exist.");

  const payload = {
    signInUrl: publicUrl(`/link/${link.token}`),
    validMinutes: Math.round(SIGN_IN_LINK_TTL_MS.sign_in / 60_000),
  };
  const rendered = renderSignInHelpLink(
    payload,
    {
      clinicName: null,
      // Whose details still need a passkey: a vet's sign-in reads "client details".
      audience: await signInAudience(grants),
      reason: SIGN_IN_HELP_REASON,
      raisedAt: options.now ?? new Date(),
      timeZone: "UTC",
    },
  );
  try {
    // To the address on the account, as stored: never one typed on the form.
    const result = await sendEmail(
      {
        to: account.email,
        kind: "sign_in_help_link",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        deliveryId: link.id,
        idempotencyKey: `hd-sign_in_help_link-${link.id}-1`,
      },
      options,
    );
    await recordSecurityEvent(unsafeDb, {
      event: "sign_in_help_link_sent",
      actorLabel: "sign-in-help",
      userId: account.id,
      ...trace,
      metadata: { deliveryId: link.id, detail: request.detail.kind, status: result.status },
    });
    if (result.status === "failed") {
      log.warn("sign-in help link not delivered", { deliveryId: link.id, reason: result.reason });
      return "failed";
    }
    return "sent";
  } catch (error) {
    log.error("sign-in help link not sent", { deliveryId: link.id, error: describeError(error) });
    return "failed";
  }
}

/** Where an access request goes: hello@, the support inbox (I3), as the support chat's escalation does. */
const ACCESS_REQUEST_INBOX = SENDER_IDENTITY.replyTo;

/**
 * The most I3 access requests hello@ gets in a UTC day, all clinics
 * together. Resend's free plan stops every email at 100 a day, sign-in links
 * and urgent alerts included, and the form is unauthenticated: its limits
 * (three a window per inbox, ten per IP) are per process and in memory, so
 * without a cap of its own the form could spend the day's sending.
 */
export const ACCESS_REQUEST_DAILY_CAP = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The claim's event id: a digest of the clinic, the code and the UTC day, so
 * the day's dedupe holds and email_events, which says it holds no clinic,
 * does not carry one.
 */
export function accessRequestClaimId(clinicId: string, code: AccessRequestCode, day: string): string {
  return `i3.${createHash("sha256").update(`${clinicId}|${code}|${day}`).digest("hex").slice(0, 40)}`;
}

/**
 * Claim today's one I3 email for this clinic and code, under the day's cap.
 * The claim is the email_events row the digest counts (status `sent`), keyed
 * by its event id `i3.<digest of clinic, code and UTC day>`, so the table
 * holds no clinic id, and a second request about
 * the same clinic and code that day finds it and sends nothing, and the cap
 * is a count of the day's claims. Serialised by an advisory lock, so two
 * processes cannot both take the last place.
 */
async function claimAccessRequest(
  clinicId: string,
  code: AccessRequestCode,
  now: Date,
): Promise<{ claimId: string } | "duplicate" | "capped"> {
  const day = now.toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  return unsafeDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access_request', 0))`);
    const [taken] = await tx
      .select({ n: count() })
      .from(emailEvents)
      .where(
        and(
          eq(emailEvents.kind, "access_request"),
          eq(emailEvents.status, "sent"),
          gte(emailEvents.at, dayStart),
          lt(emailEvents.at, new Date(dayStart.getTime() + DAY_MS)),
        ),
      );
    const [claimed] = await tx
      .insert(emailEvents)
      .values({
        app: "app",
        kind: "access_request",
        status: "sent",
        at: now,
        eventId: accessRequestClaimId(clinicId, code, day),
      })
      .onConflictDoNothing()
      .returning({ id: emailEvents.id });
    if (!claimed) return "duplicate";
    if ((taken?.n ?? 0) >= ACCESS_REQUEST_DAILY_CAP) {
      // Over the cap: the claim goes again, so the day's count stays the cap.
      await tx.delete(emailEvents).where(eq(emailEvents.id, claimed.id));
      return "capped";
    }
    return { claimId: claimed.id };
  });
}

/**
 * A send that did not go gives its claim back, so a later request that day
 * can try again, and is counted as the failure it was. Never throws.
 */
async function releaseAccessRequest(claimId: string, now: Date): Promise<void> {
  try {
    await unsafeDb.delete(emailEvents).where(eq(emailEvents.id, claimId));
    await unsafeDb
      .insert(emailEvents)
      .values({ app: "app", kind: "access_request", status: "failed", at: now });
  } catch (error) {
    log.warn("sign-in help access request claim not released", { error: describeError(error) });
  }
}

/**
 * I3, an access request: the unmatched request about an account, to hello@,
 * structured fields only (templates/access_request.ts). At most one a day
 * per clinic and code, and ACCESS_REQUEST_DAILY_CAP a day in all; past the
 * cap, ops is told once that day instead. Never throws: the person has
 * already been answered, and ops has been told.
 */
async function sendAccessRequest(
  payload: AccessRequestPayload & { clinicId: string },
  replyTo: string | null,
  options: SendEmailOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  let claimId: string | null = null;
  try {
    const claim = await claimAccessRequest(payload.clinicId, payload.code, now);
    if (claim === "duplicate") return;
    if (claim === "capped") {
      await notifyOpsOnce("access_requests_capped", {
        count: ACCESS_REQUEST_DAILY_CAP,
        windowStart: now.toISOString().slice(0, 10),
      });
      return;
    }
    claimId = claim.claimId;
    const rendered = renderAccessRequest(payload, {
      clinicName: null,
      audience: "patients",
      reason: SUPPORT_REASON,
      raisedAt: now,
      timeZone: "America/New_York",
    });
    const result = await sendEmail(
      {
        to: ACCESS_REQUEST_INBOX,
        kind: "access_request",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        deliveryId: payload.requestId,
        idempotencyKey: `hd-access_request-${payload.requestId}-1`,
        ...(replyTo ? { replyTo } : {}),
      },
      options,
    );
    if (result.status === "failed") {
      await releaseAccessRequest(claimId, now);
      log.warn("sign-in help access request not delivered", {
        deliveryId: payload.requestId,
        reason: result.reason,
      });
    }
  } catch (error) {
    if (claimId) await releaseAccessRequest(claimId, now);
    log.error("sign-in help access request not sent", {
      deliveryId: payload.requestId,
      error: describeError(error),
    });
  }
}

/** Whether a name typed is the clinic's, loosely: letters and digits only, either inside the other. */
export function sameName(stored: string, typed: string): boolean {
  const a = stored.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = typed.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

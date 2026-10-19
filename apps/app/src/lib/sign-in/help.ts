import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { billingDetailMatches, type BillingDetail } from "@/lib/billing/billing-detail";
import { stripeCustomerOf } from "@/lib/billing/customer-email";
import { stripeConfigured } from "@/lib/billing/stripe-client";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { renderSignInHelpLink, SIGN_IN_HELP_REASON } from "@/lib/email/templates/sign_in_help_link";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { portalGrants } from "@/lib/portal/access";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";

import { issueSignInLink, SIGN_IN_LINK_TTL_MS } from "./links";
import { looksLikeEmail, normaliseSignInEmail } from "./request";

/**
 * "I can't get in" (plan Part D5; spec, "Losing access"): /sign-in/help.
 *
 * The person gives the clinic's address, the clinic's name and one billing
 * detail: the card's last four digits and expiry, or an invoice number. The
 * detail is checked against the account's Stripe customer on the server
 * (lib/billing/billing-detail.ts). On a match, O6 sends a sign-in link to the
 * address already on the account, and only there; it never adds a device,
 * and patient pages still need a passkey. Anything else sends no link and
 * tells ops through notifyOps, with structured fields only (a code, the
 * clinic's id when the address is one, and whether the name typed matched),
 * never what was typed. notifyOps keeps that to one email an hour per
 * clinic, so the form cannot be used to flood the inbox.
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
    code: Exclude<SignInHelpOutcome, "sent" | "failed">,
    fields: { userId?: string | null; clinicId?: string | null; clinicNamed?: boolean } = {},
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
    await notifyOps("sign_in_help_unmatched", {
      code,
      clinicId: fields.clinicId ?? null,
      signal,
    });
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
    return unmatched("no_billing", { userId: account.id, clinicId: firstClinic, clinicNamed });
  }
  if (!stripeConfigured()) {
    return unmatched("billing_unavailable", {
      userId: account.id,
      clinicId: firstClinic,
      clinicNamed,
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
    });
  }
  if (!matched) {
    return unmatched("no_match", { userId: account.id, clinicId: firstClinic, clinicNamed });
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

  const rendered = renderSignInHelpLink(
    {
      signInUrl: publicUrl(`/link/${link.token}`),
      validMinutes: Math.round(SIGN_IN_LINK_TTL_MS.sign_in / 60_000),
    },
    {
      clinicName: null,
      audience: "patients",
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

/** Whether a name typed is the clinic's, loosely: letters and digits only, either inside the other. */
export function sameName(stored: string, typed: string): boolean {
  const a = stored.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = typed.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { SIGN_IN_REASON } from "@/lib/email/templates/context";
import { renderSignInLink } from "@/lib/email/templates/sign_in_link";
import { describeError, log } from "@/lib/log";
import { portalGrants } from "@/lib/portal/access";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";

import { isSafeRedirect, issueSignInLink, SIGN_IN_LINK_TTL_MS } from "./links";

/**
 * /sign-in, behind the page (plan Part D1): email a single-use sign-in link
 * to an address, if it is a clinic's.
 *
 * "A clinic's address" means a user with at least one portal grant. Anyone
 * else is sent nothing, and the page cannot tell the difference: it answers
 * every request the same way, before this runs (the action hands it to
 * after()), so neither the words nor the time it takes say whether an
 * address has an account.
 *
 * The outcome is for the log and the tests, never for the person asking.
 */

export type SignInRequestOutcome =
  /** A link went to a clinic's address. */
  | "sent"
  /** The address belongs to no clinic: nothing was minted or sent. */
  | "no_account"
  /** BETTER_AUTH_URL is unset in production: no link minted that nobody could follow. */
  | "unavailable"
  /** The link was minted but the email did not go. */
  | "failed";

/** An address as /sign-in compares it: trimmed and lower-cased. */
export function normaliseSignInEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Loose on purpose: the provider decides what is deliverable, this only refuses what cannot be. */
export function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function sendSignInLink(
  input: { email: string; next?: string | null },
  options: SendEmailOptions = {},
): Promise<SignInRequestOutcome> {
  const email = normaliseSignInEmail(input.email);

  const [account] = await unsafeDb
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);
  if (!account || (await portalGrants(account.id)).length === 0) return "no_account";

  // Asked before anything is minted, so no live link exists that nobody can
  // be sent (lib/public-url.ts).
  const originProblem = publicOriginProblem();
  if (originProblem) {
    log.error("sign-in link not sent: no public origin", { reason: originProblem });
    return "unavailable";
  }

  const link = await issueSignInLink({
    userId: account.id,
    purpose: "sign_in",
    redirectTo: isSafeRedirect(input.next) ? input.next : null,
    issuedBy: "sign_in_page",
  });
  // No sourceRef, so nothing can have minted this link before.
  if (!link) throw new Error("A sign-in link without a source cannot already exist.");

  const rendered = renderSignInLink(
    {
      signInUrl: publicUrl(`/link/${link.token}`),
      validMinutes: Math.round(SIGN_IN_LINK_TTL_MS.sign_in / 60_000),
    },
    {
      clinicName: null,
      audience: "patients",
      reason: SIGN_IN_REASON,
      raisedAt: options.now ?? new Date(),
      timeZone: "UTC",
    },
  );

  try {
    const result = await sendEmail(
      {
        to: account.email,
        kind: "sign_in_link",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        deliveryId: link.id,
        // Every send mints its own link row, so the row id already tells one
        // attempt from the next (X1.4).
        idempotencyKey: `hd-sign_in_link-${link.id}-1`,
      },
      options,
    );
    if (result.status === "failed") {
      log.warn("sign-in link not delivered", { deliveryId: link.id, reason: result.reason });
      return "failed";
    }
    log.info("sign-in link sent", { deliveryId: link.id, status: result.status });
    return "sent";
  } catch (error) {
    log.error("sign-in link not sent", { deliveryId: link.id, error: describeError(error) });
    return "failed";
  }
}

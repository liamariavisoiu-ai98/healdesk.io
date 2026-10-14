import { randomUUID } from "node:crypto";

import {
  AgreementError,
  effectiveDateOf,
  MAX_SIGN_REQUEST_BYTES,
  prepareSigning,
  validateSignRequest,
  type PreparedSigning,
} from "@healdesk/catalog/agreement-signing";
import { agreementRecordFrom } from "@healdesk/catalog/checkout-record";
import { after, NextResponse } from "next/server";

import {
  DOWNLOAD_COOKIE,
  downloadCookieOptions,
  issueDownloadToken,
} from "@/lib/agreement-download";
import { signRequestRefusal } from "@/lib/checkout/order";
import { appendAgreementRecord, recordsConfigured } from "@/lib/checkout/records";
import { copyReport, COPY_BUDGET_MS, deliverAgreementCopyWithin } from "@/lib/email/agreement-copy";
import { normalizeEmail } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { demoInvitation, gateState, refuseOtherEmail, refuseWithoutLink } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";
import { updateSetupRequest } from "@/lib/setup-requests";

/**
 * POST /api/agreement, sign the agreement, before payment.
 *
 * Called while the buyer is still on the signature step, BEFORE a payment
 * session is created, because a business associate may not receive patient
 * data without a written contract, and "we'll record it when the webhook
 * lands" is not a contract. An abandoned checkout therefore leaves a signed
 * agreement that no account names. That is correct and deliberate.
 *
 * ## Recorded here, not on apps/app (owner, 14 October 2026)
 *
 * Until that day this route signed the payload over to apps/app's
 * /api/agreements, which rendered, stored and mailed the agreement. The AWS
 * host now has a standby mode that removes its database until the first
 * clinic pays, so a buyer must be able to sign with it off: the signature is
 * validated and the document rendered here, by the catalog's own code
 * (@healdesk/catalog/agreement-signing, the same functions apps/app ran), and
 * recorded as a SEALED record in the marketing Sheet's `agreements` tab
 * (lib/checkout/records.ts). apps/app imports it, with the same id and
 * accepted-at, when the purchase's first invoice is paid
 * (docs/design/checkout-records-on-vercel-2026-10-14.md). Nothing here calls
 * apps/app.
 *
 * The record keeps no text: it keeps what re-renders the document exactly,
 * with the hash beside it, and every reader renders it again and checks.
 *
 * ## Why the server renders the document
 *
 * The browser is shown the agreement, but it does not get to say what it was.
 * The text is rendered again from the submitted answers, here, and compared
 * with the hash of what the screen displayed: a mismatch is refused and
 * nothing is recorded. The assent sentence stored is derived here too.
 *
 * ## The copy
 *
 * The signer is mailed the PDF of what they signed, through this site's
 * Resend sender (lib/email/agreement-copy.ts), within eight seconds; a send
 * still running then is left to finish (Next's `after`) and still records
 * its evidence. The response says whether the copy went, because the browser
 * is the only place the buyer can learn that it did not.
 *
 * ## The download cookie
 *
 * The buyer wants a PDF of what they just signed, and the obvious URL keyed on
 * the acceptance id would be a bearer credential for a signed contract. So the
 * id is not the credential. THIS response is: the cookie minted here is a
 * short-lived, HTTP-only MAC valid for this one agreement id and no other, and
 * /api/agreement/pdf serves the document only against it
 * (lib/agreement-download.ts).
 *
 * ## Recording may never cost the buyer their signature
 *
 * Once the record is written, nothing after it (the cookie, the copy, the
 * setup request's progress) may turn the answer into a failure: a buyer told
 * their agreement was not recorded would sign again, and two records would
 * stand for one act of assent.
 *
 * Rate limited harder than checkout, because this writes a record on every
 * call and the caller is unauthenticated by construction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function refuse(error: string, status: number, field?: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { error, ...(field ? { field } : {}) },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!recordsConfigured()) {
    console.error(
      "[healdesk] signing is unavailable: HEALDESK_PROVISION_SECRET, MARKETING_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is not set",
    );
    return refuse("Signing is unavailable.", 503);
  }

  const limit = await rateLimit(`agreement:${clientKey(request.headers)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return refuse("Too many attempts. Try again shortly.", 429, undefined, { "Retry-After": String(limit.retryAfter) });
  }

  // A signature is a dozen short fields. The declared length is a claim, so
  // the text is measured too, before it is parsed.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SIGN_REQUEST_BYTES) {
    return refuse("Request too large.", 413);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_SIGN_REQUEST_BYTES) return refuse("Request too large.", 413);

  /**
   * The setup link, while the purchase is by invitation (lib/checkout-mode.ts).
   *
   * Signing comes before paying, so it is gated the same way, by the same
   * function, as /api/checkout: without a valid link there is nothing to sign
   * for, and every refusal here is one fewer orphaned record. The signatory's
   * address must be the one the link was sent to, because it becomes the
   * clinic's one address.
   */
  const gate = await gateState(readCookie(request.headers, SETUP_COOKIE));
  let invited: { id: string; signedAt: Date | null } | null = null;
  if (gate.mode === "pilot") {
    const refused = refuseWithoutLink(gate);
    // A personalised demo is an invitation too (lib/setup-gate.ts).
    if (refused && !(await demoInvitation(request.headers.get("cookie")))) return refused;
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse("Invalid request body.", 400);
  }

  if (gate.mode === "pilot" && gate.link === "valid") {
    if (normalizeEmail(String(body.signatoryEmail ?? "")) !== gate.request.emailNormalized) {
      return refuseOtherEmail(gate.request, "signatoryEmail");
    }
    invited = { id: gate.request.id, signedAt: gate.request.signedAt };
  }

  // The calendar answers and the agreement's kind (lib/checkout/order.ts),
  // under the field names the funnel's steps use.
  const unsignable = signRequestRefusal(body);
  if (unsignable) return Response.json(unsignable, { status: 422, headers: { "Cache-Control": "no-store" } });

  // Everything a signature must be, and the document it signs, by the
  // catalog's rules: the version (current, or inside a release overlap),
  // the kind the practice signs, every answer, the published assent label,
  // the address (one healdesk can mail), and the caps on every typed field.
  // Today in UTC is the effective date: the signer's clock is not asked.
  const acceptedAt = new Date();
  let prepared: PreparedSigning;
  try {
    validateSignRequest(body);
    prepared = prepareSigning(body, effectiveDateOf(acceptedAt), {});
  } catch (error) {
    if (error instanceof AgreementError) return refuse(error.message, 422, error.field);
    throw error;
  }

  /**
   * The screen and the record must agree, byte for byte. A mismatch means the
   * browser displayed something other than what would be recorded (a stale
   * bundle, a tampered client), and a signature on a document nobody can
   * identify is worse than none: it looks like evidence.
   */
  const displayed = typeof body.displayedHash === "string" ? body.displayedHash.toLowerCase() : "";
  if (displayed && displayed !== prepared.hash) {
    return refuse(
      "The agreement on your screen doesn't match our copy. Please reload the page and read it again — nothing has been recorded.",
      422,
      "displayedHash",
    );
  }

  const record = agreementRecordFrom(prepared, {
    id: randomUUID(),
    acceptedAt,
    // Where the signature came from: the browser, as Vercel reports it.
    ipAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim() ||
      null,
    userAgent: request.headers.get("user-agent"),
  });

  try {
    await appendAgreementRecord(record);
  } catch (error) {
    console.error("[healdesk] agreement NOT recorded", {
      error: error instanceof Error ? error.message : String(error),
    });
    return refuse("We couldn't record your agreement. Please try again.", 502);
  }

  // One line per signature: what was signed, never who signed it.
  console.info("[healdesk] agreement signed", {
    agreementId: record.id,
    version: record.documentVersion,
    hash: record.documentHash,
  });

  // From here the agreement is recorded, and nothing below may say otherwise.
  const copy = await deliverAgreementCopyWithin(COPY_BUDGET_MS, record, prepared.text, keepAlive);

  const out = NextResponse.json(
    {
      agreementId: record.id,
      version: record.documentVersion,
      hash: record.documentHash,
      text: prepared.text,
      acceptedAt: record.acceptedAt,
      approvedByCounsel: record.approvedByCounsel,
      copy: copyReport(copy),
    },
    {
      status: 201,
      // The agreement text with the signatory's name and address in it, and
      // the download credential in Set-Cookie: no cache keeps this.
      headers: { "Cache-Control": "no-store" },
    },
  );

  try {
    out.cookies.set(DOWNLOAD_COOKIE, issueDownloadToken(record.id), downloadCookieOptions());
  } catch (error) {
    // Recorded already. The checkout falls back to the text copy; the id is
    // the reference the checkout displays, and the only way to find the record.
    console.error(`[healdesk] agreement ${record.id}: download cookie not issued`, error);
  }

  // Progress for /admin/setup: the first signature on this link.
  if (invited && !invited.signedAt) {
    try {
      await updateSetupRequest(invited.id, { signedAt: acceptedAt });
    } catch (error) {
      console.error("[healdesk] could not mark the setup request signed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}

/** Hold the function open for a copy still sending after the response; outside a request (tests), nothing to hold. */
function keepAlive(pending: Promise<unknown>): void {
  try {
    after(() => pending.then(() => undefined));
  } catch {
    // Not in a request scope: the promise runs on regardless.
  }
}

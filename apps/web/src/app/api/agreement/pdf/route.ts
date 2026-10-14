import { renderAgreementPdf, type AgreementPdf } from "@healdesk/catalog/agreement-pdf";
import { agreementPdfRecordOf } from "@healdesk/catalog/checkout-record";
import { cookies } from "next/headers";

import {
  DOWNLOAD_COOKIE,
  DOWNLOAD_TTL_SECONDS,
  verifyDownloadToken,
} from "@/lib/agreement-download";
import { findAgreementRecord, recordsConfigured, type AgreementLookup } from "@/lib/checkout/records";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/agreement/pdf?id=<agreementId>, the executed agreement, as a file:
 * the business associate agreement, or the Data Protection Agreement a
 * practice HIPAA does not reach signs instead.
 *
 * ## This is a security boundary, and the id is not the credential
 *
 * `lib/gate.ts` says of itself that it is "not a security boundary, and nothing
 * behind it is sensitive". Both halves are false here. Behind this route sits a
 * countersigned business associate agreement: the practice's legal name, the
 * name and work email of the human who signed, the record of assent, and the
 * agreement text. Nothing in this file may be relaxed on the strength of the
 * demo gate having relaxed it first.
 *
 * The obvious design, `/agreement/<uuid>.pdf`, was rejected before it was
 * built: the acceptance id is deliberately NOT in the email, and an endpoint
 * keyed on it would turn a UUID mailed to an unverified address into a bearer
 * credential. So the uuid in the query string authorises nothing. The
 * credential is the cookie `lib/agreement-download.ts` mints at signature
 * time, bound by HMAC to one agreement id and expiring in thirty minutes.
 * Possession of the uuid alone gets a 401, before anything is read, so an
 * unauthenticated caller cannot make us render a PDF, and cannot learn from
 * the status code whether the id they guessed exists.
 *
 * ## Rendered here, from the record (owner, 14 October 2026)
 *
 * Until that day this route asked apps/app, which held the acceptance, to
 * render it. The signature is recorded here now, as a sealed record in the
 * marketing Sheet, so a buyer can sign and download while the AWS host is in
 * standby (docs/design/checkout-records-on-vercel-2026-10-14.md). The record
 * is opened only if its seal is good, and the document is rendered again from
 * it with the catalogue's renderer and must hash to what was signed
 * (lib/checkout/records.ts, findAgreementRecord); the PDF is the catalog's,
 * the same file apps/app renders for a resend. Nothing here calls apps/app.
 *
 * ## Failing fast beats hanging
 *
 * This sits on the last screen before payment, and the text the checkout
 * already holds is the authority the PDF only presents, so every failure is
 * survivable: the buyer falls back to the plain-text copy. Each failure gets
 * its own status, so the UI can tell whether retrying could ever help: 404
 * and 409 cannot (there is no such record, or it fails its own check), 502,
 * 503 and 500 might.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per agreement, not per IP: the token has been verified when this runs, so
 * the key cannot be chosen by an unauthenticated caller, and one buyer behind
 * a shared office NAT cannot spend another's budget. The window is the
 * cookie's own lifetime.
 */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = DOWNLOAD_TTL_SECONDS * 1000;

function problem(message: string, status: number, extra: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

const USE_TEXT_COPY = "We couldn't produce the PDF. Download the text copy of your agreement instead.";

const NO_PDF = "This agreement is not available as a PDF. Download the text copy of your agreement instead.";

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";

  // 1. The credential: the cookie, bound to this id. Before anything is read.
  const store = await cookies();
  if (!verifyDownloadToken(store.get(DOWNLOAD_COOKIE)?.value, id)) {
    return problem(
      "This download has expired. Use the text copy of your agreement, or ask us to resend it.",
      401,
    );
  }

  // 2. A valid token can only have been minted for an id we issued, so a
  //    non-uuid here is our bug, not the caller's.
  if (!UUID.test(id)) {
    console.error("[healdesk] agreement pdf: a valid download token named a non-uuid id");
    return problem("Invalid agreement id.", 400);
  }

  // 3. Rate limit.
  const limit = await rateLimit(`agreement-pdf:${id}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return problem("Too many download attempts. Try again shortly.", 429, {
      "Retry-After": String(limit.retryAfter),
    });
  }

  // 4. Configuration. Below the token check so an unauthenticated caller
  //    cannot probe whether this deployment is wired up.
  if (!recordsConfigured()) {
    console.error("[healdesk] agreement pdf: the checkout records are not configured");
    return problem(USE_TEXT_COPY, 503);
  }

  // 5. The record, opened and re-rendered.
  let found: AgreementLookup;
  try {
    found = await findAgreementRecord(id);
  } catch (error) {
    console.error("[healdesk] agreement pdf: the record could not be read", {
      error: error instanceof Error ? error.message : String(error),
    });
    return problem(USE_TEXT_COPY, 502);
  }
  if (found.status === "missing") return problem(NO_PDF, 404);
  if (found.status === "refused") {
    // An edited record, or one the template no longer renders to its hash: a
    // PDF printing a hash its own text does not produce would be manufactured
    // evidence, so none is made, and someone needs to look.
    console.error("[healdesk] AGREEMENT RECORD FAILED ITS CHECK; no PDF produced", {
      agreementId: id,
      problem: found.problem,
    });
    return problem(NO_PDF, 409);
  }

  let pdf: AgreementPdf;
  try {
    pdf = await renderAgreementPdf(agreementPdfRecordOf(found.record, found.text));
  } catch (error) {
    console.error("[healdesk] agreement pdf render failed", {
      agreementId: id,
      error: error instanceof Error ? error.name : "unknown error",
    });
    return problem(USE_TEXT_COPY, 500);
  }

  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // The renderer's own name, built from a filtered alphabet
      // (`healdesk-baa-<version>-<date>.pdf`): no quote, newline or separator,
      // and no clinic or signer name.
      "Content-Disposition": `attachment; filename="${pdf.filename}"`,
      "Content-Length": String(pdf.bytes.byteLength),
      // A signed contract naming the person who signed it, on what may be a
      // shared front-desk machine. Nothing caches this, at any hop.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

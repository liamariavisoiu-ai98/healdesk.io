import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import {
  DOWNLOAD_COOKIE,
  downloadCookieOptions,
  issueDownloadToken,
} from "@/lib/agreement-download";
import { normalizeEmail } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { demoInvitation, gateState, refuseOtherEmail, refuseWithoutLink } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";
import { updateSetupRequest } from "@/lib/setup-requests";

/**
 * POST /api/agreement, sign the BAA, before payment.
 *
 * Same shape as /api/checkout: the marketing site never talks to the product
 * database, it signs the payload and forwards it. What differs is when it runs.
 * This is called while the buyer is still on the signature step, BEFORE a
 * payment session is created, because a business associate may not receive
 * patient data without a written contract, and "we'll record it when the
 * webhook lands" is not a contract.
 *
 * The practical consequence is that an abandoned checkout leaves a signed
 * agreement with no organization attached. That is correct and deliberate. See
 * apps/app/src/lib/agreements.ts.
 *
 * Rate limited harder than checkout, because this endpoint writes a row on
 * every call and the caller is unauthenticated by construction.
 *
 * ## Why the app's body is returned whole
 *
 * The 201 carries more than an id: the rendered text, and what became of the
 * copy the app tried to email the signer. That last one is the only place the
 * browser can learn its copy did not go out, and the buyer is on the signature
 * step waiting to be told. Narrowing this to the fields the checkout happened
 * to need on the day would drop it silently, which is exactly how it went
 * missing before. So the payload is passed through untouched, and anything
 * added on the app side reaches the client without a change here.
 *
 * ## Why this response also carries a download cookie
 *
 * The buyer wants a PDF of what they just signed, and the obvious way to give
 * them one is a URL keyed on the acceptance id. That would be a mistake, and it
 * is the specific mistake this codebase already decided not to make: the id is
 * deliberately kept out of the emailed copy, because a UUID sent to an address
 * nobody has verified is a bearer credential for a signed contract the moment
 * anything will serve a document in exchange for it.
 *
 * So the id is not the credential. THIS response is. A successful signature is
 * the one moment where the server knows the browser it is answering is the
 * browser that signed, and the cookie minted here says that and nothing else:
 * a short-lived, HTTP-only MAC that is arithmetically valid for this one
 * agreement id and no other. /api/agreement/pdf serves a document only against
 * it. Possession of the UUID alone gets a 401. See lib/agreement-download.ts,
 * which unlike lib/gate.ts is a security boundary and says so.
 *
 * The cookie is minted from the app's own 201, received over the HMAC-signed
 * channel, and from nothing the browser sent. A body that does not parse, a
 * status that is not 201, or an id that is not a UUID all yield no cookie at
 * all.
 *
 * ## Minting a cookie may never cost the buyer their signature
 *
 * By the time this code runs the agreement is a row in an append-only table.
 * The buyer is one step from paying, and the acceptance table has no notion of
 * "the same signature twice", a 500 here would tell a browser that its
 * agreement was not recorded when it was, and the honest response to that
 * message is to sign again, which writes a second row for one act of assent.
 *
 * `issueDownloadToken` throws when it has no key to sign with, and its own
 * comment says callers must catch. So the whole cookie step is wrapped, logged
 * loudly and then abandoned. The client gets the app's 201 either way, and the
 * checkout falls back to the stored text, which is the authority the PDF only
 * presents. The cost of failing here is a plainer file, never a lost contract.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Postgres `uuid`, which is what the acceptance id is. See db/schema.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id of an agreement this request just recorded, or null.
 *
 * Deliberately narrow, because its return value becomes the subject of a
 * credential. Only a 201 counts: that is the single status /api/agreements
 * issues on a write, and treating any 2xx as a signature would let a future
 * 200 somewhere upstream mint a download token for a row that was not created
 * here. The shape check is the same argument one step down: the id is the MAC
 * input that binds the token to one record, so a value that cannot be an id
 * must never become the thing a download is authorised against.
 */
function signedAgreementId(status: number, payload: string): string | null {
  if (status !== 201) return null;

  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }

  const id = (body as { agreementId?: unknown } | null)?.agreementId;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;

  if (!secret || !target) {
    console.error(
      "[healdesk] HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return Response.json({ error: "Signing is unavailable." }, { status: 503 });
  }

  const limit = await rateLimit(
    `agreement:${clientKey(request.headers)}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return Response.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const raw = await request.text();

  /**
   * The setup link, while the purchase is by invitation (lib/checkout-mode.ts).
   *
   * Signing comes before paying, so it is gated the same way, by the same
   * function, as /api/checkout: without a valid link there is nothing to sign
   * for, and every refusal here is one fewer orphaned row in an append-only
   * table. The signatory's address must be the one the link was sent to,
   * because it becomes the clinic's one address. The body is parsed only to
   * read that address; what is forwarded is still the raw bytes.
   */
  const gate = await gateState(readCookie(request.headers, SETUP_COOKIE));
  let invited: { id: string; signedAt: Date | null } | null = null;
  if (gate.mode === "pilot") {
    const refused = refuseWithoutLink(gate);
    // A personalised demo is an invitation too (lib/setup-gate.ts).
    if (refused && !(await demoInvitation(request.headers.get("cookie")))) return refused;
    if (gate.link === "valid") {
      let signatoryEmail = "";
      try {
        signatoryEmail = String((JSON.parse(raw) as { signatoryEmail?: unknown }).signatoryEmail ?? "");
      } catch {
        return Response.json({ error: "Invalid request body." }, { status: 400 });
      }
      if (normalizeEmail(signatoryEmail) !== gate.request.emailNormalized) {
        return refuseOtherEmail(gate.request, "signatoryEmail");
      }
      invited = { id: gate.request.id, signedAt: gate.request.signedAt };
    }
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL("/api/agreements", target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(raw, timestamp, secret),
        // Forwarded so the acceptance record shows where the signature came
        // from, not where our server sits.
        "x-forwarded-for":
          request.headers.get("x-forwarded-for") ??
          request.headers.get("x-real-ip") ??
          "",
        "user-agent": request.headers.get("user-agent") ?? "",
      },
      body: raw,
    });
  } catch (error) {
    console.error("[healdesk] signing endpoint unreachable", error);
    return Response.json(
      { error: "We couldn't record your agreement. Please try again." },
      { status: 502 },
    );
  }

  const payload = await response.text();
  // The app's bytes, unchanged. Parsed above only to read the id; never
  // re-serialised, so a field this file has never heard of still reaches the
  // browser exactly as the app wrote it.
  const out = new NextResponse(payload, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      /**
       * This is the one response in the whole feature that is worth storing
       * twice over: the body is the agreement text with the signatory's name
       * and address in it, and the `Set-Cookie` below is the download
       * credential itself. A conformant shared cache will not reuse a POST
       * response with no freshness information anyway, which is why nothing
       * was obviously broken without this, but "no cache is allowed to" is a
       * weaker guarantee than "we said not to", and every sibling on this path
       * (/api/agreement/pdf here, /api/agreements/[id]/pdf in apps/app, and
       * apps/app's blanket next.config header) says it out loud. apps/web has
       * no blanket header, so this route has to.
       */
      "Cache-Control": "no-store",
    },
  });

  const agreementId = signedAgreementId(response.status, payload);
  if (agreementId) {
    try {
      out.cookies.set(
        DOWNLOAD_COOKIE,
        issueDownloadToken(agreementId),
        downloadCookieOptions(),
      );
    } catch (error) {
      // The agreement is already recorded. Whatever went wrong here, the one
      // thing that must not happen is telling this browser its signature
      // failed. The id is safe to log. It is the reference the checkout
      // already displays, and it is the only way to find the row later.
      console.error(
        `[healdesk] agreement ${agreementId}: download cookie not issued`,
        error,
      );
    }
  }

  // Progress for /admin/setup: the first signature on this link. Never a
  // reason to fail the response, which already carries a recorded signature.
  if (agreementId && invited && !invited.signedAt) {
    try {
      await updateSetupRequest(invited.id, { signedAt: new Date() });
    } catch (error) {
      console.error("[healdesk] could not mark the setup request signed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}

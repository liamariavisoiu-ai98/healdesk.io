import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { cookies } from "next/headers";

import {
  DOWNLOAD_COOKIE,
  DOWNLOAD_TTL_SECONDS,
  verifyDownloadToken,
} from "@/lib/agreement-download";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/agreement/pdf?id=<agreementId>, the executed BAA, as a file.
 *
 * ## This is a security boundary, and the id is not the credential
 *
 * `lib/gate.ts` says of itself that it is "not a security boundary, and nothing
 * behind it is sensitive". Both halves are false here. Behind this route sits a
 * countersigned HIPAA business associate agreement: the practice's legal name,
 * the name and work email of the human who signed, the record of assent, and
 * the agreement text. Nothing in this file may be relaxed on the strength of
 * the demo gate having relaxed it first.
 *
 * The obvious design, `/agreement/<uuid>.pdf`, was rejected before it was
 * built, in one sentence from an earlier review of this codebase:
 *
 *   > The acceptance id is deliberately NOT in the email. A future "download
 *   > what I signed" endpoint keyed on it would turn a UUID mailed to an
 *   > unverified address into a bearer credential.
 *
 * So the uuid in the query string authorises nothing. The credential is the
 * cookie `lib/agreement-download.ts` mints at signature time, which is bound by
 * HMAC to one agreement id and expires in thirty minutes. Possession of the
 * uuid alone gets a 401 here, and the cookie, which is the part that has to
 * stay true, gets it *without* this route making a single call inward. An unauthenticated
 * caller cannot make us render a PDF, and cannot learn from the status code
 * whether the id they guessed exists.
 *
 * ## The chain
 *
 *   browser -> apps/web (this file: signed cookie) -> apps/app (HMAC) -> PDF
 *
 * The renderer lives in apps/app because that is the only service holding the
 * stored acceptance, and its endpoint is server-to-server only: it is
 * authenticated with `HEALDESK_PROVISION_SECRET` over body and timestamp, the
 * same way `/api/checkout` and `/api/agreement` reach provisioning. The browser
 * never has that secret and must never reach that endpoint. Two independent
 * checks, and neither is sufficient alone: the cookie says *which* browser, the
 * HMAC says *which service*.
 *
 * ## The agreement id travels in the signed body, not only in the path
 *
 * The upstream signature covers `timestamp + body`. If the id lived only in the
 * URL path, one captured pair of headers would be replayable against any other
 * id for the whole 300-second skew window, because the MAC would not have
 * changed. Putting the id in the JSON body binds it to the signature.
 *
 * This is half a contract: the app side must reject a request whose body id
 * disagrees with its path segment. If that check is ever dropped there, the
 * binding here becomes decoration.
 *
 * ## Failing fast beats hanging
 *
 * This sits on the critical path of checkout, on the last screen before
 * payment. The stored text is the authority and the PDF is a presentation of
 * it, so every failure mode here is survivable: the checkout keeps its plain
 * `.txt` copy of the agreement and the buyer leaves with the document either
 * way. What is *not* survivable is a spinner. Hence a hard timeout on the
 * inward call and a distinct, actionable status on every path, so the UI can
 * degrade to the text copy instead of waiting.
 *
 * ## Why the body is buffered rather than piped through
 *
 * Streaming `upstream.body` straight to the browser is cheaper, and wrong here
 * for two reasons. The timeout signal stays armed for the life of the response,
 * so an abort mid-body would truncate a download whose 200 and headers had
 * already been committed, a buyer left holding a corrupt file believing it is
 * their contract, which is worse than an error, because the fallback link is by
 * then behind them. And a piped body cannot be inspected: buffering is what
 * lets us refuse to label something `application/pdf` that does not begin
 * `%PDF-`. These files are a few pages of Courier; the memory is not the
 * consideration. Every failure is therefore decided before a status is sent.
 *
 * Note the `Content-Length` that comes with buffering is computed here and
 * never forwarded from upstream: `fetch` transparently decompresses, so an
 * upstream length would describe the encoded bytes and not the ones we send.
 *
 * ## Upstream failures are translated, never forwarded
 *
 * apps/app puts a machine-readable `code` on every problem response for exactly
 * this reader, so the classification survives a reworded message and a second
 * route answering 400. It is read, logged, and turned into one of our own
 * statuses and one of our own sentences. What is never forwarded is the
 * upstream body or the upstream URL: the body is written for us and on some
 * paths names the record, and the URL is our internal topology. The buyer's
 * next move is the text copy in every case; the status is what tells the UI
 * whether retrying could ever help.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Postgres `uuid`, which is what the acceptance id is. See db/schema.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Long enough for a cold start in apps/app plus a render, short enough that a
 * buyer staring at the last step before payment gets their fallback link back
 * rather than a spinner. A slow apps/app must fail, not queue.
 */
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Per agreement, not per IP.
 *
 * The token has already been verified when this runs, so the key cannot be
 * chosen by an unauthenticated caller, and one buyer behind a shared office NAT
 * cannot spend another's budget. The window matches the cookie's own lifetime:
 * a single signature is worth this many renders and then it is expired anyway.
 */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = DOWNLOAD_TTL_SECONDS * 1000;

/**
 * A lower bound, not a memory bound. `fetch` decompresses transparently, so a
 * declared `content-length` is at most the decoded size, which makes it sound
 * for *rejecting* (over the cap encoded implies over the cap decoded) and
 * useless for accepting. It buys an early bail on an obviously wrong response
 * without pretending to cap what a header-less response can allocate.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** "%PDF-". Compared as bytes so no decoder has to be trusted with them. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** Used when upstream sends no usable filename. Names the document, nothing else. */
const FALLBACK_FILENAME = "healdesk-baa.pdf";

/**
 * One sentence the checkout can show, and never anything from upstream.
 *
 * The app's error bodies and the app's URL both stay on our side of this
 * boundary: they describe our internal topology, and the buyer can act on
 * exactly one thing regardless of which of them failed.
 */
function problem(
  message: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", ...extra } },
  );
}

/** Whatever went wrong, the buyer's next move is the same. */
const USE_TEXT_COPY =
  "We couldn't produce the PDF. Download the text copy of your agreement instead.";

/** For the failures a retry cannot fix. Still says nothing about why. */
const NO_PDF =
  "This agreement is not available as a PDF. Download the text copy of your agreement instead.";

/**
 * A problem response from apps/app is a small JSON object. Anything claiming
 * otherwise is not one, and is dropped unread rather than buffered.
 */
const UPSTREAM_PROBLEM_BYTES = 4_096;

/** Release the socket without reading a body we have already decided to discard. */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * The upstream `code`, or null when there isn't a usable one.
 *
 * Takes ownership of the body either way: it is read here or cancelled here,
 * and never left half-consumed on a socket.
 *
 * The value is pattern-checked before it is allowed near a log line. It arrives
 * over the network, and a string with a newline in it writes a second, forged
 * log entry. Constraining it to the shape apps/app actually emits costs nothing
 * and removes that; an unrecognised value is simply null, which lands on the
 * generic branch, which is the safe direction to be wrong in.
 */
async function upstreamCode(response: Response): Promise<string | null> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const declared = Number(response.headers.get("content-length"));

  if (
    !type.startsWith("application/json") ||
    (Number.isFinite(declared) && declared > UPSTREAM_PROBLEM_BYTES)
  ) {
    discard(response);
    return null;
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw.length > UPSTREAM_PROBLEM_BYTES) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const code = (parsed as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError`, which undici may hand
 * back nested under `cause`. Both shapes are the same event and both deserve a
 * 504 rather than being logged as an unreachable host.
 */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.name === "TimeoutError";
}

/**
 * The upstream filename, reduced to something that cannot do anything.
 *
 * It is echoed into a header we send, so it is treated as hostile even though
 * apps/app builds it from a filtered template version. A CR or LF here would be
 * response header injection; a `"` would end the quoted string early and let
 * the rest be read as further disposition parameters; a `/` or a `..` would be
 * a path for whatever the browser or an intermediary does with the name. The
 * allowlist removes all three categories at once rather than blocking them one
 * at a time, and anything left empty by it falls back to a constant.
 *
 * RFC 5987's `filename*=` is deliberately ignored rather than decoded: these
 * names are ASCII by construction upstream, and a percent-decoder is another
 * way for bytes we just excluded to come back in.
 */
function safeFilename(disposition: string | null): string {
  if (!disposition) return FALLBACK_FILENAME;

  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  if (raw.length === 0) return FALLBACK_FILENAME;

  // Last segment first, so a name shaped like a path cannot survive as one.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // A leading dot hides the file; a leading dash reads as a flag to whatever
    // the buyer eventually pipes it into.
    .replace(/^[.\-]+/, "")
    .slice(0, 120);
  if (cleaned.length === 0) return FALLBACK_FILENAME;

  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";

  /**
   * 1. Authorise. FIRST, before the environment is read, before anything is
   *    parsed, and above all before anything is asked of apps/app.
   *
   * `verifyDownloadToken` takes the id as an input to the MAC, so a token that
   * is valid for a different agreement fails here exactly as a forged one does.
   * A missing `id` reaches it as "" and is refused for the same reason, which
   * is why there is no separate 400 for it: every unauthenticated shape leaves
   * with the identical 401, so nothing about which ids exist can be read off
   * the status code.
   */
  const store = await cookies();
  if (!verifyDownloadToken(store.get(DOWNLOAD_COOKIE)?.value, id)) {
    return problem(
      "This download has expired. Use the text copy of your agreement, or ask us to resend it.",
      401,
    );
  }

  /**
   * 2. Shape. Defence in depth, and deliberately *after* the token check so it
   *    can never become the oracle step 1 refuses to be.
   *
   * The id is interpolated into an upstream path below. Today it can only be a
   * uuid, because the only thing that mints these tokens is a route that checks
   * the same pattern before minting. This is the check that survives that route
   * being edited. Reaching it means a token was signed for something that is
   * not an id, which is our bug and belongs in our logs.
   */
  if (!UUID.test(id)) {
    console.error(
      "[healdesk] agreement pdf: a valid download token named a non-uuid id",
    );
    return problem("Invalid agreement id.", 400);
  }

  // 3. Rate limit.
  const limit = await rateLimit(`agreement-pdf:${id}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.ok) {
    return problem("Too many download attempts. Try again shortly.", 429, {
      "Retry-After": String(limit.retryAfter),
    });
  }

  // 4. Configuration. Below the token check so an unauthenticated caller cannot
  //    probe whether this deployment is wired up.
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;
  if (!secret || !target) {
    console.error(
      "[healdesk] HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return problem(USE_TEXT_COPY, 503);
  }

  // 5. Ask apps/app, server to server. Same signing pattern as /api/checkout:
  //    the HMAC covers the timestamp and the body, and the body carries the id
  //    so the signature is worthless against any other agreement.
  const body = JSON.stringify({ agreementId: id });
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let upstream: Response;
  try {
    upstream = await fetch(
      new URL(`/api/agreements/${encodeURIComponent(id)}/pdf`, target),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: sign(body, timestamp, secret),
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (error) {
    if (isTimeout(error)) {
      console.error(
        `[healdesk] agreement pdf timed out after ${UPSTREAM_TIMEOUT_MS}ms`,
      );
      return problem(USE_TEXT_COPY, 504);
    }
    console.error("[healdesk] agreement pdf endpoint unreachable", error);
    return problem(USE_TEXT_COPY, 502);
  }

  if (!upstream.ok) {
    // The status and the code go to our logs; the body never leaves this
    // function. It is written for us, and on some paths it names the record.
    const code = await upstreamCode(upstream);
    console.error(
      "[healdesk] agreement pdf refused upstream:",
      upstream.status,
      code ?? "no code",
    );

    /**
     * Two upstream conditions are permanent and are told apart from the rest,
     * because "retrying will not help" is the one thing the UI can usefully do
     * differently: there is no such agreement (404), and the stored record
     * failed its own integrity check so apps/app refuses to render it (409).
     *
     * Both are safe to distinguish here, and only here, because the caller has
     * already proved with the cookie that they are the session that signed this
     * id. Neither reaches an unauthenticated caller, so neither is an oracle.
     * What the buyer is told is the same sentence in both cases: this route does
     * not explain to a clinic mid-checkout that their record looks tampered
     * with. That conversation belongs to ops, and the security event apps/app
     * writes is what starts it.
     *
     * Status and code are both checked so a change to either on the app side
     * degrades to the generic branch rather than mislabelling.
     */
    if (upstream.status === 404 || code === "not_found") {
      return problem(NO_PDF, 404);
    }
    if (upstream.status === 409 || code === "record_integrity") {
      return problem(NO_PDF, 409);
    }
    return problem(USE_TEXT_COPY, 502);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    discard(upstream);
    console.error(
      "[healdesk] agreement pdf upstream sent",
      contentType || "no content type",
    );
    return problem(USE_TEXT_COPY, 502);
  }

  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
    discard(upstream);
    console.error("[healdesk] agreement pdf upstream too large:", declared);
    return problem(USE_TEXT_COPY, 502);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch (error) {
    // Includes the timeout firing while the body was still arriving. Nothing
    // has been sent to the browser yet, which is the whole point of buffering.
    if (isTimeout(error)) {
      console.error("[healdesk] agreement pdf timed out mid-body");
      return problem(USE_TEXT_COPY, 504);
    }
    console.error("[healdesk] agreement pdf body did not arrive", error);
    return problem(USE_TEXT_COPY, 502);
  }

  // A content-type header is a claim; these five bytes are the document saying
  // so itself. We do not put `application/pdf` on anything that fails this.
  const head = new Uint8Array(
    bytes,
    0,
    Math.min(PDF_MAGIC.length, bytes.byteLength),
  );
  const looksLikePdf =
    head.length === PDF_MAGIC.length &&
    PDF_MAGIC.every((byte, index) => head[index] === byte);
  if (!looksLikePdf) {
    console.error("[healdesk] agreement pdf upstream body is not a PDF");
    return problem(USE_TEXT_COPY, 502);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeFilename(
        upstream.headers.get("content-disposition"),
      )}"`,
      "Content-Length": String(bytes.byteLength),
      // A signed contract naming the person who signed it, on what may be a
      // shared front-desk machine. Nothing caches this, at any hop.
      "Cache-Control": "no-store",
    },
  });
}

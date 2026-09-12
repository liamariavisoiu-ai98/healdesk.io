import { createHash } from "node:crypto";

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";
import {
  renderAgreementPdf,
  type AgreementPdf,
  type BaaAcceptanceRecord,
} from "@/lib/agreements/pdf";
import { recordSecurityEvent } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * POST /api/agreements/[id]/pdf — the signed agreement as a PDF, served only to
 * the server that has already proved the buyer is the one who signed it.
 *
 * ## The shape this deliberately is not
 *
 * The obvious design is `GET /agreement/<uuid>.pdf`, and it is the one thing
 * this must never be. The acceptance id is kept out of the confirmation email
 * on purpose, precisely so that it never becomes a bearer credential: a UUID
 * standing alone as the key to an executed HIPAA contract that carries the
 * practice's legal name, the signatory, their title, their IP address and their
 * user agent. Mail it to an address nobody verified and every place that id
 * subsequently lands — a forwarded thread, a mail server log, a support ticket,
 * a screenshot — is a place that now holds the document.
 *
 * So the id is not a credential here either. Knowing it gets you nothing. This
 * endpoint is server-to-server only and authenticates exactly the way
 * /api/provision and /api/agreements do: an HMAC over the request body and a
 * timestamp, keyed on HEALDESK_PROVISION_SECRET, which lives on our servers and
 * must never reach a browser.
 *
 * The chain is two links and two different questions:
 *
 *   browser -> apps/web (is this the session that signed?) -> here (is this our
 *   own server asking?) -> PDF
 *
 * apps/web answers the first with the short-lived cookie it issues at signature
 * time; this route answers the second. Neither answer is derivable from the id,
 * and neither is sufficient on its own.
 *
 * ## Why POST, and why the id in the path is not trusted
 *
 * The signature covers the body and the timestamp header, so the thing being
 * asked for has to travel in a body. A GET with the id in the path could only
 * be signed over a URL, which means a second signing scheme to write, review and
 * eventually get wrong, and it would put the id into every access log on the
 * way. The `[id]` segment therefore exists for readability and for the proxy's
 * prefix match; the id this route acts on is the one inside the SIGNED body,
 * and a path that disagrees with it is refused rather than reconciled. Trusting
 * the path would hand an attacker who captured one signed request the ability to
 * point it at any other agreement.
 *
 * ## Ordering
 *
 * Same as its two siblings: authenticate before parsing, parse before
 * validating, validate before touching the database. An unauthenticated caller
 * cannot make us do work.
 *
 * ## The proxy
 *
 * src/proxy.ts lists `/api/agreements` in SELF_AUTHENTICATING_PATHS and matches
 * it with `startsWith`, so `/api/agreements/<id>/pdf` is already covered by that
 * prefix and no new entry is needed. Being on that list is not an exemption from
 * authentication — it is the statement that this route does its own, which is
 * everything above.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The machine-readable half of every failure.
 *
 * The browser-facing route in apps/web has to degrade to the plain-text copy
 * whenever a PDF cannot be produced, and "which failure was it" decides what it
 * tells the buyer and what ops sees. Branching on the status code alone would
 * work until somebody adds a second 400; branching on a message string would
 * break the day the message is reworded. So the code is the contract and the
 * message is prose.
 */
type ProblemCode =
  | "unavailable"
  | "too_large"
  | "unauthorized"
  | "invalid_body"
  | "not_found"
  | "record_integrity"
  | "render_failed";

function problem(
  message: string,
  status: number,
  code: ProblemCode,
): Response {
  return Response.json({ error: message, code }, { status });
}

/**
 * A body larger than this is not one of ours.
 *
 * The signature covers the body, so the body must be read before the caller is
 * authenticated — which is exactly the window in which an unauthenticated
 * stranger gets to choose how much memory we allocate. The real payload is one
 * JSON object holding a UUID, so the cap is generous by three orders of
 * magnitude and still closes the window.
 *
 * It has to be enforced WHILE reading. See readBoundedBody: a Content-Length is
 * absent on a chunked request and is a claim in any case, and a check on the
 * result of `request.text()` runs after the allocation it was meant to prevent.
 */
const MAX_BODY_BYTES = 8_192;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * The event name this route writes to security_events.
 *
 * A local const and NOT an export: Next validates the export surface of a
 * `route.ts` at build time and rejects anything that is not a handler or a
 * segment option, so a shared constant cannot live in this file. Its natural
 * home is beside COPY_SENT_EVENT in lib/agreements.ts, where a reader of these
 * rows would import it rather than retype it; that file belongs to another
 * workflow right now, so the name is written out here and the move is noted.
 */
const RECORD_INTEGRITY_EVENT = "baa_record_integrity_failed";

/** Not a person. This request is made by a machine holding the shared secret. */
const CALLER_LABEL = "apps/web checkout";

/**
 * The request body, or null when it is bigger than one of ours could be.
 *
 * `await request.text()` cannot be the cap. It resolves only once the whole
 * body is in memory, so a length check on what it returns is a check made after
 * the allocation it was supposed to prevent — this route answered 413 to a 4 MB
 * chunked body having first buffered all 4 MB of it. The declared
 * Content-Length is not the cap either: it is absent on a chunked request,
 * NaN when it is malformed, and a claim rather than a measurement in every
 * case. Both are still worth having as an early bail; neither bounds anything.
 *
 * So the stream is read with a running total and cancelled the moment it
 * exceeds the limit. That is the only point at which an unauthenticated
 * stranger stops choosing how much memory this process allocates, and this
 * endpoint sits on the PHI side of the system where that matters most.
 *
 * BYTES, not characters: `String.length` counts UTF-16 code units, so 8192
 * astral characters are 32KB of them. Decoded incrementally in stream mode so
 * that a multi-byte character split across two chunks still decodes to the one
 * character it is — the string handed back has to be byte-for-byte what the
 * caller signed, or every valid request fails its own signature.
 */
async function readBoundedBody(
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

/**
 * Why the record was refused, in the vocabulary of the table rather than of the
 * renderer.
 *
 * These are the four conditions `renderAgreementPdf` refuses on, restated here
 * so that this route can classify BEFORE calling it. The alternative was to call
 * the renderer and read its thrown message, and a security response that turns
 * on matching English prose is one reword away from silently reclassifying
 * tampering as a transient fault.
 *
 * Duplication is the cost, and it is bounded and one-directional. The renderer
 * keeps its own check and remains the authority — nothing here can cause a PDF
 * to be produced that it would have refused. If it ever grows a fifth refusal
 * this preflight will not recognise it, the throw lands in the catch below, and
 * the answer is a 500 with no PDF: the wrong label on the right outcome, which
 * is the direction to be wrong in.
 */
type IntegrityFault =
  | "accepted_at_invalid"
  | "text_missing"
  | "hash_missing"
  | "hash_mismatch";

type IntegrityCheck =
  | { ok: true }
  | { ok: false; fault: IntegrityFault; expected?: string; actual?: string };

function checkIntegrity(record: BaaAcceptanceRecord): IntegrityCheck {
  const acceptedAt = record.acceptedAt;
  if (!(acceptedAt instanceof Date) || Number.isNaN(acceptedAt.getTime())) {
    return { ok: false, fault: "accepted_at_invalid" };
  }

  const text = record.renderedText;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, fault: "text_missing" };
  }

  const stored = record.documentHash?.trim().toLowerCase() ?? "";
  if (!SHA256_HEX.test(stored)) {
    return { ok: false, fault: "hash_missing" };
  }

  // Byte-for-byte the renderer's own comparison, encoding included. A different
  // normalisation here would let a row pass this gate and then be refused by the
  // renderer, which is the one outcome this preflight exists to avoid mislabelling.
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (actual !== stored) {
    return { ok: false, fault: "hash_mismatch", expected: stored, actual };
  }

  return { ok: true };
}

/**
 * Record the refusal, and never let recording it become the failure.
 *
 * A row whose stored text no longer hashes to its recorded hash is a
 * record-integrity event: either the evidence column has been altered or the
 * hash has, and both are things somebody needs to be told about rather than a
 * blip to retry. It is written to security_events because that is where
 * identity-plane facts with no clinic to scope them by live.
 *
 * Wrapped in its own try/catch on the same reasoning as traceCopy: the audit
 * guard throws on metadata it dislikes, and losing the 409 to a failed INSERT
 * would replace a precise answer with a generic 500 — the exact conflation this
 * route was asked to avoid. Only the error's NAME is logged: a drizzle failure
 * carries the attempted statement and its bound parameters as own properties,
 * and application logs have none of the protections the database row has.
 */
async function traceIntegrityFailure(
  agreementId: string,
  organizationId: string | null,
  check: Extract<IntegrityCheck, { ok: false }>,
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<void> {
  try {
    await recordSecurityEvent(unsafeDb, {
      event: RECORD_INTEGRITY_EVENT,
      actorLabel: CALLER_LABEL,
      organizationId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        agreementId,
        fault: check.fault,
        // Only ever well-formed digests, and only on the branch that has two to
        // compare. assertNoPhi() strips 32+ character hex runs before its
        // phone-number check precisely so hashes can be recorded; an arbitrary
        // string out of a corrupted column would have no such guarantee, so the
        // other three faults record their name and nothing else.
        ...(check.expected && check.actual
          ? { expectedHash: check.expected, actualHash: check.actual }
          : {}),
      },
    });
  } catch (error) {
    console.error(
      "[healdesk] could not record BAA record-integrity failure:",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    console.error("[healdesk] HEALDESK_PROVISION_SECRET is not set");
    return problem("Copies are unavailable.", 503, "unavailable");
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return problem("Payload too large.", 413, "too_large");
  }

  // 1. Authenticate — before parsing, before the path is even read.
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    return problem("Payload too large.", 413, "too_large");
  }

  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    // Vague to the caller; the reason goes to our logs only. verify() checks the
    // timestamp window in both directions, so a captured request stops working
    // five minutes after it was made.
    console.warn("[healdesk] agreement pdf rejected:", verification.reason);
    return problem("Unauthorized.", 401, "unauthorized");
  }

  // 2. Parse.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("Invalid request body.", 400, "invalid_body");
  }

  // Unknown properties are ignored rather than rejected. The caller is our own
  // checkout and may carry more than this route reads; a strict shape here turns
  // an unrelated addition on that side into a broken download on this one.
  const requested =
    typeof body === "object" && body !== null && "agreementId" in body
      ? (body as { agreementId: unknown }).agreementId
      : undefined;

  if (typeof requested !== "string") {
    return problem("Invalid request body.", 400, "invalid_body");
  }

  // 3. Validate. The signed body is the authority for WHICH agreement.
  const agreementId = requested.trim().toLowerCase();
  if (!UUID.test(agreementId)) {
    // Same answer as an id that simply is not there: whether a given string was
    // ever a well-formed id of ours is not a fact this endpoint gives away.
    return problem("Not found.", 404, "not_found");
  }

  const { id: pathId } = await params;
  if (pathId.trim().toLowerCase() !== agreementId) {
    /**
     * The path is not covered by the signature; the body is. A mismatch is
     * therefore either our own caller being wrong or somebody pointing a
     * captured, still-valid signed request at a different agreement. Nothing is
     * served for either id — reconciling in favour of the body would work, but
     * refusing says out loud that the two are not interchangeable, and leaves a
     * log line where the attempt would otherwise be invisible.
     */
    // The path segment is caller-controlled and arrives percent-decoded, so a
    // newline in it would forge a second line in this log. Reduced to the
    // alphabet a UUID is made of and clamped, because what matters here is that
    // the two disagreed, not the exact bytes of the wrong one.
    console.warn(
      `[healdesk] agreement pdf: signed body ${agreementId} disagrees with path ` +
        pathId.replace(/[^A-Za-z0-9-]/g, "?").slice(0, 64),
    );
    return problem("Invalid request body.", 400, "invalid_body");
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;

  /**
   * Every column the renderer needs, selected under its own name, plus the id
   * and the organization for the audit trail.
   *
   * `BaaAcceptanceRecord` is a Pick off the table's inferred row, so this
   * projection satisfies it structurally and a renamed column breaks here at
   * compile time instead of rendering a blank field. The row is passed to the
   * renderer as a variable rather than an object literal so the two surplus
   * properties are not an excess-property error.
   */
  const [row] = await unsafeDb
    .select({
      id: baaAcceptances.id,
      organizationId: baaAcceptances.organizationId,
      documentVersion: baaAcceptances.documentVersion,
      documentHash: baaAcceptances.documentHash,
      renderedText: baaAcceptances.renderedText,
      assentLabel: baaAcceptances.assentLabel,
      acceptedByName: baaAcceptances.acceptedByName,
      acceptedByEmail: baaAcceptances.acceptedByEmail,
      acceptedByTitle: baaAcceptances.acceptedByTitle,
      ipAddress: baaAcceptances.ipAddress,
      userAgent: baaAcceptances.userAgent,
      acceptedAt: baaAcceptances.acceptedAt,
    })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, agreementId))
    .limit(1);

  if (!row) {
    // Byte-identical to the malformed-id answer above, and it says nothing about
    // whether this id ever existed, was deleted, or belongs to someone else.
    console.warn(`[healdesk] agreement pdf: no such agreement ${agreementId}`);
    return problem("Not found.", 404, "not_found");
  }

  /**
   * A corrupt record is not a failed request.
   *
   * The renderer refuses to lay out text that does not produce the hash printed
   * in its own footer, because a PDF asserting a digest its body does not yield
   * is manufactured evidence and worse than no copy at all. Folding that into a
   * 500 would file it alongside a timeout: retried, shrugged at, and never
   * looked into. It gets its own status and its own security event, and no PDF
   * is produced.
   *
   * 409 rather than 422 or 500: the request is well-formed and authorised, and
   * what conflicts is the stored record with itself.
   */
  const integrity = checkIntegrity(row);
  if (!integrity.ok) {
    console.error(
      `[healdesk] agreement ${row.id} failed its record-integrity check (${integrity.fault}); refusing to render`,
    );
    await traceIntegrityFailure(row.id, row.organizationId, integrity, {
      ipAddress,
      userAgent,
    });
    return problem(
      "This agreement record failed its integrity check, so a PDF copy cannot be produced from it.",
      409,
      "record_integrity",
    );
  }

  let pdf: AgreementPdf;
  try {
    pdf = await renderAgreementPdf(row);
  } catch (error) {
    /**
     * Anything reaching here is a renderer fault, not a record fault: the four
     * conditions renderAgreementPdf refuses on were all checked above. Name and
     * message, never the error object — the precedent in lib/agreements.ts is
     * that a thrown object's own properties can carry a statement and its bound
     * parameters, and the signatory's address is one of the values this row
     * holds.
     */
    console.error(
      `[healdesk] agreement ${row.id} pdf render failed:`,
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return problem("Could not produce the PDF copy.", 500, "render_failed");
  }

  /**
   * Copied into a plain ArrayBuffer on the way out.
   *
   * `renderAgreementPdf` hands back a `Uint8Array<ArrayBufferLike>`, and a body
   * may not be a view onto a SharedArrayBuffer, so the platform types refuse it.
   * One copy of a document measured in tens of kilobytes is the honest fix; the
   * alternative was a cast asserting something about the buffer that the type
   * does not say.
   */
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      /**
       * The renderer's own filename, which it built from a filtered alphabet
       * (`healdesk-baa-<version>-<date>.pdf`) precisely so a stored value could
       * never reach a header verbatim. It cannot contain a quote, a newline or a
       * path separator, and it carries no clinic or signer name. Do not invent
       * one here: a name assembled at this layer is a header injection waiting
       * for the first version string with a `"` in it.
       */
      "Content-Disposition": `attachment; filename="${pdf.filename}"`,
      /**
       * Stated rather than left to the runtime.
       *
       * The caller in apps/web buffers this body before it puts
       * `application/pdf` on anything, and refuses one that is larger than it
       * is willing to hold. That guard reads Content-Length, and a missing
       * header makes it a no-op — so the size is declared here, where it is
       * known exactly, instead of being inferred downstream from a body that
       * has already been read into memory.
       */
      "Content-Length": String(pdf.bytes.byteLength),
      // An executed contract naming the practice and the signatory. Not in a
      // shared cache, not on disk, not in a proxy between here and apps/web.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

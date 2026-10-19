import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  AgreementError,
  prepareSigning,
  validateSignRequest as validateSignRequestWith,
  type PreparedSigning,
  type SignAgreementRequest,
  type SignableOptions,
} from "@healdesk/catalog/agreement-signing";
import type { BaaVariables } from "@healdesk/catalog";

import { unsafeDb, type Queryable } from "@/db";
import { baaAcceptances, securityEvents } from "@/db/schema";
import { renderAgreementPdf } from "@/lib/agreements/pdf";
import { sendAgreementCopy } from "@/lib/email/agreement-copy";

import { recordSecurityEvent } from "./audit";
import type { RequestContext } from "./audit";
import { env } from "./env";
import { log } from "@/lib/log";

/**
 * Signing the data agreement, before payment: the business associate
 * agreement, or, for a practice HIPAA does not reach, the Data Protection
 * Agreement (plan Part L). `agreementKindFor` decides which, and both are
 * rendered by the server, compared with the hash of what the screen showed,
 * stored in `baa_acceptances` under their own namespaced versions and sent to
 * the signer as a PDF by the same code. The DPA is signed only once the owner
 * releases it: until then every request it would govern is refused.
 *
 * The ordering is the point. A covered entity may not hand patient data to a
 * business associate without a written contract (45 CFR 164.502(e)), so the
 * agreement cannot be something that lands after the card is charged, or
 * something carried through a payment provider's metadata and written only if
 * a webhook happens to arrive. It is written here, first, on its own.
 *
 * Which means an unbound acceptance is a normal state, not an error: someone
 * signed and then abandoned checkout. We would far rather hold a signed
 * agreement for a deal that never closed than take money for an account with
 * no agreement behind it.
 *
 * ## Why the server renders the document
 *
 * The browser is shown the agreement, but it does not get to say what the
 * agreement was. The text stored and hashed here is rendered again from the
 * submitted variables, server-side. Otherwise the evidentiary record is only as
 * good as a form field, and nobody could truthfully testify to what the screen
 * displayed.
 *
 * ## Why this is not `withTenant`
 *
 * There is no clinic yet — there is not even an organization. This is the
 * identity plane, like provisioning, and the table carries no clinic_id.
 *
 * ## Where a buyer signs now
 *
 * Since 14 October 2026 a buyer signs on apps/web, which records the
 * signature as a sealed record in the marketing Sheet and mails the copy, so
 * a buyer can sign while this host is in standby; the first paid invoice
 * brings the record here, and lib/checkout/import.ts writes it into
 * `baa_acceptances` under its own id and time. From then on it is a row like
 * any signAgreement writes: the readers, the resend and the bind below treat
 * the two alike. signAgreement itself still signs the operator's demo clinic
 * (lib/onboarding/demo-clinic.ts) and the tests.
 */

// What a signature request must be, and the document it signs, are the
// catalog's since 14 October 2026 (packages/catalog/src/agreement-signing.ts):
// apps/web takes the signature now, so a buyer can sign while this host is in
// standby (docs/design/checkout-records-on-vercel-2026-10-14.md), and the two
// sides must not disagree about what a signature is. This module keeps what
// writes and reads the row: signAgreement, which the operator's demo clinic and
// the tests sign with, the signer's copy, the bind, and the readers.
export {
  AgreementError,
  agreementKindForRequest,
  prepareAgreement,
  prepareDpaAgreement,
  signableDpaTemplate,
  signableTemplate,
  type SignAgreementRequest,
  type SignableOptions,
} from "@healdesk/catalog/agreement-signing";

/**
 * The catalog's validateSignRequest, with phase two's switch read from this
 * host's environment (HEALDESK_PHASE_TWO_ATTRIBUTION), as it always was here.
 * apps/web passes nothing, which is v1's answer: verified reporting is not
 * signed.
 */
export function validateSignRequest(
  input: unknown,
  options: SignableOptions = {},
): asserts input is SignAgreementRequest {
  validateSignRequestWith(input, { phaseTwoAttribution: env.phaseTwoAttribution(), ...options });
}

export type SignedAgreement = {
  agreementId: string;
  version: string;
  hash: string;
  /** Which clauses this clinic's agreement contains. */
  clauseIds: string[];
  /** The rendered document, returned so the buyer can be shown/emailed a copy. */
  text: string;
  acceptedAt: Date;
  approvedByCounsel: boolean;
  /**
   * What happened when we tried to send the signer their copy.
   *
   * Reported rather than assumed, and never fatal — see deliverSignedCopy. The
   * signature stands whatever this says.
   */
  copy: SignedCopyDelivery;
};

export async function signAgreement(
  request: SignAgreementRequest,
  context: RequestContext = {},
  options: SignableOptions = {},
): Promise<SignedAgreement> {
  // Rendered through the builder the funnel's preview uses, because the
  // browser hashes what it displayed and the check below refuses a signature
  // whose document differs from ours by a byte; and only for a version the
  // endpoint would sign, judged again here because this function is exported
  // and writes the row however it is reached. Which agreement is the
  // catalogue's decision (agreementKindForRequest), never the request's.
  const prepared = prepareSigning(
    request,
    // Today, in UTC. The signer's own clock is not authoritative and is not asked.
    new Date().toISOString().slice(0, 10),
    options,
  );

  /**
   * The screen and the record must agree, byte for byte.
   *
   * A mismatch means the browser displayed something other than what we are
   * about to store — a stale bundle, a cached template, a tampered client. In
   * every one of those cases the honest answer is to refuse and make them
   * reload, because a signature on a document nobody can identify is worth
   * nothing and is worse than no signature at all: it looks like evidence.
   */
  if (
    request.displayedHash &&
    request.displayedHash.toLowerCase() !== prepared.hash
  ) {
    throw new AgreementError(
      "The agreement on your screen doesn't match our copy. Please reload the page and read it again — nothing has been recorded.",
      "displayedHash",
    );
  }

  const acceptance = await recordAcceptance(unsafeDb, prepared, context);

  /**
   * Only now, with the row committed, does anyone try to send anything.
   *
   * The insert above is a single statement on a pooled connection, so it is
   * committed by the time `.returning()` resolves; nothing here opens a
   * transaction around it and nothing here can undo it. deliverSignedCopy is
   * total — it catches its own failures and returns them — which matters at
   * exactly this line: a throw would surface as a 500 for a request whose
   * contract row already exists, and the marketing site would tell a buyer who
   * genuinely signed that their agreement was not recorded.
   *
   * It is bounded for the same reason it is caught. Never throwing stops a
   * FAILED send from breaking the response; it does nothing about a send that
   * simply does not come back, and an unbounded wait ends in exactly the place
   * the catch was written to avoid — the platform kills the request, the buyer
   * is told their agreement was not recorded, and the obvious thing to do about
   * that is sign it again. See COPY_BUDGET_MS.
   */
  const copy = await deliverSignedCopyWithin(
    COPY_BUDGET_MS,
    acceptance.id,
    { kind: "signature" },
    context,
  );

  return {
    agreementId: acceptance.id,
    version: prepared.version,
    hash: prepared.hash,
    clauseIds: prepared.clauseIds,
    text: prepared.text,
    acceptedAt: acceptance.acceptedAt,
    approvedByCounsel: prepared.approvedByCounsel,
    copy,
  };
}

/**
 * Write one prepared signature as an unbound acceptance, with its
 * `baa_accepted` security event: the row signAgreement writes, and the one the
 * re-sign writes inside the transaction that puts it in force
 * (lib/agreements/resign.ts), so the two cannot store a signature differently.
 * `db` must be in service context (no tenant): the runtime role inserts an
 * unbound row only there (baa_acceptances_scope, 0031).
 */
export async function recordAcceptance(
  db: Queryable,
  prepared: PreparedSigning,
  context: RequestContext = {},
): Promise<{ id: string; acceptedAt: Date }> {
  // Raw SQL naming only the columns it writes: the runtime role may insert
  // no organization_id, bound_at, terminated_at or termination_reason
  // (column-scoped INSERT, drizzle/0066), and Drizzle's insert names every
  // column, even the ones it leaves at their defaults. A signature is
  // unbound until provisioning binds it through app_bind_agreement(), or a
  // supersede through app_supersede_agreement().
  //
  // The assent label is the full sentence beside the checkbox, re-derived
  // from the validated clinic name rather than copied from the request.
  // validateSignRequest has already proved the client displayed the
  // published label.
  const inserted = await db.execute<{ id: string; accepted_at: Date | string }>(sql`
    insert into baa_acceptances
      (user_id, document_version, document_hash, rendered_text, variables, assent_label,
       accepted_by_name, accepted_by_email, accepted_by_title, ip_address, user_agent)
    values
      (null, ${prepared.version}, ${prepared.hash}, ${prepared.text},
       ${JSON.stringify(prepared.stored)}::jsonb, ${prepared.assentSentence},
       ${prepared.signatoryName}, ${prepared.signatoryEmail}, ${prepared.signatoryTitle},
       ${context.ipAddress ?? null}, ${context.userAgent ?? null})
    returning id, accepted_at`);
  const row = inserted.rows[0];
  if (!row) throw new Error("The agreement's row was not written.");
  const acceptance = { id: row.id, acceptedAt: new Date(row.accepted_at) };

  await recordSecurityEvent(db, {
    event: "baa_accepted",
    actorLabel: prepared.signatoryEmail,
    organizationId: null,
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
    metadata: {
      agreementId: acceptance.id,
      // A DPA's version names its kind ("dpa/1.0.0"), so one event serves both.
      version: prepared.version,
      hash: prepared.hash,
      approvedByCounsel: prepared.approvedByCounsel,
      // Deliberately not the clinic name: security_events is the identity
      // plane's log and the acceptance row already holds the detail.
    },
  });
  return acceptance;
}

// -----------------------------------------------------------------------------
// The counterparty's copy
// -----------------------------------------------------------------------------

/**
 * Sending the signer the document they just signed.
 *
 * A business associate agreement binds two parties, and until this existed only
 * one of them could produce it. The clinic signed on a page they never see
 * again: nothing was emailed, nothing was attached, and there is deliberately
 * no clinic login to download it from. So when a practice's own counsel, an
 * insurer, or an OCR investigator asked them for their BAA, the honest answer
 * was that they did not have one — and a contract only we hold is a bad
 * position to argue from, whatever the contract says.
 *
 * ## Why the send is after the write, and outside it
 *
 * The acceptance is committed before this function is called, and this function
 * opens no transaction. That ordering is the requirement, not a preference: the
 * obvious alternative — render, send, then write — loses signatures, and it
 * loses precisely the ones signed while the mail transport is having a bad
 * hour. A signature we hold with no copy delivered is a small problem with an
 * obvious remedy (resend it). A signature we never took is unrecoverable: the
 * buyer has closed the tab.
 *
 * ## Why a failed send is recorded rather than raised
 *
 * api/provision/route.ts swallows a failed invitation for the same reason —
 * failing there would have Stripe retry and provision a duplicate account — and
 * leaves a `console.error` behind, which is a trace only if somebody happens to
 * be reading the logs that day. This leaves two an operator can find without
 * knowing to look:
 *
 *   1. a `baa_copy_not_sent` row in security_events carrying the reason, which
 *      the ops console reads back and prints beside the agreement, and
 *   2. `copy_sent_at` left null, which is what the console counts to say how
 *      many signers cannot produce their own agreement.
 *
 * The second is the one that matters: it turns a missed delivery into a piece
 * of visible state that stays visible until someone fixes it, rather than an
 * event that scrolls away.
 *
 * ## Two hashes, and which one goes in which column
 *
 * `document_hash` is the SHA-256 of the agreement TEXT and identifies what was
 * agreed. `copy_document_sha256` is the SHA-256 of the PDF FILE and identifies
 * what was delivered. They are different questions — the renderer wraps and
 * paginates, so the file's digest cannot be recomputed from the text — and a
 * dispute asks the second one: what does the clinic actually hold. The file
 * digest is taken from the renderer, which documents it as the digest of the
 * same `bytes` this function hands to the transport and renders deterministically
 * so that the value is worth storing at all.
 *
 * ## And where the SECOND delivery's digest lives
 *
 * `copy_document_sha256` is the first delivery's, permanently: it is written
 * once, beside `copy_sent_at`, and drizzle/0025 refuses to change either. That
 * is right for the column, whose question is when the counterparty first got
 * their copy — and for a while it is also enough, because the acceptance row is
 * immutable and the renderer is deterministic, so a resend today produces the
 * same bytes and therefore the same digest. That is the entire reason the
 * column is worth storing.
 *
 * It stops being true the moment the renderer's output moves — a pdf-lib
 * upgrade, an edit to the layout in agreements/pdf.ts. From then on, a clinic
 * that lost the first email and kept the resent one holds a file whose digest
 * is not in the row, and the one column anybody would think to check says "not
 * this document" about something we did in fact send them. A narrow window, and
 * exactly the one a dispute opens: years later, over the copy they were sent.
 *
 * Two things follow. pdf-lib is pinned to an exact version (see the header of
 * agreements/pdf.ts) so the window stays shut by default rather than by luck.
 * And every delivery's digest is written to security_events under
 * `COPY_SHA256_KEY`, where `listCopyDeliveries` below reads them back as a
 * typed query keyed by agreement — the difference between a fact that is
 * recorded and a fact that is findable. Without a named reader, the digest of a
 * resend is a string in a jsonb blob, reachable only by someone who already
 * knows the event name and the key.
 *
 * It is not as good as a column, and the honest statement of the gap is that
 * making it one is a schema change: an append-only `baa_copy_deliveries` table
 * — agreement_id, delivered_at default now(), sha256, trigger, actor — is what
 * this wants, indexed by agreement and by digest so that "did we ever send this
 * exact file" is a lookup rather than a scan. security_events has no index on
 * its metadata and is a general-purpose log with its own retention; it is where
 * this lives today, not where it belongs.
 */

export type SignedCopyDelivery =
  | {
      status: "sent";
      /** SHA-256 of the PDF actually handed to the transport, hex. */
      sha256: string;
      /**
       * Whether this send is the one that stamped `copy_sent_at`.
       *
       * False on a resend of a copy that had already been delivered: the column
       * records the FIRST delivery and is not overwritten. See below.
       */
      firstCopy: boolean;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "not_found" };

/**
 * How long the signing request will wait for the copy before answering the
 * buyer anyway.
 *
 * A normal send is well inside this: the PDF is rendered in-process and the SES
 * calls are themselves bounded (see SES_REQUEST_TIMEOUT_MS in
 * reporting/deliver.ts). The budget exists for the other case — a transport
 * that accepts a connection and then goes quiet, which no `try/catch` can
 * shorten.
 *
 * The trade it makes is deliberate and is the same one the module header
 * argues for. Giving up on the copy costs a resend, and the console already has
 * the button and the `copy_sent_at is null` count that sends an operator to it.
 * Not giving up costs the signature: a request held open past the platform's
 * limit is reported to the buyer as a failure, and a buyer who signs again
 * leaves two acceptance rows for one act of assent — an evidentiary record with
 * two answers to "when did they agree", which nothing can repair afterwards
 * because the table is append-only.
 */
const COPY_BUDGET_MS = 8_000;

/**
 * `deliverSignedCopy`, with a deadline.
 *
 * The attempt is NOT cancelled — there is nothing to cancel it with, and the
 * SDK is already in the middle of an HTTP request. It is left running, and that
 * is the useful behaviour rather than a compromise: if it does finish, it
 * stamps `copy_sent_at` and writes its own security event exactly as it would
 * have, so a slow-but-successful send is still recorded as a success. What the
 * caller gets back is only the honest answer to "had it finished by the time we
 * had to reply", which is what the signing request needs to know.
 *
 * The `.catch` is belt and braces: deliverSignedCopy is documented never to
 * throw, and an unhandled rejection from a promise nobody is awaiting any more
 * would take the process down on that promise rather than on the bug.
 */
async function deliverSignedCopyWithin(
  budgetMs: number,
  agreementId: string,
  trigger: CopyTrigger,
  context: RequestContext,
): Promise<SignedCopyDelivery> {
  const attempt = deliverSignedCopy(agreementId, trigger, context).catch(
    (error: unknown): SignedCopyDelivery => ({
      status: "failed",
      reason: error instanceof Error ? error.message : "Unknown error",
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SignedCopyDelivery>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "failed",
          reason:
            `The signer's copy had not been sent after ${Math.round(budgetMs / 1000)} seconds, ` +
            `so the signature was recorded without waiting for it. The attempt may still ` +
            `complete; if it does not, the agreement will show no copy on file and can be resent.`,
        }),
      budgetMs,
    );
  });

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    // Otherwise a pending timer holds the event loop open for the rest of the
    // budget after a send that already finished — which in a short-lived
    // process is the difference between exiting and hanging.
    if (timer) clearTimeout(timer);
  }
}

/**
 * The signer's copy of a signature just recorded, within the same budget
 * signAgreement gives it: for the re-sign (lib/agreements/resign.ts), whose
 * signature is committed with its supersede before anything is sent. Never
 * throws.
 */
export function deliverSignatureCopy(
  agreementId: string,
  context: RequestContext = {},
): Promise<SignedCopyDelivery> {
  return deliverSignedCopyWithin(COPY_BUDGET_MS, agreementId, { kind: "signature" }, context);
}

/** Who asked for the copy, for the security-event trail. */
/**
 * Why a copy is going out, and who to attribute it to.
 *
 * `userId` on the resend arm is nullable, and the null is the normal case now
 * rather than the exception. The console that presses this button is
 * healdesk.io/admin, which has one account and no user store behind it, so
 * there is no `user` row to point at. `security_events.user_id` is a foreign
 * key: an empty string or an invented id does not degrade the trace, it fails
 * the INSERT outright and loses the row — silently, because `traceCopy` catches
 * its own failures so a mail problem cannot fail a signature. The attribution
 * that survives is `actorLabel`, which carries the administrator's address.
 */
export type CopyTrigger =
  | { kind: "signature" }
  | { kind: "resend"; actorLabel: string; userId: string | null };

/**
 * The two event names, exported so the console reads back what this writes.
 *
 * A string literal typed out again in the reader is a trace that works until
 * somebody renames one of them, at which point the console silently shows no
 * reason for any failure and looks like it is working.
 */
export const COPY_SENT_EVENT = "baa_copy_sent";
export const COPY_NOT_SENT_EVENT = "baa_copy_not_sent";

/**
 * The metadata key each delivery's file digest is written under, for the same
 * reason the event names are constants.
 *
 * This one is load-bearing in a way the names are not: on a resend it is the
 * ONLY place the digest of the delivered file exists, because the row keeps the
 * first delivery's. A key spelled one way by the writer and another by the
 * reader would not fail — it would report every resend as a delivery whose
 * digest was never recorded, which is a false statement about evidence rather
 * than a bug anyone would see.
 */
export const COPY_SHA256_KEY = "pdfSha256";

/**
 * Render the signed document as a PDF and email it to the signer.
 *
 * **Never throws.** Every failure — a renderer that blows up, a transport that
 * times out, a missing UPDATE grant — comes back as a value, because both
 * callers are places where throwing would do damage: the signing path has
 * already committed the contract, and the ops console would show an operator a
 * stack trace instead of a reason.
 *
 * Exported so that the console's resend uses this exact code path rather than a
 * second implementation. Two ways of producing "the copy we sent" is two ways of
 * computing the hash we then swear to.
 */
export async function deliverSignedCopy(
  agreementId: string,
  trigger: CopyTrigger,
  context: RequestContext = {},
): Promise<SignedCopyDelivery> {
  if (!isUuid(agreementId)) return { status: "not_found" };

  // Hoisted so that a failure AFTER the read still names the signer in the
  // security event. An audit row that says "unknown signer" about a row we had
  // in hand is a worse trail than the one we could have written.
  let signerEmail: string | null = null;

  try {
    /**
     * Every column the renderer needs, selected under its own name.
     *
     * `BaaAcceptanceRecord` is a Pick off the table's inferred row, so this
     * projection satisfies it structurally and a renamed column breaks here at
     * compile time rather than rendering a blank field. The two extras — the id
     * and the variables — are why the row is passed as a value: an object
     * literal with surplus properties would be rejected, a variable is not.
     */
    const [row] = await unsafeDb
      .select({
        id: baaAcceptances.id,
        documentVersion: baaAcceptances.documentVersion,
        documentHash: baaAcceptances.documentHash,
        renderedText: baaAcceptances.renderedText,
        variables: baaAcceptances.variables,
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

    if (!row) return { status: "not_found" };
    signerEmail = row.acceptedByEmail;

    // clinicLegalName is required to render the agreement at all, so the
    // fallback is unreachable for any row that exists. It is here so that a
    // corrupted one still produces a sendable email rather than one addressed
    // to a blank practice.
    const clinicName =
      String(
        (row.variables as { clinicLegalName?: string })?.clinicLegalName ?? "",
      ).trim() || "your practice";

    const pdf = await renderAgreementPdf(row);

    const result = await sendAgreementCopy({
      to: row.acceptedByEmail,
      signatoryName: row.acceptedByName,
      clinicName,
      version: row.documentVersion,
      documentHash: row.documentHash,
      acceptedAt: row.acceptedAt,
      pdf: pdf.bytes,
      // The renderer's own name for the file, which it has already made safe
      // for a Content-Disposition header.
      filename: pdf.filename,
    });

    if (!result.sent) {
      await traceCopy(row.acceptedByEmail, trigger, context, {
        agreementId: row.id,
        delivery: result.status,
        reason: scrubReason(result.reason),
      });
      return { status: result.status, reason: result.reason };
    }

    /**
     * First delivery wins, and the `is null` predicate is load-bearing twice
     * over.
     *
     * Legally: `copy_sent_at` answers "when did the counterparty get their
     * copy", and the true answer is the first time it reached them. Overwriting
     * it on a resend would make the record say a clinic first received the
     * agreement in September when in fact they received it in January — a false
     * statement in a record whose only purpose is to be true.
     *
     * Mechanically: drizzle/0025 enforces the same rule with a trigger that
     * RAISES on any attempt to change an already-recorded `copy_sent_at` or
     * `copy_document_sha256`. So a resend written as a plain UPDATE would not
     * quietly overwrite anything, it would throw — turning every resend of an
     * already-delivered copy into a failure report for a mail that went out.
     * The predicate means the statement matches no row instead, the trigger
     * never fires, and a concurrent double-send is idempotent for free.
     *
     * The pair is written together because the table's CHECK requires the date
     * and the digest to be null or non-null together: a delivery date with no
     * hash proves nothing about what was delivered.
     */
    const stamped = await unsafeDb
      .update(baaAcceptances)
      // Postgres' clock, not this process's. `accepted_at` is stamped by the
      // database (defaultNow()), and these two dates are read side by side in
      // the ops console and would be read side by side in a dispute — a skewed
      // application clock could put the copy before the signature it is a copy
      // of. Same rule the connect-link reads follow, for the same reason: an
      // app-side Date lets skew decide a fact about a record.
      .set({ copySentAt: sql`now()`, copyDocumentSha256: pdf.sha256 })
      .where(
        and(
          eq(baaAcceptances.id, row.id),
          isNull(baaAcceptances.copySentAt),
        ),
      )
      .returning({ id: baaAcceptances.id });

    const firstCopy = stamped.length > 0;

    await traceCopy(row.acceptedByEmail, trigger, context, {
      agreementId: row.id,
      delivery: "sent",
      firstCopy,
      // The digest of the file that just went out — which on a resend is the
      // only place it is recorded, since the row keeps the first delivery's.
      // Written under the shared key so listCopyDeliveries can find it, and
      // safe to write at all because assertNoPhi() strips hex digests before
      // its phone-number check, precisely so digests can be recorded.
      [COPY_SHA256_KEY]: pdf.sha256,
    });

    return { status: "sent", sha256: pdf.sha256, firstCopy };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";

    await traceCopy(signerEmail, trigger, context, {
      agreementId,
      delivery: "failed",
      reason: scrubReason(reason),
    });

    return { status: "failed", reason };
  }
}

/**
 * Write the copy's outcome to security_events, and never let that be the thing
 * that fails.
 *
 * recordSecurityEvent throws on metadata that looks like PHI, and a transport
 * error message is one of the few strings in this codebase that plausibly
 * contains an address ("550 5.1.1 user unknown: owner@clinic.com"). Losing a
 * signature — or an operator's resend — to the audit guard would be absurd, so
 * the reason is scrubbed before it goes in AND the write is caught. Belt and
 * braces on purpose: the scrubber is a regex, and regexes are wrong eventually.
 */
async function traceCopy(
  signerEmail: string | null,
  trigger: CopyTrigger,
  context: RequestContext,
  metadata: { delivery: "sent" | "skipped" | "failed" } & Record<
    string,
    unknown
  >,
): Promise<void> {
  try {
    await recordSecurityEvent(unsafeDb, {
      // Two event names, not three. "skipped" and "failed" are both "the clinic
      // does not have their copy", which is the thing anyone searching this
      // table is looking for; `delivery` in the metadata keeps the distinction
      // for whoever needs it.
      event:
        metadata.delivery === "sent" ? COPY_SENT_EVENT : COPY_NOT_SENT_EVENT,
      // actorLabel is a column, not metadata, and is not PHI-checked — the
      // signer's own address is what `baa_accepted` records too. On a resend the
      // actor is the operator who pressed the button, not the signer.
      actorLabel:
        trigger.kind === "resend"
          ? trigger.actorLabel
          : (signerEmail ?? "unknown signer"),
      userId: trigger.kind === "resend" ? trigger.userId : null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { ...metadata, trigger: trigger.kind },
    });
  } catch (error) {
    /**
     * The error's NAME, and nothing else it is carrying.
     *
     * drizzle-orm 0.45 wraps a driver failure in a `DrizzleQueryError` that
     * holds `query` and `params` as own properties and interpolates both into
     * its message — so logging the object here would print the INSERT this
     * function just attempted, bound parameters included, and the first of
     * those is `actorLabel`: the signer's address. Application logs have none
     * of the protections the database gives that row — no grants, no BAA on
     * whoever aggregates them. connect/[token]/actions.ts learned this the same
     * way; see describeError() there.
     *
     * The name is what actually helps at 3am ("PhiInAuditError" means the
     * scrubber let something through, anything else means the database), and
     * the outcome it failed to record is already the return value of the
     * function that called this.
     */
    log.error("could not record BAA copy outcome", {
      error: error instanceof Error ? error.name : "unknown error",
    });
  }
}

/** Addresses and long digit runs out of anything bound for audit metadata. */
function scrubReason(reason: string): string {
  return reason
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, "[address]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]")
    .slice(0, 300);
}

/**
 * Every recorded delivery of one agreement's copy, newest first.
 *
 * The row answers "did the counterparty ever get their copy, and what was in
 * the file when they first did". This answers the other question, the one a
 * resend creates: "here is a PDF a clinic says came from you — is it one of
 * ours". The row cannot answer that after the first send, because
 * `copy_document_sha256` is write-once by design, so the digests of later
 * deliveries live in security_events and this is what reads them back.
 *
 * It exists so that the answer is a query and not an archaeology exercise. The
 * digest was already being written; what was missing was any supported way to
 * get at it that did not involve knowing the event name and the metadata key
 * and writing the jsonb operator by hand — which is to say, it was recorded but
 * not findable, and evidence nobody can find is not evidence.
 *
 * ## ⚠️ No application code path calls this yet
 *
 * Said here rather than left to be discovered by grep — only
 * tests/agreement-copy-record.test.ts exercises it. The ops console shows the
 * DATE of the copy and, where there is none, the reason; neither digest is on
 * that screen, because an operator acting on "this clinic has no copy" does not
 * need one. This is for the case that starts with a file rather than with a row
 * — a dispute, a subject request, an auditor holding a printout. It reads,
 * takes no lock and writes nothing.
 *
 * ## What it is not
 *
 * It is not a substitute for a column. security_events carries no index on its
 * metadata, so this narrows on the event name first and filters the jsonb
 * after; it is fine for one agreement and wrong for a fleet-wide "who holds
 * digest X" sweep. That query wants the table described in the module header
 * above, and that is a migration.
 */
export type CopyDelivery = {
  /**
   * Postgres' clock. `security_events.occurred_at` is `defaultNow()`, the same
   * database clock that stamps `accepted_at` and `copy_sent_at`, so the three
   * can be ordered against each other without asking which machine wrote them.
   */
  deliveredAt: Date;
  /**
   * SHA-256 of the PDF handed to the transport.
   *
   * Null when the event does not carry one — a delivery recorded before the
   * digest was written down, or metadata that is not 64 hex characters. Null
   * means "not recorded", never "nothing was sent": the event exists, so a file
   * went out, and saying so beats inventing a digest for it.
   */
  sha256: string | null;
  /** True for the delivery that stamped `copy_sent_at`. At most one ever is. */
  firstCopy: boolean;
  /** Who asked for it: the signature itself, or an operator's resend. */
  trigger: CopyTrigger["kind"] | "unknown";
};

/** Enough for any real agreement's history; clamped so a caller cannot ask for the log. */
const DELIVERIES_DEFAULT = 50;
const DELIVERIES_MAX = 500;

export async function listCopyDeliveries(
  agreementId: string,
  limit = DELIVERIES_DEFAULT,
): Promise<CopyDelivery[]> {
  // An id that cannot identify a row identifies no deliveries. Same refusal as
  // deliverSignedCopy, rather than a query that can only return nothing.
  if (!isUuid(agreementId)) return [];

  // A NaN would reach Postgres as `limit NaN` and fail the read outright; the
  // honest answer to a nonsense limit is the default, not an error about
  // evidence that is sitting right there.
  const asked = Number.isFinite(limit) ? Math.trunc(limit) : DELIVERIES_DEFAULT;
  const bounded = Math.min(Math.max(asked, 1), DELIVERIES_MAX);

  const rows = await unsafeDb
    .select({
      occurredAt: securityEvents.occurredAt,
      metadata: securityEvents.metadata,
    })
    .from(securityEvents)
    .where(
      and(
        // Narrowed on the indexed column first: security_events_event_idx is
        // on (event, occurred_at), so the jsonb test below runs over one event
        // type rather than over the whole log.
        eq(securityEvents.event, COPY_SENT_EVENT),
        // The id is a bound parameter, not interpolated text.
        sql`${securityEvents.metadata} ->> 'agreementId' = ${agreementId}`,
      ),
    )
    .orderBy(desc(securityEvents.occurredAt))
    .limit(bounded);

  return rows.map((row) => {
    // jsonb, so this is whatever was written, which is not the same thing as
    // what this function expects. Nothing below trusts its shape.
    const metadata = row.metadata as Record<string, unknown> | null;
    const digest = metadata?.[COPY_SHA256_KEY];
    const trigger = metadata?.trigger;

    return {
      deliveredAt: row.occurredAt,
      sha256:
        typeof digest === "string" && SHA256_HEX.test(digest.trim())
          ? digest.trim().toLowerCase()
          : null,
      // Strictly true, not truthy: a missing key must not read as "this was the
      // first copy", which is a claim about which file the row's digest is of.
      firstCopy: metadata?.firstCopy === true,
      trigger:
        trigger === "signature" || trigger === "resend" ? trigger : "unknown",
    };
  });
}

/** Read one back, for the "download what I signed" endpoint. */
export async function getAgreement(agreementId: string): Promise<
  | {
      id: string;
      version: string;
      hash: string;
      text: string;
      acceptedByName: string;
      acceptedByEmail: string;
      acceptedByTitle: string | null;
      acceptedAt: Date;
      organizationId: string | null;
    }
  | undefined
> {
  if (!isUuid(agreementId)) return undefined;

  const [row] = await unsafeDb
    .select({
      id: baaAcceptances.id,
      version: baaAcceptances.documentVersion,
      hash: baaAcceptances.documentHash,
      text: baaAcceptances.renderedText,
      acceptedByName: baaAcceptances.acceptedByName,
      acceptedByEmail: baaAcceptances.acceptedByEmail,
      acceptedByTitle: baaAcceptances.acceptedByTitle,
      acceptedAt: baaAcceptances.acceptedAt,
      organizationId: baaAcceptances.organizationId,
    })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, agreementId))
    .limit(1);

  return row;
}

/**
 * Attach a signed agreement to the organization payment created for it.
 *
 * Idempotent, and narrow by design: the WHERE clause only matches a row that is
 * still unbound, so a webhook retry re-binding the same agreement is a no-op
 * rather than a second write. The grant in drizzle/0016 means this is the only
 * update the runtime role can perform on this table at all — it physically
 * cannot alter the signature or the text.
 *
 * Returns null when the agreement is missing or already bound, and the caller
 * decides whether that is fatal. Binding to a DIFFERENT organization is refused
 * outright: an agreement belongs to the practice it names.
 *
 * On success it hands back the variables that were signed, because the clinic
 * row needs the covered-entity determination and the signed document is where
 * that answer lives. Asking the buyer a second time during checkout would
 * invite a different answer from the one in the contract they just signed.
 */
export async function bindAgreement(
  tx: Parameters<typeof recordSecurityEvent>[0],
  agreementId: string,
  organizationId: string,
): Promise<BaaVariables | null> {
  if (!isUuid(agreementId)) {
    throw new AgreementError("Invalid agreement reference.", "agreementId");
  }

  // The write itself is app_bind_agreement() (drizzle/0031): the runtime
  // role no longer holds UPDATE on organization_id or bound_at at all, so the
  // "only an unbound row, only once, only to an organisation that holds none"
  // rule is enforced by the function rather than by the WHERE clause that
  // used to live here. NULL comes back when the row is missing or already
  // bound; the two organisation-level refusals raise instead, and a raise is
  // right — those are not "try again", they are "this purchase is wrong".
  const result = await tx.execute<{ variables: unknown }>(
    sql`select app_bind_agreement(${agreementId}::uuid, ${organizationId}::text) as variables`,
  );
  const rows = (result as unknown as { rows?: { variables: unknown }[] }).rows ?? [];
  const variables = rows[0]?.variables;
  return variables ? (variables as BaaVariables) : null;
}

/**
 * Agreements signed but never paid for.
 *
 * Surfaced to ops rather than swept away. Someone signed a legal document and
 * then hesitated at the payment step — that is a live record we are obliged to
 * keep, and separately it is the warmest lead the funnel produces.
 */
export async function unboundAgreements(withinDays = 30): Promise<
  { id: string; clinicName: string; email: string; acceptedAt: Date }[]
> {
  const rows = await unsafeDb
    .select({
      id: baaAcceptances.id,
      variables: baaAcceptances.variables,
      email: baaAcceptances.acceptedByEmail,
      acceptedAt: baaAcceptances.acceptedAt,
    })
    .from(baaAcceptances)
    .where(
      and(
        isNull(baaAcceptances.organizationId),
        sql`${baaAcceptances.acceptedAt} > now() - make_interval(days => ${withinDays})`,
      ),
    )
    .orderBy(sql`${baaAcceptances.acceptedAt} desc`)
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    clinicName: String(
      (row.variables as { clinicLegalName?: string })?.clinicLegalName ?? "—",
    ),
    email: row.email,
    acceptedAt: row.acceptedAt,
  }));
}

/** A recorded digest, or something that only looks like one. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

import {
  BaaRenderError,
  currentBaaTemplate,
  getBaaTemplate,
  isSpecialtyId,
  prepareBaa,
  specialties,
  type BaaVariables,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";

import { recordSecurityEvent } from "./audit";
import type { RequestContext } from "./audit";

/**
 * Signing the business associate agreement, before payment.
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
 */

export class AgreementError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AgreementError";
  }
}

export type SignAgreementRequest = {
  clinicLegalName: string;
  specialty: string;
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  /** true | false | null — "I don't know" is a real and common answer. */
  isCoveredEntity: boolean | null;
  /** The exact label of the button the signer clicked. */
  assentLabel: string;
  /** Template version the browser rendered. Must be the current one. */
  templateVersion: string;
  /**
   * SHA-256 of the document the browser actually displayed.
   *
   * The server renders its own copy and refuses if the two differ. Without
   * this, the record says "we rendered X" and the screen may have shown Y —
   * and the one question that matters in a dispute is what the signer SAW.
   * Optional only because a browser without Web Crypto (http:// on a LAN)
   * cannot compute it; when absent the mismatch check is skipped and the
   * omission is recorded rather than passing silently.
   */
  displayedHash?: string;
};

export type SignedAgreement = {
  agreementId: string;
  version: string;
  hash: string;
  /** The rendered document, returned so the buyer can be shown/emailed a copy. */
  text: string;
  acceptedAt: Date;
  approvedByCounsel: boolean;
};

const MAX_ASSENT_LABEL = 200;

export function validateSignRequest(
  input: unknown,
): asserts input is SignAgreementRequest {
  const body = input as Partial<SignAgreementRequest> | null;
  if (!body || typeof body !== "object") {
    throw new AgreementError("Invalid request body.");
  }

  if (!body.clinicLegalName?.trim()) {
    throw new AgreementError("Clinic name is required.", "clinicLegalName");
  }
  if (body.clinicLegalName.length > 200) {
    throw new AgreementError("Clinic name is too long.", "clinicLegalName");
  }
  if (!isSpecialtyId(body.specialty)) {
    throw new AgreementError("Unknown specialty.", "specialty");
  }

  // The typed name IS the signature. A single character is not a signature, and
  // an empty one would render a contract signed by nobody.
  if (!body.signatoryName?.trim() || body.signatoryName.trim().length < 2) {
    throw new AgreementError(
      "Type your full name to sign.",
      "signatoryName",
    );
  }
  if (body.signatoryName.length > 120) {
    throw new AgreementError("Name is too long.", "signatoryName");
  }
  if (!isEmail(body.signatoryEmail ?? "")) {
    throw new AgreementError("A valid work email is required.", "signatoryEmail");
  }

  if (
    body.isCoveredEntity !== true &&
    body.isCoveredEntity !== false &&
    body.isCoveredEntity !== null
  ) {
    throw new AgreementError(
      "Answer whether the practice bills insurance electronically.",
      "isCoveredEntity",
    );
  }

  if (!body.assentLabel?.trim() || body.assentLabel.length > MAX_ASSENT_LABEL) {
    throw new AgreementError("Missing assent label.", "assentLabel");
  }

  if (
    body.displayedHash !== undefined &&
    !/^[0-9a-f]{64}$/i.test(body.displayedHash)
  ) {
    throw new AgreementError("Malformed document hash.", "displayedHash");
  }

  // Refuse a stale template outright rather than silently signing the current
  // one. Someone who left the tab open across a revision must see the new text.
  if (!getBaaTemplate(body.templateVersion ?? "")) {
    throw new AgreementError("Unknown agreement version.", "templateVersion");
  }
  if (body.templateVersion !== currentBaaTemplate().version) {
    throw new AgreementError(
      "The agreement has been updated. Please reload and review the current version.",
      "templateVersion",
    );
  }
}

export async function signAgreement(
  request: SignAgreementRequest,
  context: RequestContext = {},
): Promise<SignedAgreement> {
  const template = currentBaaTemplate();
  const email = request.signatoryEmail.trim().toLowerCase();

  const variables: BaaVariables = {
    clinicLegalName: request.clinicLegalName.trim(),
    signatoryName: request.signatoryName.trim(),
    signatoryTitle: request.signatoryTitle?.trim() || undefined,
    signatoryEmail: email,
    // Today, in UTC. The signer's own clock is not authoritative and is not asked.
    effectiveDate: new Date().toISOString().slice(0, 10),
    specialty:
      specialties.find((s) => s.id === request.specialty)?.name ??
      request.specialty,
    isCoveredEntity: request.isCoveredEntity,
  };

  let prepared: ReturnType<typeof prepareBaa>;
  try {
    prepared = prepareBaa(template, variables);
  } catch (error) {
    // A template that cannot render is our bug, not the buyer's — but it must
    // never fall through to storing a half-substituted contract.
    if (error instanceof BaaRenderError) {
      throw new AgreementError(
        "We couldn't prepare your agreement. Nothing has been charged — please contact us.",
      );
    }
    throw error;
  }

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

  const [row] = await unsafeDb
    .insert(baaAcceptances)
    .values({
      organizationId: null,
      userId: null,
      documentVersion: prepared.version,
      documentHash: prepared.hash,
      renderedText: prepared.text,
      variables: {
        ...variables,
        // Recorded because its ABSENCE is itself a fact about the signature:
        // this one could not be checked against what the browser displayed.
        displayedHashVerified: Boolean(request.displayedHash),
      } as unknown as Record<string, unknown>,
      assentLabel: request.assentLabel.trim(),
      acceptedByName: variables.signatoryName,
      acceptedByEmail: email,
      acceptedByTitle: variables.signatoryTitle ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    })
    .returning({ id: baaAcceptances.id, acceptedAt: baaAcceptances.acceptedAt });

  const acceptance = row!;

  await recordSecurityEvent(unsafeDb, {
    event: "baa_accepted",
    actorLabel: email,
    organizationId: null,
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
    metadata: {
      agreementId: acceptance.id,
      version: prepared.version,
      hash: prepared.hash,
      approvedByCounsel: template.approvedByCounsel,
      // Deliberately not the clinic name: security_events is the identity
      // plane's log and the acceptance row already holds the detail.
    },
  });

  return {
    agreementId: acceptance.id,
    version: prepared.version,
    hash: prepared.hash,
    text: prepared.text,
    acceptedAt: acceptance.acceptedAt,
    approvedByCounsel: template.approvedByCounsel,
  };
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

  const bound = await tx
    .update(baaAcceptances)
    .set({ organizationId, boundAt: new Date() })
    .where(
      and(
        eq(baaAcceptances.id, agreementId),
        isNull(baaAcceptances.organizationId),
      ),
    )
    .returning({ variables: baaAcceptances.variables });

  const row = bound[0];
  return row ? (row.variables as unknown as BaaVariables) : null;
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

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

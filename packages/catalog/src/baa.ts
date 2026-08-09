import { createHash } from "node:crypto";

/**
 * The click-through business-associate agreement.
 *
 * Self-serve acquisition requires this to be click-through: if signing needs a
 * lawyer on a call, the funnel isn't automated. Which puts the weight on the
 * record — we store the version AND a hash of the exact text shown, so revising
 * the document later can never be confused with what somebody actually agreed to.
 *
 * ⚖️ THE TEXT BELOW IS A PLACEHOLDER AND MUST BE REPLACED BY COUNSEL BEFORE ANY
 * REAL CLINIC SEES IT. It is deliberately short and obviously provisional so it
 * cannot be mistaken for a reviewed agreement. What is production-ready is the
 * mechanism around it: versioning, hashing, and an append-only acceptance record.
 *
 * To publish a revision: add a new entry, never edit an existing one. The hash
 * of a released version is a historical fact.
 */

export type BaaDocument = {
  version: string;
  effectiveDate: string;
  /** True once counsel has approved this version. Provisioning refuses otherwise. */
  approvedByCounsel: boolean;
  text: string;
};

const DRAFT_TEXT = `HEALDESK BUSINESS ASSOCIATE AGREEMENT (DRAFT — NOT FOR EXECUTION)

This document is a placeholder. It has not been reviewed by counsel and does
not create a business associate relationship.

The executed agreement will address, at minimum:

  1. Permitted uses and disclosures of protected health information
  2. Safeguards, consistent with the HIPAA Security Rule
  3. Reporting of security incidents and breaches, including timelines
  4. Subcontractor obligations and flow-down requirements
  5. Access, amendment, and accounting of disclosures
  6. Return or destruction of protected health information on termination
  7. Whether the clinic is a covered entity, and the posture that applies if not

Until this is replaced, healdesk processes synthetic data only. The database
enforces that independently of this document.`;

export const BAA_DOCUMENTS: readonly BaaDocument[] = [
  {
    version: "0.0.0-draft",
    effectiveDate: "2026-08-09",
    approvedByCounsel: false,
    text: DRAFT_TEXT,
  },
] as const;

export const CURRENT_BAA_VERSION = BAA_DOCUMENTS[0]!.version;

export function getBaaDocument(version: string): BaaDocument | undefined {
  return BAA_DOCUMENTS.find((d) => d.version === version);
}

export function currentBaaDocument(): BaaDocument {
  return BAA_DOCUMENTS[0]!;
}

/**
 * SHA-256 of the exact text. Recorded alongside every acceptance so the
 * question "what did they actually agree to" survives the document changing.
 */
export function hashBaaText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

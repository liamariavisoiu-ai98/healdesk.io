import type { AgreementKind } from "./agreement-kind";
import type { Audience } from "./audience";

/**
 * The one sentence copy may say about the agreement healdesk signs with a
 * practice, in place of an unqualified "HIPAA compliant", which nobody
 * certifies and copy must never say.
 *
 * The BAA's is the v1 spec's line, word for word. Until the Data Protection
 * Agreement's release on 20 October 2026 it was the only one, and it was said
 * to every practice; a practice under the DPA (a veterinary practice, or one
 * that bills no health insurance) signs no business associate agreement with
 * healdesk, so telling it that it does would be untrue. Its sentence is built
 * only from words the DPA's own copy already uses, and claims nothing that
 * copy does not: the document's name as the email carrying its signed copy
 * gives it ("data protection agreement", agreement-copy-email.ts), the
 * practice's people as `audienceFor` names them, "your clients' information"
 * as the signing screen's explainer says it (DPA_EXPLAINER, dpa-explainer.ts),
 * and the BAA line's own "handle ... under it". DPA_SAFEGUARDS_LINE is that
 * explainer's paraphrase of the DPA's Safeguards clause, for a reader who asks
 * how the information is protected.
 */

export const BAA_CLAIM = "We sign a business associate agreement and handle patient data under it";

/** DPA_EXPLAINER's paraphrase of the Safeguards clause, as a sentence about healdesk. */
export const DPA_SAFEGUARDS_LINE =
  "healdesk protects it with the safeguards it uses where HIPAA does apply, the HIPAA Security Rule's included";

/**
 * The claim for one practice, without a closing full stop: the BAA's for a
 * practice under the BAA (or none recorded, as the PHI gate reads a null
 * kind), the DPA's in the practice's own word for its people otherwise.
 */
export function agreementClaim(kind: AgreementKind | null, audience: Audience): string {
  if (kind !== "dpa") return BAA_CLAIM;
  return `We sign a data protection agreement and handle your ${audience}' information under it`;
}

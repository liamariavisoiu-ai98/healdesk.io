/**
 * Notice before a new subcontractor handles the information an agreement
 * protects: 24 hours, by email, with the practice's right to object.
 *
 * The owner decided on 6 October 2026 that the agreements after BAA 1.2.1
 * give 24 hours' notice rather than fifteen days, keeping the right to object
 * (docs/design/funnel-portal-contracts-2026-10-06.md §6). It is recorded as a
 * counsel risk (docs/counsel/brief.md): a day is far shorter than the usual
 * fifteen to thirty, so it weakens the objection right it keeps. BAA 1.2.1
 * keeps its fifteen days for anyone who signed it; a released clause never
 * changes.
 *
 * The text lives here, once, because two documents are to carry it: BAA
 * 1.3.0's `subcontractors` clause (baa.ts), and the funnel's data protection
 * agreement once that is written. It is worded for both, which is why it
 * says "the information this agreement protects" rather than PHI. Once a
 * document that renders it is released, this sentence is frozen with that
 * document's golden hashes (apps/app/tests/baa-golden.test.ts): a new wording
 * is a new function beside this one, never an edit to it.
 */

/** How far ahead, in hours, the practice is told about a new subcontractor. */
export const SUBPROCESSOR_NOTICE_HOURS = 24;

/** For a document that sets the notice apart as its own clause. BAA 1.3.0 keeps it inside "Subcontractors". */
export const SUBPROCESSOR_NOTICE_HEADING = "Notice of a new subcontractor";

/**
 * The notice and the objection right, unwrapped; the document wraps it. The
 * objection right is what BAA 1.3.0's Term clause calls "the
 * subcontractor-objection right above", so it terminates "this agreement"
 * without naming a clause another document may number differently.
 */
export function subprocessorNoticeClauseBody(): string {
  return (
    `healdesk keeps a current list of its subcontractors at healdesk.io/subprocessors and ` +
    `will give Practice at least ${SUBPROCESSOR_NOTICE_HOURS} hours' notice by email before ` +
    `adding one that will handle the information this agreement protects. If Practice objects ` +
    `on reasonable grounds before the change takes effect, Practice may terminate this ` +
    `agreement without penalty.`
  );
}

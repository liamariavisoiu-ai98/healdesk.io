/**
 * The current list of subcontractors, on request, and notice before a new
 * one handles the information an agreement protects: 24 hours, by email to
 * the practice's notice address, naming the subcontractor, with the
 * practice's right to object.
 *
 * The owner decided on 6 October 2026 that the agreements after BAA 1.2.1
 * give 24 hours' notice rather than fifteen days, keeping the right to object
 * (docs/design/funnel-portal-contracts-2026-10-06.md §6). It is recorded as a
 * counsel risk (docs/counsel/brief.md): a day is far shorter than the usual
 * fifteen to thirty, so it weakens the objection right it keeps. Counsel
 * approved the 24-hour notice, as the owner reported on 6 October 2026
 * (agreement-changes.md §12.14). BAA 1.2.1 and 1.2.2 keep their fifteen days
 * for anyone who signs them; a released clause never changes.
 *
 * The list is given to a signed practice on its written request, never
 * published at a URL: the public page at healdesk.io/subprocessors is gone
 * (owner, 9 October 2026), and BAA 1.2.2 gives its list the same way. The
 * request goes to healdesk's email address in the Notices clause, which is
 * hello@healdesk.io in both documents that carry this sentence.
 *
 * The text lives here, once, because two documents are to carry it: BAA
 * 1.3.0's `subcontractors` clause (baa.ts), and the funnel's data protection
 * agreement. It is worded for both, which is why it says "the information
 * this agreement protects" rather than PHI, and names "the Notices clause",
 * which both agreements have. The pre-release audit of 6 October 2026 added
 * where the notice goes and what it says (SUB-01, PT-08, PT-15), in place:
 * neither document is released. Once a document that renders it is released,
 * this sentence is frozen with that document's golden hashes
 * (apps/app/tests/baa-golden.test.ts): a new wording is a new function beside
 * this one, never an edit to it.
 */

/** How far ahead, in hours, the practice is told about a new subcontractor. */
export const SUBPROCESSOR_NOTICE_HOURS = 24;

/** For a document that sets the notice apart as its own clause. BAA 1.3.0 keeps it inside "Subcontractors". */
export const SUBPROCESSOR_NOTICE_HEADING = "Notice of a new subcontractor";

/**
 * The list on request, the notice and the objection right, unwrapped; the
 * document wraps it. The objection right is what BAA 1.3.0's Term clause
 * calls terminating "under the Subcontractors clause", and gives its content
 * there: the Services end the same day, no Fees accrue afterwards, and Fees
 * paid for later time are refunded. A document that carries this sentence
 * has to give "without penalty" the same effect in its own Term clause.
 */
export function subprocessorNoticeClauseBody(): string {
  return (
    `healdesk will give Practice its current list of its subcontractors on Practice's written ` +
    `request to healdesk's email address in the Notices clause, and will give Practice at least ` +
    `${SUBPROCESSOR_NOTICE_HOURS} hours' notice by email before adding one that will handle the ` +
    `information this agreement protects. The notice goes to Practice's address in the Notices ` +
    `clause and names the subcontractor, what it will receive and why. If Practice objects on ` +
    `reasonable grounds before the change takes effect, Practice may terminate this agreement ` +
    `without penalty.`
  );
}

/**
 * How far ahead, in days, BAA 1.7.0 and DPA 1.2.0 (released 30 October
 * 2026, landed 1 November 2026) tell the practice about a new subcontractor. The owner asked that day
 * to lengthen the 24 hours ("24 hours' notice before adding a new vendor:
 * adjust whatever's needed"): fifteen days is what BAA 1.2.1 and 1.2.2 gave,
 * and inside the usual fifteen to thirty (docs/counsel/agreement-changes.md
 * §22; docs/counsel/brief.md row 14). The recipient, the contents and the
 * objection right are the 24-hour sentence's, word for word.
 */
export const SUBPROCESSOR_NOTICE_DAYS_1_7 = 15;

/**
 * subprocessorNoticeClauseBody() with "at least 24 hours' notice" said as
 * "at least 15 days' notice", and nothing else changed: a new wording beside
 * the released one, which stays as it is for every document that renders it.
 * The test in subprocessor-notice.test.ts holds the two to that one phrase.
 */
export function subprocessorNoticeClauseBody15Days(): string {
  const released = subprocessorNoticeClauseBody();
  const was = `at least ${SUBPROCESSOR_NOTICE_HOURS} hours' notice by email`;
  if (released.split(was).length !== 2) {
    throw new Error("The released subcontractor notice no longer says 24 hours' notice by email.");
  }
  return released.replace(was, `at least ${SUBPROCESSOR_NOTICE_DAYS_1_7} days' notice by email`);
}

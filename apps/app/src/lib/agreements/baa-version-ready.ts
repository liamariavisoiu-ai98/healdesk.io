/**
 * Whether re-signs of a newer business associate agreement over an older one
 * (`baa_version`, lib/agreements/resign.ts) run (owner, 19 October 2026).
 *
 * On since the calendar fix landed (healdesk-io-22, 2e820d57). It was off
 * until then because a supersede left the practice's location with no
 * calendar terms under the new agreement, and the next 5-minute calendar
 * sweep disconnected its Google Calendar; signAgreementResign now records
 * the new signature as the location's terms (recordSupersedingTerms), with
 * the answers of the terms in effect, an election included.
 *
 * A kill switch, should what it guards regress. Turned off, the hourly job
 * opens no BAA-version re-sign by itself and the operator's broadcast
 * refuses, saying why and that nothing changed; and a re-sign already open is
 * held as it is (resignOpenToPractice): no L22 reminder goes, no ops alert is
 * raised, Billing shows none, and its link says it is not open yet and signs
 * nothing. WP9's DPA→BAA re-sign, the misclassification signal and the list
 * of who an incident affected are untouched. Read through
 * `baaVersionResignsReady`, so a test can stand in for either setting, as the
 * billing tests do for locationsReady; nothing in production sets it
 * but this line.
 */
export const BAA_VERSION_RESIGNS_READY = true;

/** The switch, as the code asks it. */
export function baaVersionResignsReady(): boolean {
  return BAA_VERSION_RESIGNS_READY;
}

/** The console's one line beside "Start the re-signs" while it is off. */
export const BAA_VERSION_RESIGNS_WAITING =
  "Switched off in apps/app (BAA_VERSION_RESIGNS_READY): no re-sign of a newer business associate agreement opens, and one already open is held, unreminded and unsignable, until it is on again.";

/** The broadcast's refusal while it is off. */
export const BAA_VERSION_RESIGNS_REFUSED = `${BAA_VERSION_RESIGNS_WAITING} Nothing was changed.`;

/**
 * Whether a re-sign of a newer business associate agreement over an older
 * one (`baa_version`, lib/agreements/resign.ts) may open (owner, 19 October
 * 2026). Off until the calendar fix lands: a supersede leaves the practice's
 * location with no calendar election under the new agreement (drizzle/0057's
 * guard), and the next 5-minute calendar sweep then disconnects its Google
 * Calendar. healdesk-io-22's fix (branch calendar/resign-terms) records the
 * location's calendar terms from signAgreementResign right after
 * supersedeAgreement; this is flipped to true in the commit that merges it.
 *
 * While it is false the hourly job opens no BAA-version re-sign by itself
 * and the operator's broadcast refuses, saying why and that nothing changed;
 * WP9's DPA→BAA re-sign, the misclassification signal and the list of who an
 * incident affected are untouched. Read through `baaVersionResignsReady`, so
 * a test can stand in for the commit that flips it, as the billing tests do
 * for LOCATION_CLINICS_READY; nothing in production sets it but this line.
 */
export const BAA_VERSION_RESIGNS_READY = false;

/** The switch, as the code asks it. */
export function baaVersionResignsReady(): boolean {
  return BAA_VERSION_RESIGNS_READY;
}

/** The console's one line beside "Start the re-signs" while it is off. */
export const BAA_VERSION_RESIGNS_WAITING =
  "Waits for the calendar fix: a re-sign signed now would leave the practice's location without calendar terms, and its Google Calendar would disconnect.";

/** The broadcast's refusal while it is off. */
export const BAA_VERSION_RESIGNS_REFUSED = `${BAA_VERSION_RESIGNS_WAITING} Nothing was changed.`;

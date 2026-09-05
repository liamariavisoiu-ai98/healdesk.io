import type { PlaceHours } from "./places.ts";
import type { BookingDetection } from "./booking.ts";
import type { Label } from "./label.ts";

/**
 * Turning what the pipeline learned into what a cold email can actually use.
 *
 * The segment files were carrying columns like `booking_confidence` and
 * `healdesk_connects` — real fields, but internal ones. They answer "how much
 * should we trust this row" and "which product tier fits", not "what goes in
 * the email", and a sending tool cannot do anything with either. Diagnostics
 * belong in a diagnostics file.
 *
 * What replaces them is computed rather than raw. A clinic does not want to be
 * told its own opening hours; it has never worked out that closing at five
 * leaves 126 hours a week when a new patient reaches a machine. The gap between
 * a fact they know and a consequence they have not calculated is the whole
 * difference between a mail merge and a piece of research.
 */

export type OutreachRow = {
  /** Which angle this clinic gets. Drives template selection. */
  angle: Angle;
  /**
   * A ready personalisation clause, or blank.
   *
   * Blank on purpose when nothing true and specific is known — an empty
   * variable is recoverable in a template, an invented one is a lie in an email
   * to a business that can check it.
   */
  hook: string;
  /** Hours a week nobody answers, when known. The strongest single number. */
  closedHoursPerWeek: string;
  /** Days Google says they are shut. */
  closedDays: string;
  /** Set when this clinic should NOT be emailed, with the reason. */
  excludeReason: string;
};

/**
 * The pitch this clinic gets.
 *
 * Ordered by how much the recovered-call story is worth to them, which is not
 * the same as how easy they are to classify.
 */
export type Angle =
  | "phone-only"
  | "closed-weekends"
  | "closes-early"
  | "has-booking"
  | "exclude";

export function buildOutreachRow(
  label: Label,
  booking: BookingDetection | undefined,
  hours: PlaceHours | undefined,
): OutreachRow {
  const exclude = excludeReason(label, booking);
  if (exclude) {
    return {
      angle: "exclude",
      hook: "",
      closedHoursPerWeek: "",
      closedDays: "",
      excludeReason: exclude,
    };
  }

  const closed = hours?.closedDays ?? [];
  const gap = hours?.closedHoursPerWeek ?? null;
  const weekendClosed = closed.filter((d) => d === "Saturday" || d === "Sunday");
  const noBooking = booking ? !booking.hasOnlineBooking : !label.offersOnlineBooking;

  // Strongest first. A clinic with no online booking at all takes every
  // appointment by phone, so every unanswered call is a lost booking — that
  // beats any hours-based angle even when the hours are known.
  let angle: Angle = noBooking ? "phone-only" : "has-booking";
  if (!noBooking && weekendClosed.length) angle = "closed-weekends";
  else if (!noBooking && closesEarly(hours)) angle = "closes-early";

  return {
    angle,
    hook: buildHook(noBooking, weekendClosed, hours, gap),
    closedHoursPerWeek: gap === null ? "" : String(gap),
    closedDays: closed.join(", "),
    excludeReason: "",
  };
}

function closesEarly(hours: PlaceHours | undefined): boolean {
  const close = hours?.closesAt;
  return Boolean(close && Number(close.slice(0, 2)) <= 17);
}

/**
 * One clause, specific and checkable, or nothing.
 *
 * Every branch states something the clinic can verify about itself and then
 * names a consequence it has not. Ordered so the most specific available fact
 * wins — a named closed day beats a generic hours gap, because "you're shut
 * Saturdays" reads as research and "you're closed sometimes" reads as spam.
 */
function buildHook(
  noBooking: boolean,
  weekendClosed: string[],
  hours: PlaceHours | undefined,
  gap: number | null,
): string {
  const close = hours?.closesAt;

  if (weekendClosed.length === 2) {
    return gap
      ? `you're closed weekends, so there are about ${gap} hours a week when someone who calls you gets a machine`
      : `you're closed weekends, which is when most people finally get round to booking`;
  }
  if (weekendClosed.length === 1) {
    return `you're closed ${weekendClosed[0]}s — that's the day people have time to ring round`;
  }
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `you close at ${close}, so anyone who calls after work reaches voicemail`;
  }
  if (gap && gap > 100) {
    return `you're open about ${168 - gap} hours a week, which leaves ${gap} when a new patient calling you gets a machine`;
  }
  if (noBooking) {
    // The weakest hook, and deliberately the last resort: it is true of the
    // clinic but says nothing only they would recognise.
    return `there's no way to book with you online, so every appointment starts with a phone call`;
  }
  return "";
}

/**
 * Why not to email this clinic.
 *
 * Kept as a column rather than a filter so the exclusions stay visible and
 * countable. Silently dropping rows makes a list look cleaner than it is and
 * hides the day the rule is wrong.
 */
function excludeReason(
  label: Label,
  booking: BookingDetection | undefined,
): string {
  if (label.segment === "not-a-target") {
    return "not a clinic";
  }
  if (label.segment === "unknown") {
    return "site could not be read — retry before writing off";
  }
  // GoHighLevel bundles Conversation AI and Voice AI, so these clinics already
  // run an AI booking layer. They are a disqualification dressed as a
  // detection, and reading them as a win is how you email your own product back
  // to someone who already bought a competitor's.
  if (booking?.platform === "gohighlevel") {
    return "on GoHighLevel — already has bundled AI receptionist";
  }
  if (label.isChainOrFranchise) {
    return "chain or franchise — decision sits with a central buyer";
  }
  return "";
}

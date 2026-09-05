import type { BookingGap, PlaceHours } from "./places.ts";
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

/**
 * "a Botox appointment" — article included, so nothing downstream has to guess.
 *
 * Article agreement is exactly the kind of detail that betrays a mail merge:
 * "a injectables appointment" or "an Botox appointment" tells the reader
 * instantly that nobody wrote this. Composing the whole phrase here means the
 * template holds one variable and cannot get it wrong.
 *
 * Falls back to "an appointment", which is true of every clinic and reads
 * perfectly well — a generic sentence beats a broken one.
 */
export function servicePhrase(topService: string | null): string {
  const s = (topService ?? "").trim();
  if (!s) return "an appointment";

  // Vowel SOUND, not vowel letter — and the two diverge in both directions.
  //
  // An initialism read letter by letter takes its article from the first
  // letter's name: IPL is "eye-pee-ell", so "an IPL". But an acronym read as a
  // word takes it from the word: LASIK is "lay-sik", so "a LASIK" — even though
  // L on its own is "ell".
  //
  // Nothing in the spelling distinguishes the two, so a general rule cannot
  // exist. This is a small closed domain, so the word-acronyms are simply
  // listed. Anything not listed falls back to the letter-name rule, which is
  // right for the initialisms that dominate here.
  const WORD_ACRONYMS = new Set(["lasik", "smile", "hifu", "bbl", "prk"]);

  const spelledVowel = /^[aeiou]/i.test(s);
  const initialism = /^[A-Z]{2,}$/.test(s.split(/\s/)[0] ?? "");
  const letterNameIsVowel = /^[AEFHILMNORSX]/.test(s);

  const vowelSound = WORD_ACRONYMS.has(s.toLowerCase().split(/\s/)[0] ?? "")
    ? /^[aeiou]/i.test(s)
    : initialism
      ? letterNameIsVowel
      : spelledVowel;

  const article = vowelSound ? "an" : "a";

  return `${article} ${s} appointment`;
}

export type OutreachRow = {
  /**
   * What healdesk is offering THIS clinic, named around their own gap.
   *
   * Not a product description. Every clinic gets the same product; what differs
   * is which of its properties matters to them, and saying the right one is the
   * difference between "we do AI reception" and "we answer the calls you get
   * between Friday evening and Monday morning".
   *
   * Built from the same three facts the hook uses — the gap, the service, and
   * whether they can be booked online — so the offer and the observation cannot
   * contradict each other in the same email.
   */
  topOffer: string;
  /** Hours in the longest stretch nobody answers. The number the email turns on. */
  gapHours: string;
  /** "Friday 17:00 to Monday 09:00" — where the gap falls. */
  gapWindow: string;
  /** "a Botox appointment", ready to drop into a sentence. */
  servicePhrase: string;
  /** The bare service, for subject lines where the article is wrong. */
  topService: string;
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
  const phrase = servicePhrase(label.topService);
  const exclude = excludeReason(label, booking);
  if (exclude) {
    return {
      servicePhrase: phrase,
      topService: label.topService ?? "",
      topOffer: "",
      gapHours: "",
      gapWindow: "",
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

  const window = hours?.gap ?? undefined;

  return {
    servicePhrase: phrase,
    topService: label.topService ?? "",
    topOffer: buildOffer(angle, phrase, window),
    gapHours: window ? String(window.hours) : "",
    gapWindow: window
      ? `${window.startsDay} ${window.startsAt} to ${window.endsDay} ${window.endsAt}`
      : "",
    angle,
    hook: buildHook(noBooking, weekendClosed, hours, gap, phrase, window),
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
  phrase: string,
  window: BookingGap | undefined,
): string {
  const close = hours?.closesAt;

  // The gap outranks everything else, because it is the only fact here the
  // clinic has not already got a ready answer for. "You're closed weekends"
  // invites "so is every clinic"; "there are 64 unbroken hours from Friday
  // evening to Monday morning when nobody can reach you" does not.
  if (window && window.hours >= 24) {
    return (
      `nobody can reach you between ${window.startsDay} ${window.startsAt} and ` +
      `${window.endsDay} ${window.endsAt} — ${window.hours} straight hours, and ` +
      `that is exactly when someone decides they want ${phrase} and starts ` +
      `ringing round`
    );
  }

  if (weekendClosed.length === 2) {
    return gap
      ? `you're closed weekends, so there are about ${gap} hours a week when a new patient calling you gets a machine and calls someone else`
      : `you're closed weekends, which is when people finally get round to booking — and they book with whoever answers`;
  }
  if (weekendClosed.length === 1) {
    return `you're closed ${weekendClosed[0]}s, which is the day people have time to ring round and book on the spot`;
  }
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `you close at ${close}, so anyone ringing after work gets voicemail — and most of them ring the next clinic rather than wait`;
  }
  if (gap && gap > 100) {
    return `you're open about ${168 - gap} hours a week, which leaves ${gap} when a new patient calling you gets a machine`;
  }
  if (noBooking) {
    // The weakest hook, and deliberately the last resort: it is true of the
    // clinic but says nothing only they would recognise. The service name is
    // what stops it reading as a form letter.
    return `there's no way to book ${phrase} with you online, so every one starts with a phone call — and every unanswered call is somebody booking elsewhere`;
  }
  return "";
}

/**
 * The offer, named around this clinic's own gap.
 *
 * Deliberately concrete and small. "AI receptionist" is a category; "answers
 * the calls that come in between Friday evening and Monday morning" is a job
 * they can picture being done, and it is the same job in every case — only the
 * window changes.
 *
 * Ordered so the most specific available framing wins, and falls back to
 * something true and plain rather than to something vague and grand.
 */
function buildOffer(
  angle: Angle,
  phrase: string,
  window: BookingGap | undefined,
): string {
  // Two things every version below has to carry.
  //
  // IMMEDIACY: "books" is a state the caller reaches eventually; "books on the
  // spot" is the thing being sold. The whole product is that the gap between
  // wanting an appointment and having one collapses to the length of a phone
  // call, and a verb without a timeframe gives that away for free.
  //
  // THE COMPETITOR: "leaves a message" understates the loss to the point of
  // being reassuring — a message implies the patient is still yours and you
  // ring them back tomorrow. They are not. Someone who cannot reach you calls
  // the next clinic on the list, and by the time you return the call they have
  // an appointment. That is the actual cost, and naming it is what makes the
  // 64 hours frightening rather than merely true.
  if (window && window.hours >= 24) {
    return (
      `cover the ${window.hours} hours from ${window.startsDay} ${window.startsAt} ` +
      `to ${window.endsDay} ${window.endsAt}, so someone who wants ${phrase} ` +
      `books on the spot instead of leaving a message and ringing the next ` +
      `clinic while they wait for you to call back`
    );
  }

  switch (angle) {
    case "phone-only":
      return (
        `take the calls your front desk cannot and book ${phrase} into your ` +
        `calendar there and then, before they try somebody else`
      );
    case "closes-early":
      return (
        `answer the after-work calls and book them on the spot, so ${phrase} ` +
        `does not become a voicemail they never wait for`
      );
    case "closed-weekends":
      return (
        `answer at weekends and book while they are still on the phone — that ` +
        `is when people ring round, and they book with whoever picks up`
      );
    case "has-booking":
      return (
        `catch the callers your booking page does not: the ones who ring ` +
        `instead of clicking, and hang up rather than leave a message`
      );
    default:
      return "";
  }
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

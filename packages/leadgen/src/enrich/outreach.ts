import {
  CAPABILITY_LABEL,
  selectCapability,
  type Capability,
} from "./capabilities.ts";
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
/**
 * "17:00" -> "5pm". Nobody writes 24-hour time to a clinic.
 *
 * Small, and it is exactly the sort of thing that gives a generated email away:
 * a receptionist reads "17:00" and knows a machine wrote it.
 */
export function clockTime(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === "00" ? `${hour}${suffix}` : `${hour}.${m}${suffix}`;
}

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
  /** Which of the seven capabilities this clinic is being sold. */
  capability: Capability;
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
      capability: "around-the-clock",
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
  const offer = buildOffer(label, phrase, window, !noBooking, closesEarly(hours));

  return {
    servicePhrase: phrase,
    topService: label.topService ?? "",
    topOffer: offer.offer,
    capability: offer.capability,
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
  // One sentence. It has to land in about three seconds, because that is how
  // long a clinic owner gives an unknown sender before the thumb moves.
  //
  // Written to be recognised rather than argued with. A receptionist reading
  // "Fri 5pm to Mon 9am nobody is there" thinks yes, obviously, that is my job
  // and I am not there at the weekend. That is the reaction worth having: not
  // guilt, just recognition. Everything explaining WHY it matters was cut,
  // because the reader already knows why and telling them is what makes an
  // email sound like a pitch.
  if (window && window.hours >= 24) {
    return (
      `${window.startsDay.slice(0, 3)} ${clockTime(window.startsAt)} to ` +
      `${window.endsDay.slice(0, 3)} ${clockTime(window.endsAt)} nobody is ` +
      `picking up. That is ${window.hours} hours.`
    );
  }

  if (weekendClosed.length === 2) {
    return `You are shut at weekends, which is when most people get round to ringing.`;
  }
  if (weekendClosed.length === 1) {
    return `You are shut ${weekendClosed[0]}s. That is the day people ring round.`;
  }

  const close = hours?.closesAt;
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `You close at ${clockTime(close)}, so the after-work calls go to voicemail.`;
  }
  if (gap && gap > 100) {
    return `There are about ${gap} hours a week when nobody can reach you.`;
  }
  if (noBooking) {
    return `There is no way to book ${phrase} with you online, so it all comes through the phone.`;
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
  label: Label,
  phrase: string,
  window: BookingGap | undefined,
  hasBooking: boolean,
  closesEarly: boolean,
): { offer: string; capability: Capability } {
  const pitch = selectCapability({
    segment: label.segment,
    gapHours: window?.hours ?? null,
    hasOnlineBooking: hasBooking,
    closesEarly,
  });

  // Short, and in the register a receptionist would use.
  //
  // The person reading this is not lazy, they are busy — they already know they
  // cannot answer everything, and being told they "miss calls" reads as an
  // accusation from someone who has never worked a front desk. So the offer
  // says what happens instead, in one sentence, and stops.
  //
  // No em dashes and no semicolons: they are the punctuation of generated text
  // and a reader clocks them before they clock the argument.
  const tail =
    pitch.capability === "around-the-clock" || pitch.capability === "calendar-booking"
      ? `They book ${phrase} on the spot instead of trying the next clinic.`
      : pitch.because;

  return {
    offer: `${CAPABILITY_LABEL[pitch.capability]}. ${tail}`,
    capability: pitch.capability,
  };
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

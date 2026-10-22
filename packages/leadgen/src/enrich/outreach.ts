import {
  bookingModeFor,
  offerLabel,
  selectCapability,
  type BookingMode,
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

/**
 * What to call the product to THIS reader.
 *
 * An owner is being sold a business decision, so "smart assistant" is the right
 * register: it implies judgement and return. A receptionist is being told
 * something will help with their actual day, and "smart" reads as a threat to
 * someone whose job is answering phones. "Virtual assistant" is the familiar,
 * unthreatening word for help.
 *
 * A role address (info@, frontdesk@) gets the receptionist framing too. Nobody
 * knows who opens it, and the safe assumption is whoever staffs the desk — an
 * owner reading a virtual-assistant email loses nothing, while a receptionist
 * reading a replace-your-front-desk email forwards it to nobody.
 */
export function assistantTerm(jobTitle: string, email: string): "smart" | "virtual" {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  const ROLE = /^(info|contact|hello|hi|admin|office|frontdesk|front\.desk|reception|bookings?|appointments?|team|enquiries|inquiries|support|mail|clinic|spa)$/;
  if (ROLE.test(local)) return "virtual";

  const t = jobTitle.toLowerCase();
  if (/\b(owner|founder|co-founder|ceo|president|principal|partner|director|proprietor)\b/.test(t)) {
    return "smart";
  }
  return "virtual";
}

/**
 * What this clinic calls the people who book with it.
 *
 * A med spa has clients and a dental practice has patients, and each notices
 * the other's word at once: "patients" from a stranger tells a med spa owner
 * the email was written for a doctor's office. Exported as `client_term` so
 * the sequence's own text uses the same word as the merged lines.
 */
const CLIENT_SEGMENTS: ReadonlySet<string> = new Set([
  "injectables", "laser-skin", "body-contouring", "wellness-iv", "massage-therapy", "veterinary",
]);

export function clientTerm(segment: string): "clients" | "patients" {
  return CLIENT_SEGMENTS.has(segment) ? "clients" : "patients";
}

/**
 * The service as a bare noun, for "booking dental implants" and "about lip
 * filler", or null when there is none worth naming.
 *
 * The clinic's own word, plural and all. servicePhrase() singularises it,
 * because there it sits before "appointment"; used on its own the singular
 * reads wrong ("booking dental implant"). Where servicePhrase() fell back, so
 * does this, and where the service already names the encounter ("OB-GYN
 * appointment") the encounter word is dropped rather than doubled.
 */
export function serviceTopic(phrase: string, topService: string | null): string | null {
  if (phrase === "an appointment") return null;
  const raw = (topService ?? "").trim();
  if (!raw || /\b(appointment|visit|consult|consultation|session|treatment|exam|scan|screening)$/i.test(raw)) {
    return phrase.replace(/^an? /, "").replace(/ appointment$/, "");
  }
  return raw;
}

export function servicePhrase(topService: string | null): string {
  let s = (topService ?? "").trim();
  if (!s) return "an appointment";

  // The service is used attributively — "a {service} appointment" — so it has
  // to be singular. The label step returns whatever the site calls it, and 12%
  // of the time that is a plural: "Every laser facials appointment you take"
  // was going out in 8 of 177 rows. One ungrammatical word is enough to tell
  // the reader a template wrote the sentence.
  //
  // A coordinated pair cannot be fixed by trimming a letter — "botox and
  // fillers" stays wrong either way — so those fall back to the generic
  // opening rather than being mangled into grammatical nonsense.
  if (/\s(?:and|&|\+)\s/i.test(s)) return "an appointment";
  if (/[a-z]s$/.test(s) && !/(?:ss|us|is)$/i.test(s)) s = s.slice(0, -1);

  // Some services ARE the appointment. The classifier returns "OB-GYN
  // appointment", "urgent care visit", "acne treatment" — the clinic's own
  // words — and appending another booking noun produced "an OB-GYN appointment
  // appointment" in six rows and "a primary care visit appointment" in more.
  //
  // Where the service already names the encounter, it is the noun and nothing
  // is added to it.
  const ENCOUNTER = /\b(appointment|visit|consult|consultation|session|treatment|exam|scan|screening)$/i;
  if (ENCOUNTER.test(s)) return `${article(s)} ${s}`;


  return `${article(s)} ${s} appointment`;
}

/**
 * "a" or "an", by the SOUND of what follows, not the letter.
 *
 * An initialism read letter by letter takes its article from the first letter's
 * name: IPL is "eye-pee-ell", so "an IPL". An acronym read as a word takes it
 * from the word: LASIK is "lay-sik", so "a LASIK", even though L on its own is
 * "ell". Nothing in the spelling distinguishes the two, so the word-acronyms
 * are listed.
 */
function article(s: string): string {
  const WORD_ACRONYMS = new Set(["lasik", "smile", "hifu", "bbl", "prk"]);
  const first = s.split(/\s/)[0] ?? "";
  const initialism = /^[A-Z]{2,}$/.test(first);
  const vowelSound = WORD_ACRONYMS.has(first.toLowerCase())
    ? /^[aeiou]/i.test(s)
    : initialism
      ? /^[AEFHILMNORSX]/.test(s)
      : /^[aeiou]/i.test(s);
  return vowelSound ? "an" : "a";
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
  /**
   * The one-line question the email ends on, derived from this clinic's facts.
   *
   * A message that ends on a statement gives the reader nothing to do, and the
   * reply is the point of the send.
   */
  closingQuestion: string;
  /**
   * Touch 1's subject, built on the same fact as the hook: "Weekend calls at
   * Glow". Under 40 characters so a phone shows all of it; the company is
   * dropped before the fact is.
   */
  subjectLine: string;
  /** Where the preview's chat is dressed: "your Instagram", or "your website". */
  chatSurface: string;
  /**
   * Touch 2: one scene from this clinic's own week. Someone gets in touch
   * while they are closed, on the channel they run, about their service, and
   * what AYA does with it, which follows bookingMode.
   */
  scenario: string;
  /** "clients" for aesthetics, wellness, massage and vets, "patients" otherwise. */
  clientTerm: "clients" | "patients";
  /** Hours in the longest stretch nobody answers. The number the email turns on. */
  gapHours: string;
  /** "Friday 17:00 to Monday 09:00" — where the gap falls. */
  gapWindow: string;
  /** Which capability this clinic is being sold. */
  capability: Capability;
  /**
   * Whether the offer may promise a booking outright. "manual" and
   * "unverified" clinics get a booking clause that says what happens when
   * their system does not read Google Calendar. See bookingModeFor().
   */
  bookingMode: BookingMode;
  /** "smart" for an owner, "virtual" for a receptionist or role address. */
  assistantTerm: "smart" | "virtual";
  /** instagram, facebook, tiktok, whatsapp — whichever they actually run. */
  socialChannels: string;
  /**
   * Which of the three surfaces to offer: phone, meta, website.
   *
   * The product runs on all three, but pitching all three to everyone turns a
   * specific email into a capability list. A clinic with no Instagram does not
   * want to hear about Instagram.
   */
  channels: string;


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
 * Ordered by how much the answered-call story is worth to them, which is not
 * the same as how easy they are to classify.
 */
/**
 * The question the email ends on.
 *
 * Every message closes with one, because a message that closes with a statement
 * gives the reader nothing to do and the reply is the entire point of the send.
 *
 * It is derived from the same facts as the hook rather than being one stock
 * line, for the same reason the hooks are: a question every recipient gets is a
 * question none of them answers. Each one asks about a thing this clinic
 * specifically does, so answering it takes less effort than ignoring it.
 *
 * Kept to one short line. A question that needs re-reading is not a question,
 * it is a form.
 *
 * Since 22 October 2026 it is the sequence's ask as well (owner's brief:
 * "Mind if I send the test link?", docs/outreach/sequences.md). One question
 * per email, and it says plainly what the link is for: talking to AYA as one
 * of the clinic's own new clients would, to book. An earlier version named a
 * moment instead ("call her after 4pm on a Saturday?"), and the owner found it
 * confusing: it asked the reader to work out why they would. "Her" is AYA,
 * whom every email in the sequence names first.
 */
function buildQuestion(
  angle: Angle,
  sites: number | null,
  client: "clients" | "patients",
  social: readonly string[],
): string {
  const one = client.slice(0, -1);
  if (sites) {
    return `Want one link to test her like a new ${one} at any of your ${NUMBER_WORDS[sites] ?? sites} locations?`;
  }
  if (angle === "has-automation") {
    return "Want the link to see how she'd handle one of your own leads?";
  }
  // The chat is dressed as their Instagram or WhatsApp, so a clinic that runs
  // one is asked to message her; one that books only by phone, to call her.
  if (social.some((s) => s === "instagram" || s === "facebook" || s === "whatsapp")) {
    return `Want the link to message her like a new ${one} would?`;
  }
  if (angle === "phone-only") {
    return `Want the link to call her like a new ${one} would?`;
  }
  return `Want the link to try booking with her like a new ${one} would?`;
}

export type Angle =
  | "phone-only"
  | "closed-weekends"
  | "closes-early"
  | "has-booking"
  | "has-automation"
  | "multi-site"
  | "exclude";

export function buildOutreachRow(
  label: Label,
  booking: BookingDetection | undefined,
  hours: PlaceHours | undefined,
  contact: { jobTitle: string; email: string; social?: readonly string[]; company?: string } = {
    jobTitle: "",
    email: "",
  },
): OutreachRow {
  const assistant = assistantTerm(contact.jobTitle, contact.email);
  const social = contact.social ?? [];
  const phrase = servicePhrase(label.topService);
  const exclude = excludeReason(label);
  if (exclude) {
    return {
      servicePhrase: phrase,
      topService: label.topService ?? "",
      topOffer: "",
      closingQuestion: "",
      subjectLine: "",
      chatSurface: "",
      scenario: "",
      clientTerm: clientTerm(label.segment),
      gapHours: "",
      gapWindow: "",
      capability: "around-the-clock",
      bookingMode: bookingModeFor(booking?.platform, Boolean(booking?.hasOnlineBooking) || label.offersOnlineBooking),
      assistantTerm: assistant,
      socialChannels: social.join(", "),
      channels: "",
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
  // Either source saying "they book online" is enough; only both staying silent
  // makes it phone-only.
  //
  // This used to give the link pass absolute precedence, which meant a gap in
  // the signature table was promoted to a claim about the clinic. Measured: 17
  // clinics whose own homepage linked straight to Zocdoc, Vagaro, Boulevard or
  // Calendly were being told "every appointment you take starts with a phone
  // call". That sentence is the opening line of the email and it is disprovable
  // in one click by the person reading it.
  //
  // The asymmetry decides the direction. A wrong has-booking costs a weaker
  // email. A wrong phone-only costs the whole email, and the sender with it.
  const noBooking = booking?.hasOnlineBooking
    ? false
    : !label.offersOnlineBooking;

  // Strongest first. A clinic with no online booking at all takes every
  // appointment by phone, so every unanswered call is a lost booking — that
  // beats any hours-based angle even when the hours are known.
  // What we detected is an automation PLATFORM, not an AI.
  //
  // GoHighLevel is a CRM and marketing-automation product; its Conversation AI
  // and Voice AI are paid add-ons most accounts never switch on. So a detected
  // GHL widget proves somebody set this clinic up with real lead-capture
  // tooling, and proves nothing at all about whether anything answers the
  // phone. The earlier version asserted "you already run an AI layer", which
  // was an unverified claim in the first sentence of a cold email.
  //
  // It outranks the other angles because writing to a clinic with a built-out
  // stack as though they have nothing is the one opening they cannot read past.
  const hasAutomation = booking?.platform === "gohighlevel";

  /**
   * A group of two to ten sites under one owner.
   *
   * These were all excluded as "chain or franchise". 438 of the 835 flagged
   * turned out to be this: a dermatology practice with four offices in one
   * metro, physician owned, where the owner both decides and answers. That is a
   * BETTER prospect than a single site, not a worse one, because the same
   * decision covers several unanswered phones.
   *
   * Capped at ten. Above that the owner stops being the person who notices a
   * missed call, which is the whole premise of the pitch.
   */
  const sites =
    label.chainTier === "multi-site-group" &&
    typeof label.siteCount === "number" &&
    label.siteCount >= 2 &&
    label.siteCount <= 10
      ? label.siteCount
      : null;

  let angle: Angle = hasAutomation
    ? "has-automation"
    : sites
      ? "multi-site"
      : noBooking
      ? "phone-only"
      : "has-booking";
  if (!hasAutomation && !sites && !noBooking && weekendClosed.length) {
    angle = "closed-weekends";
  } else if (!hasAutomation && !sites && !noBooking && closesEarly(hours)) {
    angle = "closes-early";
  }

  const window = hours?.gap ?? undefined;
  const channels = selectChannels(social);
  const bookingMode = bookingModeFor(booking?.platform, !noBooking);
  const offer = buildOffer(
    label,
    window,
    !noBooking,
    closesEarly(hours),
    channelPhrase(channels, social),
    bookingMode,
  );

  return {
    servicePhrase: phrase,
    topService: label.topService ?? "",
    topOffer: offer.offer,
    closingQuestion: buildQuestion(angle, sites, clientTerm(label.segment), social),
    clientTerm: clientTerm(label.segment),
    subjectLine: buildSubject(companyShort(contact.company ?? ""), window, weekendClosed, hours, sites, noBooking),
    chatSurface: chatSurface(social),
    scenario: buildScenario(phrase, label.topService, social, window, weekendClosed, hours, bookingMode),
    capability: offer.capability,
    bookingMode,
    assistantTerm: assistant,
    socialChannels: social.join(", "),
    channels: channels.join(", "),
    gapHours: window ? String(window.hours) : "",
    gapWindow: window
      ? `${window.startsDay} ${window.startsAt} to ${window.endsDay} ${window.endsAt}`
      : "",
    angle,
    hook: buildHook(noBooking, weekendClosed, hours, gap, phrase, label.topService, window, hasAutomation, sites),
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
/**
 * Small numbers read as words in a sentence. "3 locations" looks like a
 * spreadsheet; "three locations" looks like someone wrote it.
 */
const NUMBER_WORDS: Record<number, string> = {
  2: "two", 3: "three", 4: "four", 5: "five",
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
};

function buildHook(
  noBooking: boolean,
  weekendClosed: string[],
  hours: PlaceHours | undefined,
  gap: number | null,
  phrase: string,
  service: string | null,
  window: BookingGap | undefined,
  hasAutomation: boolean,
  sites: number | null,
): string {
  // Framed as what is available, not what is going wrong.
  //
  // The earlier version opened with "nobody is there to pick up", which is true
  // and is also a stranger telling a clinic it is failing. Loss framing earns
  // attention when it comes from someone you trust; from an unknown sender it
  // reads as criticism and gets deleted. The same 64 hours described as time
  // the phone could be booking is the identical fact with the accusation taken
  // out, and it leaves the reader with something to want rather than something
  // to defend.
  //
  // The service is named HERE and nowhere else. Repeating it in the offer was
  // the loudest tell that a template wrote this.
  //
  // It is named in EVERY branch, which it was not before. Four of these six
  // returned a sentence with nothing clinic-specific in it, so a third of the
  // list received an opening line that was true of every clinic in the country.
  // The branch decides which fact about the clinic is worth opening on; the
  // service is what makes it that clinic's sentence rather than a category's.
  //
  // Since 22 October 2026 every hook is the email's FIRST line (docs/outreach/
  // sequences.md), so it is what a phone shows as the preview text under the
  // subject. Each one therefore states a fact about this clinic the reader can
  // check ("You close at 5pm"), not a claim about people in general, and it
  // stands on its own: nothing before it for "this" or "that" to point back at.
  // About fifteen words, US English, because the list is US clinics and
  // "ringing round" reads as a stranger from somewhere else.
  //
  // The bare service, "lip filler", not "lip filler appointments": "booking
  // lip filler" is how a clinic says it.
  const topic = serviceTopic(phrase, service);
  const booking = topic ?? "appointments";
  const about = topic ?? "booking an appointment";

  if (hasAutomation) {
    // Credits the work rather than questioning the judgement. The clinic chose
    // that stack, so anything implying the choice was naive is an insult in the
    // opening line. "The harder half" says their build was the difficult part,
    // which is both flattering and true.
    return "Your automation setup has already solved the harder half of lead capture.";
  }

  if (sites) {
    // The site count is the fact they own and we noticed. Framed as capacity
    // rather than failure.
    const n = NUMBER_WORDS[sites] ?? String(sites);
    if (window && window.hours >= 24) {
      return `From ${window.startsDay} ${clockTime(window.startsAt)} to ${window.endsDay} ${clockTime(window.endsAt)}, all ${n} of your locations could still be booking ${booking}.`;
    }
    return `${n[0]!.toUpperCase()}${n.slice(1)} locations means ${n} phones that could all be booking ${booking}.`;
  }

  if (window && window.hours >= 24) {
    return (
      `From ${window.startsDay} ${clockTime(window.startsAt)} to ` +
      `${window.endsDay} ${clockTime(window.endsAt)}, that's ${window.hours} ` +
      `hours your phone could still be booking ${booking}.`
    );
  }

  if (weekendClosed.length === 2) {
    return `You're closed on weekends, when a lot of people finally call about ${about}.`;
  }
  if (weekendClosed.length === 1) {
    return `You're closed ${weekendClosed[0]}s, which is when a lot of people shop around for ${about}.`;
  }

  const close = hours?.closesAt;
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `You close at ${clockTime(close)}, right when most people get off work and call about ${about}.`;
  }
  if (gap && gap > 100) {
    return `Outside your opening hours, that's about ${gap} hours a week your phone could be booking ${booking}.`;
  }
  if (noBooking) {
    return `Every ${phrase.replace(/^an? /, "")} you take starts with a phone call.`;
  }

  // Never blank. A clinic that books online and whose hours we could not read
  // used to fall through every branch, leaving a hole in the email or silently
  // dropping the personalisation that justified sending it. This claims nothing
  // specific and is true of everyone.
  return topic
    ? `Your booking page works for people who've decided on ${topic}, not the ones still asking questions.`
    : "Your booking page works for people who've already decided, not the ones still asking questions.";
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
  window: BookingGap | undefined,
  hasBooking: boolean,
  closesEarly: boolean,
  surfaces: string,
  bookingMode: BookingMode,
): { offer: string; capability: Capability } {
  const pitch = selectCapability({
    segment: label.segment,
    gapHours: window?.hours ?? null,
    hasOnlineBooking: hasBooking,
    closesEarly,
  });

  // The surfaces are named INSIDE the offer, not after it.
  //
  // The previous version emitted three lines about channels: one offer for the
  // phone, a second for social, a third listing the mix. Three sentences saying
  // versions of the same thing is a capability list that has been broken up,
  // and a reader clocks it instantly. One sentence that happens to name two or
  // three surfaces reads like somebody describing what they built.
  // The booking mode can swap the label: a Mindbody clinic is never promised
  // a live booking, because the slot the assistant writes into Google does not
  // block anything in Mindbody (docs/v1-product-spec.md → "What the hub model
  // does and does not guarantee").
  const opening = offerLabel(pitch.capability, bookingMode).replace("{surfaces}", surfaces);

  // One sentence that keeps going, not two that stop.
  //
  // Two short sentences read as bullet points with the bullets removed, which
  // is the shape people have learned to skim. A clause that runs on is how a
  // person writes to another person, and it also lets the consequence arrive
  // inside the same breath as the offer rather than as a separate claim.
  // The service is NOT repeated here. It is named once, in the hook, and saying
  // it again in the very next sentence is the loudest tell that a template
  // wrote both.
  const tail = pitch.because;

  return { offer: `${opening}, ${tail}.`, capability: pitch.capability };
}

/**
 * Which surfaces to put in front of this clinic.
 *
 * Phone and website are always there. Every clinic has both, and both are half
 * the product.
 *
 * Website used to be conditional on the clinic having NO online booking, on the
 * reasoning that a booking widget already catches the visitor. It does not. A
 * widget is a form: it takes a slot from somebody who has already decided, and
 * it has no answer for the visitor who wants to know whether they are a
 * candidate, whether their insurance is taken, what it costs, or whether they
 * can have it while pregnant. That person does not fill in a booking form. They
 * leave. So the rule excluded the chatbot from 1,225 of 1,753 clinics — 70% —
 * and the ones it excluded were the ones sophisticated enough to have bought
 * booking software.
 *
 * What differs by case is the REASON, not whether to offer it. See
 * websiteReason() below.
 *
 * Meta stays conditional: offering Instagram to a clinic with no Instagram is
 * the fastest way to sound like a form, and unlike a website it is genuinely
 * absent for more than half the list. Only the three Meta channels the product
 * answers count. A clinic that runs only TikTok is not offered "social
 * messages", because the Meta bot covers Instagram, Messenger and WhatsApp
 * and nothing else.
 */
const META_SOCIAL = new Set(["instagram", "facebook", "whatsapp"]);

function selectChannels(social: readonly string[]): string[] {
  const out = ["phone", "website"];
  if (social.some((s) => META_SOCIAL.has(s))) out.push("meta");
  return out;
}

/**
 * The surfaces as one noun phrase, to sit inside the offer sentence.
 *
 * This exists because the previous version produced THREE separate lines about
 * channels: an offer for the phone, another for social, and a third listing the
 * mix. Three sentences saying versions of the same thing is what a capability
 * list looks like after it has been broken up, and a reader recognises it
 * instantly. One sentence naming the surfaces reads like a person describing
 * their product.
 */
function channelPhrase(channels: readonly string[], social: readonly string[]): string {
  // Named the way patients name them. A Facebook Page is reached through
  // Messenger, so that is the word.
  const named = social.includes("instagram")
    ? "Instagram DMs"
    : social.includes("facebook")
      ? "Facebook messages"
      : social.includes("whatsapp")
        ? "WhatsApp messages"
        : null;

  const parts = ["your calls"];
  if (channels.includes("website")) parts.push("website chat");
  if (channels.includes("meta") && named) parts.push(named);

  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} and ${parts[2]}`;
}

/**
 * Why not to email this clinic.
 *
 * Kept as a column rather than a filter so the exclusions stay visible and
 * countable. Silently dropping rows makes a list look cleaner than it is and
 * hides the day the rule is wrong.
 */
export function excludeReason(label: Label): string {
  if (label.segment === "not-a-target") {
    return "not a clinic";
  }
  if (label.segment === "unknown") {
    return "site could not be read — retry before writing off";
  }
  // GoHighLevel is deliberately NOT an exclusion.
  //
  // It bundles Conversation AI and Voice AI, so these clinics have already
  // bought the idea and only have to be persuaded about the execution. That is
  // a warmer starting position than a clinic which has never considered it, not
  // a colder one. What it changes is the approach, not the eligibility, so it
  // sets the "has-ai" angle below rather than removing the row.
  if (label.isChainOrFranchise) {
    return "chain or franchise — decision sits with a central buyer";
  }
  return "";
}

export type HookDiversity = {
  /** Sendable rows measured. Excluded rows have no hook and are not counted. */
  rows: number;
  distinct: number;
  /** Share of rows getting the single most common hook, 0 to 1. */
  topShare: number;
  topHook: string;
  warning: string | null;
};

/**
 * How many different opening sentences the list would actually receive.
 *
 * The count of hook BRANCHES is not the number worth watching, because three of
 * them return a fixed string with nothing clinic-specific in it. What decides
 * whether a campaign reads as researched is how many distinct sentences leave
 * the building, and that is dominated by whether topService resolved.
 *
 * Measured before the Google hours run: 177 sendable rows, 49 distinct hooks,
 * and the top one on 34.5% of them. So one in three clinics got a sentence that
 * is true of every clinic in the country. Spam filters cluster on repeated
 * bodies, and a recipient who forwards it to the practice next door finds the
 * same email.
 *
 * A quarter is the line because below it no single sentence dominates the send,
 * and above it the campaign has a template the recipient can feel.
 */
export function hookDiversity(hooks: string[]): HookDiversity {
  const used = hooks.filter((h) => h.trim());
  if (used.length === 0) {
    return { rows: 0, distinct: 0, topShare: 0, topHook: "", warning: null };
  }

  const counts = new Map<string, number>();
  for (const h of used) counts.set(h, (counts.get(h) ?? 0) + 1);

  const [topHook, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  const topShare = topCount / used.length;

  const warning =
    topShare > 0.25
      ? `${Math.round(100 * topShare)}% of ${used.length} sendable clinics get the ` +
        `same opening sentence ("${topHook.slice(0, 48)}..."). That is one ` +
        `sentence carrying a third of the campaign, and it says nothing about ` +
        `the clinic reading it.`
      : null;

  return { rows: used.length, distinct: counts.size, topShare, topHook, warning };
}

/**
 * "Glow Aesthetics & Wellness, LLC" -> "Glow Aesthetics & Wellness".
 *
 * The list carries the registered name, and a legal suffix in a subject line
 * or a greeting is the surest sign a database wrote it. It also costs a phone
 * the characters it needed for the rest of the subject.
 */
export function companyShort(name: string): string {
  const out = name
    .replace(/[,\s]+(?:L\.?L\.?C\.?|P\.?L\.?L\.?C\.?|P\.?C\.?|P\.?A\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|LLP)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || name.trim();
}

/** "https://www.glowaesthetics.com/home" -> "glowaesthetics.com", as a person types it. */
export function siteHost(url: string): string {
  const s = url.trim();
  if (!s) return "";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  }
}

/**
 * The channel the preview's chat is dressed as, in the words of touch 1:
 * "chat with her as she'd appear on your Instagram". Naming the one they run
 * lets them picture the preview before asking for it.
 */
export function chatSurface(social: readonly string[]): string {
  if (social.includes("instagram")) return "your Instagram";
  if (social.includes("whatsapp")) return "your WhatsApp";
  if (social.includes("facebook")) return "your Facebook page";
  return "your website";
}

const SUBJECT_MAX = 40;

/**
 * Short, specific, about them. A subject naming their own fact ("Weekend
 * calls at Glow") is opened as mail about the clinic; "preview for Glow" is
 * opened as a pitch, or not at all.
 */
function buildSubject(
  company: string,
  window: BookingGap | undefined,
  weekendClosed: string[],
  hours: PlaceHours | undefined,
  sites: number | null,
  noBooking: boolean,
): string {
  const close = hours?.closesAt;
  const fact = sites
    ? `${sites} phones`
    : window && window.hours >= 24
      ? `${window.startsDay} calls`
      : weekendClosed.length === 2
        ? "Weekend calls"
        : weekendClosed.length === 1
          ? `${weekendClosed[0]} calls`
          : close && Number(close.slice(0, 2)) <= 17
            ? `After-${clockTime(close)} calls`
            : noBooking
              ? "Phone bookings"
              : null;

  if (!fact) {
    const full = `AYA for ${company}`;
    return company && full.length <= SUBJECT_MAX ? full : "AYA for your clinic";
  }
  const full = `${fact} at ${company}`;
  return company && full.length <= SUBJECT_MAX ? full : fact;
}

/**
 * "Picture someone messaging your Instagram on a Saturday night about lip
 * filler. AYA answers, offers a time and books it straight into your calendar."
 *
 * A feature list is skimmed; a scene from their own week is read. Every part
 * is a fact we have: when they are closed, the channel they run (the phone
 * when they run no Meta channel), the service, and what happens to the
 * booking, which never promises more than bookingMode allows.
 */
function buildScenario(
  phrase: string,
  service: string | null,
  social: readonly string[],
  window: BookingGap | undefined,
  weekendClosed: string[],
  hours: PlaceHours | undefined,
  mode: BookingMode,
): string {
  const close = hours?.closesAt;
  const when =
    window && window.hours >= 24
      ? Number(window.startsAt.slice(0, 2)) >= 15
        ? ` on a ${window.startsDay} night`
        : ` on a ${window.startsDay}`
      : weekendClosed.length === 2
        ? " on a Sunday"
        : weekendClosed.length === 1
          ? ` on a ${weekendClosed[0]}`
          : close && Number(close.slice(0, 2)) <= 17
            ? ` at ${clockTime(`${String(Number(close.slice(0, 2)) + 3).padStart(2, "0")}:00`)}`
            : " while your team is busy";

  const how = social.includes("instagram")
    ? "messaging your Instagram"
    : social.includes("whatsapp")
      ? "messaging you on WhatsApp"
      : social.includes("facebook")
        ? "messaging your Facebook page"
        : "calling";

  const about = serviceTopic(phrase, service) ?? "booking an appointment";

  const outcome =
    mode === "live"
      ? "AYA answers, offers a time and books it straight into your calendar."
      : mode === "manual"
        ? "AYA answers, takes the time they want and passes it to your desk to confirm in Mindbody."
        : "AYA answers, takes the time they want and passes it to your desk to confirm.";

  return `Picture someone ${how}${when} about ${about}. ${outcome}`;
}


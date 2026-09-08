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

/**
 * What to call the product to THIS reader.
 *
 * An owner is being sold a business decision, so "smart assistant" is the right
 * register: it implies judgement and revenue. A receptionist is being told
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
  /**
   * The one-line question the email ends on, derived from this clinic's facts.
   *
   * A message that ends on a statement gives the reader nothing to do, and the
   * reply is the point of the send.
   */
  closingQuestion: string;
  /** Hours in the longest stretch nobody answers. The number the email turns on. */
  gapHours: string;
  /** "Friday 17:00 to Monday 09:00" — where the gap falls. */
  gapWindow: string;
  /** Which of the seven capabilities this clinic is being sold. */
  capability: Capability;
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
 * Ordered by how much the recovered-call story is worth to them, which is not
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
 */
function buildQuestion(
  angle: Angle,
  window: BookingGap | undefined,
  weekendClosed: string[],
  hours: PlaceHours | undefined,
): string {
  if (angle === "has-automation") {
    return "Is that the half you'd want covered?";
  }
  if (window && window.hours >= 24) {
    return `Where do those ${window.hours} hours of calls go at the moment?`;
  }
  if (weekendClosed.length === 2) {
    return "What happens to the weekend callers right now?";
  }
  if (weekendClosed.length === 1) {
    return `Who picks up on a ${weekendClosed[0]}?`;
  }
  const close = hours?.closesAt;
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `Where do the calls after ${clockTime(close)} go now?`;
  }
  if (angle === "phone-only") {
    return "Who takes those calls when you're with a patient?";
  }
  return "Do the ones who ring instead still get through?";
}

export type Angle =
  | "phone-only"
  | "closed-weekends"
  | "closes-early"
  | "has-booking"
  | "has-automation"
  | "exclude";

export function buildOutreachRow(
  label: Label,
  booking: BookingDetection | undefined,
  hours: PlaceHours | undefined,
  contact: { jobTitle: string; email: string; social?: readonly string[] } = {
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
      gapHours: "",
      gapWindow: "",
      capability: "around-the-clock",
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

  let angle: Angle = hasAutomation
    ? "has-automation"
    : noBooking
      ? "phone-only"
      : "has-booking";
  if (!hasAutomation && !noBooking && weekendClosed.length) angle = "closed-weekends";
  else if (!hasAutomation && !noBooking && closesEarly(hours)) angle = "closes-early";

  const window = hours?.gap ?? undefined;
  const channels = selectChannels(social, !noBooking);
  const offer = buildOffer(
    label,
    window,
    !noBooking,
    closesEarly(hours),
    assistant,
    channelPhrase(channels, social),
    hasAutomation,
  );

  return {
    servicePhrase: phrase,
    topService: label.topService ?? "",
    topOffer: offer.offer,
    closingQuestion: buildQuestion(angle, window, weekendClosed, hours),
    capability: offer.capability,
    assistantTerm: assistant,
    socialChannels: social.join(", "),
    channels: channels.join(", "),
    gapHours: window ? String(window.hours) : "",
    gapWindow: window
      ? `${window.startsDay} ${window.startsAt} to ${window.endsDay} ${window.endsAt}`
      : "",
    angle,
    hook: buildHook(noBooking, weekendClosed, hours, gap, phrase, window, hasAutomation, assistant),
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
  hasAutomation: boolean,
  assistant: "smart" | "virtual",
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
  const svc = `${phrase.replace(/^an? /, "")}s`;

  if (hasAutomation) {
    // Credits the work rather than questioning the judgement. The clinic chose
    // that stack, so anything implying the choice was naive is an insult in the
    // opening line. "The harder half" says their build was the difficult part,
    // which is both flattering and true.
    return (
      `As far as our research goes, you've already solved the harder half of ` +
      `this with your current automation setup. What's left is a ${assistant} ` +
      `assistant that answers when you can't.`
    );
  }

  if (window && window.hours >= 24) {
    return (
      `There are ${window.hours} hours between ${window.startsDay.slice(0, 3)} ` +
      `${clockTime(window.startsAt)} and ${window.endsDay.slice(0, 3)} ` +
      `${clockTime(window.endsAt)} when your phone could still be booking ` +
      `${svc} for you.`
    );
  }

  if (weekendClosed.length === 2) {
    return `Weekends are when people finally get round to ringing about ${svc}, and that is a whole market sitting outside your opening hours.`;
  }
  if (weekendClosed.length === 1) {
    return `${weekendClosed[0]}s are when people ring round about ${svc}, so that is a free run at anyone shopping that day.`;
  }

  const close = hours?.closesAt;
  if (close && Number(close.slice(0, 2)) <= 17) {
    return `The hours after ${clockTime(close)} are when people finish work and start ringing about ${svc}, and they are yours for the taking.`;
  }
  if (gap && gap > 100) {
    return `There are around ${gap} hours a week your phone could be booking ${svc} while the practice is shut.`;
  }
  if (noBooking) {
    return `Every ${phrase.replace(/^an? /, "")} you take starts with a phone call, so each one answered is a patient booked.`;
  }

  // Never blank. A clinic that books online and whose hours we could not read
  // used to fall through every branch, leaving a hole in the email or silently
  // dropping the personalisation that justified sending it. This claims nothing
  // specific and is true of everyone.
  return `Some patients will always ring about ${svc} rather than book online, and they are usually the ones ready today.`;
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
  assistant: "smart" | "virtual",
  surfaces: string,
  introduced: boolean,
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
  // "Our smart assistant ..." twice in two sentences reads as a template that
  // forgot it had already spoken. The has-automation hook names the assistant
  // itself, so here the offer refers back to it instead of re-introducing it,
  // which is also just how a person continues a sentence they already started.
  const opening = (
    introduced
      ? CAPABILITY_LABEL[pitch.capability].replace(/^Our \{assistant\} assistant/, "It")
      : CAPABILITY_LABEL[pitch.capability]
  )
    .replace("{assistant}", assistant)
    .replace("{surfaces}", surfaces);

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
 * Phone is always there: it is the core of the product and every clinic has
 * one. The other two are conditional, because offering a surface a clinic does
 * not use is the fastest way to sound like a form.
 *
 * Meta only where they actually run a social account. Website where patients
 * cannot already book online, since a site with no booking path is one where
 * every visitor with a question has nowhere to put it. Where booking exists
 * that case is weaker and the phone argument is stronger, so it is left out
 * rather than padded in.
 */
function selectChannels(
  social: readonly string[],
  hasOnlineBooking: boolean,
): string[] {
  const out = ["phone"];
  if (social.length > 0) out.push("meta");
  if (!hasOnlineBooking) out.push("website");
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
  const named =
    social.includes("instagram") && social.includes("facebook")
      ? "Instagram messages"
      : social.includes("instagram")
        ? "Instagram messages"
        : social.includes("facebook")
          ? "Facebook messages"
          : social.includes("whatsapp")
            ? "WhatsApp messages"
            : "social messages";

  const parts = ["your calls"];
  if (channels.includes("website")) parts.push("website chat");
  if (channels.includes("meta")) parts.push(named);

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

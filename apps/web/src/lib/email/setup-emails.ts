import { ENTITY, entityLine } from "@/lib/legal";
import { SETUP_CHANNELS } from "@/lib/setup-channels";
import { site } from "@/lib/site";
import type { SetupRequest } from "@/lib/sheets/schema";

/**
 * The emails around a "Tell us about your clinic" request (Annex X: P2, P3,
 * P4, P5) and the contact form's acknowledgement (P8).
 *
 * Rules every one of these follows (Annex X1):
 * - one job, one next action, an exact date: "by Tuesday 7 October", never
 *   "within one business day";
 * - nothing that suggests we are new: no "pilot", "early access", "first
 *   clinics" or "founding"; the link is "your setup link";
 * - no timing before purchase: how each step works, never when a channel
 *   opens;
 * - the two acknowledgements (P2, P8) go to an address nobody has verified,
 *   so they echo nothing the person typed but that address itself: a form
 *   must not become a way to mail chosen text to a stranger. P4 and P5 may
 *   name the clinic, because an operator has read the request first;
 * - the footer names the sender as the site does, says replies reach a
 *   person and asks them to leave out patient details, and, on the two
 *   commercial ones (P4, P5), carries a one-click way to stop them and the
 *   postal address CAN-SPAM requires.
 */

export type RenderedEmail = { subject: string; text: string };

/** "Tuesday 20 October", in New York time, where our buyers are. */
export function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/** The most a subject may be (Annex X4): longer ones are cut by the inbox, mid-word. */
export const SUBJECT_MAX = 70;

/** A clinic's name cut, with an ellipsis, to fit `room` characters of a subject. */
export function nameForSubject(name: string, room: number): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean.length <= room ? clean : `${clean.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
}

/** The first word of the name as typed, or "there". */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}'-]{1,40}$/u.test(first) ? first : "there";
}

/**
 * The sender identity, as on the site (Annex X1.9): the operating entity and
 * the US mailing address for correspondence, which is also the postal
 * address CAN-SPAM asks of commercial mail.
 */
function identity(): string[] {
  return [entityLine(), `${ENTITY.postalAddressLabel}: ${ENTITY.postalAddress}`];
}

/** The footer of every apps/web email that offers no opt-out: why it came, who replies, who sent it. */
export function transactionalFooter(why: string): string {
  return [
    "",
    "--",
    why,
    "Replies reach the healdesk team. Please leave out patient details.",
    ...identity(),
  ].join("\n");
}

/** The footer of every commercial email (P1, P4, P5, P7): the same, plus the one-click way to stop them. */
export function commercialFooter(why: string, unsubscribeUrl: string): string {
  return [
    "",
    "--",
    `${why} Stop these emails: ${unsubscribeUrl}`,
    "Replies reach the healdesk team. Please leave out patient details.",
    ...identity(),
  ].join("\n");
}

export function channelList(channels: string | null): string {
  const names = (channels ?? "")
    .split(",")
    .map((id) => SETUP_CHANNELS.find((c) => c.id === id.trim())?.inSentence)
    .filter((c): c is (typeof SETUP_CHANNELS)[number]["inSentence"] => Boolean(c));
  if (names.length === 0) return "not said";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** P2: the acknowledgement, to the person who asked. Echoes nothing but the address. */
export function setupRequestAck(request: SetupRequest, replyBy: string): RenderedEmail {
  return {
    subject: "We've got your request",
    text:
      `Hi,\n\n` +
      `Thanks for your request. We'll reply to ${request.email} by ${replyBy} with your next step.\n\n` +
      `If anything changes before then, reply to this email.` +
      transactionalFooter(
        `You're getting this because this address was used to ask for setup at ${site.domain}. If that wasn't you, ignore this email.`,
      ),
  };
}

/**
 * P3: the request itself, to us. Reply-to is the requester. `replyBy` is the
 * day P2 promised them, the same string, so the inbox shows the date that is
 * owed rather than "the next business day" (X1.3: an exact time).
 */
export function setupRequestInternal(
  request: SetupRequest,
  opts: { creditLive: boolean; replyBy: string },
): RenderedEmail {
  return {
    subject: `Setup request: ${nameForSubject(request.clinicName, SUBJECT_MAX - "Setup request: ".length)}`,
    text: [
      `Name:      ${request.name}`,
      `Clinic:    ${request.clinicName}`,
      `Website:   ${request.website ?? "(none)"}`,
      `Email:     ${request.email}`,
      `Channels:  ${channelList(request.channels)}`,
      `From the Day 7 email: ${request.leadId ? (opts.creditLive ? "yes, setup credit still valid" : "yes, credit expired") : "no"}`,
      "",
      `Send their setup link from ${site.url}/admin/setup. We promised them a reply by ${opts.replyBy}.`,
    ].join("\n"),
  };
}

/** P4: the setup link. */
export function setupLinkEmail(
  request: SetupRequest,
  opts: { link: string; expiresAt: Date; creditUntil: Date | null; unsubscribeUrl: string },
): RenderedEmail {
  const credit = opts.creditUntil
    ? `Your setup fee is waived if you complete your purchase by ${longDate(opts.creditUntil)}.\n\n`
    : "";
  return {
    subject: `Your setup link for ${nameForSubject(request.clinicName, SUBJECT_MAX - "Your setup link for ".length)}`,
    text:
      `Hi ${firstName(request.name)},\n\n` +
      `Here is your setup link for ${request.clinicName}:\n\n${opts.link}\n\n` +
      `It takes you through four short steps: choose your package, tell us about your clinic, sign the data agreement your practice needs, and pay the setup fee. Your monthly plan starts the day AYA first answers a patient.\n\n` +
      credit +
      `The link works until ${longDate(opts.expiresAt)}, for ${request.email}. If someone else at the clinic should complete the purchase, reply and we'll send them one.\n\n` +
      `Reply to this email with any question and a person answers.` +
      commercialFooter(`You're getting this because you asked healdesk to set up ${request.clinicName}.`, opts.unsubscribeUrl),
  };
}

/** P5: one reminder, four days before the link expires unused. */
export function setupLinkReminder(
  request: SetupRequest,
  opts: { link: string; expiresAt: Date; unsubscribeUrl: string },
): RenderedEmail {
  return {
    subject: `Your setup link works until ${longDate(opts.expiresAt)}`,
    text:
      `Hi ${firstName(request.name)},\n\n` +
      `Your setup link for ${request.clinicName} works until ${longDate(opts.expiresAt)}:\n\n${opts.link}\n\n` +
      `If the timing isn't right, nothing happens when it expires, and you can ask for a new one at ${site.url}/get-started.` +
      commercialFooter(`You're getting this because you asked healdesk to set up ${request.clinicName}.`, opts.unsubscribeUrl),
  };
}

/** P8: the contact form's acknowledgement. Echoes nothing but the address. */
export function contactAck(email: string, replyBy: string): RenderedEmail {
  return {
    subject: "We've got your message",
    text:
      `Hi,\n\n` +
      `Thanks for getting in touch. We'll reply to ${email} by ${replyBy}.` +
      transactionalFooter(
        `You're getting this because this address was used on the contact form at ${site.domain}. If that wasn't you, ignore this email.`,
      ),
  };
}

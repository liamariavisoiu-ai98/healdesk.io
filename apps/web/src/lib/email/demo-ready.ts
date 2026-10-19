import {
  demoOfferEndsAt,
  demoSetupCredit,
  demoUrl,
  displayName,
  type DemoSession,
} from "@/lib/demo/sessions";
import { site } from "@/lib/site";

import { commercialFooter, nameForSubject, SUBJECT_MAX, type RenderedEmail } from "./setup-emails";

/**
 * The demo-ready email: the link to the private demo built for a clinic from
 * its own website, sent when its audit clears it (lib/demo/build.ts).
 *
 * Commercial under CAN-SPAM, because it can carry the demo's setup offer
 * (50% off setup from an operator's demo, 30% from one asked for on the
 * homepage), so it carries what Annex X1.9 and X1.10 ask of a commercial
 * email: the one-click opt-out (the footer's link, and List-Unsubscribe from
 * the sender), why it came, that replies reach a person and should leave out
 * patient details, and the sender's identity with the US mailing address.
 * Until 19 October 2026 it ended with the postal address alone.
 */

function expiryDate(session: DemoSession): string {
  return session.expiresAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * The demo's setup offer, in a sentence, while it holds (catalog
 * `demoSetupCredit`: 50% off setup from an operator's demo, 30% from a homepage
 * one, for 48 hours from the demo being ready,
 * owner, 13 October 2026). Empty once it has ended, so an email an operator
 * releases late never promises a discount checkout would refuse.
 */
function offerLines(session: DemoSession, now: number): string[] {
  const ends = demoOfferEndsAt(session, now);
  if (!ends) return [];
  const when = ends.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
  return [
    `If you decide to go ahead, the setup fee is ${demoSetupCredit(session).percentOfSetupFee}% off when you start from the demo page before ${when}.`,
    "",
  ];
}

const SUBJECT_OPENING = "Custom demo instance ready for ";

/** Subject and body, for the sender and the tests. `unsubscribeUrl` is the lead's opt-out. */
export function demoEmail(
  session: DemoSession,
  now: number,
  opts: { unsubscribeUrl: string },
): RenderedEmail {
  const name = displayName(session);
  return {
    subject: `${SUBJECT_OPENING}${nameForSubject(name, SUBJECT_MAX - SUBJECT_OPENING.length)}`,
    text:
      [
        "Hi,",
        "",
        `As promised, here is the demo we built for ${name} from your website:`,
        "",
        demoUrl(session.slug),
        "",
        `On that page you can talk to the voice assistant from your browser, have it ring your phone, and chat with the website assistant. Both answer as ${name}, with the services, hours and FAQs from your site.`,
        "",
        "It runs in demo mode: it doesn't have your booking calendar or a confirmed price list yet, so it will tell you where it would book or quote for real. Try it the way a patient would: ask what a treatment costs, when you're open, or to book a consult.",
        "",
        `The link is private to you and stays live until ${expiryDate(session)}. Just reply to this email with any questions.`,
        "",
        ...offerLines(session, now),
        `The ${site.name} team`,
      ].join("\n") +
      commercialFooter(
        `You're getting this because a demo was built for ${name} and this address asked for its link.`,
        opts.unsubscribeUrl,
      ),
  };
}

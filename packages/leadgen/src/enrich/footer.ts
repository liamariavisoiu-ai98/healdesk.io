/**
 * The CAN-SPAM footer.
 *
 * Three things have to be in every commercial email, and none of them were
 * anywhere in this repo:
 *
 *   1. §7704(a)(5)(A)(i)  identification that the message is an advertisement
 *                         or solicitation
 *   2. §7704(a)(5)(A)(ii) notice of the opportunity to decline further email
 *   3. §7704(a)(5)(A)(iii) a valid physical postal address of the sender
 *
 * ## Why the opt-out is a reply and not a link
 *
 * §7704(a)(3)(A) accepts "a functioning return electronic mail address OR
 * other Internet-based mechanism". A reply-to address is the first of those,
 * named first in the statute, so a reply-based opt-out is not a workaround —
 * it is the mechanism the law describes before it describes anything else.
 *
 * It is also better for deliverability. An unsubscribe link in a cold email is
 * a tracked outbound URL on a domain with no sending history, which is one of
 * the strongest spam signals a young domain can carry. A reply is the opposite
 * signal: engagement.
 *
 * The obligation the reply route creates is operational rather than technical.
 * Somebody has to read the replies and act within 10 business days, and the
 * suppression has to hold across all ten sending domains, not just the campaign
 * the reply landed in. See docs/outreach/opt-out.md.
 *
 * ## Why the identification does not say "ADVERTISEMENT"
 *
 * The statute requires the identification to be "clear and conspicuous". It has
 * never required particular words, and the FTC's own compliance guidance says
 * so: there is no prescribed label. What it cannot be is hidden, ambiguous, or
 * so soft that a reader would not understand the message is a solicitation.
 *
 * So this says "a sales note" in plain text at normal size. That is an
 * unambiguous identification a human actually reads, and it is not a banner.
 *
 * "Cold" was in an earlier draft and came out: it describes how the address was
 * obtained, not what the message is, so it was doing no statutory work and only
 * made the line longer. Softening past "sales" is a different matter. "Just
 * reaching out" or "a quick note" would drop below clear and conspicuous, and at
 * that point the footer stops doing the one job it exists for.
 */

/**
 * Shared with scalabid. A registered-agent address is a valid physical postal
 * address under the statute: what is required is that mail sent there reaches
 * the sender, not that the sender sits in the room.
 */
export const POSTAL_ADDRESS = "800 N King St, Suite 304-1426, Wilmington, DE 19801";

/** The word a recipient is told to send back. Kept short, and kept the same. */
export const OPT_OUT_PHRASE = "no thanks";

export type FooterInput = {
  /** "Sarah Whitfield" — from docs/outreach/sender-identities.csv. */
  senderName: string;
  /**
   * Which email in the sequence this is.
   *
   * The identification is required on every commercial message, so it cannot
   * drop off after the first. But repeating "A sales note" verbatim on the
   * fourth email reads as a script that has forgotten it wrote the first three.
   * "Still a sales note" acknowledges the sequence the recipient can already
   * see, which is the only honest thing to do at that point.
   */
  touch: number;
};

export function buildFooter({ senderName, touch }: FooterInput): string {
  const identification =
    touch <= 1
      ? "A sales note"
      : "Still a sales note";

  return [
    `${senderName}, healdesk`,
    POSTAL_ADDRESS,
    "",
    `${identification}, so reply "${OPT_OUT_PHRASE}" if you would rather not get another.`,
  ].join("\n");
}

/**
 * Who an email from healdesk says it is from, and where a reply goes.
 *
 * apps/web words the operating entity and the US mailing address once, in
 * `ENTITY` and `entityLine()` in apps/web/src/lib/legal.ts, and apps/app cannot
 * import from apps/web. Every email apps/app sends carries the same two lines
 * in its footer (Annex X1.9 of docs/design/funnel-onboarding-portal-2026-10-06.md),
 * and CAN-SPAM wants the postal address on any commercial one, so they are
 * mirrored here rather than typed a second time into the email templates.
 * apps/web/src/lib/sender-identity.test.ts compares this mirror with legal.ts,
 * so a change to one that forgets the other fails a test instead of putting two
 * different addresses in front of a clinic.
 *
 * The registered street address is deliberately absent: the footer prints the
 * mailbox, not the licence address (owner's decision, 3 October 2026).
 */
export const SENDER_IDENTITY = {
  /**
   * The entity line, exactly as `entityLine()` words it. The site footer
   * stopped printing it on 9 October 2026; the email footers still do.
   */
  entityLine:
    "healdesk is a service of Viixi FZC, a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates.",
  /** The US correspondence mailbox (`ENTITY.postalAddress`): CAN-SPAM's physical address. */
  postalAddress: "800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States",
  /** How the mailbox is labelled wherever it is printed (`ENTITY.postalAddressLabel`). */
  postalAddressLabel: "US mailing address (correspondence only)",
  /**
   * Where every reply goes (`ENTITY.email`). hello@ is the only address healdesk
   * has, for product and marketing mail, notices and support alike (owner, 9
   * October 2026), with no BAA mailbox behind it, which is why every footer asks
   * the reader to leave patient details out. The From address is the
   * HEALDESK_EMAIL_FROM environment variable, not this.
   */
  replyTo: "hello@healdesk.io",
} as const;

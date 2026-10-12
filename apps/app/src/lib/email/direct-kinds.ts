import type { NoticeClass, NoticeOwner } from "./kinds";

/**
 * The kinds sent straight, not through the outbox, and so not in kinds.ts.
 *
 * Annex X3: "Kinds without a clinic (P6, B2, B3, O6, I1, I2) keep their state
 * on their own row (acceptance, link, intent, ops log) and use that row's id as
 * the key." They carry no `clinic` tag, so when Resend reports one bounced, the
 * webhook relay has no clinic to open and only logs it, except for the kinds
 * marked `locksOut`: a sign-in that cannot arrive locks a clinic out of its
 * account, so a bounce, complaint or suppression on one of those calls
 * notifyOps as well.
 *
 * Only the kinds the platform itself has to know about are listed: the one it
 * builds (I1) and the three the relay must recognise. P6 and I2 join with the
 * milestones that build them. A link email (X1.5) mints its single-use token at
 * send time and never stores it, which is also why none of these can be an
 * outbox row: the outbox stores its payloads.
 *
 * One of them has a clinic: the welcome email (B1) goes to a clinic's address
 * with a fresh "Continue setup" link, so it cannot be an outbox row either.
 * It keeps its once-per-clinic state on the ledger, report_deliveries, whose
 * kinds CHECK takes it from `LEDGER_DIRECT_KINDS`, and carries the `clinic`
 * and `delivery` tags like an outbox send, so the webhook relay can mark its
 * row.
 *
 * Pure data, like kinds.ts.
 */
export type DirectKindAttributes = {
  /** The catalogue id in Annex X5. */
  annex: string;
  class: NoticeClass;
  owner: NoticeOwner;
  /** Carries a single-use link minted at send time: the only email a token may appear in. */
  linkEmail: boolean;
  /** A sign-in that cannot arrive locks the clinic out, so its bounce calls notifyOps. */
  locksOut: boolean;
  /** Sent to a clinic's address and recorded on the ledger (report_deliveries), keyed per clinic. */
  ledger: boolean;
};

function direct(
  annex: string,
  cls: NoticeClass,
  owner: NoticeOwner,
  flags: { linkEmail: boolean; locksOut: boolean; ledger?: boolean },
): DirectKindAttributes {
  return { annex, class: cls, owner, ledger: false, ...flags };
}

export const DIRECT_KIND_REGISTRY = {
  /** I1: notifyOps, to HEALDESK_OPS_EMAIL. Built with the platform. */
  ops_alert: direct("I1", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /** B2: the sign-in link, from /sign-in and "Send again". */
  sign_in_link: direct("B2", "transactional", "plan", { linkEmail: true, locksOut: true }),
  /** O6: the sign-in link sent from /sign-in/help. */
  sign_in_help_link: direct("O6", "transactional", "plan", { linkEmail: true, locksOut: true }),
  /**
   * O3: a device was added to the sign-in, removed from it, or code entry
   * locked. About the sign-in, not a clinic: factors belong to the user, and
   * one sign-in can open several locations.
   */
  device_changed: direct("O3", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /** B3: "Your order is confirmed: one step on our side", when provisioning failed. */
  order_confirmed_delayed: direct("B3", "transactional", "plan", {
    linkEmail: false,
    locksOut: true,
  }),
  /**
   * B1: the welcome email, once per clinic, at provisioning: the order, the
   * terms, each channel's status in words, and a 72-hour "Continue setup"
   * link. A sign-in that cannot arrive locks the clinic out of setup.
   */
  welcome: direct("B1", "transactional", "plan", {
    linkEmail: true,
    locksOut: true,
    ledger: true,
  }),
  /**
   * The calendar backend's link (plan §4.1): connect a location's Google
   * Calendar, change the Google account it uses (the owner's), or confirm an
   * election that widens what reaches Google (the owner's). Mailed only to
   * the practice's own address, with a token minted at send time.
   */
  calendar_link: direct("CAL1", "transactional", "plan", { linkEmail: true, locksOut: false }),
  /** The practice's copy of a calendar election it recorded (plan §2.6). No link. */
  calendar_election_recorded: direct("CAL2", "transactional", "plan", {
    linkEmail: false,
    locksOut: false,
  }),
} as const;

export type DirectKind = keyof typeof DIRECT_KIND_REGISTRY;

export const DIRECT_KINDS = Object.keys(DIRECT_KIND_REGISTRY) as readonly DirectKind[];

/**
 * The direct kinds the ledger records (the `ledger` flag), as a literal list
 * because db/schema.ts builds report_deliveries' kinds CHECK from it.
 * tests/email-templates.test.ts holds it to the flag.
 */
export const LEDGER_DIRECT_KINDS = ["welcome"] as const;

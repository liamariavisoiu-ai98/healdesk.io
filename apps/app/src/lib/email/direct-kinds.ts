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
 * Every direct kind apps/app sends is listed, built or not: I1, the three the
 * relay must recognise, and (since 14 October 2026) I2 and I4, so the
 * packages that build them find their names here. P6 is apps/web's at
 * signature; apps/app sends it again on an operator's resend, as
 * `agreement_copy` (since 19 October 2026, when the resend stopped calling a
 * transport directly). A link
 * email (X1.5) mints its single-use token at send time and never stores it,
 * which is also why none of these can be an outbox row: the outbox stores its
 * payloads.
 *
 * Some of them have a clinic. The welcome email (B1) goes to a clinic's
 * address with a fresh "Continue setup" link, so it cannot be an outbox row
 * either. It keeps its once-per-clinic state on the ledger,
 * report_deliveries, whose kinds CHECK takes it from `LEDGER_DIRECT_KINDS`,
 * and carries the `clinic` and `delivery` tags like an outbox send, so the
 * webhook relay can mark its row. O11 goes to someone the clinic names, with
 * the steps it asked us to send on, and keeps its sends on the same ledger.
 * So do O5 (a link email, and to an address that is not yet the clinic's),
 * L22 (a link email) and E6 (to the address captured before destruction).
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
  /** Recorded on the ledger (report_deliveries), keyed per clinic. */
  ledger: boolean;
  /**
   * Sent to someone the clinic names, never to the clinic's own address (O11):
   * it carries a stop link for that address, and a bounce from it says
   * nothing about whether the clinic's address can be reached.
   */
  toSomeoneNamed: boolean;
};

function direct(
  annex: string,
  cls: NoticeClass,
  owner: NoticeOwner,
  flags: { linkEmail: boolean; locksOut: boolean; ledger?: boolean; toSomeoneNamed?: boolean },
): DirectKindAttributes {
  return { annex, class: cls, owner, ledger: false, toSomeoneNamed: false, ...flags };
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
   * O11: a channel's step, sent on by the clinic to the person it names
   * (lib/notices/steps-sent.ts). Not to the clinic's address, so not an
   * outbox row; the ledger holds each send, the three-a-day limit and the
   * addresses that asked for no more.
   */
  steps_sent: direct("O11", "transactional", "plan", {
    linkEmail: false,
    locksOut: false,
    ledger: true,
    toSomeoneNamed: true,
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

  // The rest of Annex X5's direct kinds, registered with the outbox's
  // (14 October 2026) so the ledger's CHECK widens once. Each has a clinic
  // but cannot be an outbox row: a link email may never store its token, and
  // the outbox sends only to the clinic's address as it stands at send time.
  /**
   * O5, from Settings: the single-use link that confirms a new sign-in
   * address, sent to the NEW address (X1.5 names O5's confirmation a link
   * email).
   */
  address_change_confirm: direct("O5", "transactional", "plan", {
    linkEmail: true,
    locksOut: false,
    ledger: true,
  }),
  /**
   * O5's notice: "Your sign-in address is changing", with "Stop this
   * change", to the old address from Settings, or to both from ops'
   * changeClinicEmail, naming the end of the 72-hour objection window.
   */
  address_changing: direct("O5", "transactional", "plan", {
    linkEmail: false,
    locksOut: false,
    ledger: true,
  }),
  /**
   * L22: "Sign your updated agreement", with a signed single-use link, and
   * its reminders at 3 and 7 days, each a fresh link under its own period key.
   */
  agreement_to_sign: direct("L22", "transactional", "plan", {
    linkEmail: true,
    locksOut: false,
    ledger: true,
  }),
  /**
   * E6: "Your data has been destroyed", to the address captured before
   * destruction, which by then may no longer be the clinic's sign-in.
   */
  data_destroyed: direct("E6", "transactional", "plan", {
    linkEmail: false,
    locksOut: false,
    ledger: true,
  }),
  /** I2: the 07:00 ops digest, to HEALDESK_OPS_EMAIL. Ids and counts only. */
  ops_digest: direct("I2", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /** I4: each flagged answer, and two flags in seven days, to ops. Ids and counts only. */
  flag_alert: direct("I4", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /**
   * I3's support escalation: the portal's support chat asking for a person,
   * to hello@ with the clinic's address as reply-to (lib/support/escalate.ts).
   * The topic, fields from fixed lists and the account's state; never the
   * chat's words. It carries no `clinic` tag: it goes to our own inbox, so a
   * bounce from it says nothing about the clinic's address.
   */
  support_escalation: direct("I3", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /**
   * P6, the signer's copy of the agreement, with the PDF attached: sent again
   * on an operator's resend from the console, and at signature for apps/app's
   * own demo clinic (lib/email/agreement-copy.ts). Before payment there is no
   * clinic, so it carries no `clinic` tag; its `delivery` tag is the
   * acceptance's id, the row whose copy_sent_at records it.
   */
  agreement_copy: direct("P6", "transactional", "plan", { linkEmail: false, locksOut: false }),
  /**
   * I3's access request: a /sign-in/help request that sent no link, to hello@
   * with structured fields only (plan Part D5; lib/sign-in/help.ts), and the
   * account's address as reply-to when the address typed is one. No `clinic`
   * tag: it goes to our own inbox, as the support escalation does.
   */
  access_request: direct("I3", "transactional", "plan", { linkEmail: false, locksOut: false }),
} as const;

export type DirectKind = keyof typeof DIRECT_KIND_REGISTRY;

export const DIRECT_KINDS = Object.keys(DIRECT_KIND_REGISTRY) as readonly DirectKind[];

/**
 * The direct kinds the ledger records (the `ledger` flag), as a literal list
 * because db/schema.ts builds report_deliveries' kinds CHECK from it.
 * tests/email-templates.test.ts holds it to the flag.
 */
export const LEDGER_DIRECT_KINDS = [
  "welcome",
  "steps_sent",
  "address_change_confirm",
  "address_changing",
  "agreement_to_sign",
  "data_destroyed",
] as const;

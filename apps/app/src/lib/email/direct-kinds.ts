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
};

function direct(
  annex: string,
  cls: NoticeClass,
  owner: NoticeOwner,
  flags: { linkEmail: boolean; locksOut: boolean },
): DirectKindAttributes {
  return { annex, class: cls, owner, ...flags };
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
} as const;

export type DirectKind = keyof typeof DIRECT_KIND_REGISTRY;

export const DIRECT_KINDS = Object.keys(DIRECT_KIND_REGISTRY) as readonly DirectKind[];

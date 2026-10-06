import type { EmailKind } from "../kind-rules";
import type { NoticeKind, NoticeOwner } from "../kinds";

import { OPS_ALERT_FIXTURE, renderOpsAlert } from "./ops_alert";
import { ORDER_CONFIRMED_DELAYED_ENTRY } from "./order_confirmed_delayed";
import { SIGN_IN_LINK_ENTRY } from "./sign_in_link";
import type { EmailTemplate } from "./types";

/**
 * Which kinds have a template, and who owes the rest.
 *
 * The sender looks a kind up here. A kind with no entry is HELD: its notices
 * stay pending, untouched, until a template ships, and the minute job counts
 * them, rather than burning retries on an email it cannot render. Package C
 * and later milestones add entries as they build their templates; each entry
 * carries the fixture its snapshot test and `npm run email:seed` render.
 *
 * The test in tests/email-templates.test.ts holds the two lists to the
 * registries: every kind has a template or a line in PENDING_TEMPLATES naming
 * its owner, never both, never neither.
 */

export type TemplateEntry<P = Readonly<Record<string, unknown>>> = {
  render: EmailTemplate<P>;
  /** A realistic payload: ids, counts and dates only, as the allowlist requires. */
  fixture: P;
};

// `any` is the registry's own business: each entry pairs a render with a fixture
// of the same payload type, and the lookup below hands both back together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = TemplateEntry<any>;

export const TEMPLATES: Partial<Record<EmailKind, AnyEntry>> = {
  ops_alert: { render: renderOpsAlert, fixture: OPS_ALERT_FIXTURE },
  sign_in_link: SIGN_IN_LINK_ENTRY,
  order_confirmed_delayed: ORDER_CONFIRMED_DELAYED_ENTRY,
};

export type PendingTemplate = {
  owner: NoticeOwner;
  /** Where Annex X5 ships it. */
  ships: string;
};

/** Every kind still waiting for its template, with the session that owes it. */
export const PENDING_TEMPLATES: Record<
  Exclude<EmailKind, "ops_alert" | "sign_in_link" | "order_confirmed_delayed">,
  PendingTemplate
> = {
  payment_failed: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  payment_action_required: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  grace_ending: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  suspended: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  restored: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  cancel_scheduled: { owner: "package_c", ships: "Package C, Gate A (E1)" },
  cancel_reversed: { owner: "package_c", ships: "Package C, Gate A (E1)" },
  canceled: { owner: "package_c", ships: "Package C, Gate A (E2)" },
  renewal_upcoming: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  usage_80: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  usage_100: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  overage_invoiced: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  plan_changed: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  location_added: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  connect_disconnected: { owner: "package_d", ships: "Package D (O14)" },
  plan_started: { owner: "package_c", ships: "Package C, M6 hook (L2)" },
  price_stepped_up: { owner: "package_c", ships: "Package C, M6 hook (L3)" },
  step_up_reminder: { owner: "package_c", ships: "Package C, M6 hook (L4)" },
  allowance_fallback: { owner: "package_c", ships: "Package B/C, Gate B (L19)" },
  receipt: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  refund_issued: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  card_expiring: { owner: "package_c", ships: "Package C, Gate A (L27)" },
  connect_connected: { owner: "package_d", ships: "Package D (O14)" },
  sign_in_help_link: { owner: "plan", ships: "M2, sign-in (O6)" },
};

/** The template for a kind, or undefined while it is pending. */
export function templateFor(kind: string): AnyEntry | undefined {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? TEMPLATES[kind as EmailKind]
    : undefined;
}

/** The outbox kinds the sender can render now: the ones it asks the database for. */
export function templatedNoticeKinds(
  kinds: readonly NoticeKind[],
  lookup: (kind: string) => AnyEntry | undefined = templateFor,
): NoticeKind[] {
  return kinds.filter((kind) => lookup(kind) !== undefined);
}

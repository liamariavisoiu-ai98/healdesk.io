import { SUPPORT_SIGN_OFF } from "@healdesk/catalog";

/**
 * Who a support case can be given to (design E5 §2.5, "Reassign"): the
 * comma-separated names in `HEALDESK_OPS_PEOPLE`, a setting on this host,
 * read at call time. v1 has one shared operator sign-in (owner decision
 * D21), so a name is a label on the case, not an identity: it says who is
 * handling it, never who is signed in. Unset or empty, the one label is
 * "The Healdesk Team", the name replies are signed with.
 *
 * A label holds letters, spaces, full stops, apostrophes and hyphens, up to
 * 60 characters (support_cases_assignee_check): a name, never an address or
 * a number. One that does not fit is left out, not refused, so a typo in the
 * setting costs one name rather than the list.
 */

export const OPS_PEOPLE_DEFAULT: readonly string[] = [SUPPORT_SIGN_OFF];

const LABEL = /^[A-Za-z][A-Za-z .'-]{0,59}$/;

export function isPersonLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL.test(value) && value.trim() === value;
}

export function opsPeople(raw: string | undefined = process.env.HEALDESK_OPS_PEOPLE): readonly string[] {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim().replace(/\s+/g, " "))
    .filter(isPersonLabel);
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : OPS_PEOPLE_DEFAULT;
}

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { publicUrl } from "@/lib/public-url";

import type { NoticeSwitch } from "./kinds";
import { UNSUBSCRIBE_PATH_PREFIX } from "./lint";

/**
 * The one-click way to stop an optional or commercial email (Annex X1.9 and
 * X1.10): the link in its footer, and the List-Unsubscribe and
 * List-Unsubscribe-Post headers Gmail and Yahoo require of a sender (RFC 8058).
 *
 * The link names a clinic and a switch, and is signed, so it can stop that one
 * optional email for that one clinic and nothing else: it signs no one in and
 * opens nothing. A clinic id alone would not do, because clinic ids travel in
 * Resend's tags and logs, and anyone holding one could switch a clinic's
 * alerts off.
 *
 * The page behind it is /email/stop/<token> (src/app/email/stop): a GET
 * shows a confirmation page whose button posts, so a link scanner cannot
 * unsubscribe anyone, and a POST carrying "List-Unsubscribe=One-Click" turns
 * the switch off at once (lib/email/stop.ts). The switches are the ones
 * Settings and Billing show: the daily summary and usage alerts; and O11's
 * link stops a clinic's sent-on steps reaching the address it went to.
 * Product updates (M7) and commercial mail have no switch on a clinic yet, so
 * a link for them changes nothing, and tests/email-templates.test.ts fails the
 * day an optional or commercial kind gets a template without that route.
 */

/**
 * What a stop link turns off: an optional email's switch, commercial mail, or
 * (`steps`) any more of a clinic's sent-on steps to the address one of them
 * went to (O11), which is named by that email's ledger row, never by the
 * address itself.
 */
export type StopScope = NoticeSwitch | "commercial" | "steps";

const SCOPES: readonly StopScope[] = [
  "usage_alerts",
  "daily_summary",
  "product_updates",
  "commercial",
  "steps",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(): Buffer {
  // A key of its own, derived from the auth secret, so a stop link's MAC can
  // never be replayed as anything Better Auth signs, and the reverse.
  return createHmac("sha256", env.betterAuthSecret())
    .update("healdesk email stop link v1")
    .digest();
}

function mac(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

/**
 * `<base64url(clinicId:scope[:deliveryId])>.<mac>`: opaque, and checkable
 * without a database. Only `steps` names a delivery.
 */
export function unsubscribeToken(clinicId: string, scope: Exclude<StopScope, "steps">): string {
  return sign(`${clinicId}:${scope}`);
}

/** O11's stop link: no more of this clinic's sent-on steps to the address this delivery went to. */
export function stepsStopToken(clinicId: string, deliveryId: string): string {
  return sign(`${clinicId}:steps:${deliveryId}`);
}

function sign(text: string): string {
  const payload = Buffer.from(text, "utf8").toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export type StopTarget = { clinicId: string; scope: StopScope; deliveryId?: string };

/** The clinic and switch a stop link names, or null when it is not one of ours. */
export function readUnsubscribeToken(token: string): StopTarget | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split(":");
  const [clinicId, scope, deliveryId] = parts;
  if (!clinicId || !scope || !(SCOPES as readonly string[]).includes(scope)) return null;
  if (scope === "steps") {
    if (parts.length !== 3 || !deliveryId || !UUID.test(deliveryId)) return null;
    return { clinicId, scope, deliveryId };
  }
  if (parts.length !== 2) return null;
  return { clinicId, scope: scope as StopScope };
}

export function unsubscribeUrl(clinicId: string, scope: Exclude<StopScope, "steps">): string {
  return publicUrl(`${UNSUBSCRIBE_PATH_PREFIX}${unsubscribeToken(clinicId, scope)}`);
}

export function stepsStopUrl(clinicId: string, deliveryId: string): string {
  return publicUrl(`${UNSUBSCRIBE_PATH_PREFIX}${stepsStopToken(clinicId, deliveryId)}`);
}

/** RFC 8058's pair. The URL is the same one the footer prints. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

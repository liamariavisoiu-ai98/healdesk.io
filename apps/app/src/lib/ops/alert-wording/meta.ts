import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "meta" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // `phase` retries or destruction; the connection and provider name the row.
  meta_revoke_failed: legacy(
    "Meta would not take healdesk off a leaving practice",
    "Meta keeps refusing to take healdesk's app off the Facebook Page or WhatsApp Business account of the clinic below, which has left. For phase retries the token is kept and the hourly run tries again. For phase destruction the last try failed and the clinic's data, its token included, is destroyed now, as its agreement requires. Either way, ask the practice to remove healdesk from the Page's or the WhatsApp account's connected apps in Meta Business Suite, or remove the subscription from the app's dashboard, so no message reaches healdesk again.",
  ),
  // `code` says why; the connection and provider name the row.
  meta_revoke_by_hand: legacy(
    "End a leaving practice's Meta subscription by hand",
    "The clinic below has left, and healdesk erased its Meta token, but could not take its app off the Page or WhatsApp Business account itself. For code no_asset_on_record, healdesk holds no Page or account id for the connection (an operator pasted its token); for code no_token, the token could not be read. For either, ask the practice to remove healdesk from the Page's or the WhatsApp account's connected apps in Meta Business Suite, or end the subscription where it was set up in the app's dashboard. For code asset_unverified, another clinic in service has a connection of the same kind that healdesk holds no Page or account id for, so the Page or account was left subscribed in case it is that clinic's too: check in Meta Business Suite which numbers or Instagram accounts are on it, leave it if the other clinic's is, and otherwise have the leaving practice remove healdesk from it.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "meta_revoke_failed",
  "meta_revoke_by_hand",
]);

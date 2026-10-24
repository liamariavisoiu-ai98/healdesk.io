import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "meta" section of docs/on-call.md's alert runbook. The console cannot
 * end a Meta subscription or mark one ended by hand: the Setup tab's "Meta
 * front door" card lists each connection with its status, and the Touch log
 * holds the operator's record (apps/web OnboardingPanel.tsx, TouchLog.tsx).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // `phase` retries (lib/meta/revoke.ts, after META_REVOKE_ALERT_AFTER
  // refusals, the access kept) or destruction (lib/offboarding, the last try
  // before the data went, `count` connections); neither word is printable.
  meta_revoke_failed: {
    title: "Meta would not take healdesk off a leaving practice",
    whatHappened:
      "{clinicName} has left, and Meta keeps refusing to take healdesk's app off its Facebook Page or WhatsApp Business account[ for {count:connection}]. Either the hourly run has been refused six times and keeps trying with the clinic's access kept, or this was the last try before its data, that access included, was destroyed on the agreement's day.",
    whyItMatters:
      "While the Page or account stays subscribed to our app, a message a patient sends there can still reach healdesk after the service has ended. Meta signs no agreement with us, so the clean end is the practice removing our app itself.",
    steps: [
      "Open the clinic's Setup tab and read Meta front door: each connected Page or account is listed with its status.",
      "Phone the clinic on its published number, shown under Phone line on the same tab, and ask it to remove healdesk from the Page's or WhatsApp account's connected apps in Meta Business Suite. That ends the subscription whatever Meta answered us.",
      "Ask whoever holds our Meta app's dashboard to remove the Page's or account's subscription there if the practice cannot. Do not attach the channel again or enter any access for a leaving clinic on the Setup tab.",
      "Press Record in the Touch log on the clinic's Care tab to note who removed it and when. You are done when the practice confirms healdesk is off its Page or account.",
    ],
  },
  // `code` says why (no_asset_on_record, no_token, asset_unverified); not
  // printable, and the steps cover each.
  meta_revoke_by_hand: {
    title: "End a leaving practice's Meta subscription by hand",
    whatHappened:
      "{clinicName} has left, and healdesk erased the access it held for its Facebook Page, Instagram or WhatsApp account, but could not take its own app off that Page or account. Either we hold no Page or account id for the connection, the access could not be read, or another clinic in service may share the same Page or account, so it was left subscribed.",
    whyItMatters:
      "Until the app is off, messages sent to that Page or account can still reach healdesk after the service ended. Taking it off a Page another clinic still uses would cut that clinic's channel, so the shared case needs a check first.",
    steps: [
      "Open the clinic's Setup tab and read Meta front door: the connection's platform, id and status are listed there.",
      "Check in Meta Business Suite which numbers or Instagram accounts are on the Page or account if another clinic may share it, and leave it subscribed if the other clinic's is there. Compare with that other clinic's Meta front door on its Setup tab.",
      "Phone the leaving clinic on its published number, shown under Phone line on its Setup tab, and ask it to remove healdesk from the Page's or account's connected apps in Meta Business Suite, or to end the subscription where it was set up.",
      "Press Record in the Touch log on the clinic's Care tab to note the outcome. You are done when the practice confirms healdesk is off, or you have confirmed the Page serves another clinic in service.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

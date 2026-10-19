import type { Channel } from "@healdesk/catalog";

import {
  SCREEN_DEFINITIONS,
  resumeScreen,
  stepsLeft,
  wizardFinished,
  wizardScreens,
} from "@/lib/setup/screens";
import type { CalendarConnectionView } from "@/lib/connections/google-calendar";
import type { SetupState } from "@/lib/setup/state";
import { PRACTICE_SECTION_WORDS } from "@/lib/engine/practice/sections";
import { practiceDoubleChecking, type PracticeState } from "@/lib/engine/practice/state";
import { joinWords } from "@/lib/setup/tracker";

import { isBuiltSection, sectionPath, type PortalSection } from "./nav";

/**
 * Home's "Needs attention" list (plan Part F1): each thing the clinic has to
 * do, in one line, with the one tap that does it. Nothing here is about a
 * patient; every item is the practice's own setup, sign-in or billing.
 *
 * Before go-live the plan names four: setup unfinished, the insurance
 * question, the backup factor and the website changes the drift check finds
 * (M7, whose list does not exist yet, so its count is always 0 here). Three
 * more come from facts already on hand and cost the clinic dearly if missed:
 * an address that bounces (Annex X3: "We can't email {address}", the one
 * address every email goes to), a payment that failed, and a sign-in with no
 * device that can open patient details. After go-live, a calendar that
 * stopped working: bookings quietly become requests the desk must confirm,
 * which is worth a line once patients are booking, and not before, when the
 * calendar step of setup says it already. And a channel that has gone quiet
 * (the spec's "a channel that has gone quiet"): live, answering, and nothing
 * has reached AYA there for a week (lib/reporting/claims.ts,
 * QUIET_CHANNEL_DAYS), with the one thing to check for that channel. Only the
 * clinic's own line: the internal health flags stay with ops (WP5).
 *
 * After go-live, a change the practice questions did not pass (lib/engine/
 * practice: failed on the clinic's own data, or in review with our team)
 * shows "We're double-checking your change to Prices" (plan Part F1, F3),
 * linking to the section, while AYA keeps answering as she was. Before
 * go-live the build tracker says the same thing in its own stage.
 *
 * Pure: the page reads the facts, this decides what to say.
 */

export type AttentionId =
  | "address_undeliverable"
  | "payment_failed"
  | "setup_unfinished"
  | "setup_skipped"
  | "insurance"
  | "passkey"
  | "backup"
  | "payment_account"
  | "website_changes"
  | "calendar_disconnected"
  | "quiet_channel"
  | "double_checking";

export type AttentionItem = {
  /** Unique within the list: a quiet channel's carries its channel, `quiet_channel:voice`. */
  key?: string;
  id: AttentionId;
  text: string;
  action: { label: string; href: string };
};

export type AttentionFacts = {
  slug: string;
  state: Pick<
    SetupState,
    "screens" | "progress" | "clinic" | "hasPasskey" | "hasBackup" | "billing" | "address"
  >;
  /** The latest report on the clinic's address says it bounced, complained or was suppressed. */
  addressUndeliverable: boolean;
  /** The clinic's Stripe account was disconnected and nothing is connected now. */
  paymentAccountDisconnected?: boolean;
  /** The clinic's Google Calendar connection as the calendar session reads it. */
  calendar?: CalendarConnectionView;
  /** Website changes the drift check found and nobody has confirmed or ignored (M7). */
  websiteChanges?: number;
  /** Where the practice questions stand (lib/engine/practice). */
  practice?: PracticeState;
  /** Whether any channel has gone live: before then, the tracker shows the practice questions. */
  live?: boolean;
  /** Live channels nothing has reached for a week (readQuietChannels). */
  quietChannels?: readonly Channel[];
};

export function needsAttention(facts: AttentionFacts): AttentionItem[] {
  const { slug, state } = facts;
  const home = `/c/${slug}`;
  const items: AttentionItem[] = [];

  if (facts.addressUndeliverable && state.address) {
    items.push({
      id: "address_undeliverable",
      text: `We can't email ${state.address}, the address every healdesk email goes to.`,
      action: screenLink(slug, "settings", "#sign-in", "Check it in Settings"),
    });
  }

  if (
    state.billing &&
    (state.billing.status === "past_due" || state.billing.status === "suspended")
  ) {
    items.push({
      id: "payment_failed",
      text: "A payment didn't go through.",
      action: screenLink(slug, "billing", "", "Open Billing"),
    });
  }

  const finished = wizardFinished(state.screens, state.progress);
  if (!finished) {
    const left = stepsLeft(state.screens, state.progress);
    const resume = resumeScreen(wizardScreens(state.screens), state.progress);
    items.push({
      id: "setup_unfinished",
      text:
        left === 1
          ? "Setup isn't finished: one step left."
          : `Setup isn't finished: ${left} steps left.`,
      action: {
        label: "Continue setup",
        href: resume ? `${home}/setup?s=${resume}` : `${home}/setup`,
      },
    });
  } else {
    // The insurance question has its own line below; the backup is not one
    // of the four steps.
    const skipped = wizardScreens(state.screens).filter(
      (id) => id !== "insurance" && state.progress.get(id)?.outcome === "skipped",
    );
    if (skipped.length > 0) {
      items.push({
        id: "setup_skipped",
        text: `You skipped ${joinWords(skipped.map((id) => SCREEN_DEFINITIONS[id].title.toLowerCase()))} in setup.`,
        action: {
          label: skipped.length === 1 ? "Finish it" : "Finish them",
          href: `${home}/setup?s=${skipped[0]}`,
        },
      });
    }
  }

  if (
    state.screens.includes("insurance") &&
    state.clinic.isCoveredEntity === null &&
    state.progress.get("insurance")?.outcome === "skipped"
  ) {
    items.push({
      id: "insurance",
      text: "Tell us whether your practice bills any health insurance electronically.",
      action: { label: "Answer it", href: `${home}/setup?s=insurance` },
    });
  }

  if (!state.hasPasskey) {
    items.push({
      id: "passkey",
      text: "No device can open patient details yet. Conversations and Bookings need one.",
      action: {
        label: "Add this device",
        href: `${home}/protect?next=${encodeURIComponent(home)}`,
      },
    });
  } else if (finished && !state.hasBackup) {
    items.push({
      id: "backup",
      text: "No backup way in yet, in case the device with your Face ID is lost.",
      action: { label: "Add an authenticator app", href: `${home}/setup?s=backup` },
    });
  }

  if (facts.paymentAccountDisconnected) {
    items.push({
      id: "payment_account",
      text: "Your payment account is disconnected, so AYA can't send deposit links.",
      action: screenLink(slug, "settings", "#payments", "Reconnect it in Settings"),
    });
  }

  if (facts.live && facts.calendar && calendarStoppedWorking(facts.calendar)) {
    items.push({
      id: "calendar_disconnected",
      text: "Your calendar stopped working, so bookings arrive as requests your team confirms.",
      action: screenLink(slug, "settings", "#calendar", "Reconnect it in Settings"),
    });
  }

  if (facts.live) {
    for (const channel of facts.quietChannels ?? []) {
      items.push({
        key: `quiet_channel:${channel}`,
        id: "quiet_channel",
        text: QUIET_CHANNEL_WORDS[channel],
        action: screenLink(slug, "settings", "#channels", "Check it in Settings"),
      });
    }
  }

  const changes = facts.websiteChanges ?? 0;
  if (changes > 0) {
    items.push({
      id: "website_changes",
      text:
        changes === 1
          ? "We found a change on your website."
          : `We found ${changes} changes on your website.`,
      action: screenLink(slug, "knowledge", "#website", "Review them"),
    });
  }

  if (facts.live && facts.practice && practiceDoubleChecking(facts.practice)) {
    const latest = facts.practice.latest!;
    const section = latest.failedSection ?? latest.triggerSection;
    const words = section ? PRACTICE_SECTION_WORDS[section] : null;
    const [screen, hash] = words ? (words.path.split("#") as [string, string]) : ["knowledge", ""];
    items.push({
      id: "double_checking",
      text: words ? `We're double-checking your change to ${words.name}.` : "We're double-checking your latest change.",
      action: screenLink(slug, screen === "settings" ? "settings" : "knowledge", hash ? `#${hash}` : "", words ? `Open ${words.name}` : "Open Knowledge"),
    });
  }

  return items;
}

/**
 * What a quiet channel's line says: what has not happened for a week, and
 * the one thing that most often stops it, which the clinic checks itself.
 */
const QUIET_CHANNEL_WORDS: Record<Channel, string> = {
  voice:
    "No calls have reached AYA for a week. Check that call forwarding is still set on your line.",
  web: "No one has used your website chat for a week. Check that the chat is still on your website.",
  meta: "No messages have reached AYA on Instagram, Messenger or WhatsApp for a week. Check that they're still connected.",
};

/**
 * Whether the calendar a clinic connected has stopped working: the
 * connection is broken (`error`, or a break on record), or Google told us its
 * access was removed. Never for a calendar that was never connected or that
 * the clinic disconnected itself: those are choices, and Settings shows them.
 * A connection Google merely could not reach this time (`degraded`) is not a
 * stop: the calendar watch probes again, and marks it broken if it stays so.
 */
export function calendarStoppedWorking(view: CalendarConnectionView): boolean {
  if (view.status === "not_connected") return view.accessRemovedAt !== null;
  return view.status === "error" || view.brokenAt !== null;
}

/**
 * The tap into another screen, or, in a build without that screen, Help: an
 * item never links to a page that does not exist (lib/portal/nav.ts).
 */
function screenLink(
  slug: string,
  section: PortalSection,
  hash: string,
  label: string,
): { label: string; href: string } {
  return isBuiltSection(section)
    ? { label, href: `${sectionPath(slug, section)}${hash}` }
    : { label: "Ask us", href: "#help" };
}

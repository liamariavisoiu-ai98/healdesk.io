import {
  SCREEN_DEFINITIONS,
  resumeScreen,
  stepsLeft,
  wizardFinished,
  wizardScreens,
} from "@/lib/setup/screens";
import type { SetupState } from "@/lib/setup/state";
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
 * device that can open patient details. The rest of the plan's list (a
 * calendar that stopped working, a quiet channel) needs the calendar backend
 * and go-live (M6), and joins here then.
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
  | "website_changes";

export type AttentionItem = {
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
  /** Website changes the drift check found and nobody has confirmed or ignored (M7). */
  websiteChanges?: number;
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

  return items;
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

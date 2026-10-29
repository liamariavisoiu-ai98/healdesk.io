import type { Channel, RegulatoryRegime } from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinicSetupScreens } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { SETUP_SCREENS, type SetupScreenId, type SetupScreenOutcome } from "./screen-ids";

/**
 * The setup wizard's shape (plan Part E): four steps, one decision per
 * screen, each saved as it is left, resuming on the first screen nobody has
 * answered or skipped. Every screen can be skipped, and says what skipping
 * costs (spec, "No dead ends").
 *
 * Which screens a clinic sees follows from what it bought and what it said at
 * checkout: the phone's two questions only with voice, the insurance question
 * only when the buyer was not sure, and the backup factor only while the
 * sign-in has none. Pure apart from the progress reads and the one write.
 */

export type StepNumber = 1 | 2 | 3 | 4;

export const STEP_TITLES: Readonly<Record<StepNumber, string>> = {
  1: "Your practice",
  2: "How AYA works",
  3: "Calendar",
  4: "Your channels",
};

export type ScreenDefinition = {
  id: SetupScreenId;
  /** The step it belongs to; the backup factor offer comes after all four. */
  step: StepNumber | "end";
  /** Its name in the step's list of screens. */
  title: string;
};

export const SCREEN_DEFINITIONS: Readonly<Record<SetupScreenId, ScreenDefinition>> = {
  basics: { id: "basics", step: 1, title: "Basics" },
  hours: { id: "hours", step: 1, title: "Hours" },
  services: { id: "services", step: 1, title: "Services and prices" },
  question: { id: "question", step: 1, title: "Most-asked question" },
  insurance: { id: "insurance", step: 1, title: "Insurance" },
  tone: { id: "tone", step: 2, title: "Tone and greeting" },
  coverage: { id: "coverage", step: 2, title: "Which calls" },
  direct_line: { id: "direct_line", step: 2, title: "Direct line" },
  deposits: { id: "deposits", step: 2, title: "Deposits" },
  urgent: { id: "urgent", step: 2, title: "Urgent help" },
  calendar: { id: "calendar", step: 3, title: "Calendar" },
  providers: { id: "providers", step: 3, title: "Providers" },
  channels: { id: "channels", step: 4, title: "Your channels" },
  backup: { id: "backup", step: "end", title: "Backup sign-in" },
};

/** What the clinic's screens depend on. */
export type WizardFacts = {
  /** The bought channels. */
  channels: readonly Channel[];
  regulatoryRegime: RegulatoryRegime | null;
  agreementKind: "baa" | "dpa" | null;
  /** clinics.is_covered_entity: null while the practice has not said. */
  isCoveredEntity: boolean | null;
  /** Whether the sign-in already has an authenticator-app backup. */
  hasBackup: boolean;
};

export type Progress = ReadonlyMap<SetupScreenId, { outcome: SetupScreenOutcome; at: Date }>;

/**
 * The clinic's screens, in order. A screen it has already left stays in its
 * list even when the reason it was shown has gone (the insurance question,
 * once answered; the backup, once added), so the step's ticks stay put.
 */
export function screensFor(facts: WizardFacts, progress: Progress): SetupScreenId[] {
  const voice = facts.channels.includes("voice");
  return SETUP_SCREENS.filter((id) => {
    if (progress.has(id)) return true;
    switch (id) {
      case "insurance":
        // Asked again only where the buyer was not sure, and only on the BAA
        // path: a DPA is signed only on "No", and a vet is never asked.
        return (
          facts.regulatoryRegime === "hipaa-if-covered" &&
          facts.agreementKind === "baa" &&
          facts.isCoveredEntity === null
        );
      case "coverage":
      case "direct_line":
        return voice;
      case "backup":
        return !facts.hasBackup;
      default:
        return true;
    }
  });
}

/** The wizard's own screens, without the backup offer at the end. */
export function wizardScreens(screens: readonly SetupScreenId[]): SetupScreenId[] {
  return screens.filter((id) => SCREEN_DEFINITIONS[id].step !== "end");
}

/** The first screen nobody has answered or skipped, or null when there is none. */
export function resumeScreen(
  screens: readonly SetupScreenId[],
  progress: Progress,
): SetupScreenId | null {
  return screens.find((id) => !progress.has(id)) ?? null;
}

/** Whether every one of the four steps' screens has been left, answered or skipped. */
export function wizardFinished(screens: readonly SetupScreenId[], progress: Progress): boolean {
  return wizardScreens(screens).every((id) => progress.has(id));
}

/**
 * The ONE `setupFinished` input for channel status (channelPresentation,
 * channelNextStep), on Home, in Settings and in the wizard's Your channels
 * step: every screen before the channels screen has been left. The channels
 * screen is the one that shows each channel's status, so counting it would
 * make a channel say "finish setup" while its own screen is the thing being
 * finished; counting `wizardFinished` there made Settings and the wizard
 * disagree about the same channel. (A step shown under a wizard row still
 * overrides it for that row.)
 */
export function channelSetupFinished(screens: readonly SetupScreenId[], progress: Progress): boolean {
  return wizardScreens(screens)
    .filter((id) => id !== "channels")
    .every((id) => progress.has(id));
}

/** How many of the four steps still have a screen nobody has answered or skipped. */
export function stepsLeft(screens: readonly SetupScreenId[], progress: Progress): number {
  const open = new Set<StepNumber>();
  for (const id of wizardScreens(screens)) {
    const step = SCREEN_DEFINITIONS[id].step;
    if (step !== "end" && !progress.has(id)) open.add(step);
  }
  return open.size;
}

/** The screen before and after `id` in the clinic's list, for Back and for Continue. */
export function neighbours(
  screens: readonly SetupScreenId[],
  id: SetupScreenId,
): { previous: SetupScreenId | null; next: SetupScreenId | null } {
  const index = screens.indexOf(id);
  return {
    previous: index > 0 ? screens[index - 1]! : null,
    next: index >= 0 && index < screens.length - 1 ? screens[index + 1]! : null,
  };
}

export async function readProgress(db: Transaction, clinicId: string): Promise<Progress> {
  const rows = await db
    .select({
      screen: clinicSetupScreens.screen,
      outcome: clinicSetupScreens.outcome,
      at: clinicSetupScreens.at,
    })
    .from(clinicSetupScreens)
    .where(eq(clinicSetupScreens.clinicId, clinicId));
  return new Map(rows.map((r) => [r.screen, { outcome: r.outcome, at: r.at }]));
}

/**
 * Record a screen as answered or skipped. Answering a skipped screen turns it
 * to done; skipping an answered one leaves it done, because what was saved
 * still stands.
 */
export async function recordScreen(
  tx: TenantTx,
  screen: SetupScreenId,
  outcome: SetupScreenOutcome,
  actorLabel: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.db
    .insert(clinicSetupScreens)
    .values({
      clinicId: tx.clinicId,
      screen,
      outcome,
      at: now,
      actorLabel: actorLabel.slice(0, 200),
    })
    .onConflictDoUpdate({
      target: [clinicSetupScreens.clinicId, clinicSetupScreens.screen],
      set: { outcome, at: now, actorLabel: actorLabel.slice(0, 200) },
      // A skip never undoes an answer.
      ...(outcome === "skipped"
        ? { setWhere: sql`${clinicSetupScreens.outcome} = 'skipped'` }
        : {}),
    });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_setup",
    resourceId: tx.clinicId,
    metadata: { screen, outcome },
  });
}

import {
  COVERAGE_MODES,
  isBookingSystemId,
  type AssistantTone,
  type BookingSystemId,
  type CoverageModeId,
} from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import { requestPracticeQuestions } from "@/lib/engine/practice/store";
import type { PracticeSection } from "@/lib/engine/practice/types";
import { evaluateChannels } from "@/lib/channels/events";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  KnowledgeError,
  saveMostAsked,
  saveServiceDeposits,
  saveServices,
  validateAnswer,
  validateServices,
} from "./knowledge";
import {
  adoptReadHours,
  PracticeError,
  recordInsuranceAnswer,
  saveBasics,
  saveHours,
} from "./practice";
import { saveNamedProviders } from "./providers";
import { neighbours, recordScreen } from "./screens";
import { SETUP_SCREENS, type SetupScreenId } from "./screen-ids";
import { saveDirectLine, saveSetupSettings, SetupSettingsError, toE164 } from "./settings";
import { readSetupState, type SetupState } from "./state";
import { urgentHelpDefault } from "./urgent";

/**
 * Saving one setup screen (plan Part E): validate what the screen sent, write
 * it, record the screen as answered, and say where to go next, all in one
 * tenant transaction, so a screen is never ticked for an answer that did not
 * save. Skipping records the screen as skipped and moves on; what skipping
 * costs is said on the screen itself.
 *
 * Free of Next: the server actions in app/c/[slug]/setup/actions.ts check the
 * sign-in and the step-up, then call these, which is also how the tests call
 * them.
 */

export type ScreenResult =
  { ok: true; next: string } | { ok: false; field: string; message: string };

export type SaveContext = {
  clinicId: string;
  slug: string;
  userId: string;
  /** The device whose passkey is live on this session, or the sign-in's own label. */
  actorLabel: string;
};

export function isSetupScreen(value: unknown): value is SetupScreenId {
  return typeof value === "string" && (SETUP_SCREENS as readonly string[]).includes(value);
}

/** Where the wizard goes after `screen`: the next of the clinic's screens, or its page. */
export function nextPath(state: SetupState, slug: string, screen: SetupScreenId): string {
  const { next } = neighbours(state.screens, screen);
  return next ? `/c/${slug}/setup?s=${next}` : `/c/${slug}`;
}

function actorOf(ctx: SaveContext): ActorContext {
  return { type: "user", userId: ctx.userId, label: ctx.actorLabel };
}

/** A refusal a screen can show beside its field. */
function refusal(error: unknown): ScreenResult | null {
  if (
    error instanceof KnowledgeError ||
    error instanceof PracticeError ||
    error instanceof SetupSettingsError
  ) {
    return { ok: false, field: error.field, message: error.message };
  }
  return null;
}

export async function saveSetupScreen(
  ctx: SaveContext,
  screen: SetupScreenId,
  input: unknown,
  now: Date = new Date(),
): Promise<ScreenResult> {
  // The backup factor is recorded by its own ceremony, once it is enrolled
  // (app/c/[slug]/setup/actions.ts); it is never "answered" by a form.
  if (screen === "backup") {
    return { ok: false, field: "screen", message: "The backup is added by its own steps." };
  }
  if (screen === "providers") {
    // 3.2's named providers are checked with Google and saved by the
    // calendar functions, each in a transaction of its own, before this
    // screen's: Google is never asked inside a transaction. Only what they
    // saved reaches booking_detail, below.
    const named = await saveNamedProviders(ctx, input);
    if (!named.ok) return named;
    input = named.bookingDetail ? { bookingDetail: named.bookingDetail } : {};
  }
  try {
    return await withTenant({ clinicId: ctx.clinicId, actor: actorOf(ctx) }, async (tx) => {
      const state = await readSetupState(tx, { userId: ctx.userId, now });
      if (!state) return { ok: false, field: "screen", message: "This clinic could not be found." };
      if (!state.screens.includes(screen)) {
        return { ok: false, field: "screen", message: "That step isn't part of your setup." };
      }
      await writeScreen(tx, state, screen, (input ?? {}) as Record<string, unknown>, ctx, now);
      const section = PRACTICE_SCREENS[screen];
      if (section) await requestPracticeQuestions(tx, { reason: "wizard", section, now });
      await recordScreen(tx, screen, "done", ctx.actorLabel, now);
      // Setup done, or the direct line on file, can be what a channel was
      // waiting for (lib/channels/events.ts).
      await evaluateChannels(tx, { now, actor: ctx.actorLabel });
      // Read again: an answer can change which screens follow (none today,
      // but the order must come from what was just saved, not before it).
      const after = (await readSetupState(tx, { userId: ctx.userId, now })) ?? state;
      return { ok: true, next: nextPath(after, ctx.slug, screen) };
    });
  } catch (error) {
    const refused = refusal(error);
    if (refused) return refused;
    throw error;
  }
}

export async function skipSetupScreen(
  ctx: SaveContext,
  screen: SetupScreenId,
  now: Date = new Date(),
): Promise<ScreenResult> {
  return withTenant({ clinicId: ctx.clinicId, actor: actorOf(ctx) }, async (tx) => {
    const state = await readSetupState(tx, { userId: ctx.userId, now });
    if (!state || !state.screens.includes(screen)) {
      return { ok: false, field: "screen", message: "That step isn't part of your setup." };
    }
    await recordScreen(tx, screen, "skipped", ctx.actorLabel, now);
    await evaluateChannels(tx, { now, actor: ctx.actorLabel });
    return { ok: true, next: nextPath(state, ctx.slug, screen) };
  });
}

/**
 * The screens whose answers the practice questions read (lib/engine/practice),
 * and the section each is edited in afterwards: saving one asks for the
 * questions to run again, two minutes after the last change.
 */
const PRACTICE_SCREENS: Partial<Record<SetupScreenId, PracticeSection>> = {
  basics: "practice",
  hours: "hours",
  services: "prices",
  question: "quick_answers",
  tone: "how_aya_talks",
  deposits: "prices",
  direct_line: "safety_net",
  urgent: "safety_net",
};

// -----------------------------------------------------------------------------
// One screen's write
// -----------------------------------------------------------------------------

async function writeScreen(
  tx: TenantTx,
  state: SetupState,
  screen: SetupScreenId,
  input: Record<string, unknown>,
  ctx: SaveContext,
  now: Date,
): Promise<void> {
  switch (screen) {
    case "basics": {
      await saveBasics(
        tx,
        {
          name: input.name,
          address: input.address,
          phone: input.phone,
          website: input.website,
          timezone: input.timezone,
        },
        now,
      );
      // "Which location is this AYA for?": the chosen location's hours become
      // the starting point of the hours screen, until the clinic confirms them.
      const index = typeof input.location === "number" ? input.location : null;
      const location = index === null ? undefined : state.clinic.siteProfile?.locations[index];
      if (location?.hours && !state.clinic.onboarding.hours_confirmed) {
        await adoptReadHours(tx, location.hours, now);
      }
      return;
    }

    case "hours":
      await saveHours(
        tx,
        { hours: input.hours, closures: input.closures },
        state.clinic.timezone,
        now,
      );
      return;

    case "services":
      await saveServices(tx, validateServices(input.services, state.clinic.specialty), now);
      return;

    case "question":
      await saveMostAsked(tx, validateAnswer(input, "question"), now);
      return;

    case "insurance": {
      if (typeof input.billsInsurance !== "boolean") {
        throw new PracticeError("billsInsurance", "Choose yes or no.");
      }
      await recordInsuranceAnswer(tx, input.billsInsurance, now);
      return;
    }

    case "tone":
      await saveSetupSettings(
        tx,
        {
          tone: input.tone as AssistantTone,
          ...(input.phoneGreeting !== undefined
            ? { phoneGreeting: input.phoneGreeting as string | null }
            : {}),
          ...(input.chatGreeting !== undefined
            ? { chatGreeting: input.chatGreeting as string | null }
            : {}),
        },
        ctx.actorLabel,
        now,
      );
      return;

    case "coverage": {
      const mode = input.coverageMode;
      if (!(COVERAGE_MODES as readonly unknown[]).includes(mode)) {
        throw new SetupSettingsError("coverageMode", "Choose which calls reach AYA.");
      }
      await saveSetupSettings(tx, { coverageMode: mode as CoverageModeId }, ctx.actorLabel, now);
      return;
    }

    case "direct_line": {
      const raw = typeof input.directLine === "string" ? input.directLine : "";
      if (!raw.trim()) {
        throw new SetupSettingsError(
          "directLine",
          "Enter a number that reaches your team, or skip this for now.",
        );
      }
      await saveDirectLine(tx, raw, ctx.actorLabel, now);
      return;
    }

    case "deposits": {
      // "No", and an amount left blank under "Yes" (it shows "None"), are no
      // deposit, stored as 0. BD27 reads a service's 0 as none even when the
      // clinic has a default, and an absent one as that default
      // (AgentService.depositUsd), which a clinic answering No never chose.
      const wanted = input.needsDeposits === true;
      const amounts = (input.deposits ?? {}) as Record<string, unknown>;
      const deposits: Record<string, number> = {};
      for (const service of state.knowledge.services) {
        const raw = wanted ? amounts[service.name] : null;
        deposits[service.name] =
          raw === null || raw === undefined || raw === "" ? 0 : (raw as number);
      }
      if (wanted && Object.values(deposits).every((d) => d === 0)) {
        throw new KnowledgeError(
          "deposits",
          "Enter the deposit for at least one treatment, or choose No.",
        );
      }
      await saveServiceDeposits(tx, deposits, now);
      return;
    }

    case "urgent": {
      // A veterinary practice's urgent reply gives its emergency referral
      // clinic, and it may not go live without one (plan Part L); everyone
      // else's gives the urgent-help number, or, left empty, the direct line
      // (the main phone with no phone channel).
      if (state.clinic.regulatoryRegime === "non-hipaa") {
        const referral = typeof input.vetReferral === "string" ? input.vetReferral : "";
        if (!referral.trim()) {
          throw new SetupSettingsError(
            "vetReferral",
            "Enter the emergency clinic you refer to. AYA gives it to anyone with an urgent problem.",
          );
        }
        await saveSetupSettings(tx, { vetReferralE164: referral }, ctx.actorLabel, now);
        return;
      }
      // Null is "use the default", resolved when the number is read
      // (lib/setup/urgent.ts). A number typed equal to the default is the
      // default too, so it follows the direct line instead of freezing it.
      const urgent = typeof input.urgentHelp === "string" ? input.urgentHelp.trim() : "";
      const fallback = urgentHelpDefault(state);
      const sameAsDefault = urgent !== "" && fallback !== null && toE164(urgent) === fallback;
      await saveSetupSettings(
        tx,
        { urgentHelpE164: urgent && !sameAsDefault ? urgent : null },
        ctx.actorLabel,
        now,
      );
      return;
    }

    case "calendar": {
      const system = input.bookingSystem;
      if (system !== undefined && system !== null) {
        if (!isBookingSystemId(system)) {
          throw new SetupSettingsError("bookingSystem", "Choose where your bookings live today.");
        }
        await saveSetupSettings(
          tx,
          { bookingSystem: system as BookingSystemId },
          ctx.actorLabel,
          now,
        );
      }
      return;
    }

    case "providers":
      // `named_provider` only once saveNamedProviders has saved the providers
      // (saveSetupScreen, before this transaction); nothing when it left the
      // saved answer as it is.
      if (input.bookingDetail === "named_provider" || input.bookingDetail === "generic") {
        await saveSetupSettings(tx, { bookingDetail: input.bookingDetail }, ctx.actorLabel, now);
      }
      return;

    case "channels":
    case "backup":
      // Nothing to save: the channels screen shows where each stands, and the
      // backup is enrolled by its own ceremony before this is recorded.
      return;
  }
}

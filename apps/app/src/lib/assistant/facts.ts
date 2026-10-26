import {
  isScreenedLanguage,
  resolveBookingRequirements,
  type AssistantTone,
  type BookingField,
  type ScreenedLanguage,
} from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { agentConfigs, clinicChannels, clinicProviders, clinics, type AgentService, type KnowledgeAnswer } from "@/db/schema";
import { clinicLocalDate, closuresFrom, type Closure } from "@/lib/clinic/closures";
import { DAY_KEYS, DAY_LABELS, type OpeningHours } from "@/lib/clinic/opening-hours";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";
import { urgentAlertReadiness } from "@/lib/notices/urgent-readiness";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { neverSayWithDefaults, readKnowledge } from "@/lib/setup/knowledge";
import { readSetupSettings } from "@/lib/setup/settings";
import { urgentHelpNumber } from "@/lib/setup/urgent";
import type { TenantTx } from "@/lib/tenant";

/**
 * What the assistant may know about one clinic on a call or a web chat: the
 * BAA-covered channels (the Meta channels have their own, narrower front
 * door, lib/meta/front-door.ts). Read inside the clinic's tenant.
 *
 * Only an approved script's services, notes and hours are public facts, as on
 * the front door. The never-say list is the clinic's own plus the built-in
 * defaults, and goes into every conversation on every channel (CLAUDE.md,
 * "Guardrails"): the Meta front door reads the same list, built the same way
 * and with or without an approved script (frontDoorFacts), and refuses it
 * with the same matcher (guard.ts, neverSayIn). The rest of these facts are
 * a call's and a web chat's. The clinic cannot edit the prompt, only these
 * facts.
 *
 * The clinic's Behaviour switches come with them (the v1 spec, "Every switch
 * in the portal"): its tone, its languages, "Suggest add-on treatments" and
 * "Mention promotions". The promotions box is a fact only while Mention
 * promotions is on. Add-ons and promotions are phone and website chat only:
 * the Meta front door never mentions either, and reads none of this.
 */

export type AssistantChannel = "voice" | "web_chat";

export type AssistantService = Pick<AgentService, "name" | "priceFromUsd" | "priceToUsd" | "priceKind" | "unit" | "durationMinutes" | "depositUsd">;

export type AssistantFacts = {
  clinicId: string;
  clinicName: string;
  /**
   * What patients call the practice (Settings › How AYA talks, "What patients
   * call you"): said after the full name has been said once. Null or absent
   * when the clinic left it empty, and the prompt works one out from the name
   * (@healdesk/catalog shortClinicName).
   */
  shortName?: string | null;
  /** The practice's specialty id: which urgent set it is screened with (@healdesk/catalog, urgentSetFor). */
  specialty: string | null;
  timeZone: string;
  /** The clinic's published number. */
  phone: string | null;
  /** The clinic's AYA number, which callers reach us on: never a line to put a call through to. */
  assistantNumber?: string | null;
  /** What the urgent line gives after 911 (lib/setup/urgent.ts). */
  urgentPhone: string | null;
  /** A veterinary practice's emergency referral clinic: what its urgent line gives instead of 911. */
  vetReferralPhone: string | null;
  /** The direct line: a number that reaches a person and never forwards back to us. */
  directLine: string | null;
  address: string | null;
  /** Weekly hours, one line a day, in the clinic's own zone. */
  hours: string[];
  /** The same hours as stored: whether a veterinary practice is open, for its urgent line. */
  openingHours: OpeningHours | null;
  /**
   * The days the clinic is closed outright from today on (Knowledge → Hours),
   * earliest first, at most CLOSURES_IN_FACTS: shut all day whatever the
   * weekly hours say, as the booking engine reads them. Absent counts as none.
   */
  closures?: Closure[];
  services: AssistantService[];
  /**
   * Why `services` is what it is: "said" when the approved script has some,
   * "awaiting_approval" when Knowledge has services the practice questions
   * have not passed yet (so AYA says none), "none" when Knowledge has none.
   * Read by lib/assistant/menu-check.ts; absent counts as "said".
   */
  menu?: "said" | "awaiting_approval" | "none";
  policies: string[];
  quickAnswers: KnowledgeAnswer[];
  /** The promotions box, only while "Mention promotions" is on; null otherwise. */
  promotions: string | null;
  notes: string | null;
  escalationHours: string | null;
  neverSay: string[];
  /** The practice's requirement set: what a request needs before the desk can confirm it. */
  requirements: BookingField[];
  greeting: { phone: string; chat: string };
  /** How AYA speaks: "warm" (the default) or "clinical". */
  tone: AssistantTone;
  /**
   * The languages AYA answers in: the clinic's choice, read through the
   * languages the screens read (SCREENED_LANGUAGES), so a language saved
   * before the screens existed is never answered in. English is always one.
   */
  languages: ScreenedLanguage[];
  /** "Suggest add-on treatments": on lets AYA suggest a complementary service during a booking. */
  suggestAddOns: boolean;
  /** The practice's providers, as it names them: words the language check reads as no language. */
  providerNames: string[];
  /**
   * Whether an urgent alert raised now would reach the clinic (the sender's
   * switch, an email transport and the clinic's address: urgentAlertReadiness,
   * lib/notices/urgent-readiness.ts). The fixed urgent reply says "I've told
   * the team" only when this is true; absent counts as false, so facts built
   * anywhere else never promise an alert.
   */
  urgentAlertsReady?: boolean;
  /**
   * Dollar amounts the call may say beyond the menu's, each exactly. Only a
   * demo call has them (demo-facts.ts): healdesk's own catalog prices for the
   * pitch. A clinic's facts never do, so its calls quote its menu alone.
   */
  quotedAmountsUsd?: readonly number[];
  /**
   * A demo call's talk after the role-play, with a clinic's owner about their
   * own business (lib/voice/demo-facts.ts, demoPitchFacts): a bare figure
   * there is a count of their calls ("around 110 a month"), never a dose, so
   * the guard's unit-less dose pattern (guard.ts, UNITLESS_DOSE) stands aside
   * for it. Every other clinical pattern still reads every word. A clinic's
   * facts never set it, so a patient's call is screened exactly as before.
   */
  businessCounts?: boolean;
};


function screenedLanguages(chosen: readonly string[]): ScreenedLanguage[] {
  const screened = chosen.filter(isScreenedLanguage);
  return screened.includes("en") ? screened : ["en", ...screened];
}

function hoursLines(hours: OpeningHours | null): string[] {
  if (!hours) return [];
  return DAY_KEYS.map((day) => {
    const ranges = hours[day] ?? [];
    return `${DAY_LABELS[day]}: ${ranges.length === 0 ? "closed" : ranges.map(([open, close]) => `${open}-${close}`).join(", ")}`;
  });
}

/** The closed days a conversation is told about: the next sixty, as many as one save may add. */
export const CLOSURES_IN_FACTS = 60;

/** The clinic's closed days from today in its zone; none when the zone cannot be read. */
async function upcomingClosures(tx: TenantTx, timeZone: string, now: Date): Promise<Closure[]> {
  let today: string;
  try {
    today = clinicLocalDate(now, timeZone);
  } catch {
    return [];
  }
  return closuresFrom(tx.db, tx.clinicId, today, CLOSURES_IN_FACTS);
}

/**
 * `asApproved` reads the script as it would be once approved: the practice
 * questions (lib/engine/practice) check the words a pass would approve,
 * before anyone has approved them. Every channel reads it without.
 */
export async function assistantFacts(
  tx: TenantTx,
  options: {
    asApproved?: boolean;
    /** The transport this conversation hands the outbox for its alerts, when it hands one (tests). */
    alertTransport?: EmailTransport;
    /** The moment "today" is read at, for the closed days; now by default. */
    now?: Date;
  } = {},
): Promise<AssistantFacts | null> {
  const [clinic] = await tx.db
    .select({
      name: clinics.name,
      timeZone: clinics.timezone,
      phone: clinics.publishedPhoneE164,
      assistantNumber: clinics.assistantNumberE164,
      specialty: clinics.specialty,
      bookingRequirements: clinics.bookingRequirements,
      openingHours: clinics.openingHours,
      address: clinics.address,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;

  const [agent] = await tx.db
    .select({ notes: agentConfigs.notes, escalationHours: agentConfigs.escalationHours, approvedAt: agentConfigs.approvedAt })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const approved = options.asApproved === true ? Boolean(agent) : Boolean(agent?.approvedAt);
  const knowledge = await readKnowledge(tx.db, tx.clinicId);

  const settings = await readSetupSettings(tx.db, tx.clinicId);
  const bought = await tx.db.select({ channel: clinicChannels.channel }).from(clinicChannels).where(eq(clinicChannels.clinicId, tx.clinicId));
  const providers = await tx.db
    .select({ name: clinicProviders.displayName })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)));

  return {
    clinicId: tx.clinicId,
    clinicName: clinic.name,
    shortName: settings.shortName,
    specialty: clinic.specialty,
    timeZone: clinic.timeZone,
    phone: clinic.phone,
    assistantNumber: clinic.assistantNumber,
    urgentPhone: urgentHelpNumber({
      channels: bought,
      settings: { urgentHelpE164: settings.urgentHelpE164, directLineE164: settings.directLineE164 },
      clinic: { publishedPhoneE164: clinic.phone },
    }),
    vetReferralPhone: settings.vetReferralE164,
    directLine: settings.directLineE164,
    address: clinic.address,
    hours: hoursLines(clinic.openingHours),
    openingHours: clinic.openingHours ?? null,
    closures: await upcomingClosures(tx, clinic.timeZone, options.now ?? new Date()),
    services: approved
      ? knowledge.services.map((s) => ({
          name: s.name,
          priceFromUsd: s.priceFromUsd,
          priceToUsd: s.priceToUsd,
          priceKind: s.priceKind ?? null,
          unit: s.unit ?? null,
          durationMinutes: s.durationMinutes,
          depositUsd: s.depositUsd ?? null,
        }))
      : [],
    menu: knowledge.services.length === 0 ? "none" : approved ? "said" : "awaiting_approval",
    policies: approved ? knowledge.policies : [],
    quickAnswers: approved ? [...knowledge.quickAnswers, ...(knowledge.mostAsked ? [knowledge.mostAsked] : [])] : [],
    promotions: approved && settings.mentionPromotions ? knowledge.promotions : null,
    notes: approved ? (agent?.notes ?? null) : null,
    escalationHours: approved ? (agent?.escalationHours ?? null) : null,
    neverSay: neverSayWithDefaults(knowledge.neverSay),
    requirements: resolveBookingRequirements(clinic.specialty, clinic.bookingRequirements ?? null),
    greeting: {
      phone: settings.phoneGreeting?.trim() || defaultPhoneGreeting(clinic.name),
      chat: settings.chatGreeting?.trim() || defaultChatGreeting(),
    },
    tone: settings.tone,
    languages: screenedLanguages(settings.languages),
    suggestAddOns: settings.suggestAddOns,
    providerNames: providers.map((p) => p.name),
    urgentAlertsReady: (await urgentAlertReadiness(tx, { transport: options.alertTransport })).ready,
  };
}

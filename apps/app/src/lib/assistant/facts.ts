import { resolveBookingRequirements, type BookingField } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { agentConfigs, clinicChannels, clinicSettings, clinics, type AgentService, type KnowledgeAnswer } from "@/db/schema";
import { DAY_KEYS, DAY_LABELS, type OpeningHours } from "@/lib/clinic/opening-hours";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";
import { neverSayWithDefaults, readKnowledge } from "@/lib/setup/knowledge";
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
 * "Guardrails"). The clinic cannot edit the prompt, only these facts.
 */

export type AssistantChannel = "voice" | "web_chat";

export type AssistantService = Pick<AgentService, "name" | "priceFromUsd" | "priceToUsd" | "priceKind" | "unit" | "durationMinutes" | "depositUsd">;

export type AssistantFacts = {
  clinicId: string;
  clinicName: string;
  timeZone: string;
  /** The clinic's published number. */
  phone: string | null;
  /** What the urgent line gives after 911 (lib/setup/urgent.ts). */
  urgentPhone: string | null;
  /** The direct line: a number that reaches a person and never forwards back to us. */
  directLine: string | null;
  address: string | null;
  /** Weekly hours, one line a day, in the clinic's own zone. */
  hours: string[];
  services: AssistantService[];
  policies: string[];
  quickAnswers: KnowledgeAnswer[];
  promotions: string | null;
  notes: string | null;
  escalationHours: string | null;
  neverSay: string[];
  /** The practice's requirement set: what a request needs before the desk can confirm it. */
  requirements: BookingField[];
  greeting: { phone: string; chat: string };
};

function hoursLines(hours: OpeningHours | null): string[] {
  if (!hours) return [];
  return DAY_KEYS.map((day) => {
    const ranges = hours[day] ?? [];
    return `${DAY_LABELS[day]}: ${ranges.length === 0 ? "closed" : ranges.map(([open, close]) => `${open}-${close}`).join(", ")}`;
  });
}

export async function assistantFacts(tx: TenantTx): Promise<AssistantFacts | null> {
  const [clinic] = await tx.db
    .select({
      name: clinics.name,
      timeZone: clinics.timezone,
      phone: clinics.publishedPhoneE164,
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
  const approved = Boolean(agent?.approvedAt);
  const knowledge = await readKnowledge(tx.db, tx.clinicId);

  const [settings] = await tx.db
    .select({
      directLine: clinicSettings.directLineE164,
      urgentHelp: clinicSettings.urgentHelpE164,
      phoneGreeting: clinicSettings.phoneGreeting,
      chatGreeting: clinicSettings.chatGreeting,
    })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const bought = await tx.db.select({ channel: clinicChannels.channel }).from(clinicChannels).where(eq(clinicChannels.clinicId, tx.clinicId));

  return {
    clinicId: tx.clinicId,
    clinicName: clinic.name,
    timeZone: clinic.timeZone,
    phone: clinic.phone,
    urgentPhone: urgentHelpNumber({
      channels: bought,
      settings: { urgentHelpE164: settings?.urgentHelp ?? null, directLineE164: settings?.directLine ?? null },
      clinic: { publishedPhoneE164: clinic.phone },
    }),
    directLine: settings?.directLine ?? null,
    address: clinic.address,
    hours: hoursLines(clinic.openingHours),
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
    policies: approved ? knowledge.policies : [],
    quickAnswers: approved ? [...knowledge.quickAnswers, ...(knowledge.mostAsked ? [knowledge.mostAsked] : [])] : [],
    promotions: approved ? knowledge.promotions : null,
    notes: approved ? (agent?.notes ?? null) : null,
    escalationHours: approved ? (agent?.escalationHours ?? null) : null,
    neverSay: neverSayWithDefaults(knowledge.neverSay),
    requirements: resolveBookingRequirements(clinic.specialty, clinic.bookingRequirements ?? null),
    greeting: {
      phone: settings?.phoneGreeting?.trim() || defaultPhoneGreeting(clinic.name),
      chat: settings?.chatGreeting?.trim() || defaultChatGreeting(),
    },
  };
}

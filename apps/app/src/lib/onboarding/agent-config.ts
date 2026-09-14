import { eq } from "drizzle-orm";

import {
  findClinicalContent,
  type ClinicalFinding,
  type SpecialtyId,
} from "@healdesk/catalog";

import { agentConfigs, clinics, type AgentService, type DepositPolicy } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { completeStep } from "./steps";

/**
 * The agent's words, per clinic.
 *
 * A default is seeded at provisioning from the specialty so no clinic is ever
 * configured with nothing; the operator edits it with the clinic on the
 * onboarding call; the clinic approves a version; go-live requires the
 * approval. Every write screens the text with findClinicalContent() — a
 * greeting that promises safe treatment during pregnancy is refused with the
 * phrase named, not stored and hoped about.
 *
 * The AI disclosure is not part of this record and cannot be edited from it:
 * lib/compliance/disclosure.ts prepends it at call time.
 */

export type AgentConfigInput = {
  greeting: string;
  services: AgentService[];
  escalationPhone: string | null;
  escalationHours: string | null;
  notes: string | null;
  /** Null: the agent never mentions a deposit. See DepositPolicy. */
  depositPolicy?: DepositPolicy | null;
};

export class AgentConfigError extends Error {
  constructor(
    message: string,
    readonly findings: ClinicalFinding[] = [],
  ) {
    super(message);
    this.name = "AgentConfigError";
  }
}

const SPECIALTY_DEFAULTS: Partial<Record<SpecialtyId, { greeting: string; services: AgentService[] }>> = {
  "med-spa": {
    greeting: "Thanks for calling {clinic}. I can book a consultation or an appointment, answer questions about our services and hours, and take a message for the team. What can I help you with?",
    services: [
      { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
      { name: "Injectables appointment", priceFromUsd: null, priceToUsd: null, durationMinutes: 45 },
      { name: "Facial or skin treatment", priceFromUsd: null, priceToUsd: null, durationMinutes: 60 },
    ],
  },
  dental: {
    greeting: "Thanks for calling {clinic}. I can book a cleaning, a check-up or a consultation, answer questions about hours and insurance we accept, and take a message for the front desk. How can I help?",
    services: [
      { name: "New patient exam and cleaning", priceFromUsd: null, priceToUsd: null, durationMinutes: 60 },
      { name: "Cleaning", priceFromUsd: null, priceToUsd: null, durationMinutes: 45 },
      { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
    ],
  },
  veterinary: {
    greeting: "Thanks for calling {clinic}. I can book a wellness visit, a grooming appointment or a consultation, and take a message for the team. What can I help you with today?",
    services: [
      { name: "Wellness visit", priceFromUsd: null, priceToUsd: null, durationMinutes: 30 },
      { name: "Grooming", priceFromUsd: null, priceToUsd: null, durationMinutes: 60 },
    ],
  },
};

const GENERIC: { greeting: string; services: AgentService[] } = {
  greeting: "Thanks for calling {clinic}. I can book a consultation or an appointment, answer questions about our services and hours, and take a message for the team. What can I help you with?",
  services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
};

export function defaultAgentConfig(specialty: string, clinicName: string): AgentConfigInput {
  const base = SPECIALTY_DEFAULTS[specialty as SpecialtyId] ?? GENERIC;
  return {
    greeting: base.greeting.replace("{clinic}", clinicName),
    services: base.services,
    escalationPhone: null,
    escalationHours: null,
    notes: null,
    depositPolicy: null,
  };
}

export function validateAgentConfig(input: AgentConfigInput): void {
  if (!input.greeting.trim() || input.greeting.length > 600) {
    throw new AgentConfigError("The greeting must be between 1 and 600 characters.");
  }
  if (input.escalationPhone && !/^\+[1-9]\d{6,14}$/.test(input.escalationPhone)) {
    throw new AgentConfigError("The escalation number must be E.164 (e.g. +14155550100).");
  }
  if (input.services.length > 40) throw new AgentConfigError("At most 40 services.");
  const deposit = input.depositPolicy ?? null;
  if (deposit) {
    if (deposit.amountUsd !== null && (!Number.isFinite(deposit.amountUsd) || deposit.amountUsd < 0 || deposit.amountUsd > 10_000)) {
      throw new AgentConfigError("The deposit amount must be between $0 and $10,000, or left blank.");
    }
    if (deposit.collection !== "front_desk" && deposit.collection !== "stripe_connect") {
      throw new AgentConfigError("Deposits are collected by the front desk or through Stripe Connect.");
    }
  }
  for (const service of input.services) {
    if (!service.name.trim() || service.name.length > 120) {
      throw new AgentConfigError("Every service needs a name under 120 characters.");
    }
    if (service.priceFromUsd !== null && service.priceToUsd !== null && service.priceFromUsd > service.priceToUsd) {
      throw new AgentConfigError(`"${service.name}": the price range is reversed.`);
    }
  }
  const findings = findClinicalContent({
    greeting: input.greeting,
    escalationHours: input.escalationHours,
    notes: input.notes,
    ...Object.fromEntries(input.services.map((s, i) => [`services[${i}].name`, s.name])),
  });
  if (findings.length) {
    throw new AgentConfigError(
      `Clinical content is not allowed in the agent's words: ${findings
        .map((f) => `${f.field} contains ${f.label} ("${f.excerpt}")`)
        .join("; ")}. The agent routes those questions to your staff; say that instead.`,
      findings,
    );
  }
}

export type AgentConfigRow = typeof agentConfigs.$inferSelect;

export async function getAgentConfig(tx: TenantTx): Promise<AgentConfigRow | null> {
  const [row] = await tx.db
    .select()
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  return row ?? null;
}

/** Seed at provisioning. Idempotent on the unique clinic index. */
export async function seedAgentConfig(tx: TenantTx, specialty: string, clinicName: string): Promise<void> {
  const input = defaultAgentConfig(specialty, clinicName);
  validateAgentConfig(input);
  await tx.db
    .insert(agentConfigs)
    .values({ clinicId: tx.clinicId, ...input })
    .onConflictDoNothing({ target: agentConfigs.clinicId });
}

/** Any edit bumps the version and clears the approval; go-live needs a fresh one. */
export async function updateAgentConfig(tx: TenantTx, input: AgentConfigInput): Promise<AgentConfigRow> {
  validateAgentConfig(input);
  const existing = await getAgentConfig(tx);
  const now = new Date();
  const values = {
    greeting: input.greeting.trim(),
    services: input.services,
    escalationPhone: input.escalationPhone,
    escalationHours: input.escalationHours?.trim() || null,
    notes: input.notes?.trim() || null,
    depositPolicy: input.depositPolicy ?? null,
    approvedAt: null,
    approvedByLabel: null,
    updatedAt: now,
  };
  const [row] = existing
    ? await tx.db
        .update(agentConfigs)
        .set({ ...values, version: existing.version + 1 })
        .where(eq(agentConfigs.clinicId, tx.clinicId))
        .returning()
    : await tx.db.insert(agentConfigs).values({ clinicId: tx.clinicId, ...values }).returning();
  await tx.db
    .update(clinics)
    .set({ agentApprovedAt: null, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: existing ? "update" : "create",
    resourceType: "agent_config",
    resourceId: row!.id,
    metadata: { version: row!.version, services: input.services.length },
  });
  return row!;
}

/** The clinic approved the current version, via the operator on the call. */
export async function approveAgentConfig(tx: TenantTx, approvedByLabel: string): Promise<AgentConfigRow> {
  const existing = await getAgentConfig(tx);
  if (!existing) throw new AgentConfigError("There is no agent configuration to approve.");
  const now = new Date();
  const [row] = await tx.db
    .update(agentConfigs)
    .set({ approvedAt: now, approvedByLabel: approvedByLabel.slice(0, 200), updatedAt: now })
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .returning();
  await tx.db.update(clinics).set({ agentApprovedAt: now, updatedAt: now }).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "agent_config",
    resourceId: row!.id,
    metadata: { version: row!.version, approved: true },
  });
  await completeStep(tx, "agent_script_approved", { at: now, note: `version ${row!.version}` });
  return row!;
}

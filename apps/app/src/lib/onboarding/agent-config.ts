import { and, eq, isNull } from "drizzle-orm";

import {
  findClinicalContent,
  type ClinicalFinding,
  type SpecialtyId,
} from "@healdesk/catalog";

import { agentConfigs, clinics, type AgentService, type DepositPolicy } from "@/db/schema";
import { carryServiceDetails } from "@/lib/setup/prices";
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

/**
 * The most services a clinic's list may hold: a full med-spa menu, as its
 * website states it, fits; anything longer is a misreading, not a menu.
 */
export const MAX_AGENT_SERVICES = 100;

/**
 * The largest deposit, in dollars, that a service or the clinic default may
 * ask for (BD27: $0 to this). Every writer of a deposit holds to it: this
 * file's validateAgentConfig, and the setup wizard and Knowledge
 * (lib/setup/knowledge.ts). The ops console sends each service's deposit
 * back as it read it, so one stored above it by another writer would have
 * every later save of the clinic's script refused, over a field the console
 * cannot change.
 */
export const MAX_DEPOSIT_USD = 10_000;
const MAX_DEPOSIT_LABEL = `$${MAX_DEPOSIT_USD.toLocaleString("en-US")}`;

export function validateAgentConfig(input: AgentConfigInput): void {
  if (!input.greeting.trim() || input.greeting.length > 600) {
    throw new AgentConfigError("The greeting must be between 1 and 600 characters.");
  }
  if (input.escalationPhone && !/^\+[1-9]\d{6,14}$/.test(input.escalationPhone)) {
    throw new AgentConfigError("The escalation number must be E.164 (e.g. +14155550100).");
  }
  if (input.services.length > MAX_AGENT_SERVICES) {
    throw new AgentConfigError(`At most ${MAX_AGENT_SERVICES} services.`);
  }
  const deposit = input.depositPolicy ?? null;
  if (deposit) {
    if (deposit.amountUsd !== null && (!Number.isFinite(deposit.amountUsd) || deposit.amountUsd < 0 || deposit.amountUsd > MAX_DEPOSIT_USD)) {
      throw new AgentConfigError(`The deposit amount must be between $0 and ${MAX_DEPOSIT_LABEL}, or left blank.`);
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
    // Per-service deposit (BD27): 0 means none, blank means the clinic
    // default. The type check comes first because an untyped body can carry
    // a string, which must be refused, not compared.
    const deposit: unknown = service.depositUsd;
    if (deposit !== undefined && deposit !== null) {
      if (typeof deposit !== "number" || !Number.isFinite(deposit) || deposit < 0 || deposit > MAX_DEPOSIT_USD) {
        throw new AgentConfigError(`"${service.name}": the deposit must be between $0 and ${MAX_DEPOSIT_LABEL}, or left blank to use the default.`);
      }
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

/**
 * Any edit bumps the version and clears the approval; go-live needs a fresh one.
 *
 * The ops console's form edits a service's name, prices and length, and none
 * of what the setup wizard and Knowledge add to it (0056): the price kind, a
 * per-unit price's unit and the deposit. Whatever a caller leaves out is
 * carried from the stored service of the same name, so an operator's edit to
 * the greeting can never erase them (lib/setup/prices.ts).
 */
export async function updateAgentConfig(tx: TenantTx, input: AgentConfigInput): Promise<AgentConfigRow> {
  validateAgentConfig(input);
  const existing = await getAgentConfig(tx);
  const services = carryServiceDetails(existing?.services ?? [], input.services);
  const now = new Date();
  const values = {
    greeting: input.greeting.trim(),
    services,
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

/**
 * The practice questions passed this version (lib/engine/practice): it is
 * approved, as an operator's approval would approve it, and only if it is
 * still the current version and not approved already. A version the clinic
 * changed while the questions ran is never approved by them. True when this
 * call approved it.
 */
export async function approveAgentConfigVersion(tx: TenantTx, version: number, approvedByLabel: string): Promise<boolean> {
  const now = new Date();
  const [row] = await tx.db
    .update(agentConfigs)
    .set({ approvedAt: now, approvedByLabel: approvedByLabel.slice(0, 200), updatedAt: now })
    .where(and(eq(agentConfigs.clinicId, tx.clinicId), eq(agentConfigs.version, version), isNull(agentConfigs.approvedAt)))
    .returning();
  if (!row) return false;
  await tx.db.update(clinics).set({ agentApprovedAt: now, updatedAt: now }).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "agent_config",
    resourceId: row.id,
    metadata: { version: row.version, approved: true, by: "practice_questions" },
  });
  await completeStep(tx, "agent_script_approved", { at: now, note: `version ${row.version}, practice questions` });
  return true;
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

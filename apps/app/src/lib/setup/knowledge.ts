import {
  CLINIC_PROFILE_LIMITS,
  findClinicalContent,
  NEVER_SAY_DEFAULTS,
  NEVER_SAY_LIMITS,
  serviceNameScreen,
  isServicePriceKind,
  isSpecialtyId,
  type ProfileService,
  type ServicePriceKind,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { agentConfigs, clinics, type AgentService, type KnowledgeAnswer } from "@/db/schema";
import { MAX_AGENT_SERVICES } from "@/lib/onboarding/agent-config";
import type { TenantTx } from "@/lib/tenant";

import { priceKindOf } from "./prices";

/**
 * The practice's knowledge: what AYA may say about it (plan Part F3, spec
 * "Knowledge"). It lives on agent_configs, the row that has always held the
 * agent's words: services with their prices, and since 0052 the price kind,
 * the unit and the deposit per service, the policies, the quick answers, the
 * most-asked question, the promotions box and the never-say list.
 *
 * Every write screens its text with findClinicalContent, the guard every
 * stored text in the product goes through, and names the phrase it refused so
 * the clinic can reword it rather than guess. Service names are screened by
 * the specialty's own rule (serviceNameScreen): a veterinary menu is made of
 * medical words and only the claims apply to it. The never-say list is the
 * one exception: it is clinical on purpose.
 *
 * A change to the agent's words is a new version and clears its approval,
 * the rule lib/onboarding/agent-config.ts has always applied.
 */

export class KnowledgeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export type Knowledge = {
  services: AgentService[];
  policies: string[];
  quickAnswers: KnowledgeAnswer[];
  mostAsked: KnowledgeAnswer | null;
  neverSay: string[];
  promotions: string | null;
};

export async function readKnowledge(db: Transaction, clinicId: string): Promise<Knowledge> {
  const [row] = await db
    .select({
      services: agentConfigs.services,
      policies: agentConfigs.policies,
      quickAnswers: agentConfigs.quickAnswers,
      mostAsked: agentConfigs.mostAsked,
      neverSay: agentConfigs.neverSay,
      promotions: agentConfigs.promotions,
    })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, clinicId))
    .limit(1);
  return {
    services: row?.services ?? [],
    policies: row?.policies ?? [],
    quickAnswers: row?.quickAnswers ?? [],
    mostAsked: row?.mostAsked ?? null,
    neverSay: row?.neverSay ?? [],
    promotions: row?.promotions ?? null,
  };
}

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

/** One row of the services screen, as the form sends it. */
export type ServiceInput = {
  name: string;
  /** Null: no price is quoted, and AYA offers a consultation instead. */
  priceKind: ServicePriceKind | null;
  price: number | null;
  /** The top of a range. */
  maxPrice: number | null;
  /** What a per-unit price is per. */
  unit: string | null;
  durationMinutes: number | null;
  /** Carried through unchanged when present; the deposits screen sets it. */
  depositUsd?: number | null;
};

/**
 * A service as the form shows it, from what is stored. A service stored
 * without a kind (before 0052, or by a writer that does not know kinds) takes
 * the kind its prices say: a start with no top is a "from" price, never an
 * exact one, which would make the next save quote the start as the whole
 * price.
 */
export function serviceInputOf(service: AgentService): ServiceInput {
  const kind = priceKindOf(service);
  return {
    name: service.name,
    priceKind: kind,
    price: service.priceFromUsd,
    maxPrice: kind === "range" ? service.priceToUsd : null,
    unit: kind === "per_unit" ? (service.unit ?? null) : null,
    durationMinutes: service.durationMinutes,
    depositUsd: service.depositUsd ?? null,
  };
}

/** A service from the website read, as it is stored. */
export function serviceFromProfile(service: ProfileService): AgentService {
  return toAgentService({
    name: service.name,
    priceKind: service.priceKind,
    price: service.priceUsd,
    maxPrice: service.maxUsd,
    unit: service.unit,
    durationMinutes: service.durationMinutes,
  });
}

function toAgentService(input: ServiceInput): AgentService {
  const kind = input.priceKind;
  return {
    name: input.name,
    priceKind: kind,
    priceFromUsd: kind === null ? null : input.price,
    priceToUsd: kind === "exact" ? input.price : kind === "range" ? input.maxPrice : null,
    unit: kind === "per_unit" ? input.unit : null,
    durationMinutes: input.durationMinutes,
    ...(input.depositUsd !== undefined && input.depositUsd !== null
      ? { depositUsd: input.depositUsd }
      : {}),
  };
}

/** Validate the services screen. Returns what is stored, or throws a KnowledgeError naming the row. */
export function validateServices(inputs: unknown, specialty: string): AgentService[] {
  if (!Array.isArray(inputs)) throw new KnowledgeError("services", "Send the list of services.");
  if (inputs.length > MAX_AGENT_SERVICES) {
    throw new KnowledgeError("services", `Keep the list to ${MAX_AGENT_SERVICES} services.`);
  }
  const screen = serviceNameScreen(isSpecialtyId(specialty) ? specialty : null);
  const seen = new Set<string>();
  return inputs.map((raw, i) => {
    const row = (raw ?? {}) as Partial<ServiceInput>;
    const field = `services[${i}]`;
    const name = cleanText(row.name, 120);
    if (!name) throw new KnowledgeError(field, `Row ${i + 1} needs a name.`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new KnowledgeError(field, `"${name}" is listed twice.`);
    seen.add(key);

    const kind = row.priceKind ?? null;
    if (kind !== null && !isServicePriceKind(kind)) {
      throw new KnowledgeError(field, `Choose how "${name}" is priced.`);
    }
    const price = kind === null ? null : money(row.price, field, name);
    if (kind !== null && price === null) {
      throw new KnowledgeError(
        field,
        `"${name}" needs a price, or choose "No price: offer a consultation".`,
      );
    }
    let maxPrice: number | null = null;
    if (kind === "range") {
      maxPrice = money(row.maxPrice, field, name);
      if (maxPrice === null || price === null || maxPrice <= price) {
        throw new KnowledgeError(field, `"${name}": the top of the range must be above its start.`);
      }
    }
    let unit: string | null = null;
    if (kind === "per_unit") {
      unit = cleanText(row.unit, CLINIC_PROFILE_LIMITS.unit);
      if (!unit)
        throw new KnowledgeError(field, `"${name}": say what the price is per, like "unit".`);
    }
    const duration = row.durationMinutes ?? null;
    if (
      duration !== null &&
      (typeof duration !== "number" ||
        !Number.isInteger(duration) ||
        duration < 5 ||
        duration > 1440)
    ) {
      throw new KnowledgeError(field, `"${name}": the length is in whole minutes, from 5 to 1440.`);
    }

    const findings = findClinicalContent(
      { name, unit: unit === null ? null : `per ${unit}` },
      screen,
    );
    if (findings.length > 0) {
      const finding = findings[0]!;
      throw new KnowledgeError(
        field,
        `"${name}" mentions ${finding.label}. Name the service the way your menu does, without that.`,
      );
    }
    const deposit = row.depositUsd ?? null;
    return toAgentService({
      name,
      priceKind: kind,
      price,
      maxPrice,
      unit,
      durationMinutes: duration,
      depositUsd: deposit === null ? null : money(deposit, field, name),
    });
  });
}

/** Save the services, as a new version of the agent's words. */
export async function saveServices(
  tx: TenantTx,
  services: AgentService[],
  now: Date = new Date(),
): Promise<void> {
  await writeAgentConfig(tx, { services }, now);
  tx.audit.record({
    action: "update",
    resourceType: "agent_config",
    resourceId: tx.clinicId,
    metadata: {
      services: services.length,
      priced: services.filter((s) => s.priceFromUsd !== null).length,
    },
  });
}

/**
 * Set or clear the deposit on each service, by name. A name not in the list
 * is refused rather than ignored, so a stale form cannot quietly drop one.
 */
export async function saveServiceDeposits(
  tx: TenantTx,
  deposits: Record<string, number | null>,
  now: Date = new Date(),
): Promise<AgentService[]> {
  const { services } = await readKnowledge(tx.db, tx.clinicId);
  const byName = new Map(services.map((s) => [s.name, s]));
  for (const name of Object.keys(deposits)) {
    if (!byName.has(name)) {
      throw new KnowledgeError("deposits", "Your services changed. Reload the page and try again.");
    }
  }
  const next: AgentService[] = services.map((service) => {
    if (!Object.prototype.hasOwnProperty.call(deposits, service.name)) return service;
    const amount = deposits[service.name] ?? null;
    const { depositUsd: _previous, ...rest } = service;
    void _previous;
    return amount === null
      ? rest
      : { ...rest, depositUsd: money(amount, "deposits", service.name) ?? undefined };
  });
  await writeAgentConfig(tx, { services: next }, now);
  tx.audit.record({
    action: "update",
    resourceType: "agent_config",
    resourceId: tx.clinicId,
    metadata: { deposits: next.filter((s) => (s.depositUsd ?? 0) > 0).length },
  });
  return next;
}

// -----------------------------------------------------------------------------
// The most-asked question, quick answers, policies, never-say
// -----------------------------------------------------------------------------

/** Validate a question and its answer, each screened. */
export function validateAnswer(raw: unknown, field: string): KnowledgeAnswer {
  const row = (raw ?? {}) as Partial<KnowledgeAnswer>;
  const question = cleanText(row.question, CLINIC_PROFILE_LIMITS.text);
  const answer = cleanText(row.answer, CLINIC_PROFILE_LIMITS.text);
  if (!question) throw new KnowledgeError(`${field}.question`, "Write the question.");
  if (!answer) throw new KnowledgeError(`${field}.answer`, "Write the answer AYA gives.");
  const findings = findClinicalContent({ question, answer });
  if (findings.length > 0) {
    const finding = findings[0]!;
    throw new KnowledgeError(
      `${field}.${finding.field}`,
      `This mentions ${finding.label} ("${finding.excerpt}"). AYA passes those questions to your team, so leave it out.`,
    );
  }
  return { question, answer };
}

export async function saveMostAsked(
  tx: TenantTx,
  answer: KnowledgeAnswer,
  now: Date = new Date(),
): Promise<void> {
  await writeAgentConfig(tx, { mostAsked: answer }, now);
  tx.audit.record({
    action: "update",
    resourceType: "agent_config",
    resourceId: tx.clinicId,
    metadata: { mostAsked: true },
  });
}

/** The never-say list with the clinical defaults first, then the clinic's own, de-duplicated. */
export function neverSayWithDefaults(own: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const phrase of [...NEVER_SAY_DEFAULTS, ...own]) {
    const clean = cleanText(phrase, NEVER_SAY_LIMITS.chars);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= NEVER_SAY_LIMITS.entries) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// The write
// -----------------------------------------------------------------------------

type KnowledgeColumns = Partial<{
  services: AgentService[];
  policies: string[];
  quickAnswers: KnowledgeAnswer[];
  mostAsked: KnowledgeAnswer | null;
  neverSay: string[];
  promotions: string | null;
}>;

/**
 * One write of the agent's words: the columns given, a new version, and the
 * approval cleared on the row and on the clinic, as every edit to them has
 * always done. The row exists from provisioning; a clinic made before
 * agent_configs gets its own here.
 */
async function writeAgentConfig(tx: TenantTx, columns: KnowledgeColumns, now: Date): Promise<void> {
  const updated = await tx.db
    .update(agentConfigs)
    .set({
      ...columns,
      version: sql`${agentConfigs.version} + 1`,
      approvedAt: null,
      approvedByLabel: null,
      updatedAt: now,
    })
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .returning({ id: agentConfigs.id });
  if (updated.length === 0) {
    throw new KnowledgeError("services", "This practice has no assistant configuration yet.");
  }
  await tx.db
    .update(clinics)
    .set({ agentApprovedAt: null, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Text as knowledge holds it: control characters out, whitespace collapsed, trimmed, capped. */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ");
  return text.replace(/\s+/g, " ").trim().slice(0, max).trimEnd();
}

/** Dollars, to the cent, from $0 to the profile's own cap. */
function money(raw: unknown, field: string, name: string): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "string" ? Number(raw.replace(/[$,\s]/g, "")) : raw;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > CLINIC_PROFILE_LIMITS.priceUsd
  ) {
    throw new KnowledgeError(field, `"${name}": enter the amount in dollars, like 199 or 14.50.`);
  }
  return Math.round(value * 100) / 100;
}

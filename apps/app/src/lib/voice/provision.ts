import { createHash } from "node:crypto";

import { getPlan, type AssistantLanguage } from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { clinics, entitlements, voiceAgents, type VoiceAgentRow, type VoiceEngine } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { passThroughEndsAt, releaseNumberAfterPassThrough } from "@/lib/offboarding/offboarding";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import { readSetupSettings } from "@/lib/setup/settings";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { RetellApiError, retellApiKey, setRetellFallbackNumber, type RetellApiOptions } from "./retell-api";
import {
  checkRetellAgent,
  createRetellAgent,
  deleteRetellAgent,
  getRetellAgent,
  RETELL_DATA_RETENTION_DAYS,
  RETELL_DATA_STORAGE_SETTING,
  RetellAgentConfigError,
  retellAgentSettings,
  updateRetellAgent,
  type RetellAgentOptions,
  type RetellLanguage,
} from "./retell-agent";
import { wantedFallback } from "./retell-fallback-sync";
import {
  bindRetellNumber,
  createRetellPhoneNumber,
  deleteRetellNumber,
  findRetellNumberByNickname,
  getRetellNumber,
  type RetellNumberView,
} from "./retell-numbers";

/**
 * Each clinic's Retell agent and AYA number, set up, kept and released by
 * code (owner, 21 October 2026: "go ahead" with automated voice
 * provisioning), so no clinic's voice line rests on a setting chosen by hand
 * in Retell's dashboard.
 *
 * ## What it does, per clinic (voice_agents, drizzle/0106)
 *
 *   - provisionVoiceAgent: for a clinic whose first invoice is paid and whose
 *     package includes voice, creates its agent (retell-agent.ts: our
 *     storage, one-day retention, engine and webhook), buys an AYA number or
 *     adopts the one the clinic already has, binds the number to the agent
 *     for inbound calls only, sets the number's fallback to the clinic's
 *     direct line (the fallback sync's own rule and call), reads it all back,
 *     and records it as `ready`. Idempotent: each step is skipped once its
 *     result is recorded. Crash-safe: `number_ordered_at` is written before a
 *     number is bought, so a run that died between buying and recording
 *     finds the number by its nickname and never buys a second.
 *   - syncVoiceAgent: rewrites what Retell holds (the agent's settings, its
 *     voice and language; the number's binding and fallback) only when the
 *     hash of that configuration changed.
 *   - checkVoiceAgentDrift: nightly, reads a ready agent and number back,
 *     re-applies the configuration when Retell's copy drifted, tells ops
 *     once per drift, and after MAX_DRIFT_REPAIRS flags it for a person.
 *   - deprovisionVoiceAgent: once the clinic's service has ended and its
 *     pass-through is over (the offboarding flow's own clock), releases the
 *     number and deletes the agent, idempotently.
 *   - verifyVoiceAgent: a read-only report of all of the above. It never
 *     places a call: v1 is inbound only, and nothing here dials.
 *
 * ## The spend guard
 *
 * Buying a number is the one call that costs money. It is made only while
 * the owner's switch HEALDESK_VOICE_PROVISION_ENABLED is exactly "1" (never
 * set from code, off by default), only for a paid clinic, and only while
 * fewer than HEALDESK_VOICE_PROVISION_DAILY_CAP numbers (default 20) were
 * ordered since midnight UTC, across every clinic; over the cap the clinic
 * waits as `pending` and ops is told once that day. With the switch off,
 * provisionVoiceAgent makes no Retell call of any kind. Sync, drift and
 * release write only to what we already own and spend nothing, so they run
 * whenever HEALDESK_RETELL_API_KEY is set: an agent bought while the switch
 * was on must still be released after it is turned off.
 *
 * ## What Retell holds, and what it does not
 *
 * Under the custom engine (the only one built), Retell holds the agent's
 * transport (the WebSocket address, storage and webhook), its voice and its
 * speech language, and the number's binding and fallback. Everything AYA
 * says, the greeting included, comes over our socket from our database, and
 * so do the knowledge, prices, hours, never-say list and coverage mode: a
 * change to any of them needs no Retell call, and a test pins that. (The
 * coverage mode lives on the clinic's own carrier forwarding and in our
 * answer gate, never at Retell.) The native engine would move the greeting
 * and much else into Retell; it is a later package, and a clinic set to it
 * fails here with `not_implemented` and an honest reason.
 *
 * Nothing here holds a patient: Retell's ids, the AYA number (healdesk's
 * own), the clinic's direct line (business contact data), and our own
 * reasons. The LLM secret is in the agent's WebSocket address at Retell and
 * is never hashed, logged or stored here.
 */

const ACTOR: ActorContext = { type: "service", serviceName: "voice-provisioning" };

/** Drift repairs in a row before a person must look. */
export const MAX_DRIFT_REPAIRS = 3;
export const DEFAULT_DAILY_CAP = 20;

/** Retell's speech locale for each language AYA answers in. Retell's locale support beyond its examples is UNCONFIRMED. */
export const RETELL_LOCALE: Readonly<Record<AssistantLanguage, string>> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  pt: "pt-PT",
  zh: "zh-CN",
  vi: "vi-VN",
  ko: "ko-KR",
  ru: "ru-RU",
};

type Env = Readonly<Record<string, string | undefined>>;

/** The owner's switch: exactly "1". Anything else, unset or "true" included, is off. */
export function voiceProvisionEnabled(env: Env = process.env): boolean {
  return env.HEALDESK_VOICE_PROVISION_ENABLED?.trim() === "1";
}

/** Numbers that may be ordered per UTC day; a non-integer or negative value is the default. */
export function voiceProvisionDailyCap(env: Env = process.env): number {
  const raw = env.HEALDESK_VOICE_PROVISION_DAILY_CAP?.trim();
  if (!raw || raw === "__unset__" || !/^\d{1,4}$/.test(raw)) return DEFAULT_DAILY_CAP;
  return Number(raw);
}

/** The Retell voice every agent speaks with, or null while none is chosen. */
export function retellVoiceId(env: Env = process.env): string | null {
  const v = env.HEALDESK_RETELL_VOICE_ID?.trim();
  return v && v !== "__unset__" && /^[A-Za-z0-9_.-]{1,128}$/.test(v) ? v : null;
}

/** Test seam: everything that reaches outside the process. */
export type ProvisionDeps = {
  fetch?: typeof fetch;
  /** HEALDESK_RETELL_API_KEY; from the environment when absent. */
  key?: string | null;
  env?: Env;
  now?: () => Date;
  /** BETTER_AUTH_URL and HEALDESK_RETELL_LLM_SECRET, as retell-agent.ts takes them. */
  publicOrigin?: string | null;
  llmSecret?: string | null;
};

export class VoiceProvisionError extends Error {
  constructor(
    readonly code: VoiceProvisionFailure,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProvisionError";
  }
}

export type VoiceProvisionFailure =
  | "not_implemented"
  | "no_voice"
  | "config"
  | "number_missing"
  | "not_kept"
  | "rejected"
  | "unsupported_country";

export type ProvisionOutcome =
  | { outcome: "not_eligible"; reason: string }
  | { outcome: "switched_off" }
  | { outcome: "no_key" }
  | { outcome: "deferred"; reason: "daily_cap" }
  | { outcome: "already"; status: VoiceAgentRow["status"] }
  | { outcome: "ready"; agentId: string; phoneNumber: string; adopted: boolean }
  | { outcome: "failed"; code: VoiceProvisionFailure; reason: string }
  /** Retell did not answer, or asked us to wait: the job throws and pg-boss retries with backoff. */
  | { outcome: "retry"; reason: string };

// -----------------------------------------------------------------------------
// The facts, read in the clinic's tenant
// -----------------------------------------------------------------------------

type Facts = {
  eligible: boolean;
  reason: string;
  offboardingStartedAt: Date | null;
  destroyedAt: Date | null;
  publishedPhone: string | null;
  assistantNumber: string | null;
  directLine: string | null;
  languages: AssistantLanguage[];
  row: VoiceAgentRow | null;
};

const ENDED_STATUSES = new Set(["suspended", "canceled", "purged"]);

async function readFacts(tx: TenantTx): Promise<Facts> {
  const [clinic] = await tx.db
    .select({
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      publishedPhone: clinics.publishedPhoneE164,
      assistantNumber: clinics.assistantNumberE164,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const [ent] = await tx.db
    .select({
      planCode: entitlements.planCode,
      boughtPlanId: entitlements.boughtPlanId,
      status: entitlements.status,
      firstPaidAt: entitlements.firstPaidAt,
    })
    .from(entitlements)
    .where(eq(entitlements.clinicId, tx.clinicId))
    .limit(1);
  const [row] = await tx.db.select().from(voiceAgents).where(eq(voiceAgents.clinicId, tx.clinicId)).limit(1);
  const settings = await readSetupSettings(tx.db, tx.clinicId);

  let reason = "";
  if (!clinic) reason = "no such clinic";
  else if (clinic.offboardingStartedAt || clinic.destroyedAt) reason = "the clinic's service has ended";
  else if (!ent) reason = "no entitlement";
  else if (!ent.firstPaidAt) reason = "the first invoice is not paid";
  else if (ENDED_STATUSES.has(ent.status)) reason = `billing is ${ent.status}`;
  else if (!getPlan(ent.boughtPlanId ?? ent.planCode)?.channels.voice) reason = "the package bought has no voice";
  return {
    eligible: reason === "",
    reason,
    offboardingStartedAt: clinic?.offboardingStartedAt ?? null,
    destroyedAt: clinic?.destroyedAt ?? null,
    publishedPhone: clinic?.publishedPhone ?? null,
    assistantNumber: clinic?.assistantNumber ?? null,
    directLine: settings.directLineE164,
    languages: settings.languages,
    row: row ?? null,
  };
}

function facts(clinicId: string): Promise<Facts> {
  return withTenant({ clinicId, actor: ACTOR }, readFacts);
}

async function update(clinicId: string, patch: Partial<typeof voiceAgents.$inferInsert>, auditNote?: string): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    await tx.db
      .update(voiceAgents)
      .set({ ...patch, updatedAt: sql`clock_timestamp()` })
      .where(eq(voiceAgents.clinicId, tx.clinicId));
    if (auditNote) {
      tx.audit.record({ action: "update", resourceType: "voice_agent", resourceId: tx.clinicId, metadata: { step: auditNote } });
    }
  });
}

// -----------------------------------------------------------------------------
// The configuration Retell holds, and its hash
// -----------------------------------------------------------------------------

export type VoiceAgentConfig = {
  engine: VoiceEngine;
  voiceId: string;
  language: RetellLanguage;
  /** The clinic's direct line as the number's fallback, or null when it cannot be one. */
  fallback: string | null;
};

function languageOf(languages: AssistantLanguage[]): RetellLanguage {
  const locales = [...new Set(languages.map((l) => RETELL_LOCALE[l]).filter(Boolean))];
  if (locales.length === 0) return RETELL_LOCALE.en;
  return locales.length === 1 ? locales[0]! : locales;
}

/** Pure: what Retell should hold for this clinic. */
export function expectedConfig(
  input: { engine: VoiceEngine; languages: AssistantLanguage[]; directLine: string | null; assistantNumber: string | null; publishedPhone: string | null },
  env: Env,
): VoiceAgentConfig {
  const voiceId = retellVoiceId(env);
  if (!voiceId) throw new VoiceProvisionError("no_voice", "HEALDESK_RETELL_VOICE_ID is not set: no voice is chosen for the agent");
  return {
    engine: input.engine,
    voiceId,
    language: languageOf(input.languages),
    fallback: wantedFallback({ assistantNumber: input.assistantNumber, publishedPhone: input.publishedPhone, directLine: input.directLine }),
  };
}

/**
 * The hash recorded once Retell kept the configuration. Over the public
 * origin, the storage, the engine, the voice, the language and the fallback:
 * never over the LLM secret, which a rotation changes and the drift check
 * catches by reading the agent back.
 */
export function configHash(config: VoiceAgentConfig, publicHost: string): string {
  const canonical = JSON.stringify({
    v: 1,
    host: publicHost,
    storage: RETELL_DATA_STORAGE_SETTING,
    retention: RETELL_DATA_RETENTION_DAYS,
    engine: config.engine,
    voiceId: config.voiceId,
    language: typeof config.language === "string" ? [config.language] : [...config.language],
    fallback: config.fallback,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function agentOptions(engine: VoiceEngine, deps: ProvisionDeps, key: string): RetellAgentOptions {
  if (engine !== "custom") throw new VoiceProvisionError("not_implemented", "the native engine is not built yet: set the clinic back to custom");
  return {
    key,
    fetch: deps.fetch,
    engine: { type: "custom-llm" },
    ...(deps.publicOrigin !== undefined ? { publicOrigin: deps.publicOrigin } : {}),
    ...(deps.llmSecret !== undefined ? { llmSecret: deps.llmSecret } : {}),
  };
}

function publicHost(clinicId: string, options: RetellAgentOptions): string {
  return new URL(retellAgentSettings(clinicId, options).webhook_url).host;
}

/** Our reason, never Retell's body or a URL. */
function reasonOf(error: unknown): { code: VoiceProvisionFailure; reason: string; transient: boolean } {
  if (error instanceof VoiceProvisionError) return { code: error.code, reason: error.message.slice(0, 200), transient: false };
  if (error instanceof RetellAgentConfigError) return { code: "config", reason: error.message.slice(0, 200), transient: false };
  if (error instanceof RetellApiError) {
    const transient = error.status === 429 || error.status >= 500;
    return { code: "rejected", reason: `Retell answered ${error.status}`, transient };
  }
  if (error instanceof Error && /did not keep|without/.test(error.message)) {
    return { code: "not_kept", reason: error.message.slice(0, 200), transient: false };
  }
  // A timeout or a network failure: Retell not answering.
  return { code: "rejected", reason: "Retell did not answer", transient: true };
}

function areaCodeOf(publishedPhone: string | null): { areaCode: number | null; countryCode: "US" | "CA" } | null {
  if (!publishedPhone) return { areaCode: null, countryCode: "US" };
  const m = /^\+1(\d{3})\d{7}$/.exec(publishedPhone);
  // Retell sells US and Canadian numbers only; the NANP area code is the same field for both. Which country is UNCONFIRMED from the number alone, so US.
  if (!m) return null;
  return { areaCode: Number(m[1]), countryCode: "US" };
}

// -----------------------------------------------------------------------------
// Provision
// -----------------------------------------------------------------------------

/**
 * Set up the clinic's agent and number, or carry on a run that stopped part
 * way. Returns what happened; throws only when the database does.
 */
export async function provisionVoiceAgent(clinicId: string, deps: ProvisionDeps = {}): Promise<ProvisionOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const f = await facts(clinicId);
  if (!f.eligible) return { outcome: "not_eligible", reason: f.reason };

  // The row is the job's memory; owed from here, whatever the switch says,
  // so ops can see who is waiting.
  if (!f.row) {
    await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const inserted = await tx.db
        .insert(voiceAgents)
        .values({ clinicId })
        .onConflictDoNothing({ target: voiceAgents.clinicId })
        .returning({ id: voiceAgents.clinicId });
      if (inserted.length) tx.audit.record({ action: "create", resourceType: "voice_agent", resourceId: tx.clinicId });
    });
  }
  const row = f.row ?? (await facts(clinicId)).row!;
  if (row.status === "ready" || row.status === "deprovisioning" || row.status === "released") {
    return { outcome: "already", status: row.status };
  }

  if (row.engine !== "custom") {
    const reason = "the native engine is not built yet: set the clinic back to custom";
    await update(clinicId, { status: "failed", lastError: reason, attempts: row.attempts + 1 }, "failed");
    await notifyOpsOnce("voice_provision_failed", { clinicId, code: "not_implemented" });
    return { outcome: "failed", code: "not_implemented", reason };
  }

  // The spend guard, before any call to Retell.
  if (!voiceProvisionEnabled(env)) return { outcome: "switched_off" };
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { outcome: "no_key" };
  const api: RetellApiOptions = { key, fetch: deps.fetch, timeoutMs: 10_000 };

  let config: VoiceAgentConfig;
  let options: RetellAgentOptions;
  try {
    options = agentOptions(row.engine, deps, key);
    config = expectedConfig({ engine: row.engine, languages: f.languages, directLine: f.directLine, assistantNumber: row.phoneNumberE164 ?? f.assistantNumber, publishedPhone: f.publishedPhone }, env);
    publicHost(clinicId, options);
  } catch (error) {
    return fail(clinicId, row, error);
  }

  await update(clinicId, { status: "provisioning", attempts: row.attempts + 1 });
  let agentId = row.retellAgentId;
  let number = row.phoneNumberE164;
  let adopted = false;
  try {
    // 1. The agent: free, so a crash before recording leaves an unused agent, never a charge.
    if (!agentId) {
      const created = await createRetellAgent(clinicId, { voiceId: config.voiceId, language: config.language }, options);
      agentId = created.agentId;
      await update(clinicId, { retellAgentId: agentId }, "agent_created");
    }

    // 2. The number: the clinic's own, one bought before a crash, or a new one.
    let view: RetellNumberView | null = null;
    if (!number && f.assistantNumber) {
      view = await getRetellNumber(f.assistantNumber, api);
      if (!view) throw new VoiceProvisionError("number_missing", "the clinic's AYA number is not in this Retell workspace");
      adopted = true;
    }
    if (!number && !view && row.numberOrderedAt) {
      view = await findRetellNumberByNickname(clinicId, api);
      if (view) adopted = true;
    }
    if (!number && !view) {
      const where = areaCodeOf(f.publishedPhone);
      if (!where) throw new VoiceProvisionError("unsupported_country", "Retell sells US and Canadian numbers only, and the clinic's number is neither");
      const reserved = await reserveOrder(clinicId, voiceProvisionDailyCap(env), now());
      if (!reserved) {
        await update(clinicId, { status: "pending", lastError: "waiting: the daily cap on numbers bought is reached" });
        await notifyOpsOnce("voice_provision_cap_reached", { windowStart: now().toISOString().slice(0, 10), count: voiceProvisionDailyCap(env) });
        return { outcome: "deferred", reason: "daily_cap" };
      }
      view = await createRetellPhoneNumber({ clinicId, agentId, ...where }, api);
    }
    if (view) {
      number = view.phoneNumber;
      await recordNumber(clinicId, number);
    }
    if (!number) throw new VoiceProvisionError("number_missing", "no number was bought or found");

    // 3. Wire and verify.
    const hash = await applyNumberAndVerify(clinicId, agentId, number, config, options, api);
    await update(clinicId, { status: "ready", configHash: hash, lastSyncedAt: now(), lastError: null, driftRepairs: 0, driftFlaggedAt: null }, "ready");
    log.info("voice agent ready", { clinicId, outcome: adopted ? "adopted" : "bought" });
    return { outcome: "ready", agentId, phoneNumber: number, adopted };
  } catch (error) {
    return fail(clinicId, { ...row, attempts: row.attempts + 1 }, error);
  }
}

async function fail(clinicId: string, row: VoiceAgentRow, error: unknown): Promise<ProvisionOutcome> {
  const r = reasonOf(error);
  log.error("voice provisioning stopped", { clinicId, code: r.code, error: describeError(error) });
  if (r.transient) {
    await update(clinicId, { status: "provisioning", lastError: r.reason });
    return { outcome: "retry", reason: r.reason };
  }
  await update(clinicId, { status: "failed", lastError: r.reason }, "failed");
  await notifyOpsOnce("voice_provision_failed", { clinicId, code: r.code, count: row.attempts });
  return { outcome: "failed", code: r.code, reason: r.reason };
}

/**
 * Write number_ordered_at before buying, under a transaction-wide lock so
 * two runs cannot both pass the cap. False when the day's cap is reached.
 */
async function reserveOrder(clinicId: string, cap: number, at: Date): Promise<boolean> {
  const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    await tx.db.execute(sql`select pg_advisory_xact_lock(hashtext('voice_agents.number_ordered_at'))`);
    const result = await tx.db.execute<{ n: number }>(sql`select app_voice_numbers_ordered_since(${dayStart.toISOString()}::timestamptz) as n`);
    const ordered = Number(result.rows[0]?.n ?? 0);
    if (ordered >= cap) return false;
    await tx.db
      .update(voiceAgents)
      .set({ numberOrderedAt: at, updatedAt: sql`clock_timestamp()` })
      .where(eq(voiceAgents.clinicId, tx.clinicId));
    tx.audit.record({ action: "update", resourceType: "voice_agent", resourceId: tx.clinicId, metadata: { step: "number_ordered" } });
    return true;
  });
}

/** The number on our row, and on the clinic as its AYA number when it has none. */
async function recordNumber(clinicId: string, number: string): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    await tx.db
      .update(voiceAgents)
      .set({ phoneNumberE164: number, updatedAt: sql`clock_timestamp()` })
      .where(eq(voiceAgents.clinicId, tx.clinicId));
    await tx.db
      .update(clinics)
      .set({ assistantNumberE164: number })
      .where(and(eq(clinics.id, tx.clinicId), isNull(clinics.assistantNumberE164)));
    tx.audit.record({ action: "update", resourceType: "voice_agent", resourceId: tx.clinicId, metadata: { step: "number_recorded" } });
  });
}

/** Bind the number, set its fallback, read both back; returns the hash of what Retell kept. */
async function applyNumberAndVerify(
  clinicId: string,
  agentId: string,
  number: string,
  config: VoiceAgentConfig,
  options: RetellAgentOptions,
  api: RetellApiOptions,
): Promise<string> {
  const bound = await bindRetellNumber(number, { clinicId, agentId }, api);
  if (bound.fallbackNumber !== config.fallback) await setRetellFallbackNumber(number, config.fallback, api);
  const report = await readBack(clinicId, agentId, number, config, options, api);
  if (report.problems.length) throw new VoiceProvisionError("not_kept", `Retell did not keep: ${report.problems.join(", ")}`);
  return configHash(config, publicHost(clinicId, options));
}

// -----------------------------------------------------------------------------
// Read back
// -----------------------------------------------------------------------------

export type VoiceAgentProblem =
  | "agent_missing"
  | "storage"
  | "engine"
  | "webhook"
  | "voice"
  | "language"
  | "number_missing"
  | "number_agent"
  | "number_outbound"
  | "fallback";

type ReadBack = { agentExists: boolean; numberExists: boolean; problems: VoiceAgentProblem[] };

function sameLanguage(actual: unknown, expected: RetellLanguage): boolean {
  const want = typeof expected === "string" ? [expected] : [...expected];
  const got = typeof actual === "string" ? [actual] : Array.isArray(actual) ? actual : null;
  return got !== null && got.length === want.length && [...got].sort().join() === [...want].sort().join();
}

async function readBack(
  clinicId: string,
  agentId: string,
  number: string,
  config: VoiceAgentConfig,
  options: RetellAgentOptions,
  api: RetellApiOptions,
): Promise<ReadBack> {
  const problems: VoiceAgentProblem[] = [];
  const agent = await getRetellAgent(agentId, options);
  if (!agent) problems.push("agent_missing");
  else {
    const check = checkRetellAgent(agent, clinicId, options);
    if (!check.storageAsWritten) problems.push("storage");
    if (!check.engineIsOurs) problems.push("engine");
    if (!check.webhookIsOurs) problems.push("webhook");
    const a = agent as { voice_id?: unknown; language?: unknown };
    if (a.voice_id !== config.voiceId) problems.push("voice");
    if (!sameLanguage(a.language, config.language)) problems.push("language");
  }
  const n = await getRetellNumber(number, api);
  if (!n) problems.push("number_missing");
  else {
    if (n.inboundAgentIds.length !== 1 || n.inboundAgentIds[0] !== agentId) problems.push("number_agent");
    if (n.outboundAgents !== 0) problems.push("number_outbound");
    if (n.fallbackNumber !== config.fallback) problems.push("fallback");
  }
  return { agentExists: Boolean(agent), numberExists: Boolean(n), problems };
}

// -----------------------------------------------------------------------------
// Sync on change
// -----------------------------------------------------------------------------

export type SyncOutcome =
  | { outcome: "unchanged" }
  | { outcome: "synced" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Write what Retell holds again, only when its hash changed: a new voice or
 * language, a changed direct line, a new public origin. A change to anything
 * only our database holds hashes the same and makes no call.
 */
export async function syncVoiceAgent(clinicId: string, deps: ProvisionDeps = {}): Promise<SyncOutcome> {
  const env = deps.env ?? process.env;
  const f = await facts(clinicId);
  const row = f.row;
  if (!row || row.status !== "ready" || !row.retellAgentId || !row.phoneNumberE164) return { outcome: "skipped", reason: "not ready" };
  if (row.engine !== "custom") return { outcome: "skipped", reason: "native engine not built" };
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { outcome: "skipped", reason: "no key" };
  const api: RetellApiOptions = { key, fetch: deps.fetch, timeoutMs: 10_000 };
  try {
    const options = agentOptions(row.engine, deps, key);
    const config = expectedConfig({ engine: row.engine, languages: f.languages, directLine: f.directLine, assistantNumber: row.phoneNumberE164, publishedPhone: f.publishedPhone }, env);
    const hash = configHash(config, publicHost(clinicId, options));
    if (hash === row.configHash) return { outcome: "unchanged" };
    await reapply(clinicId, row.retellAgentId, row.phoneNumberE164, config, options, api);
    await update(clinicId, { configHash: hash, lastSyncedAt: (deps.now ?? (() => new Date()))(), lastError: null }, "synced");
    return { outcome: "synced" };
  } catch (error) {
    const r = reasonOf(error);
    log.error("voice agent not synced", { clinicId, code: r.code, error: describeError(error) });
    await update(clinicId, { lastError: r.reason });
    await notifyOps("voice_provision_failed", { clinicId, code: r.code, phase: "sync" });
    return { outcome: "failed", reason: r.reason };
  }
}

async function reapply(
  clinicId: string,
  agentId: string,
  number: string,
  config: VoiceAgentConfig,
  options: RetellAgentOptions,
  api: RetellApiOptions,
): Promise<void> {
  await updateRetellAgent(agentId, clinicId, options, { voiceId: config.voiceId, language: config.language });
  await applyNumberAndVerify(clinicId, agentId, number, config, options, api);
}

// -----------------------------------------------------------------------------
// Drift
// -----------------------------------------------------------------------------

export type DriftOutcome =
  | { outcome: "clean" }
  | { outcome: "repaired"; problems: VoiceAgentProblem[] }
  | { outcome: "flagged"; problems: VoiceAgentProblem[] }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Read a ready clinic's agent and number back and compare them with what
 * they should be. Drift that re-applying can fix is fixed, and ops told once
 * for that drift; after MAX_DRIFT_REPAIRS repairs without a clean read the
 * clinic is flagged and left for a person. An agent or a number gone from
 * Retell is never re-created here: that is a person's call.
 */
export async function checkVoiceAgentDrift(clinicId: string, deps: ProvisionDeps = {}): Promise<DriftOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const f = await facts(clinicId);
  const row = f.row;
  if (!row || row.status !== "ready" || !row.retellAgentId || !row.phoneNumberE164) return { outcome: "skipped", reason: "not ready" };
  if (row.driftFlaggedAt) return { outcome: "skipped", reason: "flagged for a person" };
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { outcome: "skipped", reason: "no key" };
  const api: RetellApiOptions = { key, fetch: deps.fetch, timeoutMs: 10_000 };
  try {
    const options = agentOptions(row.engine, deps, key);
    const config = expectedConfig({ engine: row.engine, languages: f.languages, directLine: f.directLine, assistantNumber: row.phoneNumberE164, publishedPhone: f.publishedPhone }, env);
    const back = await readBack(clinicId, row.retellAgentId, row.phoneNumberE164, config, options, api);
    if (back.problems.length === 0) {
      if (row.driftRepairs !== 0) await update(clinicId, { driftRepairs: 0 });
      return { outcome: "clean" };
    }
    const code = back.problems[0]!;
    const unrepairable = !back.agentExists || !back.numberExists;
    if (unrepairable || row.driftRepairs >= MAX_DRIFT_REPAIRS) {
      await update(clinicId, { driftFlaggedAt: now(), lastError: `drift left for a person: ${back.problems.join(", ")}`.slice(0, 200) }, "drift_flagged");
      await notifyOpsOnce("voice_agent_drift", { clinicId, code, status: "flagged", count: row.driftRepairs });
      return { outcome: "flagged", problems: back.problems };
    }
    await reapply(clinicId, row.retellAgentId, row.phoneNumberE164, config, options, api);
    await update(
      clinicId,
      { driftRepairs: row.driftRepairs + 1, configHash: configHash(config, publicHost(clinicId, options)), lastSyncedAt: now() },
      "drift_repaired",
    );
    // Once per drift: the repair's count is in the key.
    await notifyOpsOnce("voice_agent_drift", { clinicId, code, status: "repaired", count: row.driftRepairs + 1 });
    return { outcome: "repaired", problems: back.problems };
  } catch (error) {
    const r = reasonOf(error);
    log.error("voice agent drift check failed", { clinicId, code: r.code, error: describeError(error) });
    return { outcome: "failed", reason: r.reason };
  }
}

// -----------------------------------------------------------------------------
// Deprovision
// -----------------------------------------------------------------------------

export type DeprovisionOutcome =
  | { outcome: "not_due"; reason: string }
  | { outcome: "released"; numberDeleted: boolean; agentDeleted: boolean }
  | { outcome: "already" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Release the clinic's number and delete its agent at Retell, once its
 * service has ended AND the forwarding pass-through has (the offboarding
 * flow's clock, passThroughEndsAt): until then the agent is what passes a
 * forwarded call through to the clinic's direct line, so a live clinic, or
 * one still passing calls through, never loses its number here.
 *
 * It does not record the care page's "agent released" step
 * (recordVoiceVendorDeletion): that step also says every call since was
 * deleted at Retell, which deleting the agent does not do.
 */
export async function deprovisionVoiceAgent(clinicId: string, deps: ProvisionDeps = {}): Promise<DeprovisionOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const f = await facts(clinicId);
  const row = f.row;
  if (!row) return { outcome: "not_due", reason: "nothing provisioned" };
  if (row.status === "released") return { outcome: "already" };
  if (!f.offboardingStartedAt) return { outcome: "not_due", reason: "the clinic's service has not ended" };
  if (now.getTime() < passThroughEndsAt(f.offboardingStartedAt).getTime()) {
    return { outcome: "not_due", reason: "forwarded calls still pass through" };
  }
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { outcome: "skipped", reason: "no key" };
  const api: RetellApiOptions = { key, fetch: deps.fetch, timeoutMs: 10_000 };
  if (row.status !== "deprovisioning") await update(clinicId, { status: "deprovisioning" }, "deprovisioning");
  try {
    let numberDeleted = false;
    let agentDeleted = false;
    if (row.phoneNumberE164) numberDeleted = (await deleteRetellNumber(row.phoneNumberE164, api)) === "deleted";
    if (row.retellAgentId) agentDeleted = (await deleteRetellAgent(row.retellAgentId, api)) === "deleted";
    await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      await tx.db
        .update(voiceAgents)
        .set({ status: "released", releasedAt: now, lastError: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(voiceAgents.clinicId, tx.clinicId));
      // The same number off the clinic row, by offboarding's own guard.
      await releaseNumberAfterPassThrough(tx);
      tx.audit.record({ action: "update", resourceType: "voice_agent", resourceId: tx.clinicId, metadata: { step: "released" } });
    });
    return { outcome: "released", numberDeleted, agentDeleted };
  } catch (error) {
    const r = reasonOf(error);
    log.error("voice agent not released", { clinicId, code: r.code, error: describeError(error) });
    await update(clinicId, { lastError: r.reason });
    await notifyOpsOnce("voice_deprovision_failed", { clinicId, code: r.code, windowStart: now.toISOString().slice(0, 10) });
    return { outcome: "failed", reason: r.reason };
  }
}

// -----------------------------------------------------------------------------
// The report
// -----------------------------------------------------------------------------

export type VoiceAgentReport = {
  clinicId: string;
  status: VoiceAgentRow["status"] | "none";
  engine: VoiceEngine | null;
  /** Every check passed: the agent and number exist and hold what they should. */
  ok: boolean;
  checked: boolean;
  agentExists: boolean | null;
  numberExists: boolean | null;
  problems: VoiceAgentProblem[];
  /** Why nothing was read, when nothing was. */
  note: string | null;
};

/**
 * Confirm the clinic's agent, number, fallback, webhook and storage are as
 * they should be, by reading them (GET only). Never places a call, and
 * writes nothing.
 */
export async function verifyVoiceAgent(clinicId: string, deps: ProvisionDeps = {}): Promise<VoiceAgentReport> {
  const env = deps.env ?? process.env;
  const f = await facts(clinicId);
  const row = f.row;
  const base: VoiceAgentReport = {
    clinicId,
    status: row?.status ?? "none",
    engine: row?.engine ?? null,
    ok: false,
    checked: false,
    agentExists: null,
    numberExists: null,
    problems: [],
    note: null,
  };
  if (!row || !row.retellAgentId || !row.phoneNumberE164) return { ...base, note: "nothing provisioned yet" };
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { ...base, note: "HEALDESK_RETELL_API_KEY is not set" };
  try {
    const options = agentOptions(row.engine, deps, key);
    const config = expectedConfig({ engine: row.engine, languages: f.languages, directLine: f.directLine, assistantNumber: row.phoneNumberE164, publishedPhone: f.publishedPhone }, env);
    const back = await readBack(clinicId, row.retellAgentId, row.phoneNumberE164, config, options, { key, fetch: deps.fetch, timeoutMs: 10_000 });
    return { ...base, checked: true, ok: back.problems.length === 0, agentExists: back.agentExists, numberExists: back.numberExists, problems: back.problems };
  } catch (error) {
    return { ...base, note: reasonOf(error).reason };
  }
}

// -----------------------------------------------------------------------------
// The ops projection
// -----------------------------------------------------------------------------

/** One clinic's voice set-up, as /admin shows it: ids, status and times. Never a patient, a caller or a secret. */
export type VoiceAgentStatusView = {
  clinicId: string;
  engine: VoiceEngine;
  status: VoiceAgentRow["status"];
  retellAgentId: string | null;
  hasNumber: boolean;
  attempts: number;
  lastError: string | null;
  lastSyncedAt: string | null;
  numberOrderedAt: string | null;
  driftRepairs: number;
  driftFlaggedAt: string | null;
  releasedAt: string | null;
  updatedAt: string;
};

export function voiceAgentStatusView(row: VoiceAgentRow): VoiceAgentStatusView {
  return {
    clinicId: row.clinicId,
    engine: row.engine,
    status: row.status,
    retellAgentId: row.retellAgentId,
    hasNumber: row.phoneNumberE164 !== null,
    attempts: row.attempts,
    lastError: row.lastError,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    numberOrderedAt: row.numberOrderedAt?.toISOString() ?? null,
    driftRepairs: row.driftRepairs,
    driftFlaggedAt: row.driftFlaggedAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The row for one clinic, read in its tenant; null when it has none. */
export async function voiceAgentRow(clinicId: string): Promise<VoiceAgentRow | null> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [row] = await tx.db.select().from(voiceAgents).where(eq(voiceAgents.clinicId, tx.clinicId)).limit(1);
    return row ?? null;
  });
}

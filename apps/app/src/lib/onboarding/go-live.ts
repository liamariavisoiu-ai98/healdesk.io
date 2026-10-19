import {
  agreementKindSufficient,
  CHANNEL_NAMES,
  CURRENT_BAA_VERSION,
  type AgreementKind,
  type Channel,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import { agreementTemplateReleased } from "@/lib/agreements/kind";
import { recordSecurityEvent } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import type { LiveInput } from "@/lib/channels/events";
import { ANSWER_GATE_CHANNELS, gateBNotBuilt } from "@/lib/compliance/gate-b";
import { SUBJECT_WORDS } from "@/lib/compliance/platform";
import type { PlatformSubject } from "@/lib/compliance/subjects";
import type { TenantTx } from "@/lib/tenant";

/**
 * Go-live: the flip from synthetic to production, automatic since WP2 (plan
 * Part G, "Automatic go-live": "No operator step").
 *
 * The audit-pass event fires it: when a channel's practice questions pass
 * (lib/engine/practice/store.ts, afterPass), or any other input of a channel
 * arrives, the channel events' writer (lib/channels/events.ts, evaluate)
 * asks `goLivePreconditions` here, and when nothing is missing calls
 * app_mark_clinic_production() (drizzle/0085) in the clinic's own tenant,
 * which re-checks everything itself and refuses on its own. The channel then
 * goes live in the same transaction, and the purge, which follows the
 * agreement in effect, already applies to the clinic.
 *
 * What go-live asks, in order (the codes are app_go_live_missing()'s, and
 * tests/go-live.test.ts runs fixtures through both):
 *
 *   1. `leaving`: the clinic has not started offboarding or been destroyed;
 *   2. `demo`: it is not healdesk's own demo clinic, which never goes live;
 *   3. `covered_status`: its covered-entity status is determined, where its
 *      regime asks it (hipaa-if-covered); `hipaa` is covered in practice and
 *      `non-hipaa` is outside HIPAA by definition;
 *   4. the agreement (plan Part L): one is in effect (`no_agreement`); its
 *      version may go live for its kind, a released DPA or a BAA no older
 *      than the floor (`agreement_version`, agreementTemplateReleased, the
 *      twin of app_agreement_version_acceptable); it is the kind the clinic
 *      records (`agreement_kind_mismatch`); and it covers the practice
 *      (`agreement_insufficient`, app_agreement_kind_sufficient);
 *   5. `platform`: what every channel needs attested in platform_compliance
 *      (the model provider, the database host, AWS, the launch promises);
 *   6. `gate_b`: at least one channel meets Gate B: its live inputs but the
 *      go-live itself (its runtime, its practice questions, setup, the
 *      clinic's own step), its own attestations (Retell and phone's tests;
 *      the other channels' runtimes) and the answer gate.
 *
 * What Gate B names but does not ask, because it is not built, is listed
 * beside the answer as `notBuilt` (lib/compliance/gate-b.ts).
 *
 * A refusal leaves the clinic as it is and says why: to the operator here
 * and in the console's go-live view, to ops once per reason
 * (go_live_held), and to the clinic on Home's tracker. Nothing here ever
 * takes a live channel offline: go-live happens once, and a channel's
 * `live_at` is set once.
 *
 * Tenant plane, no patient data: codes, versions and dates.
 */

export const GO_LIVE_CODES = [
  "leaving",
  "demo",
  "covered_status",
  "no_agreement",
  "agreement_version",
  "agreement_kind_mismatch",
  "agreement_insufficient",
  "platform",
  "gate_b",
] as const;
export type GoLiveCode = (typeof GO_LIVE_CODES)[number];

export type GoLiveMissing = {
  code: GoLiveCode;
  /** The operator's words: what is missing, and where it is put right. */
  text: string;
  /** Whose move it is: the practice's (its setup, its agreement) or ours (the platform). */
  side: "clinic" | "ours";
};

/** One channel against Gate B. */
export type GoLiveChannelGate = {
  channel: Channel;
  /** Already live: it met Gate B when it went. */
  live: boolean;
  /** Everything its `live` asks but the clinic's go-live and what every channel shares. */
  met: boolean;
  /** What it still waits on, as its live inputs; never `go_live`. */
  missing: readonly LiveInput[];
  /** Its own attestations not in place. */
  platform: readonly PlatformSubject[];
};

export type GoLiveFacts = {
  production: boolean;
  leaving: boolean;
  demo: boolean;
  regulatoryRegime: string | null;
  /** The kind the clinic records (a gate column, 0051). */
  agreementKind: AgreementKind | null;
  isCoveredEntity: boolean | null;
  /** The agreement in effect (app_agreement_in_effect), its version and kind. */
  agreement: { version: string; kind: AgreementKind } | null;
  /** What every channel needs attested and is not. */
  platform: readonly PlatformSubject[];
  channels: readonly GoLiveChannelGate[];
};

export type GoLiveCheck = {
  ok: boolean;
  missing: GoLiveMissing[];
  /** What Gate B names and go-live does not ask, because it is not built. */
  notBuilt: string[];
};

const KIND_WORDS: Record<AgreementKind, string> = {
  baa: "business associate agreement",
  dpa: "data protection agreement",
};

/** A channel's live input, in the go-live view's words. */
const INPUT_WORDS: Record<LiveInput, string> = {
  leaving: "the clinic has left",
  audit: "its practice questions",
  runtime: "our half of its runtime",
  setup: "setup",
  hours: "confirmed hours",
  direct_line: "a direct line",
  vet_referral: "an emergency referral number",
  prices_checked: "a check of its prices",
  covered_status: "the covered status",
  clinic_step: "the clinic's own step",
  platform: "its attestations",
  go_live: "go-live",
};

let notBuiltMemo: string[] | null = null;

/** Gate B's items that are not built; the template registry is static, so read once. */
function notBuiltNow(): string[] {
  notBuiltMemo ??= gateBNotBuilt();
  return [...notBuiltMemo];
}

/** Pure: what stands between the clinic and production, in the database's order. */
export function goLivePreconditions(facts: GoLiveFacts): GoLiveCheck {
  const missing: GoLiveMissing[] = [];
  const add = (code: GoLiveCode, text: string, side: GoLiveMissing["side"]) =>
    missing.push({ code, text, side });

  if (facts.leaving) add("leaving", "The clinic has left: it never goes live.", "clinic");
  if (facts.demo) {
    add(
      "demo",
      "This is a demo clinic, and a demo clinic never goes live. Provision the real practice through checkout instead.",
      "ours",
    );
  }
  if (facts.regulatoryRegime === "hipaa-if-covered" && facts.isCoveredEntity === null) {
    add(
      "covered_status",
      "Covered-entity status is undetermined: the practice answers it in setup, or it is recorded on the account page.",
      "clinic",
    );
  }
  if (facts.agreement === null) {
    add("no_agreement", "No signed agreement is in effect for this account.", "clinic");
  } else {
    const { version, kind } = facts.agreement;
    if (!agreementTemplateReleased(version)) {
      add(
        "agreement_version",
        kind === "dpa"
          ? `The agreement in effect is DPA ${version}, which is not released. The DPA's release lets it go live.`
          : `The agreement in effect is BAA v${version}, which has been superseded. The practice must accept v${CURRENT_BAA_VERSION} before go-live.`,
        "clinic",
      );
    }
    if (facts.agreementKind !== kind) {
      add(
        "agreement_kind_mismatch",
        `The clinic records ${facts.agreementKind ? `a ${KIND_WORDS[facts.agreementKind]}` : "no agreement kind"}, and the agreement in effect is a ${KIND_WORDS[kind]}.`,
        "clinic",
      );
    }
    if (!agreementKindSufficient(facts.regulatoryRegime, kind, facts.isCoveredEntity)) {
      add(
        "agreement_insufficient",
        `The ${KIND_WORDS[kind]} in effect does not cover this practice: a practice HIPAA reaches signs a business associate agreement first.`,
        "clinic",
      );
    }
  }
  if (facts.platform.length > 0) {
    add(
      "platform",
      `Not attested on /admin/compliance: ${facts.platform.map((s) => SUBJECT_WORDS[s].label).join(", ")}.`,
      "ours",
    );
  }
  if (!facts.channels.some((c) => gateBMet(c))) {
    add("gate_b", gateBText(facts.channels), facts.channels.some((c) => c.missing.length === 0) ? "ours" : "clinic");
  }
  return { ok: missing.length === 0, missing, notBuilt: notBuiltNow() };
}

/** Gate B for one channel, as go-live asks it: the answer gate is the code's part. */
export function gateBMet(gate: GoLiveChannelGate): boolean {
  return gate.met && ANSWER_GATE_CHANNELS.includes(gate.channel);
}

function gateBText(channels: readonly GoLiveChannelGate[]): string {
  if (channels.length === 0) return "No channel is bought, so none can go live.";
  const lines = channels.map((c) => {
    const waits = [
      ...c.missing.map((m) => INPUT_WORDS[m]),
      ...c.platform.map((s) => SUBJECT_WORDS[s].label),
      ...(ANSWER_GATE_CHANNELS.includes(c.channel) ? [] : ["the answer gate"]),
    ];
    return `${CHANNEL_NAMES[c.channel]} waits on ${waits.length ? waits.join(", ") : "nothing"}`;
  });
  return `No channel meets Gate B yet. ${lines.join("; ")}.`;
}

/** The codes alone, in order: what tests/go-live.test.ts compares with app_go_live_missing(). */
export function goLiveCodes(check: GoLiveCheck): GoLiveCode[] {
  return check.missing.map((m) => m.code);
}

// -----------------------------------------------------------------------------
// The facts
// -----------------------------------------------------------------------------

/**
 * Read the clinic's go-live facts in its own transaction, beside the channel
 * gates and the shared attestations the caller has from its readiness facts
 * (lib/channels/events.ts). Null when there is no such clinic.
 */
export async function readGoLiveFacts(
  tx: TenantTx,
  input: { channels: readonly GoLiveChannelGate[]; platform: readonly PlatformSubject[] },
): Promise<GoLiveFacts | null> {
  const [clinic] = await tx.db
    .select({
      dataClassification: clinics.dataClassification,
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      regulatoryRegime: clinics.regulatoryRegime,
      agreementKind: clinics.agreementKind,
      isCoveredEntity: clinics.isCoveredEntity,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;
  const inEffect = await agreementInEffect(tx);
  return {
    production: clinic.dataClassification === "production",
    leaving: clinic.offboardingStartedAt !== null || clinic.destroyedAt !== null,
    demo: await isDemoClinic(tx),
    regulatoryRegime: clinic.regulatoryRegime,
    agreementKind: clinic.agreementKind,
    isCoveredEntity: clinic.isCoveredEntity,
    agreement: inEffect ? { version: inEffect.documentVersion, kind: inEffect.agreementKind } : null,
    platform: input.platform,
    channels: input.channels,
  };
}

// -----------------------------------------------------------------------------
// The flip
// -----------------------------------------------------------------------------

/** What set go-live off: the practice questions' pass, another channel input, the hourly sweep, or an operator asking. */
export type GoLiveVia = "practice_questions" | "channel_event" | "sweep" | "operator";

/** The label automatic go-lives are recorded under: no person did it. */
export const AUTOMATIC_GO_LIVE_ACTOR = "healdesk (automatic go-live)";

export type GoLiveResult =
  | { status: "live"; baaSignedAt: Date }
  | { status: "refused"; reason: string };

/**
 * app_mark_clinic_production() in the clinic's own tenant, in a savepoint so
 * a refusal leaves the caller's transaction, and whatever it recorded, as it
 * was. On a flip, the security event naming what set it off, in the same
 * transaction: the event and the flip commit together or not at all.
 */
export async function markClinicProduction(
  tx: TenantTx,
  input: {
    via: GoLiveVia;
    actorLabel?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    clinicSlug?: string;
  },
): Promise<GoLiveResult> {
  let signed: Date | null;
  try {
    signed = await tx.db.transaction(async (savepoint) => {
      const result = await savepoint.execute<{ signed: Date | string | null }>(
        sql`select app_mark_clinic_production(${tx.clinicId}::uuid) as signed`,
      );
      const value = result.rows[0]?.signed;
      return value ? new Date(value) : null;
    });
  } catch (error) {
    return { status: "refused", reason: refusalReason(error) };
  }
  if (!signed) return { status: "refused", reason: "The database refused without a reason." };
  await recordSecurityEvent(tx.db, {
    event: "clinic_went_live",
    actorLabel: input.actorLabel ?? AUTOMATIC_GO_LIVE_ACTOR,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    // No timestamp in the metadata: the audit scanner reads a date's digit
    // run as a phone number, and the flip's time is on the clinic row.
    metadata: { ...(input.clinicSlug ? { clinicSlug: input.clinicSlug } : {}), via: input.via, baaSigned: true },
  });
  return { status: "live", baaSignedAt: signed };
}

/**
 * The database's own refusal, not drizzle's wrapper around it.
 *
 * drizzle-orm 0.45 wraps the driver error in a `DrizzleQueryError` whose
 * message is "Failed query: select app_mark_clinic_production($1::uuid) …"
 * followed by the parameters; the RAISE text and its HINT sit on the pg
 * error at `.cause`. Until this walked the chain, every refusal the database
 * made reached the console as the failed query. Bounded depth, as
 * lib/provisioning.ts and the connect action walk it. An error with no
 * SQLSTATE anywhere in the chain (the database unreachable, say) keeps its
 * own message.
 */
export function refusalReason(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; hint?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.message === "string") {
      const hint = typeof e.hint === "string" && e.hint ? ` ${e.hint}` : "";
      return `${e.message}${hint}`.slice(0, 500);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message.slice(0, 500) : "Refused.";
}

// -----------------------------------------------------------------------------
// The clinic's view
// -----------------------------------------------------------------------------

/** What Home's tracker shows of go-live: done, or the one thing to say about it. */
export type GoLiveSummary = { production: boolean; line: string };

/**
 * The tracker's line, in the practice's words. Its own moves first (setup,
 * the agreement), then a channel's, then ours. Ours is said as ours, without
 * the vendor names the console uses. Never the words "patients" or
 * "clients": AYA "answers anyone".
 */
export function goLiveSummary(production: boolean, check: GoLiveCheck): GoLiveSummary {
  if (production) {
    return {
      production,
      line: "Everything on our side is in place: each channel goes live as soon as its own step is done.",
    };
  }
  const codes = new Set(goLiveCodes(check));
  if (codes.has("leaving")) return { production, line: "This account has closed." };
  if (codes.has("demo")) return { production, line: "This is a demo account, so it never goes live." };
  if (codes.has("covered_status")) {
    return {
      production,
      line: "Tell us in setup whether you bill insurance electronically: it decides which agreement covers your practice.",
    };
  }
  if (
    codes.has("no_agreement") ||
    codes.has("agreement_version") ||
    codes.has("agreement_kind_mismatch") ||
    codes.has("agreement_insufficient")
  ) {
    return {
      production,
      line: "Your agreement has to be signed again before AYA answers anyone. Our team has been told and will contact you about it.",
    };
  }
  if (codes.has("gate_b")) {
    return {
      production,
      line: "AYA goes live on a channel once her practice questions pass and that channel's own step is done: Your channels, below, says what each still needs.",
    };
  }
  if (codes.has("platform")) {
    return {
      production,
      line: "Your part is done. We're finishing the last checks on our side before AYA answers anyone, and she goes live without anything more from you.",
    };
  }
  return { production, line: "AYA goes live as soon as your first channel is ready." };
}

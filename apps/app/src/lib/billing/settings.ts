import { eq, sql } from "drizzle-orm";

import { clinicSettings, clinics, type DepositUncollectable } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Per-clinic switches the portal and the console edit (design D9): deposits,
 * Pause AI and the direct line.
 *
 * They live in clinic_settings rather than on clinics or agent_configs for two
 * reasons. An agent_configs edit is a new version that clears the clinic's
 * approval of the script, and flipping Pause AI must never do that. And a new
 * clinics column needs its own column grant and a rebuilt overview function,
 * where this table is the clinic's own row under the ordinary tenant policy.
 *
 * A missing row means the defaults below — the table is created empty and a
 * clinic gets a row on its first edit — so readers never have to seed one.
 */

export type ClinicSettings = {
  depositsEnabled: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
  aiPausedAt: Date | null;
  aiPausedByLabel: string | null;
  directLineE164: string | null;
  directLineSetAt: Date | null;
  /** Null when the clinic has never saved a setting (no row). */
  updatedAt: Date | null;
};

/** Must match the column defaults in drizzle/0043. tests/clinic-settings.test.ts compares them. */
export const DEFAULT_CLINIC_SETTINGS: ClinicSettings = Object.freeze({
  depositsEnabled: false,
  bookVoiceWithoutDeposit: true,
  bookChatWithoutDeposit: false,
  depositUncollectable: "book_and_flag",
  depositHoldMinutes: 60,
  aiPausedAt: null,
  aiPausedByLabel: null,
  directLineE164: null,
  directLineSetAt: null,
  updatedAt: null,
}) as ClinicSettings;

export const DEPOSIT_UNCOLLECTABLE_OPTIONS: readonly DepositUncollectable[] = [
  "book_and_flag",
  "hold_and_alert",
  "decline_and_alert",
];
export const DEPOSIT_HOLD_MINUTES_MIN = 30;
export const DEPOSIT_HOLD_MINUTES_MAX = 1440;

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * What a caller may change. Timestamps are not settable: `aiPaused` stamps
 * `aiPausedAt` and `aiPausedByLabel` from the clock and the actor, and a
 * direct-line change stamps `directLineSetAt`, so neither can be back-dated.
 */
export type ClinicSettingsPatch = Partial<{
  depositsEnabled: boolean;
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
  aiPaused: boolean;
  /** E.164, or null to clear. Spaces, dashes, dots and brackets are stripped first. */
  directLineE164: string | null;
}>;

/** A refused edit, worded for the person who made it. `field` names the input. */
export class ClinicSettingsError extends Error {
  constructor(
    readonly field: keyof ClinicSettingsPatch,
    message: string,
  ) {
    super(message);
    this.name = "ClinicSettingsError";
  }
}

type Row = typeof clinicSettings.$inferSelect;

function fromRow(row: Row | undefined): ClinicSettings {
  if (!row) return { ...DEFAULT_CLINIC_SETTINGS };
  return {
    depositsEnabled: row.depositsEnabled,
    bookVoiceWithoutDeposit: row.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: row.bookChatWithoutDeposit,
    depositUncollectable: row.depositUncollectable,
    depositHoldMinutes: row.depositHoldMinutes,
    aiPausedAt: row.aiPausedAt,
    aiPausedByLabel: row.aiPausedByLabel,
    directLineE164: row.directLineE164,
    directLineSetAt: row.directLineSetAt,
    updatedAt: row.updatedAt,
  };
}

/** The tenant clinic's settings; the defaults when it has never saved any. */
export async function getClinicSettings(tx: TenantTx): Promise<ClinicSettings> {
  const [row] = await tx.db
    .select()
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  return fromRow(row);
}

/** Normalise a typed number to E.164, or null when it cannot be one. Exported for forms. */
export function normaliseE164(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");
  return E164.test(compact) ? compact : null;
}

function requireBoolean(field: keyof ClinicSettingsPatch, value: unknown): boolean {
  if (typeof value !== "boolean") throw new ClinicSettingsError(field, "Choose on or off.");
  return value;
}

/**
 * Upsert the tenant clinic's settings and return the result.
 *
 * Validation happens here, inside the tenant, so the portal and the console
 * cannot disagree about what is allowed:
 *   - the direct line must be E.164 and must differ from the clinic's
 *     published number and its Synthflow number. Under conditional forwarding
 *     the published line forwards to us, so falling back to it would send the
 *     caller straight back into the system that just failed — the loop
 *     CLAUDE.md "Failure" forbids;
 *   - the hold is 30 minutes to 24 hours, as the column CHECK says, but
 *     refused here with words a person can act on;
 *   - the uncollectable choice is one of the three the spec names.
 *
 * Only what actually changes is written and audited. A form re-sends every
 * field it shows, so re-saving "paused" while paused must not rewrite when
 * the pause began or who began it, and re-saving the same direct line must
 * not move `directLineSetAt`: those stamps exist to say "paused by X since Y"
 * and are worthless if the latest editor overwrites them. The pause stamp is
 * also guarded in the upsert itself, so two concurrent "pause" saves keep the
 * first one's time and label.
 *
 * Deposits needing a connected Stripe account is a deposits rule and is
 * enforced by lib/billing/deposits.ts, the only writer meant to switch them.
 *
 * The audit entry carries booleans and enums only. The direct line is a
 * phone number, so it is recorded as `directLineSet: true|false`, never the
 * digits (assertNoPhi would refuse them anyway).
 */
export async function updateClinicSettings(
  tx: TenantTx,
  patch: ClinicSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
): Promise<ClinicSettings> {
  // 1. Validate every named field before touching the database.
  const wanted: {
    depositsEnabled?: boolean;
    bookVoiceWithoutDeposit?: boolean;
    bookChatWithoutDeposit?: boolean;
    depositUncollectable?: DepositUncollectable;
    depositHoldMinutes?: number;
    aiPaused?: boolean;
    directLine?: string | null;
  } = {};

  if (patch.depositsEnabled !== undefined) {
    wanted.depositsEnabled = requireBoolean("depositsEnabled", patch.depositsEnabled);
  }
  if (patch.bookVoiceWithoutDeposit !== undefined) {
    wanted.bookVoiceWithoutDeposit = requireBoolean(
      "bookVoiceWithoutDeposit",
      patch.bookVoiceWithoutDeposit,
    );
  }
  if (patch.bookChatWithoutDeposit !== undefined) {
    wanted.bookChatWithoutDeposit = requireBoolean(
      "bookChatWithoutDeposit",
      patch.bookChatWithoutDeposit,
    );
  }
  if (patch.depositUncollectable !== undefined) {
    if (!DEPOSIT_UNCOLLECTABLE_OPTIONS.includes(patch.depositUncollectable)) {
      throw new ClinicSettingsError(
        "depositUncollectable",
        "Choose what happens when a deposit cannot be collected: book and flag it, hold the slot and alert staff, or decline and alert staff.",
      );
    }
    wanted.depositUncollectable = patch.depositUncollectable;
  }
  if (patch.depositHoldMinutes !== undefined) {
    const minutes = patch.depositHoldMinutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < DEPOSIT_HOLD_MINUTES_MIN ||
      minutes > DEPOSIT_HOLD_MINUTES_MAX
    ) {
      throw new ClinicSettingsError(
        "depositHoldMinutes",
        `The hold must be a whole number of minutes from ${DEPOSIT_HOLD_MINUTES_MIN} to ${DEPOSIT_HOLD_MINUTES_MAX} (24 hours).`,
      );
    }
    wanted.depositHoldMinutes = minutes;
  }
  if (patch.aiPaused !== undefined) {
    wanted.aiPaused = requireBoolean("aiPaused", patch.aiPaused);
  }
  if (patch.directLineE164 !== undefined) {
    // The type check comes first: an untyped body can carry a number or an
    // object, and that must be a refusal with a field, not a TypeError.
    const raw: unknown = patch.directLineE164;
    if (raw !== null && typeof raw !== "string") {
      throw new ClinicSettingsError("directLineE164", "Enter the direct line as a phone number.");
    }
    if (raw === null || raw.trim() === "") {
      wanted.directLine = null;
    } else {
      const line = normaliseE164(raw);
      if (!line) {
        throw new ClinicSettingsError(
          "directLineE164",
          "Enter the direct line in international format, starting with + and the country code, e.g. +1 415 555 0100.",
        );
      }
      const [clinic] = await tx.db
        .select({ published: clinics.publishedPhoneE164, synthflow: clinics.synthflowNumberE164 })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (clinic?.published && clinic.published === line) {
        throw new ClinicSettingsError(
          "directLineE164",
          "The direct line must be a different number from your published number: calls to that number forward to the assistant, so a fallback to it would loop.",
        );
      }
      if (clinic?.synthflow && clinic.synthflow === line) {
        throw new ClinicSettingsError(
          "directLineE164",
          "The direct line must be a line at the practice, not the assistant's own number.",
        );
      }
      wanted.directLine = line;
    }
  }

  // 2. Keep only what differs from what is stored.
  const current = await getClinicSettings(tx);
  const values: Partial<typeof clinicSettings.$inferInsert> = {};
  const conflictSet: Record<string, unknown> = {};
  const audit: Record<string, boolean | number | string> = {};

  const plain = [
    "depositsEnabled",
    "bookVoiceWithoutDeposit",
    "bookChatWithoutDeposit",
    "depositUncollectable",
    "depositHoldMinutes",
  ] as const;
  for (const key of plain) {
    const next = wanted[key];
    if (next === undefined || next === current[key]) continue;
    (values as Record<string, unknown>)[key] = next;
    conflictSet[key] = next;
    audit[key] = next;
  }

  if (wanted.aiPaused !== undefined && wanted.aiPaused !== (current.aiPausedAt !== null)) {
    if (wanted.aiPaused) {
      values.aiPausedAt = now;
      values.aiPausedByLabel = actorLabel;
      // An existing pause wins over this one if another save got there first.
      conflictSet.aiPausedAt = sql`coalesce(${clinicSettings.aiPausedAt}, excluded.ai_paused_at)`;
      conflictSet.aiPausedByLabel = sql`case when ${clinicSettings.aiPausedAt} is null then excluded.ai_paused_by_label else ${clinicSettings.aiPausedByLabel} end`;
    } else {
      values.aiPausedAt = null;
      values.aiPausedByLabel = null;
      conflictSet.aiPausedAt = null;
      conflictSet.aiPausedByLabel = null;
    }
    audit.aiPaused = wanted.aiPaused;
  }

  if (wanted.directLine !== undefined && wanted.directLine !== current.directLineE164) {
    values.directLineE164 = wanted.directLine;
    values.directLineSetAt = wanted.directLine === null ? null : now;
    conflictSet.directLineE164 = values.directLineE164;
    conflictSet.directLineSetAt = values.directLineSetAt;
    audit.directLineSet = wanted.directLine !== null;
  }

  if (Object.keys(values).length === 0) return current;

  const [row] = await tx.db
    .insert(clinicSettings)
    .values({ clinicId: tx.clinicId, ...values, updatedAt: now })
    .onConflictDoUpdate({ target: clinicSettings.clinicId, set: { ...conflictSet, updatedAt: now } })
    .returning();

  tx.audit.record({
    action: "update",
    resourceType: "clinic_settings",
    resourceId: tx.clinicId,
    metadata: { fields: Object.keys(audit).sort(), ...audit },
  });

  return fromRow(row);
}

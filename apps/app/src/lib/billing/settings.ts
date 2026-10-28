import { and, eq, sql } from "drizzle-orm";

import {
  clinicChannels,
  clinicSettings,
  clinics,
  type DepositUncollectable,
  type PaymentAsk,
} from "@/db/schema";
import { isPaused } from "@/lib/channels/state";
import type { TenantTx } from "@/lib/tenant";

/**
 * Per-clinic switches the portal and the console edit (design D9): deposits,
 * Pause AI, the direct line and Auto-confirm.
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
  /**
   * When a timed pause ends by itself; null for "until switched back on".
   * Read only while `aiPausedAt` is set, and only through `isPaused`
   * (lib/channels/state.ts): a pause whose end has passed is over, whatever
   * the stamps still say (BD26).
   */
  aiPausedUntil: Date | null;
  /**
   * Auto-confirm (spec, "Every switch in the portal"): on, the assistant's
   * booking goes straight into the clinic's calendar where the booking mode
   * allows it (lib/booking/mode.ts); off, every booking it takes is a
   * request staff approve. On by default, as is a clinic with no row. It
   * gates the assistant's own bookings only, never a staff confirmation.
   */
  autoConfirmBookings: boolean;
  /**
   * When and by whom Auto-confirm was last switched in Settings or the
   * console (setAutoConfirm); both null until it first is.
   */
  autoConfirmChangedAt: Date | null;
  autoConfirmChangedByLabel: string | null;
  directLineE164: string | null;
  directLineSetAt: Date | null;
  /**
   * The payment switches (drizzle/0133), written only by setDepositSettings
   * (lib/billing/deposits.ts) and set back by lib/portal/switch-resets.ts:
   * "Text the payment link" and what the assistant asks the patient to pay.
   */
  textPaymentLink: boolean;
  paymentAsk: PaymentAsk;
  /** Null when the clinic has never saved a setting (no row). */
  updatedAt: Date | null;
};

/**
 * Must match the column defaults in drizzle/0043 and, for Auto-confirm,
 * drizzle/0057. tests/clinic-settings.test.ts compares them.
 */
export const DEFAULT_CLINIC_SETTINGS: ClinicSettings = Object.freeze({
  depositsEnabled: false,
  bookVoiceWithoutDeposit: true,
  bookChatWithoutDeposit: false,
  depositUncollectable: "book_and_flag",
  depositHoldMinutes: 60,
  aiPausedAt: null,
  aiPausedByLabel: null,
  aiPausedUntil: null,
  autoConfirmBookings: true,
  autoConfirmChangedAt: null,
  autoConfirmChangedByLabel: null,
  directLineE164: null,
  directLineSetAt: null,
  textPaymentLink: false,
  paymentAsk: "deposit_only",
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
 * `aiPausedAt` and `aiPausedByLabel` from the clock and the actor, a
 * direct-line change stamps `directLineSetAt`, and switching Auto-confirm
 * stamps `autoConfirmChangedAt` and `autoConfirmChangedByLabel`, so none can
 * be back-dated.
 *
 * Deposits are not switched here (R24): turning them on needs a connected
 * Stripe account and an amount above $0, and setDepositSettings in
 * lib/billing/deposits.ts is the one writer that checks both.
 */
export type ClinicSettingsPatch = Partial<{
  bookVoiceWithoutDeposit: boolean;
  bookChatWithoutDeposit: boolean;
  depositUncollectable: DepositUncollectable;
  depositHoldMinutes: number;
  aiPaused: boolean;
  /**
   * With `aiPaused: true` only: when the pause ends by itself ("for 1 hour",
   * "until tomorrow morning"), or null for until someone switches it back.
   * Must be in the future. Pausing again while paused moves only this.
   */
  aiPausedUntil: Date | null;
  /**
   * Auto-confirm on or off. The portal sends it through setAutoConfirm
   * (lib/booking/mode.ts), behind its step-up, and so does the console.
   */
  autoConfirmBookings: boolean;
  /** E.164, or null to clear. Spaces, dashes, dots and brackets are stripped first. */
  directLineE164: string | null;
}>;

/** Why the direct line can't be cleared while phone is live: said in Settings and to an operator. */
export const DIRECT_LINE_NEEDED_WHILE_LIVE =
  "Phone is live, so the direct line can be changed but not removed: every call AYA can't answer goes there. Set another number, or take phone off first.";

/**
 * Whether this clinic's phone channel is live (clinic_channels.live_at set
 * for voice): from then on every degradation path ends at its direct line,
 * so the line can be changed but never cleared.
 */
export async function voiceIsLive(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "voice")))
    .limit(1);
  return Boolean(row?.liveAt);
}

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
    aiPausedUntil: row.aiPausedUntil,
    autoConfirmBookings: row.autoConfirmBookings,
    autoConfirmChangedAt: row.autoConfirmChangedAt,
    autoConfirmChangedByLabel: row.autoConfirmChangedByLabel,
    directLineE164: row.directLineE164,
    directLineSetAt: row.directLineSetAt,
    textPaymentLink: row.textPaymentLink,
    paymentAsk: row.paymentAsk,
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
 * Hold the tenant clinic's Auto-confirm until the transaction ends.
 *
 * A switch is written only when it differs from what is stored, so two at
 * once must not both compare with the old value. Under READ COMMITTED the
 * second would read the value the first is replacing: it would either write
 * nothing and answer "off" while the first commits on, or write again and
 * move the first one's stamps. A clinic with no settings row has no row to
 * lock, so this is an advisory lock on the clinic, as for an ops Connect
 * link (lib/billing/connect.ts). updateClinicSettings takes it before it
 * reads; a caller that reads Auto-confirm itself to say what it changed
 * (setAutoConfirm) takes it first. Taking it twice in one transaction is
 * harmless.
 */
export async function lockAutoConfirm(tx: TenantTx): Promise<void> {
  await tx.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`auto-confirm:${tx.clinicId}`}, 0))`,
  );
}

/**
 * Upsert the tenant clinic's settings and return the result.
 *
 * Validation happens here, inside the tenant, so the portal and the console
 * cannot disagree about what is allowed:
 *   - the direct line must be E.164 and must differ from the clinic's
 *     published number and the assistant's number. Under conditional forwarding
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
 * Whether the clinic is paused is always `isPaused` (BD26), never "is
 * ai_paused_at set": a timed pause ends by itself while its stamps stay
 * behind. Judged by the stamp alone, a pause saved after a timed one expired
 * would be taken for "already paused" and dropped, and a new "until switched
 * back" pause would inherit the old, past end and never hold. So a pause
 * when not paused writes all three columns (`ai_paused_until` null for
 * indefinite), a pause while paused moves only its end, and a resume clears
 * all three.
 *
 * Deposits are not switched here at all (R24): turning them on needs a
 * connected Stripe account and an amount above $0, and setDepositSettings in
 * lib/billing/deposits.ts is the one writer that checks both. A patch that
 * names them is a programming error and is refused.
 *
 * Switching Auto-confirm stamps who switched it and when, together, as the
 * column CHECK in drizzle/0057 requires; re-saving the value it already has
 * moves neither, so "off since …, by …" stays true. It is compared under
 * lockAutoConfirm, so two switches at once are taken one after the other.
 * The database reads the column too (app_calendar_write_permitted), so a
 * hold claimed after the switch commits is refused there whatever the
 * caller believed.
 *
 * The audit entry carries booleans and enums only. The direct line is a
 * phone number, so it is recorded as `directLineSet: true|false`, never the
 * digits (assertNoPhi would refuse them anyway); a pause's end is recorded
 * as `pauseTimed: true|false`, never the date (an ISO date reads as a number
 * to the guard); Auto-confirm as `autoConfirm: true|false`.
 */
export async function updateClinicSettings(
  tx: TenantTx,
  patch: ClinicSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
): Promise<ClinicSettings> {
  if ((patch as Record<string, unknown>).depositsEnabled !== undefined) {
    throw new Error(
      "updateClinicSettings does not switch deposits: setDepositSettings (lib/billing/deposits.ts) does, after checking the connected account.",
    );
  }

  // 1. Validate every named field before touching the database.
  const wanted: {
    bookVoiceWithoutDeposit?: boolean;
    bookChatWithoutDeposit?: boolean;
    depositUncollectable?: DepositUncollectable;
    depositHoldMinutes?: number;
    aiPaused?: boolean;
    aiPausedUntil?: Date | null;
    autoConfirmBookings?: boolean;
    directLine?: string | null;
  } = {};

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
  if (patch.aiPausedUntil !== undefined) {
    const until: unknown = patch.aiPausedUntil;
    if (until !== null && (!(until instanceof Date) || Number.isNaN(until.getTime()))) {
      throw new ClinicSettingsError("aiPausedUntil", "Choose when the pause ends.");
    }
    if (wanted.aiPaused !== true) {
      throw new ClinicSettingsError(
        "aiPausedUntil",
        "A pause's end is chosen when pausing the assistant.",
      );
    }
    if (until !== null && until.getTime() <= now.getTime()) {
      throw new ClinicSettingsError("aiPausedUntil", "The pause must end in the future.");
    }
    wanted.aiPausedUntil = until;
  }
  if (patch.autoConfirmBookings !== undefined) {
    wanted.autoConfirmBookings = requireBoolean("autoConfirmBookings", patch.autoConfirmBookings);
  }
  if (patch.directLineE164 !== undefined) {
    // The type check comes first: an untyped body can carry a number or an
    // object, and that must be a refusal with a field, not a TypeError.
    const raw: unknown = patch.directLineE164;
    if (raw !== null && typeof raw !== "string") {
      throw new ClinicSettingsError("directLineE164", "Enter the direct line as a phone number.");
    }
    if (raw === null || raw.trim() === "") {
      // Every call AYA can't answer goes to the direct line, so a live phone
      // line keeps one (CLAUDE.md, "Failure"): change it, never clear it.
      if (await voiceIsLive(tx)) {
        throw new ClinicSettingsError("directLineE164", DIRECT_LINE_NEEDED_WHILE_LIVE);
      }
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
        .select({ published: clinics.publishedPhoneE164, assistant: clinics.assistantNumberE164 })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (clinic?.published && clinic.published === line) {
        throw new ClinicSettingsError(
          "directLineE164",
          "The direct line must be a different number from your published number: calls to that number forward to the assistant, so a fallback to it would loop.",
        );
      }
      if (clinic?.assistant && clinic.assistant === line) {
        throw new ClinicSettingsError(
          "directLineE164",
          "The direct line must be a line at the practice, not the assistant's own number.",
        );
      }
      wanted.directLine = line;
    }
  }

  // 2. Keep only what differs from what is stored. An Auto-confirm switch
  // reads under its lock, so it compares with what a concurrent switch
  // committed rather than with the value that switch replaced.
  if (wanted.autoConfirmBookings !== undefined) await lockAutoConfirm(tx);
  const current = await getClinicSettings(tx);
  const values: Partial<typeof clinicSettings.$inferInsert> = {};
  const conflictSet: Record<string, unknown> = {};
  const audit: Record<string, boolean | number | string> = {};

  const plain = [
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

  const pausedNow = isPaused(
    { pausedAt: current.aiPausedAt, pausedUntil: current.aiPausedUntil },
    now,
  );
  if (wanted.aiPaused === true && !pausedNow) {
    // A new pause: who, since when, and until when (null: until switched
    // back on). Stale stamps from a timed pause that already ended are
    // replaced, never inherited.
    const until = wanted.aiPausedUntil ?? null;
    values.aiPausedAt = now;
    values.aiPausedByLabel = actorLabel;
    values.aiPausedUntil = until;
    // A pause another save put in place meanwhile wins, but only while it
    // still holds.
    const holds = sql`(${clinicSettings.aiPausedAt} is not null and (${clinicSettings.aiPausedUntil} is null or ${clinicSettings.aiPausedUntil} > ${now}))`;
    conflictSet.aiPausedAt = sql`case when ${holds} then ${clinicSettings.aiPausedAt} else excluded.ai_paused_at end`;
    conflictSet.aiPausedByLabel = sql`case when ${holds} then ${clinicSettings.aiPausedByLabel} else excluded.ai_paused_by_label end`;
    conflictSet.aiPausedUntil = sql`case when ${holds} then ${clinicSettings.aiPausedUntil} else excluded.ai_paused_until end`;
    audit.aiPaused = true;
    audit.pauseTimed = until !== null;
  } else if (
    wanted.aiPaused === true &&
    wanted.aiPausedUntil !== undefined &&
    wanted.aiPausedUntil?.getTime() !== current.aiPausedUntil?.getTime()
  ) {
    // Paused already: only when it ends moves. Who paused and since when
    // stay, for the banner's "paused by X since Y".
    values.aiPausedUntil = wanted.aiPausedUntil;
    conflictSet.aiPausedUntil = wanted.aiPausedUntil;
    audit.aiPaused = true;
    audit.pauseTimed = wanted.aiPausedUntil !== null;
  } else if (
    wanted.aiPaused === false &&
    (current.aiPausedAt !== null ||
      current.aiPausedByLabel !== null ||
      current.aiPausedUntil !== null)
  ) {
    // A resume clears all three, including the stamps of a timed pause that
    // had already ended by itself.
    values.aiPausedAt = null;
    values.aiPausedByLabel = null;
    values.aiPausedUntil = null;
    conflictSet.aiPausedAt = null;
    conflictSet.aiPausedByLabel = null;
    conflictSet.aiPausedUntil = null;
    audit.aiPaused = false;
  }

  if (
    wanted.autoConfirmBookings !== undefined &&
    wanted.autoConfirmBookings !== current.autoConfirmBookings
  ) {
    values.autoConfirmBookings = wanted.autoConfirmBookings;
    values.autoConfirmChangedAt = now;
    values.autoConfirmChangedByLabel = actorLabel;
    conflictSet.autoConfirmBookings = values.autoConfirmBookings;
    conflictSet.autoConfirmChangedAt = values.autoConfirmChangedAt;
    conflictSet.autoConfirmChangedByLabel = values.autoConfirmChangedByLabel;
    audit.autoConfirm = wanted.autoConfirmBookings;
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
    .onConflictDoUpdate({
      target: clinicSettings.clinicId,
      set: { ...conflictSet, updatedAt: now },
    })
    .returning();

  tx.audit.record({
    action: "update",
    resourceType: "clinic_settings",
    resourceId: tx.clinicId,
    metadata: { fields: Object.keys(audit).sort(), ...audit },
  });

  return fromRow(row);
}

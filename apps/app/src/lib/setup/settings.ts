import {
  ASSISTANT_LANGUAGES,
  ASSISTANT_TONES,
  BOOKING_DETAILS,
  bookingSyncFor,
  COVERAGE_MODES,
  findClinicalContent,
  getBookingSystem,
  GREETING_MAX_CHARS,
  isCalendarAccount,
  TRANSCRIPT_RETENTION_DAYS_OPTIONS,
  type AssistantLanguage,
  type AssistantTone,
  type BookingDetail,
  type BookingSystemId,
  type CalendarAccount,
  type CoverageModeId,
  type TranscriptRetentionDays,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinics, clinicSettings, clinicSettingsHistory } from "@/db/schema";
import { normaliseE164, updateClinicSettings } from "@/lib/billing/settings";
import { completeStep } from "@/lib/onboarding/steps";
import type { SettingsHistoryField } from "@/lib/setup/screen-ids";
import type { TenantTx } from "@/lib/tenant";

/**
 * The clinic_settings columns the setup wizard and Settings own (0052): how
 * AYA talks, which calls reach it, the booking answers, the urgent-help
 * numbers, the transfer, the daily summary and how long records are kept
 * (plan Part J; spec, "Every switch in the portal").
 *
 * lib/billing/settings.ts keeps the deposit, pause and direct-line columns
 * and their one writer, `updateClinicSettings`; the direct line is set here
 * through it, so its loop check (never the published number, never the
 * assistant's own) has one home. A missing row means the defaults below,
 * which are the columns' defaults; tests/setup-settings.test.ts holds the two
 * together.
 *
 * Changes to where calls and urgent callers go, how long records are kept and
 * whether AYA books on its own keep their before and after in
 * clinic_settings_history, in the same transaction. Free text (the
 * greetings) is screened with findClinicalContent before it is stored.
 */

export type SetupSettings = {
  tone: AssistantTone;
  /** Null: the default, built from the clinic's name. */
  phoneGreeting: string | null;
  chatGreeting: string | null;
  languages: AssistantLanguage[];
  suggestAddOns: boolean;
  mentionPromotions: boolean;
  autoConfirmBookings: boolean;
  bookingDetail: BookingDetail;
  bookingSystem: BookingSystemId | null;
  calendarAccount: CalendarAccount | null;
  urgentHelpE164: string | null;
  vetReferralE164: string | null;
  transferLiveCalls: boolean;
  transferE164: string | null;
  dailySummary: boolean;
  coverageMode: CoverageModeId;
  transcriptRetentionDays: TranscriptRetentionDays;
  /** lib/billing/settings.ts's column, read here because the wizard shows it. */
  directLineE164: string | null;
};

/** The columns' defaults: the spec's. */
export const DEFAULT_SETUP_SETTINGS: Readonly<SetupSettings> = Object.freeze({
  tone: "warm",
  phoneGreeting: null,
  chatGreeting: null,
  languages: ["en"],
  suggestAddOns: false,
  mentionPromotions: true,
  autoConfirmBookings: true,
  bookingDetail: "generic",
  bookingSystem: null,
  calendarAccount: null,
  urgentHelpE164: null,
  vetReferralE164: null,
  transferLiveCalls: false,
  transferE164: null,
  dailySummary: true,
  coverageMode: "overflow_after_hours",
  transcriptRetentionDays: 90,
  directLineE164: null,
}) as SetupSettings;

/** A refused change, worded for the person who made it. `field` names the input. */
export class SetupSettingsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SetupSettingsError";
  }
}

type Row = typeof clinicSettings.$inferSelect;

function fromRow(row: Row | undefined): SetupSettings {
  if (!row) return { ...DEFAULT_SETUP_SETTINGS, languages: [...DEFAULT_SETUP_SETTINGS.languages] };
  return {
    tone: row.tone,
    phoneGreeting: row.phoneGreeting,
    chatGreeting: row.chatGreeting,
    languages: [...row.languages],
    suggestAddOns: row.suggestAddOns,
    mentionPromotions: row.mentionPromotions,
    autoConfirmBookings: row.autoConfirmBookings,
    bookingDetail: row.bookingDetail,
    bookingSystem: row.bookingSystem,
    calendarAccount: row.calendarAccount,
    urgentHelpE164: row.urgentHelpE164,
    vetReferralE164: row.vetReferralE164,
    transferLiveCalls: row.transferLiveCalls,
    transferE164: row.transferE164,
    dailySummary: row.dailySummary,
    coverageMode: row.coverageMode,
    transcriptRetentionDays: row.transcriptRetentionDays,
    directLineE164: row.directLineE164,
  };
}

/** The clinic's settings; the defaults when it has never saved any. */
export async function readSetupSettings(db: Transaction, clinicId: string): Promise<SetupSettings> {
  const [row] = await db
    .select()
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, clinicId))
    .limit(1);
  return fromRow(row);
}

/** What a caller may change here. Greetings: empty or null means the default. */
export type SetupSettingsPatch = Partial<{
  tone: AssistantTone;
  phoneGreeting: string | null;
  chatGreeting: string | null;
  languages: AssistantLanguage[];
  suggestAddOns: boolean;
  mentionPromotions: boolean;
  bookingDetail: BookingDetail;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  urgentHelpE164: string | null;
  vetReferralE164: string | null;
  transferLiveCalls: boolean;
  transferE164: string | null;
  dailySummary: boolean;
  coverageMode: CoverageModeId;
  transcriptRetentionDays: TranscriptRetentionDays;
}>;

/** The column each history field is, in SetupSettings' names. */
const HISTORY: Partial<Record<keyof SetupSettings, SettingsHistoryField>> = {
  urgentHelpE164: "urgent_help_e164",
  vetReferralE164: "vet_referral_e164",
  transferE164: "transfer_e164",
  transcriptRetentionDays: "transcript_retention_days",
  autoConfirmBookings: "auto_confirm_bookings",
};

/**
 * Validate and save, upserting the row, writing only what changes, and
 * keeping the history of what clinic_settings_history records. Returns the
 * settings as they now stand.
 */
export async function saveSetupSettings(
  tx: TenantTx,
  patch: SetupSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
): Promise<SetupSettings> {
  const wanted = validate(patch);
  const current = await readSetupSettings(tx.db, tx.clinicId);

  // The booking system decides Auto-confirm while the clinic has not chosen
  // it itself: on where the system reads Google Calendar, off where it does
  // not (provisioning's rule, lib/setup/seed.ts). Its own switch is the
  // calendar backend's, behind a step-up, in Settings.
  if (wanted.bookingSystem !== undefined && wanted.bookingSystem !== current.bookingSystem) {
    wanted.autoConfirmBookings = bookingSyncFor(wanted.bookingSystem) === "live";
  }

  const changed: Partial<SetupSettings> = {};
  for (const [key, value] of Object.entries(wanted) as [keyof SetupSettings, unknown][]) {
    const before = current[key];
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(before)
      : value === before;
    if (!same) (changed as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(changed).length === 0) return current;

  const [row] = await tx.db
    .insert(clinicSettings)
    .values({ clinicId: tx.clinicId, ...changed, updatedAt: now })
    .onConflictDoUpdate({ target: clinicSettings.clinicId, set: { ...changed, updatedAt: now } })
    .returning();

  const history = (Object.keys(changed) as (keyof SetupSettings)[])
    .filter((key) => HISTORY[key])
    .map((key) => ({
      clinicId: tx.clinicId,
      field: HISTORY[key]!,
      beforeValue: historyValue(current[key]),
      afterValue: historyValue(changed[key]),
      actorLabel: actorLabel.slice(0, 200),
      changedAt: now,
    }));
  if (history.length > 0) await tx.db.insert(clinicSettingsHistory).values(history);

  // Which calls reach AYA is the single source here; clinics.call_routing is
  // kept in step for the readers still on it (the voice ingest's recovered
  // reasons, the ops console, Package B's coverage accessor), and the
  // onboarding step it stamps is the wizard's answer.
  if (changed.coverageMode !== undefined) {
    await tx.db
      .update(clinics)
      .set({
        callRouting: changed.coverageMode === "all_calls" ? "always" : "conditional",
        callRoutingConfirmedAt: now,
        updatedAt: now,
      })
      .where(eq(clinics.id, tx.clinicId));
    await completeStep(tx, "call_routing_chosen", { at: now });
  }

  tx.audit.record({
    action: "update",
    resourceType: "clinic_settings",
    resourceId: tx.clinicId,
    // Field names and booleans only: the numbers are the clinic's, but a
    // phone-shaped value never goes in an audit row.
    metadata: { fields: Object.keys(changed).sort() },
  });
  return fromRow(row);
}

function historyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 64);
}

/**
 * Set the direct line through its one writer (lib/billing/settings.ts, which
 * refuses the published number and the assistant's own), and keep its before
 * and after. A refusal is a SetupSettingsError on `directLine`.
 */
export async function saveDirectLine(
  tx: TenantTx,
  raw: string | null,
  actorLabel: string,
  now: Date = new Date(),
): Promise<string | null> {
  const before = (await readSetupSettings(tx.db, tx.clinicId)).directLineE164;
  // A US number typed the way people write it is taken as one; anything else
  // goes to the writer as typed, whose refusal says what it needs.
  const typed = raw === null || raw.trim() === "" ? null : (toE164(raw) ?? raw);
  let after: string | null;
  try {
    after = (await updateClinicSettings(tx, { directLineE164: typed }, actorLabel, now))
      .directLineE164;
  } catch (error) {
    if (error instanceof Error && error.name === "ClinicSettingsError") {
      throw new SetupSettingsError("directLine", error.message);
    }
    throw error;
  }
  if (after !== before) {
    await tx.db.insert(clinicSettingsHistory).values({
      clinicId: tx.clinicId,
      field: "direct_line_e164",
      beforeValue: before,
      afterValue: after,
      actorLabel: actorLabel.slice(0, 200),
      changedAt: now,
    });
  }
  return after;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function validate(patch: SetupSettingsPatch): Partial<SetupSettings> {
  const out: Partial<SetupSettings> = {};
  if (patch.tone !== undefined) {
    if (!(ASSISTANT_TONES as readonly string[]).includes(patch.tone)) {
      throw new SetupSettingsError("tone", "Choose warm or clinical.");
    }
    out.tone = patch.tone;
  }
  for (const field of ["phoneGreeting", "chatGreeting"] as const) {
    if (patch[field] === undefined) continue;
    out[field] = greeting(field, patch[field]);
  }
  if (patch.languages !== undefined) {
    const list = Array.isArray(patch.languages) ? [...new Set(patch.languages)] : [];
    if (
      list.length === 0 ||
      !list.every((l) => (ASSISTANT_LANGUAGES as readonly string[]).includes(l))
    ) {
      throw new SetupSettingsError("languages", "Choose at least one language AYA answers in.");
    }
    out.languages = ASSISTANT_LANGUAGES.filter((l) => list.includes(l));
  }
  for (const field of [
    "suggestAddOns",
    "mentionPromotions",
    "transferLiveCalls",
    "dailySummary",
  ] as const) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "boolean") throw new SetupSettingsError(field, "Choose on or off.");
    out[field] = patch[field];
  }
  if (patch.bookingDetail !== undefined) {
    if (!(BOOKING_DETAILS as readonly string[]).includes(patch.bookingDetail)) {
      throw new SetupSettingsError("bookingDetail", "Choose a shared calendar or named providers.");
    }
    out.bookingDetail = patch.bookingDetail;
  }
  if (patch.bookingSystem !== undefined) {
    if (!getBookingSystem(patch.bookingSystem)) {
      throw new SetupSettingsError("bookingSystem", "Choose where your bookings live today.");
    }
    out.bookingSystem = patch.bookingSystem;
  }
  if (patch.calendarAccount !== undefined) {
    if (!isCalendarAccount(patch.calendarAccount)) {
      throw new SetupSettingsError("calendarAccount", "Choose the kind of Google account.");
    }
    out.calendarAccount = patch.calendarAccount;
  }
  for (const field of ["urgentHelpE164", "vetReferralE164", "transferE164"] as const) {
    if (patch[field] === undefined) continue;
    out[field] = phone(field, patch[field]);
  }
  if (patch.coverageMode !== undefined) {
    if (!(COVERAGE_MODES as readonly string[]).includes(patch.coverageMode)) {
      throw new SetupSettingsError("coverageMode", "Choose which calls reach AYA.");
    }
    out.coverageMode = patch.coverageMode;
  }
  if (patch.transcriptRetentionDays !== undefined) {
    if (
      !(TRANSCRIPT_RETENTION_DAYS_OPTIONS as readonly number[]).includes(
        patch.transcriptRetentionDays,
      )
    ) {
      throw new SetupSettingsError("transcriptRetentionDays", "Choose 90, 30 or 7 days.");
    }
    out.transcriptRetentionDays = patch.transcriptRetentionDays;
  }
  return out;
}

function greeting(field: "phoneGreeting" | "chatGreeting", raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new SetupSettingsError(field, "Write the greeting as text.");
  // eslint-disable-next-line no-control-regex
  const text = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > GREETING_MAX_CHARS) {
    throw new SetupSettingsError(
      field,
      `Keep the greeting under ${GREETING_MAX_CHARS} characters.`,
    );
  }
  const findings = findClinicalContent({ greeting: text });
  if (findings.length > 0) {
    const finding = findings[0]!;
    throw new SetupSettingsError(
      field,
      `The greeting can't include ${finding.label} ("${finding.excerpt}"). AYA passes those questions to your team; say that instead.`,
    );
  }
  return text;
}

function phone(field: string, raw: unknown): string | null {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  if (typeof raw !== "string") throw new SetupSettingsError(field, "Enter a phone number.");
  const normalised = normaliseE164(raw) ?? usNumber(raw);
  if (!normalised) {
    throw new SetupSettingsError(
      field,
      "Enter the number with its area code, like (415) 555-0100, or in international format starting with +.",
    );
  }
  return normalised;
}

/** A ten-digit US number, or eleven starting with 1, as people type it. */
export function usNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+${digits}`;
  return null;
}

/** A typed number as E.164: international form, or a US number with its area code. */
export function toE164(raw: string): string | null {
  return normaliseE164(raw) ?? usNumber(raw);
}

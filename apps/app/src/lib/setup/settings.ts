import {
  ASSISTANT_LANGUAGE_NAMES,
  isScreenedLanguage,
  SCREENED_LANGUAGES,
  ASSISTANT_TONES,
  BOOKING_DETAILS,
  bookingSyncFor,
  COVERAGE_MODES,
  findClinicalContent,
  getBookingSystem,
  GREETING_MAX_CHARS,
  isCalendarAccount,
  isSafeTypedText,
  type AssistantLanguage,
  type AssistantTone,
  type BookingDetail,
  type BookingSystemId,
  type CalendarAccount,
  type CallRouting,
  type CoverageModeId,
  type TranscriptRetentionDays,
} from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinicProviders, clinics, clinicSettings, clinicSettingsHistory } from "@/db/schema";
import { clinicOwnWords, guardGreeting, neverSayIn, type GreetingRefusal } from "@/lib/assistant/guard";
import { normaliseE164, updateClinicSettings } from "@/lib/billing/settings";
import { notifySettingChanged } from "@/lib/notices/setting-changed";
import { completeStep } from "@/lib/onboarding/steps";
import { neverSayWithDefaults, readKnowledge } from "@/lib/setup/knowledge";
import type { SettingsHistoryField } from "@/lib/setup/screen-ids";
import type { TenantTx } from "@/lib/tenant";

/**
 * The clinic_settings columns the setup wizard and Settings own (0056): how
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
 * clinic_settings_history, in the same transaction, and a change to the
 * direct line or the transfer number after it was first set emails the
 * clinic (O4, lib/notices/setting-changed.ts). Free text (the greetings) is
 * screened with findClinicalContent before it is stored, and then with the
 * guard every reply passes (lib/assistant/guard.ts, guardGreeting) against
 * the clinic's menu and never-say list: a greeting that says AYA is a
 * person, names a price off the menu, says something on the never-say list
 * or claims "HIPAA compliant" is refused with the reason.
 */

export type SetupSettings = {
  tone: AssistantTone;
  /** Null: the default, built from the clinic's name. */
  phoneGreeting: string | null;
  chatGreeting: string | null;
  /** What patients call the clinic (Settings, "What patients call you"); null: worked out from its name. */
  shortName: string | null;
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
  shortName: null,
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
    shortName: row.shortName,
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
  shortName: string | null;
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
  // No transcriptRetentionDays: nothing may change it any more. healdesk
  // keeps no transcript (owner, 13 October 2026; BAA 1.4.0 clause 11), and
  // the portal's "Keep transcripts for" is gone (lib/portal/settings.ts). The
  // column stays, read above and by the purge, which a value saved before
  // only ever makes delete sooner.
}>;

/**
 * The column each history field is, in SetupSettings' names.
 * transcript_retention_days stays a history field (SETTINGS_HISTORY_FIELDS)
 * for the rows written while it could change; nothing writes a new one.
 */
const HISTORY: Partial<Record<keyof SetupSettings, SettingsHistoryField>> = {
  urgentHelpE164: "urgent_help_e164",
  vetReferralE164: "vet_referral_e164",
  transferE164: "transfer_e164",
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
  await screenGreetings(tx, wanted);
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

  // A coverage mode in the patch is the clinic's answer to "which calls
  // reach AYA?", whether or not it changes what is stored: the wizard
  // pre-selects the stored mode, which on a funnel purchase is the column
  // default, so the commonest answer is the unchanged one. That answer is
  // what confirms the call routing, which go-live waits for.
  const routingAnswer = wanted.coverageMode;
  if (Object.keys(changed).length === 0 && routingAnswer === undefined) return current;

  let saved = current;
  if (Object.keys(changed).length > 0) {
    const [row] = await tx.db
      .insert(clinicSettings)
      .values({ clinicId: tx.clinicId, ...changed, updatedAt: now })
      .onConflictDoUpdate({ target: clinicSettings.clinicId, set: { ...changed, updatedAt: now } })
      .returning();
    saved = fromRow(row);

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
    if (history.length > 0) {
      const written = await tx.db
        .insert(clinicSettingsHistory)
        .values(history)
        .returning({ id: clinicSettingsHistory.id, field: clinicSettingsHistory.field });
      // O4 for a transfer number changed after it was first set (plan Part
      // D4). The direct line's own email is saveDirectLine's, below.
      const transfer = written.find((row) => row.field === "transfer_e164");
      if (transfer && current.transferE164 !== null) {
        await notifySettingChanged(tx, {
          field: "transfer_e164",
          before: current.transferE164,
          after: changed.transferE164 ?? null,
          historyId: transfer.id,
          actorLabel,
          at: now,
        });
      }
    }

    tx.audit.record({
      action: "update",
      resourceType: "clinic_settings",
      resourceId: tx.clinicId,
      // Field names and booleans only: the numbers are the clinic's, but a
      // phone-shaped value never goes in an audit row.
      metadata: { fields: Object.keys(changed).sort() },
    });
  }

  // Which calls reach AYA is the single source here; clinics.call_routing is
  // kept in step for the one reader still on it (billing's coverageModeOf,
  // for a clinic with no settings row) and for the ops console's phone form,
  // and confirmed, with the onboarding step it stamps. A changed mode is confirmed now; an
  // unchanged one keeps the time it was first confirmed.
  if (routingAnswer !== undefined) {
    await tx.db
      .update(clinics)
      .set({
        callRouting: routingForCoverageMode(routingAnswer),
        callRoutingConfirmedAt:
          changed.coverageMode !== undefined
            ? now
            : sql`coalesce(${clinics.callRoutingConfirmedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(eq(clinics.id, tx.clinicId));
    await completeStep(tx, "call_routing_chosen", { at: now });
  }
  return saved;
}

function historyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 64);
}

// -----------------------------------------------------------------------------
// Which calls reach AYA, both ways round
// -----------------------------------------------------------------------------

/** clinics.call_routing for a coverage mode: every call is 'always', the other two ring the clinic first. */
export function routingForCoverageMode(mode: CoverageModeId): CallRouting {
  return mode === "all_calls" ? "always" : "conditional";
}

/**
 * The coverage mode a call_routing answer means, from the mode stored now.
 * 'always' is All calls. 'conditional' is either mode that rings the clinic
 * first: a clinic already on After hours only keeps it, and any other
 * becomes Overflow and after hours, the default.
 */
export function coverageModeForRouting(
  routing: CallRouting,
  current: CoverageModeId | null,
): CoverageModeId {
  if (routing === "always") return "all_calls";
  return current === "after_hours_only" ? "after_hours_only" : "overflow_after_hours";
}

/**
 * Keep coverage_mode, the single source (0056), in step with a call_routing
 * answer written somewhere else: the ops console's phone settings on the
 * onboarding call (lib/onboarding/phone.ts). In the caller's transaction, so
 * the two columns cannot disagree.
 */
export async function keepCoverageModeInStep(
  tx: TenantTx,
  routing: CallRouting,
  now: Date = new Date(),
): Promise<CoverageModeId> {
  const [row] = await tx.db
    .select({ coverageMode: clinicSettings.coverageMode })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const mode = coverageModeForRouting(routing, row?.coverageMode ?? null);
  if (row?.coverageMode === mode) return mode;
  await tx.db
    .insert(clinicSettings)
    .values({ clinicId: tx.clinicId, coverageMode: mode, updatedAt: now })
    .onConflictDoUpdate({
      target: clinicSettings.clinicId,
      set: { coverageMode: mode, updatedAt: now },
    });
  return mode;
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
    const [row] = await tx.db
      .insert(clinicSettingsHistory)
      .values({
        clinicId: tx.clinicId,
        field: "direct_line_e164",
        beforeValue: before,
        afterValue: after,
        actorLabel: actorLabel.slice(0, 200),
        changedAt: now,
      })
      .returning({ id: clinicSettingsHistory.id });
    // A change after the line was first set emails the clinic (O4): the
    // first time is part of setup and sends nothing (plan Part D4).
    if (before !== null && row) {
      await notifySettingChanged(tx, {
        field: "direct_line_e164",
        before,
        after,
        historyId: row.id,
        actorLabel,
        at: now,
      });
    }
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
  if (patch.shortName !== undefined) out.shortName = shortName(patch.shortName);
  if (patch.languages !== undefined) {
    const list = Array.isArray(patch.languages) ? [...new Set(patch.languages)] : [];
    if (list.length === 0) {
      throw new SetupSettingsError("languages", "Choose at least one language AYA answers in.");
    }
    // Only the languages AYA's safety checks read (SCREENED_LANGUAGES): a
    // message in any other gets a fixed line, never an answer.
    if (!list.every(isScreenedLanguage)) {
      throw new SetupSettingsError(
        "languages",
        "AYA answers in English and Spanish, the languages its safety checks read.",
      );
    }
    out.languages = SCREENED_LANGUAGES.filter((l) => list.includes(l));
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

/** The longest short name: a word or two, as patients say it. */
export const SHORT_NAME_MAX_CHARS = 40;

/**
 * What patients call the clinic (docs/design/clinic-nickname-2026-10-26.md):
 * plain words, said aloud after the full name, so never a link, a number or
 * markup (the catalog's isSafeTypedText), and nothing clinical. Empty or
 * null means the form worked out from the name.
 */
function shortName(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") throw new SetupSettingsError("shortName", "Write the name as text.");
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > SHORT_NAME_MAX_CHARS) {
    throw new SetupSettingsError("shortName", `Keep it to ${SHORT_NAME_MAX_CHARS} characters: the word or two patients use.`);
  }
  if (!isSafeTypedText(text, SHORT_NAME_MAX_CHARS) || !/\p{L}/u.test(text)) {
    throw new SetupSettingsError("shortName", "Use the name as patients say it, in plain words: no links, numbers on their own or symbols.");
  }
  // With everyday conditions too ("Acne"), as the Meta screen reads replies:
  // a part of the clinic's name the screens read past must name none.
  if (findClinicalContent({ greeting: text }, { conditions: true }).length > 0) {
    throw new SetupSettingsError("shortName", "Use the name as patients say it, not a treatment or medical term.");
  }
  return text;
}

/** What the clinic is told when the guard refuses its greeting, by the guard's reason. */
const GREETING_REFUSED: Record<GreetingRefusal, string> = {
  undoes_disclosure:
    "The greeting can't say AYA is a person or not an AI: it comes right after the line that says she's an AI assistant.",
  never_say:
    "The greeting says something on your never-say list. Take it out, or change the list in Knowledge.",
  price:
    "The greeting names a price that isn't one of your listed prices or deposits. AYA quotes prices from Knowledge, exactly as listed.",
  payment_details:
    "The greeting can't ask for card or bank details. The practice takes payment itself.",
  hipaa_claim: 'The greeting can\'t call the practice "HIPAA compliant".',
  clinical:
    "The greeting can't give clinical advice or promise results. AYA passes those questions to your team; say that instead.",
  language: `Write the greeting in ${SCREENED_LANGUAGES.map((l) => ASSISTANT_LANGUAGE_NAMES[l]).join(" or ")}, the languages AYA's safety checks read.`,
  booking_confirmation:
    "The greeting can't say an appointment is booked: the team confirms every booking.",
  human_claim:
    "The greeting can't say AYA is a person or not an AI: it comes right after the line that says she's an AI assistant.",
  outbound_promise:
    "The greeting can't promise a text, a reminder, a follow-up or a call back: AYA only answers, and your team gets back to people.",
  alert_claim: "The greeting can't say your team has already been told: nothing has been sent when it is said.",
  other_party: "The greeting can't mention other patients or compare the practice with another one.",
  empty: "Write the greeting as text.",
};

/**
 * Each greeting in the patch through the guard every reply passes, and the
 * short name through its never-say list, with the
 * clinic's menu, never-say list, name, address and providers. The channel
 * asks it again each time it opens (lib/assistant/opening.ts), since the
 * menu and the list can change after the greeting is saved.
 */
async function screenGreetings(tx: TenantTx, wanted: Partial<SetupSettings>): Promise<void> {
  const fields = (["phoneGreeting", "chatGreeting"] as const).filter(
    (field) => typeof wanted[field] === "string",
  );
  const short = typeof wanted.shortName === "string" ? wanted.shortName : null;
  if (fields.length === 0 && short === null) return;
  const [clinic] = await tx.db
    .select({ name: clinics.name, address: clinics.address })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const knowledge = await readKnowledge(tx.db, tx.clinicId);
  const providers = await tx.db
    .select({ name: clinicProviders.displayName })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)));
  const facts = {
    clinicName: clinic?.name ?? "",
    address: clinic?.address ?? null,
    services: knowledge.services.map((s) => ({
      name: s.name,
      priceFromUsd: s.priceFromUsd,
      priceToUsd: s.priceToUsd,
      priceKind: s.priceKind ?? null,
      unit: s.unit ?? null,
      durationMinutes: s.durationMinutes,
      depositUsd: s.depositUsd ?? null,
    })),
    neverSay: neverSayWithDefaults(knowledge.neverSay),
    providerNames: providers.map((p) => p.name),
  };
  // The short name is said on every channel, so no entry of the never-say
  // list may be in it, unless it is a part of the full name, which excuses
  // the same words wherever the name is said (guard.ts, clinicOwnWords).
  if (short !== null && neverSayIn(short, facts.neverSay, clinicOwnWords({ ...facts, shortName: short }))) {
    throw new SetupSettingsError("shortName", "That name has a word on your never-say list in it, so AYA couldn't say it. Use the name as patients say it without that word.");
  }
  for (const field of fields) {
    const verdict = guardGreeting(wanted[field] as string, facts);
    if (!verdict.ok) throw new SetupSettingsError(field, GREETING_REFUSED[verdict.reason]);
  }
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

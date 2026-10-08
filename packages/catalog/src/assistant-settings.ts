import type { Channel } from "./plans";

/**
 * The words and the choices behind the clinic's own switches: the setup
 * wizard asks them, Settings will show them, and the engine reads what was
 * chosen (v1 spec, "Every switch in the portal").
 *
 * Here rather than in apps/app because the same names and one-liners appear
 * in the wizard, in the emails and, later, in the support chat's help text,
 * and a switch described two ways is a switch nobody trusts. apps/app's
 * CHECK constraints are built from the id lists, so a choice added here is a
 * choice the database accepts.
 *
 * Pure data, no imports beyond types: drizzle-kit loads the schema, and the
 * schema reads the id lists, outside the app.
 */

/** What patients call each channel (spec, "Admin portal principles": no jargon). */
export const CHANNEL_NAMES: Readonly<Record<Channel, string>> = {
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "Phone",
};

// -----------------------------------------------------------------------------
// How AYA talks
// -----------------------------------------------------------------------------

export const ASSISTANT_TONES = ["warm", "clinical"] as const;
export type AssistantTone = (typeof ASSISTANT_TONES)[number];

/** The spec's default: "Warm". */
export const DEFAULT_ASSISTANT_TONE: AssistantTone = "warm";

export const ASSISTANT_TONE_OPTIONS: readonly {
  id: AssistantTone;
  label: string;
  /** The one line under the choice. */
  line: string;
}[] = [
  {
    id: "warm",
    label: "Warm and welcoming",
    line: "Friendly and unhurried, like your best person at the front desk.",
  },
  {
    id: "clinical",
    label: "Clinical and professional",
    line: "Brief, calm and precise.",
  },
];

/**
 * The languages AYA may answer in. It answers in the caller's language and
 * stays in it (spec, "Languages"). English is the default and always on.
 */
export const ASSISTANT_LANGUAGES = ["en", "es", "fr", "pt", "zh", "vi", "ko", "ru"] as const;
export type AssistantLanguage = (typeof ASSISTANT_LANGUAGES)[number];

export const ASSISTANT_LANGUAGE_NAMES: Readonly<Record<AssistantLanguage, string>> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  zh: "Chinese",
  vi: "Vietnamese",
  ko: "Korean",
  ru: "Russian",
};

/** The longest greeting the clinic may write after the locked AI line. */
export const GREETING_MAX_CHARS = 300;

// -----------------------------------------------------------------------------
// Which calls reach AYA
// -----------------------------------------------------------------------------

/**
 * Voice coverage: the spec's three modes, in its order. The id is what
 * `clinic_settings.coverage_mode` stores and what apps/app's `CoverageMode`
 * names, so the two cannot spell a mode differently.
 */
export const COVERAGE_MODES = ["all_calls", "overflow_after_hours", "after_hours_only"] as const;
export type CoverageModeId = (typeof COVERAGE_MODES)[number];

/** The spec's default: "Overflow and after hours". */
export const DEFAULT_COVERAGE_MODE: CoverageModeId = "overflow_after_hours";

export const COVERAGE_MODE_OPTIONS: readonly {
  id: CoverageModeId;
  label: string;
  line: string;
}[] = [
  {
    id: "all_calls",
    label: "All calls",
    line: "AYA answers every call to your main number. Your team won't hear it ring.",
  },
  {
    id: "overflow_after_hours",
    label: "Overflow and after hours",
    line: "Your team answers first. AYA takes the calls they miss, and every call while you're closed.",
  },
  {
    id: "after_hours_only",
    label: "After hours only",
    line: "AYA answers only while you're closed. During your hours, calls ring as they do today.",
  },
];

/** What After hours only costs a clinic on a landline, said before it chooses (plan Part E, 2.2). */
export const AFTER_HOURS_ONLY_LANDLINE_NOTE =
  "On a landline, After hours only means dialling one code at closing and another at opening, every day.";

// -----------------------------------------------------------------------------
// Booking
// -----------------------------------------------------------------------------

/**
 * Whether AYA books into one shared calendar or against a named provider's
 * own (spec, "Booking detail"). Named providers need a calendar per provider
 * and a service-to-provider mapping, which the calendar backend owns.
 */
export const BOOKING_DETAILS = ["generic", "named_provider"] as const;
export type BookingDetail = (typeof BOOKING_DETAILS)[number];

// -----------------------------------------------------------------------------
// Records
// -----------------------------------------------------------------------------

/**
 * How long transcripts and conversation records are kept, in days: 90 by
 * default, as the agreements say, and a clinic may shorten it to 30 or 7
 * (plan, "Retention"). Never longer than the default.
 */
export const TRANSCRIPT_RETENTION_DAYS_OPTIONS = [90, 30, 7] as const;
export type TranscriptRetentionDays = (typeof TRANSCRIPT_RETENTION_DAYS_OPTIONS)[number];

// -----------------------------------------------------------------------------
// Never say
// -----------------------------------------------------------------------------

/**
 * The phrases every clinic's never-say list starts with: the clinical
 * defaults (spec, "Knowledge": "Pre-seeded with the clinical defaults and
 * editable"). They are promises no assistant may make about a treatment,
 * which the engine's own guards refuse as well; the list puts them in the
 * clinic's view, where it can see them and add its own. Clinical on purpose,
 * so nothing screens this list with findClinicalContent.
 */
export const NEVER_SAY_DEFAULTS: readonly string[] = [
  "guaranteed results",
  "risk-free",
  "completely safe",
  "no side effects",
  "painless",
  "permanent results",
  "you're a good candidate",
  "you don't need to see a doctor",
];

/** The most entries a never-say list may hold, and the longest entry. */
export const NEVER_SAY_LIMITS = { entries: 50, chars: 120 } as const;

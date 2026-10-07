/**
 * The setup wizard's screens and the settings whose changes are kept, as
 * plain lists (plan Part E). db/schema.ts builds two CHECK constraints from
 * them, so this file is pure data with no imports: drizzle-kit loads the
 * schema, and this file through it, outside the app.
 *
 * The order is the wizard's: four steps, one decision per screen, then the
 * backup factor offer at the end. Which screens a clinic actually sees
 * depends on what it bought and what it answered at checkout
 * (lib/setup/screens.ts); a screen it never sees is never stored.
 */
export const SETUP_SCREENS = [
  // Step 1 · Your practice
  "basics",
  "hours",
  "services",
  "question",
  "insurance",
  // Step 2 · How AYA works
  "tone",
  "coverage",
  "direct_line",
  "deposits",
  "urgent",
  // Step 3 · Calendar
  "calendar",
  "providers",
  // Step 4 · Your channels
  "channels",
  // The end: the authenticator-app backup, offered once when missing.
  "backup",
] as const;
export type SetupScreenId = (typeof SETUP_SCREENS)[number];

/** How a screen was left: answered, or skipped with its cost said. */
export const SETUP_SCREEN_OUTCOMES = ["done", "skipped"] as const;
export type SetupScreenOutcome = (typeof SETUP_SCREEN_OUTCOMES)[number];

/**
 * The settings whose every change keeps its before and after
 * (`clinic_settings_history`): where calls and urgent callers are sent, how
 * long records are kept, and whether AYA books on its own. Each is a
 * clinic_settings column; plan Part D4 puts them behind a step-up once set.
 */
export const SETTINGS_HISTORY_FIELDS = [
  "direct_line_e164",
  "transfer_e164",
  "urgent_help_e164",
  "vet_referral_e164",
  "transcript_retention_days",
  "auto_confirm_bookings",
] as const;
export type SettingsHistoryField = (typeof SETTINGS_HISTORY_FIELDS)[number];

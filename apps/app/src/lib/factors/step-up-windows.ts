/**
 * How long a passkey step-up holds (plan Part D2), in a module of its own
 * with no imports, so the patient page's "Keep open" warning in the browser
 * (app/c/[slug]/PatientPageGuard.tsx) counts with the numbers the database
 * enforces (step-ups.ts) rather than a copy of them.
 */

/** Idle limit: patient pages clear and ask again after this long untouched. */
export const STEP_UP_IDLE_MS = 15 * 60 * 1000;
/** Absolute limit, however busy the page: one passkey tap holds for a working day. */
export const STEP_UP_MAX_MS = 8 * 60 * 60 * 1000;

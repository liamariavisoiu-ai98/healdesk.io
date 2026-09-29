/**
 * The onboarding checklist — the ordered steps between payment and the first
 * answered call, as data both apps agree on.
 *
 * Stored on `clinics.onboarding` as `{ [step]: ISO timestamp | null }`, seeded
 * with every step null at provisioning, and completed by real state where the
 * product can observe it (hours saved, routing confirmed, agent approved) or
 * by the operator where it cannot yet (forwarding tested, test call passed).
 * Go-live refuses while any REQUIRED step is open.
 */

export const ONBOARDING_STEPS = [
  "hours_confirmed",
  "phone_type_confirmed",
  "call_routing_chosen",
  "covered_entity_confirmed",
  "agent_script_approved",
  "forwarding_configured",
  "test_call_passed",
  "platform_connected",
  "booking_requirements_confirmed",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingState = Partial<Record<OnboardingStep, string | null>>;

export const ONBOARDING_LABELS: Record<OnboardingStep, { title: string; why: string; required: boolean }> = {
  hours_confirmed: {
    title: "Opening hours confirmed",
    why: "After-hours recovery is only counted when we know when the desk is closed.",
    required: true,
  },
  phone_type_confirmed: {
    title: "Phone line type confirmed (landline, VoIP) and carrier known",
    why: "Decides which forwarding codes apply and whether the number can be text-enabled.",
    required: true,
  },
  call_routing_chosen: {
    title: "Call routing chosen: ring at the practice first, or AYA answers everything",
    why: "Decides what counts as recovered revenue on the report. Never assumed.",
    required: true,
  },
  covered_entity_confirmed: {
    title: "Covered-entity status confirmed",
    why: "Decides which privacy regime, breach clock and consent standard apply.",
    required: true,
  },
  agent_script_approved: {
    title: "Agent greeting, services, prices and escalation approved by the clinic",
    why: "These are the words the agent says on a recorded call. The clinic owns them.",
    required: true,
  },
  forwarding_configured: {
    title: "Call forwarding dialled in on the clinic's line",
    why: "Without it the product answers nothing.",
    required: true,
  },
  test_call_passed: {
    title: "Test call arrived with the caller's number intact",
    why: "If caller ID does not survive the forward, every caller looks like the clinic.",
    required: true,
  },
  platform_connected: {
    title: "Booking system connected (verified attribution only)",
    why: "Needed for the verified report; estimated clinics skip it.",
    required: false,
  },
  // Stamped by the practice on its setup link, by the operator on the call,
  // or by the specialty defaults when the link expires unspent — so it is
  // always satisfiable, and go-live (and the database's own
  // app_mark_clinic_production) refuse while it is open.
  booking_requirements_confirmed: {
    title: "Booking request fields confirmed (what the assistant collects)",
    why: "Minimum necessary: the assistant asks for exactly these and nothing clinical. Confirmed by the practice on its setup link, by you on the call, or by the specialty defaults when the link expires.",
    required: true,
  },
};

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

export function emptyOnboarding(): OnboardingState {
  const state: OnboardingState = {};
  for (const step of ONBOARDING_STEPS) state[step] = null;
  return state;
}

/** Required steps still open, in order. Empty means go-live may proceed. */
export function openRequiredSteps(
  state: OnboardingState | null | undefined,
  options: { requirePlatform?: boolean } = {},
): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    const required = ONBOARDING_LABELS[step].required || (step === "platform_connected" && options.requirePlatform);
    return required && !state?.[step];
  });
}

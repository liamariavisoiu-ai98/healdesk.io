import {
  agreementKindFor,
  agreementPlatformFor,
  type AgreementKind,
  asksCoveredQuestion,
  type BillingInterval,
  bookingSyncFor,
  bookingSystemName,
  type BookingSystemId,
  type CalendarAccount,
  cleanWebsite,
  type CoveredAnswer,
  DEFAULT_STEPS,
  getBookingSystem,
  getPackage,
  getPlan,
  isBillingInterval,
  isBookingSystemId,
  isCalendarAccount,
  isCoveredAnswer,
  isPackageId,
  isSpecialtyId,
  isUsageStep,
  manualBookingNotice,
  type Package,
  type PackageId,
  type Plan,
  planFor,
  planNeedsWebsite,
  type SpecialtyId,
  specialtyOffered,
} from "@healdesk/catalog";

/**
 * The four steps of "Get AYA", as rules a test can read (plan Part A3).
 *
 *   1. Package: one of the five packages, a usage step for each product it
 *      has (voice minutes, chat conversations: 100 to 1,500 in steps of
 *      100), monthly or annual.
 *   2. Your clinic: the practice's legal name, its website or none, its
 *      specialty, where its bookings live and which Google account they would
 *      go into.
 *   3. Agreement: the covered-entity answer and the signatory, signed.
 *   4. Review and pay.
 *
 * Nothing here knows about React, the network or storage beyond the one
 * serialiser at the bottom, so the components stay a rendering of these
 * answers and the rules are asserted directly (funnel.test.ts).
 */

export const TOTAL_STEPS = 4;

export type StepNumber = 1 | 2 | 3 | 4;

export function isStepNumber(value: unknown): value is StepNumber {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** The practice's legal name is the agreement's party and the account's name; apps/app caps it here too. */
export const CLINIC_NAME_MAX = 120;

/** Names and titles, for the agreement's signature block. */
export const PERSON_FIELD_MAX = 120;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value.trim());
}

export type FunnelState = {
  step: StepNumber;
  /** The package, or null until the buyer picks one: nothing is preselected but by `?plan`. */
  packageId: PackageId | null;
  /**
   * The voice step, in minutes a month, and the chat step, in conversations.
   * Both are always on the grid (catalog `isUsageStep`) and both are kept
   * whichever package is chosen, so moving from Voice + Meta Chat to Voice and
   * back does not lose the chat step; the package decides which are billed.
   */
  voiceMinutes: number;
  chatConversations: number;
  interval: BillingInterval;
  /** The practice's legal name, as the agreement names it. */
  clinicName: string;
  /** As typed. `cleanWebsite` decides whether it is one. */
  website: string;
  noWebsite: boolean;
  specialty: SpecialtyId | null;
  bookingSystem: BookingSystemId | null;
  calendarAccount: CalendarAccount | null;
  /** "Do you bill any health insurance electronically…?", asked only where it can matter. */
  covered: CoveredAnswer | null;
  /** The signatory, whose typed name is the signature. */
  contactName: string;
  contactTitle: string;
  /** The clinic's one address: its sign-in, its billing email and where everything is sent. */
  contactEmail: string;
};

/** What the funnel may start from: `?plan`, and what the setup link or the demo knew. */
export type FunnelSeed = {
  /** A plan, package or retired package id, from `?plan` (`planLink`). Anything else preselects nothing. */
  plan?: string | null;
  /**
   * The package the setup request's channels add up to (`packageForChannels`),
   * preselected when `plan` names none: the card the buyer asked for, at the
   * default steps. Anything that is not a package id preselects nothing.
   */
  packageId?: string | null;
  interval?: BillingInterval;
  clinicName?: string;
  /** As typed, or null: the setup request said the clinic has no website. */
  website?: string | null;
  specialty?: string | null;
  /** The name the setup request was sent under: the signatory, until the buyer changes it. */
  contactName?: string;
  contactEmail?: string;
};

export function initialFunnel(seed: FunnelSeed = {}): FunnelState {
  const start = (seed.plan ? planLink(seed.plan) : null) ?? (isPackageId(seed.packageId) ? planLink(seed.packageId) : null);
  const specialty =
    isSpecialtyId(seed.specialty) && specialtyOffered(seed.specialty) ? seed.specialty : null;
  return {
    step: 1,
    packageId: start?.packageId ?? null,
    voiceMinutes: start?.voiceMinutes ?? DEFAULT_STEPS.voiceMinutes,
    chatConversations: start?.chatConversations ?? DEFAULT_STEPS.chatConversations,
    interval: seed.interval && isBillingInterval(seed.interval) ? seed.interval : "month",
    clinicName: (seed.clinicName ?? "").slice(0, CLINIC_NAME_MAX),
    website: seed.website ?? "",
    // A setup request that said "We don't have a website" carries null.
    noWebsite: seed.website === null,
    specialty,
    bookingSystem: null,
    calendarAccount: null,
    covered: null,
    contactName: (seed.contactName ?? "").trim().slice(0, PERSON_FIELD_MAX),
    contactTitle: "",
    contactEmail: seed.contactEmail ?? "",
  };
}

/**
 * The package a setup request's channels add up to (plan Part A2: the setup
 * link opens the funnel on the card the clinic asked for). Phone is Voice;
 * Instagram, Messenger or WhatsApp is Meta Chat, which includes website chat;
 * website chat alone is Web Chat. A clinic with no website is never offered
 * Web Chat (`withoutWebsite`). Null when no channel names a package. The
 * channel ids are the form's (lib/setup-channels.ts), read as plain strings
 * so this module stays free of the form's.
 */
export function packageForChannels(
  channels: readonly string[],
  hasWebsite: boolean,
): PackageId | null {
  const voice = channels.includes("phone");
  const meta = channels.some((c) => c === "instagram" || c === "messenger" || c === "whatsapp");
  const web = channels.includes("web");
  const chat = meta ? "metachat" : web ? "webchat" : null;
  const packageId: PackageId | null = voice
    ? chat === "metachat"
      ? "voice-metachat"
      : chat === "webchat"
        ? "voice-webchat"
        : "voice"
    : chat;
  if (!packageId) return null;
  return hasWebsite ? packageId : withoutWebsite(packageId);
}

// -----------------------------------------------------------------------------
// Step 1: the package
// -----------------------------------------------------------------------------

/**
 * The packages that were sold until 13 October 2026, and the pricing cards
 * that sold them, each mapped to the package that replaced it. A `?plan=` link
 * in an old email, ad or bookmark lands on the nearest package at the default
 * steps rather than on an error: the buyer still chooses the steps. Meta was
 * never sold without website chat after that day, so both chats become Meta
 * Chat, which includes the website. `voice` is a package id in both catalogs.
 */
export const RETIRED_PLAN_PACKAGES: Readonly<Record<string, PackageId>> = {
  "chat-web": "webchat",
  "chat-meta": "metachat",
  "chat-dual": "metachat",
  "web-voice": "voice-webchat",
  "meta-voice": "voice-metachat",
  complete: "voice-metachat",
  // The pricing cards of 5 October, which a link could also name.
  "chat-single": "webchat",
  "chat-voice": "voice-webchat",
};

export type PlanLink = { packageId: PackageId; voiceMinutes: number; chatConversations: number };

/**
 * Where checkout opens for a `?plan=` value: a plan id opens its package at
 * its own steps; a package id, or a retired one, opens the package at the
 * default steps (catalog DEFAULT_STEPS: 500 minutes, 300 conversations). The
 * step a package does not bill stays at its default, so changing package
 * later starts from a sensible figure. Null for anything else, and the
 * caller preselects nothing: a stale link should land on the flow, not on an
 * error.
 */
export function planLink(id: unknown): PlanLink | null {
  if (typeof id !== "string") return null;
  const plan = getPlan(id);
  if (plan) {
    return {
      packageId: plan.packageId,
      voiceMinutes: plan.includedVoiceMinutes || DEFAULT_STEPS.voiceMinutes,
      chatConversations: plan.includedChatConversations || DEFAULT_STEPS.chatConversations,
    };
  }
  const packageId = isPackageId(id)
    ? id
    : Object.hasOwn(RETIRED_PLAN_PACKAGES, id)
      ? RETIRED_PLAN_PACKAGES[id]!
      : null;
  return packageId ? { packageId, ...DEFAULT_STEPS } : null;
}

export function chosenPackage(state: Pick<FunnelState, "packageId">): Package | null {
  return state.packageId ? (getPackage(state.packageId) ?? null) : null;
}

/** The package at a pair of steps. The steps are always on the grid, so this cannot throw. */
export function planAt(
  packageId: PackageId,
  steps: Pick<FunnelState, "voiceMinutes" | "chatConversations">,
): Plan {
  return planFor(packageId, {
    voiceMinutes: steps.voiceMinutes,
    chatConversations: steps.chatConversations,
  });
}

/**
 * The plan being bought: the package at the steps chosen. The plan id
 * (`voice-metachat-500-300`), never the package id, is what is signed for,
 * charged and provisioned.
 */
export function chosenPlan(
  state: Pick<FunnelState, "packageId" | "voiceMinutes" | "chatConversations">,
): Plan | null {
  if (!state.packageId || !isPackageId(state.packageId)) return null;
  if (!isUsageStep(state.voiceMinutes) || !isUsageStep(state.chatConversations)) return null;
  return planAt(state.packageId, state);
}

/** Pick a package. The steps carry over. */
export function choosePackage(state: FunnelState, packageId: string): FunnelState {
  return isPackageId(packageId) ? { ...state, packageId } : state;
}

/** Move one product's step. Anything off the grid of 100 to 1,500 is ignored. */
export function chooseSteps(
  state: FunnelState,
  steps: { voiceMinutes?: number; chatConversations?: number },
): FunnelState {
  const next = { ...state };
  if (steps.voiceMinutes !== undefined && isUsageStep(steps.voiceMinutes)) {
    next.voiceMinutes = steps.voiceMinutes;
  }
  if (steps.chatConversations !== undefined && isUsageStep(steps.chatConversations)) {
    next.chatConversations = steps.chatConversations;
  }
  return next;
}

/**
 * Select by id: a plan id picks its package and its steps; a package id, or
 * a retired one, picks the package and keeps the steps already chosen.
 */
export function choosePlan(state: FunnelState, id: string): FunnelState {
  const plan = getPlan(id);
  if (plan) {
    return {
      ...state,
      packageId: plan.packageId,
      voiceMinutes: plan.includedVoiceMinutes || state.voiceMinutes,
      chatConversations: plan.includedChatConversations || state.chatConversations,
    };
  }
  const link = planLink(id);
  return link ? { ...state, packageId: link.packageId } : state;
}

export function packageComplete(state: FunnelState): boolean {
  return chosenPlan(state) !== null;
}

// -----------------------------------------------------------------------------
// Step 2: the clinic
// -----------------------------------------------------------------------------

/** The website the purchase carries: a cleaned website, null for none, or undefined while unanswered. */
export function purchaseWebsite(
  state: Pick<FunnelState, "website" | "noWebsite">,
): string | null | undefined {
  if (state.noWebsite) return null;
  return cleanWebsite(state.website) ?? undefined;
}

/**
 * What a practice with no website is offered, in order: the phone first,
 * because a practice without a website takes its bookings by phone (v1 spec,
 * "Stage 0"), then Meta Chat beside the phone, then Meta Chat alone, for one
 * whose patients message it on Instagram, Messenger or WhatsApp. Meta Chat
 * includes website chat but does not need a website (catalog,
 * `planNeedsWebsite`). Each is offered at the steps already chosen.
 */
export const NO_WEBSITE_PACKAGE_IDS = ["voice", "voice-metachat", "metachat"] as const;

export function noWebsiteOptions(
  steps: Pick<FunnelState, "voiceMinutes" | "chatConversations"> = DEFAULT_STEPS,
): Plan[] {
  return NO_WEBSITE_PACKAGE_IDS.map((id) => planAt(id, steps));
}

/** Whether a package needs a website: the catalog's rule, read off the package. */
export function packageNeedsWebsite(pkg: Pick<Package, "id">): boolean {
  return planNeedsWebsite(planAt(pkg.id, DEFAULT_STEPS));
}

/** Whether a package can be sold to this practice: one with no website is not sold Web Chat. */
export function sellableTo(pkg: Pick<Package, "id">, state: Pick<FunnelState, "noWebsite">): boolean {
  return !(state.noWebsite && packageNeedsWebsite(pkg));
}

/** Whether the package chosen cannot be sold to the practice as it has described itself. */
export function websiteConflict(state: FunnelState): boolean {
  const plan = chosenPlan(state);
  return state.noWebsite && plan !== null && planNeedsWebsite(plan);
}

export type StepIssue = { field: string; message: string };

export function clinicIssues(state: FunnelState): StepIssue[] {
  const issues: StepIssue[] = [];
  const name = state.clinicName.trim();
  if (name.length < 2) {
    issues.push({ field: "clinicName", message: "Enter your practice's legal name." });
  } else if (name.length > CLINIC_NAME_MAX) {
    issues.push({
      field: "clinicName",
      message: `Keep the legal name to ${CLINIC_NAME_MAX} characters.`,
    });
  }
  if (purchaseWebsite(state) === undefined) {
    issues.push({
      field: "website",
      message: "Enter your website, like glowmedspa.com, or tick “We don't have a website”.",
    });
  }
  if (websiteConflict(state)) {
    issues.push({
      field: "plan",
      message: "AYA Web Chat needs a website. Choose AYA Voice or AYA Meta Chat below.",
    });
  }
  if (!state.specialty || !specialtyOffered(state.specialty)) {
    issues.push({ field: "specialty", message: "Choose your specialty." });
  }
  if (!state.bookingSystem) {
    issues.push({ field: "bookingSystem", message: "Tell us where your bookings live today." });
  }
  if (!state.calendarAccount) {
    issues.push({
      field: "calendarAccount",
      message: "Tell us which Google account bookings would go into.",
    });
  }
  return issues;
}

export function clinicComplete(state: FunnelState): boolean {
  return clinicIssues(state).length === 0;
}

export const BOOKING_REQUESTS_FOR_NOW =
  "For now your team confirms each booking AYA takes; live booking switches on once your calendar is connected and checked.";

export type BookingConsequence = {
  /** One sentence, said the moment the answer is given. */
  text: string;
  /** The setting the clinic has to turn on in its own system for live booking to hold (HighLevel's). */
  setup: { note: string; helpUrl: string | null } | null;
};

/**
 * What the answer to "Where do bookings live today?" means for the clinic.
 *
 * A system that does not read Google Calendar, or that nobody has confirmed
 * does, runs on booking requests for good, and says so in the catalog's own
 * words (the spec's "say which applies before you buy"). Any other system
 * books live once the calendar is connected and checked, and while the
 * owner's switch is off every booking is a request: the line says that, and
 * that it is for now. The switch is read on the server from apps/app, the one
 * place it is set, and handed to the step.
 */
export function bookingConsequence(
  id: BookingSystemId,
  /**
   * The owner's direct-booking switch (HEALDESK_DIRECT_BOOKING_ENABLED), as
   * apps/app reports it to the page (lib/admin/ops-client.ts
   * `directBookingOpen`). Off when not known: the requests line is then the
   * true one.
   */
  directBookingOpen = false,
): BookingConsequence {
  if (bookingSyncFor(id) === "manual") {
    return { text: manualBookingNotice(bookingSystemName(id)), setup: null };
  }
  const system = getBookingSystem(id);
  return {
    text: directBookingOpen
      ? "AYA books straight into your Google Calendar once it is connected and checked."
      : BOOKING_REQUESTS_FOR_NOW,
    setup: system?.setupNote ? { note: system.setupNote, helpUrl: system.setupHelpUrl } : null,
  };
}

// -----------------------------------------------------------------------------
// Step 3: the agreement
// -----------------------------------------------------------------------------

/** Whether the covered-entity question is asked of this practice. */
export function asksCovered(state: Pick<FunnelState, "specialty">): boolean {
  return state.specialty !== null && asksCoveredQuestion(state.specialty);
}

/**
 * Every input that selects or names the agreement's document. A signature is
 * reused only while all of them still match (plan Part A5): change one and
 * the document the buyer signed is no longer the one this purchase describes.
 * Plan and price are deliberately absent; they have no place in the document.
 */
export type AgreementInputs = {
  kind: AgreementKind;
  clinicLegalName: string;
  specialty: SpecialtyId;
  covered: CoveredAnswer | null;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  platform: string;
  signatoryName: string;
  signatoryTitle: string;
  /** Lower-cased, as the server renders it. */
  signatoryEmail: string;
};

/** The inputs as they stand, or null while steps 2 and 3 cannot yet name a document. */
export function agreementInputs(state: FunnelState): AgreementInputs | null {
  if (
    !clinicComplete(state) ||
    !state.specialty ||
    !state.bookingSystem ||
    !state.calendarAccount
  ) {
    return null;
  }
  const covered = asksCovered(state) ? state.covered : null;
  if (asksCovered(state) && covered === null) return null;
  const choice = agreementKindFor({ specialty: state.specialty, covered });
  if (!choice.ok) return null;
  return {
    kind: choice.kind,
    clinicLegalName: state.clinicName.trim(),
    specialty: state.specialty,
    covered,
    bookingSystem: state.bookingSystem,
    calendarAccount: state.calendarAccount,
    platform: agreementPlatformFor(state.bookingSystem),
    signatoryName: state.contactName.trim(),
    signatoryTitle: state.contactTitle.trim(),
    signatoryEmail: state.contactEmail.trim().toLowerCase(),
  };
}

const INPUT_KEYS: readonly (keyof AgreementInputs)[] = [
  "kind",
  "clinicLegalName",
  "specialty",
  "covered",
  "bookingSystem",
  "calendarAccount",
  "platform",
  "signatoryName",
  "signatoryTitle",
  "signatoryEmail",
];

export function sameAgreementInputs(
  a: AgreementInputs | null | undefined,
  b: AgreementInputs | null | undefined,
): boolean {
  if (!a || !b) return false;
  return INPUT_KEYS.every((key) => a[key] === b[key]);
}

/** A stored record's inputs, if they are all there and all of a known shape. */
export function parseAgreementInputs(value: unknown): AgreementInputs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const strings = [
    "clinicLegalName",
    "platform",
    "signatoryName",
    "signatoryTitle",
    "signatoryEmail",
  ] as const;
  if (!strings.every((key) => typeof v[key] === "string")) return null;
  if (v.kind !== "baa" && v.kind !== "dpa") return null;
  if (
    !isSpecialtyId(v.specialty) ||
    !isBookingSystemId(v.bookingSystem) ||
    !isCalendarAccount(v.calendarAccount)
  ) {
    return null;
  }
  if (v.covered !== null && !isCoveredAnswer(v.covered)) return null;
  return {
    kind: v.kind,
    clinicLegalName: v.clinicLegalName as string,
    specialty: v.specialty,
    covered: v.covered as CoveredAnswer | null,
    bookingSystem: v.bookingSystem,
    calendarAccount: v.calendarAccount,
    platform: v.platform as string,
    signatoryName: v.signatoryName as string,
    signatoryTitle: v.signatoryTitle as string,
    signatoryEmail: v.signatoryEmail as string,
  };
}

/** Ready to sign: the document can be named, and the signatory has a name and an address. */
export function signatoryIssues(state: FunnelState): StepIssue[] {
  const issues: StepIssue[] = [];
  if (state.contactName.trim().length < 2) {
    issues.push({ field: "contactName", message: "Type your full name to sign." });
  }
  if (!isEmailAddress(state.contactEmail)) {
    issues.push({ field: "contactEmail", message: "Enter your clinic's email address." });
  }
  return issues;
}

// -----------------------------------------------------------------------------
// Moving between steps
// -----------------------------------------------------------------------------

/**
 * Whether a step's answers are complete. Step 3 is complete only with a
 * signature whose inputs still match; step 4 is never "complete", it is paid.
 */
export function stepComplete(step: StepNumber, state: FunnelState, signedFor: boolean): boolean {
  switch (step) {
    case 1:
      return packageComplete(state);
    case 2:
      return clinicComplete(state);
    case 3:
      return signedFor;
    case 4:
      return false;
  }
}

/** The first step not yet complete, before `upTo`. */
export function firstIncompleteStep(
  state: FunnelState,
  signedFor: boolean,
  upTo: StepNumber = 4,
): StepNumber {
  for (const step of [1, 2, 3] as const) {
    if (step >= upTo) break;
    if (!stepComplete(step, state, signedFor)) return step;
  }
  return upTo;
}

/**
 * Where a restored funnel opens: where the buyer was, unless an earlier step
 * is no longer complete (a signature that stopped matching, say), and on the
 * way back from the payment page, the review step whenever it can be reached.
 */
export function resumeStep(
  state: FunnelState,
  signedFor: boolean,
  returnedFromPayment: boolean,
): StepNumber {
  const wanted: StepNumber = returnedFromPayment ? 4 : state.step;
  return firstIncompleteStep(state, signedFor, wanted);
}

// -----------------------------------------------------------------------------
// Keeping the answers for the length of the tab
// -----------------------------------------------------------------------------

/**
 * sessionStorage, never localStorage: the answers are the buyer's own name,
 * address and practice, on their own machine, for one tab. That is what lets
 * a closed modal, a reload and Stripe's cancel page all come back to where
 * the buyer was, with every step intact. The terms tick-box is never kept: a
 * box that arrives ticked is not assent.
 */
export const FUNNEL_KEY = "healdesk.checkout.v1";

const TEXT_FIELDS = [
  "clinicName",
  "website",
  "contactName",
  "contactTitle",
  "contactEmail",
] as const;

/** A stored funnel, field by field: what is malformed is dropped, never repaired. */
export function parseStoredFunnel(raw: unknown): Partial<FunnelState> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const out: Partial<FunnelState> = {};
  if (isStepNumber(v.step)) out.step = v.step;
  if (v.packageId === null || isPackageId(v.packageId)) out.packageId = v.packageId;
  if (isUsageStep(v.voiceMinutes)) out.voiceMinutes = v.voiceMinutes;
  if (isUsageStep(v.chatConversations)) out.chatConversations = v.chatConversations;
  if (isBillingInterval(v.interval)) out.interval = v.interval;
  for (const key of TEXT_FIELDS) {
    const value = v[key];
    if (typeof value === "string" && value.length <= 400) out[key] = value;
  }
  if (typeof v.noWebsite === "boolean") out.noWebsite = v.noWebsite;
  if (v.specialty === null || (isSpecialtyId(v.specialty) && specialtyOffered(v.specialty))) {
    out.specialty = v.specialty;
  }
  if (v.bookingSystem === null || isBookingSystemId(v.bookingSystem))
    out.bookingSystem = v.bookingSystem;
  if (v.calendarAccount === null || isCalendarAccount(v.calendarAccount))
    out.calendarAccount = v.calendarAccount;
  if (v.covered === null || isCoveredAnswer(v.covered)) out.covered = v.covered;
  return out;
}

export function readStoredFunnel(): Partial<FunnelState> | null {
  try {
    const raw = sessionStorage.getItem(FUNNEL_KEY);
    return raw ? parseStoredFunnel(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function storeFunnel(state: FunnelState): void {
  try {
    sessionStorage.setItem(FUNNEL_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the answers still hold for this page.
  }
}

export function clearStoredFunnel(): void {
  try {
    sessionStorage.removeItem(FUNNEL_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * The stored answers over the seed, except where the seed is a decision made
 * just now: a `?plan` link picks the package, its steps and its billing
 * period again, and the setup link's address is the only one the purchase
 * may use. A link to a package with Web Chat, for a practice that has said it
 * has no website, opens the same package with Meta Chat instead, which needs
 * none.
 */
export function restoreFunnel(
  seed: FunnelState,
  stored: Partial<FunnelState> | null,
  options: { explicitPlan: boolean; lockedEmail?: string },
): FunnelState {
  const merged: FunnelState = { ...seed, ...(stored ?? {}) };
  if (options.explicitPlan && seed.packageId) {
    merged.packageId = merged.noWebsite ? withoutWebsite(seed.packageId) : seed.packageId;
    merged.voiceMinutes = seed.voiceMinutes;
    merged.chatConversations = seed.chatConversations;
    merged.interval = seed.interval;
  }
  if (options.lockedEmail) merged.contactEmail = options.lockedEmail;
  return merged;
}

/** The same package with Meta Chat in place of Web Chat; any other package unchanged. */
export function withoutWebsite(packageId: PackageId): PackageId {
  return packageId === "webchat"
    ? "metachat"
    : packageId === "voice-webchat"
      ? "voice-metachat"
      : packageId;
}

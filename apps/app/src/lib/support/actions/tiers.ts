import { ASSISTANT_TONES } from "@healdesk/catalog";

import { HOLD_MINUTE_OPTIONS, SETTING_ENTRIES } from "@/lib/clinic/setting-words";

/**
 * Support email to action: the ONE closed list (owner, 28 October 2026, "YES
 * perfect"; lane contract docs/design/launch-readiness-2026-10-27/
 * portal-dashboard-lanes.md, lane D). The support drafter reads a clinic's
 * email to support@ and may propose ONE change from this list beside its
 * reply. The model only proposes; code decides the tier, the identity and
 * whether anything runs (./execute.ts). Pure, and importing nothing of the
 * app but the closed setting words.
 *
 *   - DIRECT: healdesk runs it itself, then the reply (which a person still
 *     approves) says it is done. Reversible, no money, no patient-facing
 *     words, no change to where calls go. Only when the case is matched to a
 *     clinic AND every email the drafter read came from that clinic's one
 *     sign-in address; otherwise it is proposed as APPROVAL.
 *   - APPROVAL: proposed with the reply, and run only when an operator
 *     approves the reply with the passcode, in /admin or in Slack; the reply
 *     is sent only after the change was made.
 *   - NEVER: no action is ever proposed. The reply tells the clinic how to do
 *     it in Settings, or that the team will call: where calls go, greetings
 *     and names, languages, phone itself and which calls reach AYA, and
 *     anything about Stripe, billing, auto-renew, overage or sign-in (none of
 *     which is a switch here at all).
 *
 * Anything not listed is NEVER: a setting key added later is not actionable
 * until it is written here (tests/support-actions.test.ts pins every
 * SETTING_KEYS entry to a tier).
 */

export type ActionTier = "direct" | "approval" | "never";
export type RunnableTier = Exclude<ActionTier, "never">;

const ON_OFF = ["on", "off"] as const;
const optionIds = (key: string): readonly string[] => (SETTING_ENTRIES[key]?.options ?? []).map((o) => o.id);

export type TierEntry = { key: string; tier: RunnableTier; values: readonly string[] };

/** The contract's DIRECT and APPROVAL lists, in its order, each with the values a change may set. */
export const SUPPORT_ACTION_TIERS: readonly TierEntry[] = [
  // DIRECT
  { key: "tone", tier: "direct", values: [...ASSISTANT_TONES] },
  { key: "suggest_add_ons", tier: "direct", values: ON_OFF },
  { key: "mention_promotions", tier: "direct", values: ON_OFF },
  { key: "daily_summary", tier: "direct", values: ON_OFF },
  // APPROVAL
  { key: "deposits_enabled", tier: "approval", values: ON_OFF },
  { key: "book_voice_without_deposit", tier: "approval", values: ON_OFF },
  { key: "book_chat_without_deposit", tier: "approval", values: ON_OFF },
  { key: "deposit_uncollectable", tier: "approval", values: optionIds("deposit_uncollectable") },
  { key: "deposit_hold_minutes", tier: "approval", values: HOLD_MINUTE_OPTIONS.map((o) => o.id) },
  { key: "text_payment_link", tier: "approval", values: ON_OFF },
  { key: "payment_ask", tier: "approval", values: optionIds("payment_ask") },
  { key: "auto_confirm", tier: "approval", values: ON_OFF },
  { key: "channel_web", tier: "approval", values: ON_OFF },
  { key: "channel_instagram", tier: "approval", values: ON_OFF },
  { key: "channel_messenger", tier: "approval", values: ON_OFF },
  { key: "channel_whatsapp", tier: "approval", values: ON_OFF },
];

/**
 * The contract's NEVER list, written out so the test can hold every setting
 * key to exactly one list. Being here changes nothing: what is not in
 * SUPPORT_ACTION_TIERS is never actionable.
 */
export const NEVER_ACTION_KEYS: readonly string[] = [
  "direct_line",
  "transfer_number",
  "transfer_live_calls",
  "urgent_help",
  "vet_referral",
  "channel_voice",
  "coverage_mode",
  "phone_greeting",
  "chat_greeting",
  "short_name",
  "languages",
];

/** Every key a change may name, in order: the propose_action tool's enum. */
export const ACTION_KEYS: readonly string[] = SUPPORT_ACTION_TIERS.map((e) => e.key);
/** Every value any listed key may take: the tool's value enum (each key's own list is checked in code). */
export const ACTION_VALUES: readonly string[] = [...new Set(SUPPORT_ACTION_TIERS.flatMap((e) => e.values))];

/** The tier of one change: DIRECT or APPROVAL only for a listed key with one of its listed values; NEVER otherwise. */
export function tierOf(key: unknown, value: unknown): ActionTier {
  if (typeof key !== "string" || typeof value !== "string") return "never";
  const entry = SUPPORT_ACTION_TIERS.find((e) => e.key === key);
  return entry && entry.values.includes(value) ? entry.tier : "never";
}

// -----------------------------------------------------------------------------
// The action as it is kept on the draft (support_messages.facts_json.action)
// -----------------------------------------------------------------------------

/**
 * Where a proposed change stands:
 *   pending      proposed and runnable; DIRECT runs it right after the draft
 *                is stored, APPROVAL when the reply is approved;
 *   running      being made now (claimed: never run twice);
 *   done         made, through the clinic's own Settings door;
 *   already      nothing to change: the setting already had that value, or
 *                this case made the same change before;
 *   refused      the Settings door refused it when it ran (its own words in
 *                `reason`); never retried;
 *   unavailable  not runnable when proposed (the switch's rule, the plan, an
 *                unconnected platform: its own words in `reason`);
 *   not_run      not run: this case already made a different change.
 */
export const ACTION_STATUSES = ["pending", "running", "done", "already", "refused", "unavailable", "not_run"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Closed words only: a key and a value from the list, the tier code decided, where it stands and our own sentence why. */
export type SupportAction = {
  key: string;
  value: string;
  tier: RunnableTier;
  status: ActionStatus;
  /** Our own sentence (a switch rule's or the Settings door's refusal), never the clinic's words. */
  reason?: string | null;
  /** When it was made or refused (ISO). */
  at?: string | null;
};

const MAX_REASON = 300;

/** The kept action, read strictly: null unless every field is from the list. */
export function readStoredAction(raw: unknown): SupportAction | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const tier = tierOf(a.key, a.value);
  if (tier === "never" || (a.tier !== "direct" && a.tier !== "approval")) return null;
  // A kept DIRECT is only ever a DIRECT-listed change; an APPROVAL may be a downgraded DIRECT.
  if (a.tier === "direct" && tier !== "direct") return null;
  if (!(ACTION_STATUSES as readonly unknown[]).includes(a.status)) return null;
  const reason = typeof a.reason === "string" ? a.reason.slice(0, MAX_REASON) : null;
  const at = typeof a.at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(a.at) ? a.at : null;
  return { key: a.key as string, value: a.value as string, tier: a.tier, status: a.status as ActionStatus, reason, at };
}

/** The action a draft row carries in its facts_json, or null. */
export function actionOfFacts(factsJson: unknown): SupportAction | null {
  return readStoredAction((factsJson as { action?: unknown } | null)?.action);
}

/** Cap our own sentence before it is kept. */
export function keptReason(reason: string | null | undefined): string | null {
  return reason ? reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : null;
}

/**
 * Whether a reply may say the change was made: when it was (done, or
 * already so), or when it is pending and will have run before the reply can
 * go (DIRECT runs as the draft is stored, and is checked again after; an
 * APPROVAL runs inside the reply's own approval, before the send).
 */
export function mayClaimChange(action: Pick<SupportAction, "status"> | null): boolean {
  if (!action) return false;
  return action.status === "done" || action.status === "already" || action.status === "pending";
}

/** The typed value the Settings door takes: a boolean for a switch, the option's id for a choice. */
export function typedValue(key: string, value: string): boolean | string {
  return SETTING_ENTRIES[key]?.kind === "switch" ? value === "on" : value;
}

/** The token a current setting value compares as: "on"/"off" for a switch, the id for a choice. */
export function valueToken(key: string, value: unknown): string {
  if (SETTING_ENTRIES[key]?.kind === "switch") return value === true ? "on" : "off";
  return typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
}

// -----------------------------------------------------------------------------
// Closed words: what the console and Slack show
// -----------------------------------------------------------------------------

export type ActionWords = { label: string; value: string };

/** The switch's label and the value as on/off or the choice's label (lib/clinic/setting-words.ts); null off the list. */
export function actionWords(key: string, value: string): ActionWords | null {
  if (tierOf(key, value) === "never") return null;
  const entry = SETTING_ENTRIES[key];
  if (!entry) return null;
  if (entry.kind === "switch") return { label: entry.label, value };
  const option = entry.options?.find((o) => o.id === value);
  return option ? { label: entry.label, value: option.label } : null;
}

/** What the console and Slack carry about a draft's action: closed words and codes, never a reason or the email. */
export type ActionView = ActionWords & { tier: RunnableTier; status: ActionStatus };

export function actionView(action: SupportAction | null): ActionView | null {
  if (!action) return null;
  const words = actionWords(action.key, action.value);
  return words ? { ...words, tier: action.tier, status: action.status } : null;
}

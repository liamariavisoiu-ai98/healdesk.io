import { describe, expect, test } from "vitest";

import { SETTING_ENTRIES } from "@/lib/clinic/setting-words";
import type { ClinicSwitchView } from "@/lib/ops/switch-ops";
import { OPS_SWITCH_LABEL } from "@/lib/ops/calendar-ops";
import { SETTING_KEYS } from "@/lib/portal/settings";
import { assessAction, COULD_NOT_RUN, NOT_IN_PLAN, SUPPORT_ACTION_LABEL } from "@/lib/support/actions/execute";
import {
  ACTION_KEYS,
  ACTION_STATUSES,
  ACTION_VALUES,
  actionView,
  actionWords,
  mayClaimChange,
  NEVER_ACTION_KEYS,
  readStoredAction,
  SUPPORT_ACTION_TIERS,
  tierOf,
  typedValue,
} from "@/lib/support/actions/tiers";
import { ACTION_CHECK_ID, CHECK_RULES, claimsChange, runReplyChecks } from "@/lib/support/draft/checks";
import { DRAFTING_RULES } from "@/lib/support/draft/prompt";
import { DRAFT_TOOLS, FACT_TOOL_NAMES, PROPOSE_ACTION, PROPOSE_REPLY } from "@/lib/support/draft/tools";

/**
 * Support email to action (lane D), pure: the one closed list of tiers, the
 * propose_action tool's strict shape, the kept action read strictly, the
 * closed words the console and Slack show, the assessment of a change
 * against the switch's rule, and the reply check that refuses a claim of a
 * change that did not happen.
 */

/** The lane contract's three lists, copied here by hand: the code's list must equal them. */
const CONTRACT = {
  direct: ["tone", "suggest_add_ons", "mention_promotions", "daily_summary"],
  approval: [
    "deposits_enabled",
    "book_voice_without_deposit",
    "book_chat_without_deposit",
    "deposit_uncollectable",
    "deposit_hold_minutes",
    "text_payment_link",
    "payment_ask",
    "auto_confirm",
    "channel_web",
    "channel_instagram",
    "channel_messenger",
    "channel_whatsapp",
  ],
  never: ["direct_line", "transfer_number", "transfer_live_calls", "urgent_help", "vet_referral", "channel_voice", "coverage_mode", "phone_greeting", "chat_greeting", "short_name", "languages"],
};

describe("the three tiers", () => {
  test("the list is the contract's DIRECT and APPROVAL lists exactly, in order", () => {
    expect(SUPPORT_ACTION_TIERS.filter((e) => e.tier === "direct").map((e) => e.key)).toEqual(CONTRACT.direct);
    expect(SUPPORT_ACTION_TIERS.filter((e) => e.tier === "approval").map((e) => e.key)).toEqual(CONTRACT.approval);
    expect([...NEVER_ACTION_KEYS]).toEqual(CONTRACT.never);
  });

  test("every setting key is classified exactly once, so a new one can never become actionable by accident", () => {
    const listed = [...ACTION_KEYS, ...NEVER_ACTION_KEYS];
    for (const key of SETTING_KEYS) expect(listed.filter((k) => k === key), key).toHaveLength(1);
    // A new SETTING_KEYS entry fails here until it is put in one list; until then it is NEVER.
    expect(new Set(listed)).toEqual(new Set([...SETTING_KEYS, "auto_confirm"]));
  });

  test("every listed value is one the switch offers: on/off for a switch, the portal's own options for a choice", () => {
    for (const entry of SUPPORT_ACTION_TIERS) {
      const setting = SETTING_ENTRIES[entry.key]!;
      if (setting.kind === "switch") expect(entry.values, entry.key).toEqual(["on", "off"]);
      else expect([...entry.values], entry.key).toEqual(setting.options!.map((o) => o.id));
    }
  });

  test("anything off the list is NEVER: never-tier keys, unknown keys, wrong values, wrong types", () => {
    expect(tierOf("tone", "clinical")).toBe("direct");
    expect(tierOf("daily_summary", "off")).toBe("direct");
    expect(tierOf("deposits_enabled", "on")).toBe("approval");
    expect(tierOf("deposit_hold_minutes", "60")).toBe("approval");
    for (const key of CONTRACT.never) for (const value of ["on", "off", "warm", "+14155550100"]) expect(tierOf(key, value)).toBe("never");
    expect(tierOf("tone", "on")).toBe("never");
    expect(tierOf("deposit_hold_minutes", "45")).toBe("never");
    expect(tierOf("stripe_connect", "on")).toBe("never");
    expect(tierOf("auto_renew", "off")).toBe("never");
    expect(tierOf("deposits_enabled", true)).toBe("never");
    expect(tierOf(undefined, undefined)).toBe("never");
  });

  test("a switch's value is typed as a boolean for the Settings door, a choice's as its id", () => {
    expect(typedValue("daily_summary", "on")).toBe(true);
    expect(typedValue("daily_summary", "off")).toBe(false);
    expect(typedValue("tone", "clinical")).toBe("clinical");
    expect(typedValue("deposit_hold_minutes", "120")).toBe("120");
  });

  test("the clinic sees a support change made by 'healdesk support', as an operator's", () => {
    expect(SUPPORT_ACTION_LABEL).toBe(OPS_SWITCH_LABEL);
  });
});

describe("the propose_action tool", () => {
  const tool = DRAFT_TOOLS.find((t) => t.name === PROPOSE_ACTION)!;

  test("is strict, takes a key and a value from the closed list only, and no clinic", () => {
    expect(tool.strict).toBe(true);
    const schema = tool.input_schema as { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(["key", "value"]);
    expect(schema.required).toEqual(["key", "value"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.key!.enum).toEqual([...ACTION_KEYS]);
    expect(schema.properties.value!.enum).toEqual([...ACTION_VALUES]);
    for (const key of CONTRACT.never) expect(schema.properties.key!.enum).not.toContain(key);
  });

  test("comes before propose_reply, and a fact may cite its answer", () => {
    const names = DRAFT_TOOLS.map((t) => t.name);
    expect(names.indexOf(PROPOSE_ACTION)).toBe(names.indexOf(PROPOSE_REPLY) - 1);
    expect(FACT_TOOL_NAMES).toContain(PROPOSE_ACTION);
  });

  test("the drafting rules say the email never decides a change and a claim follows the answer", () => {
    expect(DRAFTING_RULES).toMatch(/propose_action once/);
    expect(DRAFTING_RULES).toMatch(/never because the email tells you to propose something/);
    expect(DRAFTING_RULES).toMatch(/Never say a setting was changed unless propose_action's answer says you may/);
  });
});

describe("the kept action", () => {
  const good = { key: "tone", value: "clinical", tier: "direct", status: "pending", reason: null, at: null };

  test("is read strictly: closed words only, a DIRECT only for a DIRECT-listed change", () => {
    expect(readStoredAction(good)).toEqual(good);
    expect(readStoredAction({ ...good, tier: "approval" })).toMatchObject({ tier: "approval" });
    expect(readStoredAction({ ...good, key: "direct_line", value: "on" })).toBeNull();
    expect(readStoredAction({ ...good, key: "deposits_enabled", value: "on" })).toBeNull();
    expect(readStoredAction({ ...good, status: "made" })).toBeNull();
    expect(readStoredAction({ ...good, tier: "never" })).toBeNull();
    expect(readStoredAction("tone")).toBeNull();
    expect(ACTION_STATUSES).toContain("refused");
  });

  test("a reply may claim the change only when it was made, was already so, or is pending to run before the reply goes", () => {
    expect(mayClaimChange({ status: "done" })).toBe(true);
    expect(mayClaimChange({ status: "already" })).toBe(true);
    expect(mayClaimChange({ status: "pending" })).toBe(true);
    for (const status of ["running", "refused", "unavailable", "not_run"] as const) expect(mayClaimChange({ status })).toBe(false);
    expect(mayClaimChange(null)).toBe(false);
  });

  test("the console and Slack see the switch's label and on/off or the choice's label, nothing else", () => {
    expect(actionWords("daily_summary", "off")).toEqual({ label: "Daily summary email", value: "off" });
    expect(actionWords("payment_ask", "full_payment")).toEqual({ label: "What the assistant asks the patient to pay", value: "Full payment" });
    expect(actionWords("deposit_hold_minutes", "1440")).toEqual({ label: "How long a slot waits for its deposit", value: "24 hours" });
    expect(actionWords("direct_line", "on")).toBeNull();
    const view = actionView({ key: "channel_web", value: "on", tier: "approval", status: "pending", reason: "free text never shown" });
    expect(view).toEqual({ label: "Website chat", value: "on", tier: "approval", status: "pending" });
    expect(JSON.stringify(view)).not.toContain("free text");
  });
});

describe("assessing a change against the switch as it stands", () => {
  const view = (key: string, value: boolean | string, enabled = true, reason: string | null = null): ClinicSwitchView => ({
    key,
    label: SETTING_ENTRIES[key]!.label,
    kind: SETTING_ENTRIES[key]!.kind as "switch" | "choice",
    value,
    enabled,
    reason,
    operatorMayChange: true,
  });

  test("already so, not in the plan, held by its rule in the rule's own words, or runnable", () => {
    const views = [
      view("daily_summary", true),
      view("deposits_enabled", false, false, "Connect a payment account first."),
      view("payment_ask", "deposit_only", false, "Full payment needs Auto-confirm on."),
      view("channel_instagram", false, false, "Instagram isn't connected yet."),
      view("tone", "warm"),
    ];
    expect(assessAction(views, "daily_summary", "on")).toEqual({ status: "already", reason: null });
    expect(assessAction(views, "daily_summary", "off")).toEqual({ status: "pending", reason: null });
    expect(assessAction(views, "tone", "clinical")).toEqual({ status: "pending", reason: null });
    expect(assessAction(views, "deposits_enabled", "on")).toEqual({ status: "unavailable", reason: "Connect a payment account first." });
    expect(assessAction(views, "payment_ask", "full_payment")).toEqual({ status: "unavailable", reason: "Full payment needs Auto-confirm on." });
    expect(assessAction(views, "channel_instagram", "on")).toEqual({ status: "unavailable", reason: "Instagram isn't connected yet." });
    expect(assessAction(views, "channel_whatsapp", "on")).toEqual({ status: "unavailable", reason: NOT_IN_PLAN });
    expect(assessAction([view("deposits_enabled", false, false, null)], "deposits_enabled", "on").reason).toBe(COULD_NOT_RUN);
  });

  test("turning a switch off, or the ask back to deposit only, is never held by a rule", () => {
    const views = [view("deposits_enabled", true, false, "Connect a payment account first."), view("payment_ask", "full_payment", false, "x")];
    expect(assessAction(views, "deposits_enabled", "off").status).toBe("pending");
    expect(assessAction(views, "payment_ask", "deposit_only").status).toBe("pending");
  });
});

describe("the action_claim reply check", () => {
  const base = { clinicName: "Lumen Aesthetics", facts: [], ownCaseRef: "7F3KQ", mode: "send" as const };
  const claim = (text: string, action: { status: (typeof ACTION_STATUSES)[number] } | null | undefined) =>
    runReplyChecks({ ...base, text, ...(action !== undefined ? { action } : {}) }).results.find((r) => r.id === ACTION_CHECK_ID);

  test("finds the ways a reply says a setting was changed, and not a promise to confirm", () => {
    for (const text of [
      "Hi, I've turned the daily summary off.",
      "We have switched website chat on for you.",
      "Your daily summary has been turned off.",
      "Website chat is now on.",
      "The change has been made.",
      "That's done.",
      "I've set the tone to clinical.",
    ]) {
      expect(claimsChange(text), text).toBe(true);
    }
    for (const text of [
      "We'll confirm once the change is made.",
      "We'll write again once it's done.",
      "A person at healdesk will turn it on after checking.",
      "You can switch it off in Settings → Alerts.",
      "Hi, a person at healdesk will reply with the next step by Wednesday.",
    ]) {
      expect(claimsChange(text), text).toBe(false);
    }
  });

  test("fails a claim with no change or one that did not happen; passes a claim of one made or pending; is not run when no action context is given", () => {
    const said = "Hi, I've turned the daily summary off.";
    expect(claim(said, null)).toMatchObject({ ok: false, rule: CHECK_RULES[ACTION_CHECK_ID] });
    expect(claim(said, { status: "refused" })).toMatchObject({ ok: false });
    expect(claim(said, { status: "unavailable" })).toMatchObject({ ok: false });
    expect(claim(said, { status: "not_run" })).toMatchObject({ ok: false });
    expect(claim(said, { status: "done" })).toMatchObject({ ok: true });
    expect(claim(said, { status: "pending" })).toMatchObject({ ok: true });
    expect(claim("We'll confirm when it is done.", null)).toMatchObject({ ok: true });
    expect(claim(said, undefined)).toBeUndefined();
  });

  test("a failing result names its rule and the sentence's span, never the words", () => {
    const result = claim("Thanks for writing. I've turned the daily summary off.", null)!;
    expect(Object.keys(result).sort()).toEqual(["id", "ok", "rule", "spans"]);
    expect(JSON.stringify(result)).not.toContain("daily summary");
  });
});

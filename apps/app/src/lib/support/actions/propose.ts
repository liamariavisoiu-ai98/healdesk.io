import { describeError, log } from "@/lib/log";

import type { ClinicSwitchView } from "@/lib/ops/switch-ops";

import { assessAction, caseChange, ONE_PER_CASE, readSwitchViews } from "./execute";
import { actionWords, tierOf, type SupportAction } from "./tiers";

/**
 * What code answers when the drafter calls propose_action (lane D). The
 * model named a key and a value; code alone decides whether that is a change
 * at all (the closed list, ./tiers.ts), for which clinic (the case's, never
 * one the email names: the tool takes no clinic), at which tier (DIRECT only
 * when the sender is the clinic's one sign-in address, else APPROVAL),
 * whether it can run now (the switch's own rule) and whether this case
 * already made one. Nothing runs here: a DIRECT change runs after the draft
 * is stored (run.ts), an APPROVAL one inside the reply's approval.
 *
 * The answer is our own words for the model: what will happen and what the
 * reply may say. Each line the reply may quote is printed "- Label: value",
 * so a fact the reply cites from it passes the facts check.
 */

export type ActionDecision = { action: SupportAction | null; text: string; isError: boolean };

export const NO_EMAIL_TEXT =
  "No change is made: this case has no email from the practice to act on. Do not say anything was changed.";
export const NEVER_TEXT =
  "No change is made: healdesk does not change this from an email. Tell the practice, in plain words, that it can change it in its own Settings, or that the team will call. Do not say anything was changed.";
export const TWICE_TEXT = "No change is made: only one change is proposed per case, and you already proposed one.";
export const UNREAD_TEXT =
  "No change is made: the practice's settings could not be read just now. Say a person at healdesk will look at it; do not say anything was changed.";

function lines(words: { label: string; value: string }): string {
  return `- Setting: ${words.label}\n- Value: ${words.value}`;
}

export async function decideProposedAction(input: {
  key: unknown;
  value: unknown;
  caseId: string;
  clinicId: string;
  /** Whether the model was shown the practice's email in this run. */
  emailShown: boolean;
  /** Whether every email shown came from the clinic's one sign-in (execute.ts senderIsClinic). */
  senderVerified: boolean;
  /** Whether this run already proposed one. */
  alreadyProposed: boolean;
  now: Date;
  /** The switches, for the tests; readSwitchViews otherwise. */
  views?: (clinicId: string, now: Date) => Promise<ClinicSwitchView[]>;
}): Promise<ActionDecision> {
  if (input.alreadyProposed) return { action: null, text: TWICE_TEXT, isError: true };
  if (!input.emailShown) return { action: null, text: NO_EMAIL_TEXT, isError: false };
  const tier = tierOf(input.key, input.value);
  if (tier === "never") return { action: null, text: NEVER_TEXT, isError: false };
  const key = input.key as string;
  const value = input.value as string;
  const words = actionWords(key, value)!;
  const effective = tier === "direct" && input.senderVerified ? "direct" : "approval";
  const base = { key, value, tier: effective } as const;

  const earlier = await caseChange(input.caseId, undefined, undefined, input.now);
  if (earlier) {
    if (earlier.status === "done" && earlier.key === key && earlier.value === value) {
      return {
        action: { ...base, status: "already", reason: null },
        text: `This change was already made on this case:\n${lines(words)}\nYou may say it is done.`,
        isError: false,
      };
    }
    return {
      action: { ...base, status: "not_run", reason: ONE_PER_CASE },
      text: `No change is made: ${ONE_PER_CASE} Say a person at healdesk will look at the rest; do not say this was changed.`,
      isError: false,
    };
  }

  let views: ClinicSwitchView[];
  try {
    views = await (input.views ?? readSwitchViews)(input.clinicId, input.now);
  } catch (error) {
    log.warn("support action: switches not read", { clinicId: input.clinicId, error: describeError(error) });
    return { action: null, text: UNREAD_TEXT, isError: true };
  }
  const assessed = assessAction(views, key, value);
  if (assessed.status === "already") {
    return {
      action: { ...base, status: "already", reason: null },
      text: `Nothing changes: the setting already has this value.\n${lines(words)}\nSay it is already set; do not say you changed it.`,
      isError: false,
    };
  }
  if (assessed.status === "unavailable") {
    return {
      action: { ...base, status: "unavailable", reason: assessed.reason },
      text: `No change is made: it can't be changed yet.\n${lines(words)}\n- Why: ${assessed.reason}\nDo not say it was changed. Tell the practice what is missing, in those plain words.`,
      isError: false,
    };
  }
  return {
    action: { ...base, status: "pending", reason: null },
    text:
      effective === "direct"
        ? `healdesk makes this change as soon as you propose the reply:\n${lines(words)}\nWrite the reply as done, naming the setting in lower case (for example "I've turned it on."). If it cannot be made, a person edits the reply before anything is sent.`
        : `A person at healdesk approves this change, and your reply is sent only after the change has been made:\n${lines(words)}\nYou may write the reply as done, naming the setting in lower case.`,
    isError: false,
  };
}

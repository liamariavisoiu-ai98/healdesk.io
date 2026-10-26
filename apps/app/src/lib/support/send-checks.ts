import { lintSupportTone } from "@healdesk/catalog";

import { copyProblems, isApprovedReplyShape, linkProblems } from "@/lib/email/lint";

import { runReplyChecks, type FactsUsed, type ReplyCheckInput as DraftCheckInput } from "./draft/checks";

/**
 * The reply checks a support reply must pass when it is drafted, and again on
 * the exact text the owner approves before anything is sent (ops automation
 * lane P7c; design E5 §6, checks 2 to 8 on Send; owner decision D12).
 *
 * The eight checks are lane P7b's (`runReplyChecks` in
 * lib/support/draft/checks.ts), installed here by default with the
 * practice's own context (lib/support/draft/run.ts readReplyCheckContext:
 * its numbers, its services, the other practices' names, its agreement, the
 * portal's origin). On Send they run in "send" mode, which leaves out check 1
 * (facts): Send never calls the model, so there is no run to hold facts to.
 * `installReplyChecks` replaces them for a test; with none installed the send
 * path FAILS CLOSED: every check run carries a failing `reply_checks`
 * result, so nothing is proposed and nothing is sent. Beside them, checks
 * of the send path's own always run, whatever is installed: the tone lint
 * the chat and the drafter share (lintSupportTone, @healdesk/catalog), the
 * email copy lint (claims, treatment names; lib/email/lint.ts copyProblems),
 * and the payload class's shape and link rules (isApprovedReplyShape, the
 * support reply's link scanner). They are a floor, not the eight.
 *
 * A result names a rule, never the words: the console shows the rule that
 * failed and the owner fixes the text himself.
 */

export type ReplyCheck = { id: string; ok: boolean; rule: string };
export type ReplyCheckResult = { ok: boolean; results: ReplyCheck[] };

export type ReplyCheckInput = {
  text: string;
  /** The clinic's printable name, or null; its words may appear in the reply. */
  clinicName: string | null;
  /** The facts the draft relied on (lane P7b's facts_used), when there are any: check 5's billing facts. */
  facts?: readonly FactsUsed[];
  /** The tool results the draft was written from, when there are any. */
  toolResults?: readonly unknown[];
  /** Further names the reply may print (the clinic's own, carrier names...). */
  allowNames?: readonly string[];
  /** This case's printed ref ("HD-7F3KQ"): the only ref the reply may carry. */
  ownCaseRef: string;
  mode: "draft" | "send";
  /** The practice's context for the eight (readReplyCheckContext), when its account could be read. */
  context?: Pick<
    DraftCheckInput,
    "allowNumbers" | "serviceNames" | "clinicId" | "otherClinicNames" | "agreementKind" | "portalOrigin"
  >;
};

export type ReplyChecker = (input: ReplyCheckInput) => ReplyCheckResult | Promise<ReplyCheckResult>;

/** Lane P7b's eight, with the practice's context. */
export const P7B_REPLY_CHECKS: ReplyChecker = (input) =>
  runReplyChecks({
    text: input.text,
    clinicName: input.clinicName ?? "",
    facts: input.facts ?? [],
    ...(input.toolResults ? { toolResults: input.toolResults as DraftCheckInput["toolResults"] } : {}),
    ...(input.allowNames ? { allowNames: input.allowNames } : {}),
    ownCaseRef: input.ownCaseRef,
    mode: input.mode,
    ...(input.context ?? {}),
  });

let installed: ReplyChecker | null = P7B_REPLY_CHECKS;

/** Replace the checks (tests); null takes them out, and every run then fails closed. */
export function installReplyChecks(checker: ReplyChecker | null): void {
  installed = checker;
}

/** Put lane P7b's eight back. */
export function restoreReplyChecks(): void {
  installed = P7B_REPLY_CHECKS;
}

export function replyChecksInstalled(): boolean {
  return installed !== null;
}

/** The rule shown while lane P7b's checks are not plugged in: nothing passes. */
export const CHECKS_NOT_INSTALLED: ReplyCheck = {
  id: "reply_checks",
  ok: false,
  rule: "The reply checks are not installed, so no reply can be proposed or sent",
};

/** The send path's own floor, run on every text whatever is installed. */
export function floorChecks(text: string): ReplyCheck[] {
  const tone = lintSupportTone(text);
  const copy = copyProblems(text);
  const links = linkProblems({ subject: "", text, html: "" }, "support_reply");
  return [
    {
      id: "send_shape",
      ok: isApprovedReplyShape(text),
      rule: "Plain text only: no email address, no phone-shaped number, no markup, at most 1,500 characters",
    },
    {
      id: "send_tone",
      ok: tone.length === 0,
      rule: "No exclamation mark, no emoji and none of the banned phrases",
    },
    {
      id: "send_copy",
      ok: copy.length === 0,
      rule: "None of the words the product may not say, and no treatment name",
    },
    {
      id: "send_links",
      ok: links.length === 0,
      rule: "At most one link, and only into the portal",
    },
  ];
}

function wellFormed(result: unknown): result is ReplyCheckResult {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return (
    typeof r.ok === "boolean" &&
    Array.isArray(r.results) &&
    r.results.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as ReplyCheck).id === "string" &&
        typeof (c as ReplyCheck).ok === "boolean" &&
        typeof (c as ReplyCheck).rule === "string",
    )
  );
}

/**
 * Every check on one text: the installed eight, then the floor. `ok` only when
 * every result passed. A checker that throws or answers out of shape is a
 * failure, never a pass.
 */
export async function runSupportReplyChecks(input: ReplyCheckInput): Promise<ReplyCheckResult> {
  const results: ReplyCheck[] = [];
  if (!installed) {
    results.push(CHECKS_NOT_INSTALLED);
  } else {
    let answer: unknown;
    try {
      answer = await installed(input);
    } catch {
      answer = null;
    }
    if (wellFormed(answer)) {
      results.push(...answer.results.map((c) => ({ id: c.id, ok: c.ok, rule: c.rule })));
      // A checker saying ok while listing a failure, or not ok with none: a failure all the same.
      if (!answer.ok && answer.results.every((c) => c.ok)) {
        results.push({ id: "reply_checks", ok: false, rule: "The reply checks did not pass" });
      }
    } else {
      results.push({ id: "reply_checks", ok: false, rule: "The reply checks could not be run" });
    }
  }
  results.push(...floorChecks(input.text));
  return { ok: results.every((c) => c.ok), results };
}

/** The rules that failed, each once, in order: what the console shows and a refusal names. */
export function failedRules(result: ReplyCheckResult): string[] {
  return [...new Set(result.results.filter((c) => !c.ok).map((c) => c.rule))];
}

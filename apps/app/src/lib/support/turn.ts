import type Anthropic from "@anthropic-ai/sdk";
import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";

import { log } from "@/lib/log";
import { formatPhone } from "@/lib/setup/help";

import { describeAccountState, type AccountState } from "./account-state";
import { openCasesText, type OpenCase } from "./draft/open-cases";
import type { EscalationResult } from "./escalate";
import type { ClosedForwardingSteps, ForwardingAnswer, ForwardingSteps } from "./forwarding";
import { supportRequest, type SupportModelClient } from "./model";
import type { SupportLines } from "./lines";
import type { SupportPrompt } from "./prompt";
import { StreamScreen, type ScreenAllow } from "./screen";
import type { SupportLink } from "./targets";

/**
 * One turn of the support chat: the model streams, its words pass through the
 * screen on their way out, and its tool calls run here, until it ends its
 * turn, refuses, or uses up its rounds.
 *
 * What the browser receives is a list of events (SupportEvent), one JSON
 * object a line: the person's own message as the model saw it, the reply in
 * pieces, a button for each place the model linked, the escalation once it
 * has gone, and `replace` when the reply so far must give way to a fixed
 * line (a refusal, a failure). Nothing here is stored or logged but the
 * outcome and counts.
 *
 * A REFUSAL (stop_reason "refusal") is its own outcome, never an empty reply
 * nor the generic failure: whatever had been streamed is replaced by the
 * fixed line giving the support phone and hello@healdesk.io, and the turn's
 * tools, if it asked for any, never run.
 */

export type SupportOutcome = "answered" | "refused" | "limited" | "failed" | "empty";

export type SupportEvent =
  /** The person's message as the model saw it, with a line for each kind of thing hidden. */
  | { type: "screened"; text: string; notices: string[] }
  /** The next piece of the reply, already screened. */
  | { type: "delta"; text: string }
  /** A button under the reply, to a place in this clinic's portal. */
  | { type: "link"; label: string; url: string }
  /** An escalation went to the team; the practice is told when a person will reply. */
  | { type: "escalated"; topic: string; replyByOn: string; to: string | null }
  /** The reply so far is replaced by this fixed line. */
  | { type: "replace"; text: string }
  | { type: "done"; outcome: SupportOutcome };

/** What the tools reach. Each is read-only but the escalation, which only sends. */
export type SupportToolbox = {
  accountState(): Promise<AccountState | null>;
  forwardingSteps(): Promise<ForwardingAnswer | null>;
  linkTo(setting: unknown): SupportLink | null;
  /** get_open_cases (lane P7b): the practice's open requests, dates and states only. */
  openCases(): Promise<OpenCase[] | null>;
  escalate(input: unknown): Promise<EscalationResult>;
};

/** Model calls in one turn: enough to read the account, link and answer. */
export const MAX_ROUNDS = 5;

export async function runSupportTurn(input: {
  client: SupportModelClient;
  system: SupportPrompt;
  messages: Anthropic.MessageParam[];
  tools: SupportToolbox;
  screen: ScreenAllow;
  lines: SupportLines;
  emit: (event: SupportEvent) => void;
}): Promise<SupportOutcome> {
  const messages = [...input.messages];
  const screen = new StreamScreen(input.screen);
  const linked = new Set<string>();
  let wroteBefore = false;
  let wroteThisRound = false;

  const send = (text: string) => {
    if (!text) return;
    if (wroteBefore && !wroteThisRound) text = `\n\n${text.replace(/^\s+/, "")}`;
    wroteThisRound = true;
    input.emit({ type: "delta", text });
  };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    wroteBefore = wroteBefore || wroteThisRound;
    wroteThisRound = false;
    let message: Anthropic.Message;
    try {
      const stream = input.client.stream(supportRequest({ system: input.system, messages }));
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          send(screen.push(event.delta.text));
        }
      }
      message = await stream.finalMessage();
    } catch (error) {
      log.warn("support chat model failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      input.emit({ type: "replace", text: input.lines.failure });
      return "failed";
    }

    if (message.stop_reason === "refusal") {
      // The held-back text is dropped, and what was sent is replaced.
      log.warn("support chat model declined", { kind: message.stop_details?.category ?? "none" });
      input.emit({ type: "replace", text: input.lines.refusal });
      return "refused";
    }
    send(screen.end());

    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // A tool input cut off at max_tokens is never run.
    if (message.stop_reason !== "tool_use" || uses.length === 0) return "answered";

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      results.push(await runTool(use, input, linked));
    }
    messages.push({ role: "user", content: results });
  }
  return "answered";
}

async function runTool(
  use: Anthropic.ToolUseBlock,
  input: { tools: SupportToolbox; emit: (event: SupportEvent) => void },
  linked: Set<string>,
): Promise<Anthropic.ToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  try {
    switch (use.name) {
      case "get_account_state": {
        const account = await input.tools.accountState();
        if (!account) return result("The account could not be read just now.", true);
        return result(
          `The account:\n${describeAccountState(account)
            .map(([label, value]) => `- ${label}: ${value}`)
            .join("\n")}`,
        );
      }
      case "get_forwarding_steps": {
        const steps = await input.tools.forwardingSteps();
        if (!steps) return result(NO_FORWARDING_YET);
        return result(steps.closed ? undoOnlyText(steps) : forwardingText(steps));
      }
      case "link_to": {
        const setting = (use.input as { setting?: unknown } | null)?.setting;
        const link = input.tools.linkTo(setting);
        if (!link) {
          return result(
            "That place isn't in this portal yet, so no button was shown. Name it in words, or say it isn't available yet.",
          );
        }
        if (!linked.has(link.url)) {
          linked.add(link.url);
          input.emit({ type: "link", label: link.label, url: link.url });
        }
        return result(`A button to "${link.label}" is shown under your reply.`);
      }
      case "get_open_cases": {
        const cases = await input.tools.openCases();
        if (!cases) return result("The practice's requests could not be read just now.", true);
        return result(openCasesText(cases));
      }
      case "escalate_to_support": {
        const outcome = await input.tools.escalate(use.input);
        switch (outcome.status) {
          case "sent":
            input.emit({
              type: "escalated",
              topic: outcome.topic,
              replyByOn: outcome.replyByOn,
              to: outcome.to,
            });
            return result(
              outcome.to
                ? `Sent to the healdesk team. The practice has been emailed that a person will reply by ${outcome.replyByOn} (an ISO date: say it as a weekday and a date). Tell them so, in one sentence.`
                : "Sent to the healdesk team. The practice's address could not be found, so tell them to email hello@healdesk.io as well.",
            );
          case "invalid":
            return result(
              "Not sent: the category or what's wrong wasn't one from the lists. Pick from the lists and try once more.",
              true,
            );
          case "limited":
            return result(
              "Not sent: this practice has sent as many requests as it can today. Give them the support phone line if Help shows one, and hello@healdesk.io.",
              true,
            );
          case "failed":
            return result(
              "Not sent: it could not be sent just now. Tell them to email hello@healdesk.io instead.",
              true,
            );
        }
        return result("Not sent.", true);
      }
      default:
        return result(`There is no tool called ${use.name}.`, true);
    }
  } catch {
    log.warn("support chat tool failed", { op: use.name });
    return result("That could not be read just now.", true);
  }
}

const NO_FORWARDING_YET =
  "Nothing yet: phone isn't ready for call forwarding on healdesk's side, so there are no codes to give. Tell them not to change their call forwarding yet: the steps appear in Setup as soon as phone is ready for them.";

/**
 * A closed account: the way back only, and the reason to take it now. Never
 * NO_FORWARDING_YET, which tells the clinic to leave its forwarding alone,
 * the opposite of what the cancellation email asks of it.
 */
function undoOnlyText(steps: ClosedForwardingSteps): string {
  return [
    `The service has ended, so there are no codes to forward calls to AYA. If the practice forwarded its main line to AYA, tell them to undo it now: calls that still forward pass through to the direct line for only ${FORWARDING_PASS_THROUGH_DAYS} days after the service ends, and the email "Your healdesk service has ended" gives the date and the same steps. Settings has nothing left to change on a closed account.`,
    `Carrier: ${steps.carrier}.`,
    "To undo:",
    ...steps.undo.map((s) => `- ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
  ].join("\n");
}

function forwardingText(steps: ForwardingSteps): string {
  const lines = [
    `AYA's number: ${formatPhone(steps.ayaNumberE164)}. Carrier: ${steps.carrier}. Which calls reach AYA: ${steps.mode}.`,
    "To forward:",
    ...steps.steps.map((s, i) => `${i + 1}. ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
    "To undo:",
    ...steps.undo.map((s) => `- ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
    "Notes:",
    ...steps.notes.map((n) => `- ${n}`),
  ];
  if (steps.needsCarrierHelp) {
    lines.push(
      "Exact codes aren't known for this carrier: say to ask the carrier, never guess a code.",
    );
  }
  return lines.join("\n");
}

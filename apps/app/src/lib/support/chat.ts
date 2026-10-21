import type Anthropic from "@anthropic-ai/sdk";
import { audienceFor, CARRIER_SERVICE_NUMBERS } from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import type { SendEmailOptions } from "@/lib/email/send";
import { log } from "@/lib/log";
import { helpContacts } from "@/lib/setup/help";
import type { SetupState } from "@/lib/setup/state";

import type { AccountState } from "./account-state";
import { escalateToSupport } from "./escalate";
import { supportLines } from "./lines";
import type { ForwardingAnswer } from "./forwarding";
import type { SupportLimiter } from "./limits";
import type { SupportModelClient } from "./model";
import { buildSupportPrompt } from "./prompt";
import { screenNotices, screenText, type ScreenAllow } from "./screen";
import { isLinkTarget, linkTo } from "./targets";
import { runSupportTurn, type SupportEvent, type SupportOutcome } from "./turn";

export { supportLines } from "./lines";

/**
 * The portal's support chat, one message at a time (plan Part H; spec,
 * "Support chat in the portal").
 *
 * It STORES NOTHING. The browser holds the conversation and sends it back
 * with each message; this reads it, screens it, answers it and forgets it.
 * No table, no transcript, and no log line with a word of it: the log gets
 * the clinic's id and the turn's outcome. The words reach one place, the
 * model, after the screen (screen.ts) has hidden every phone number, email
 * address and treatment name that is not the practice's own.
 *
 * In order: the account is read (business data only); the person's message
 * is screened and shown back to them as the model will see it; the clinic's
 * and the device's limits are taken; the earlier messages are screened again
 * (the browser is not trusted to have kept them screened); and the turn runs
 * with the four read-only tools. Past a limit, on a refusal and when the
 * model can't be reached, the reply is a fixed line with the support phone
 * and hello@healdesk.io, so a person is always one step away.
 */

export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_HISTORY = 20;

export type ChatTurnRequest = {
  history: { role: "user" | "assistant"; text: string }[];
  text: string;
};

/** The request body, read strictly: null for anything that is not one. */
export function readChatRequest(body: unknown): ChatTurnRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.text !== "string") return null;
  const history: ChatTurnRequest["history"] = [];
  if (raw.history !== undefined) {
    if (!Array.isArray(raw.history)) return null;
    for (const item of raw.history.slice(-MAX_HISTORY)) {
      if (!item || typeof item !== "object") return null;
      const { role, text } = item as Record<string, unknown>;
      if ((role !== "user" && role !== "assistant") || typeof text !== "string") return null;
      history.push({ role, text: text.slice(0, MAX_MESSAGE_CHARS) });
    }
  }
  return { history, text: raw.text.slice(0, MAX_MESSAGE_CHARS) };
}

export type SupportChatContext = {
  clinicId: string;
  slug: string;
  deviceKey: string;
  actor: ActorContext;
  limiter: SupportLimiter;
  /** The model, or null when no key is set. */
  client: SupportModelClient | null;
  readAccount: () => Promise<{ account: AccountState; state: SetupState } | null>;
  readForwarding: () => Promise<ForwardingAnswer | null>;
  email?: SendEmailOptions;
  now?: Date;
  newId?: () => string;
};

/** What the screen lets through: the practice's own numbers, the sign-in's address, healdesk's line. */
export function screenAllowFor(
  state: SetupState | null,
  helpPhoneE164: string | null,
): ScreenAllow {
  const settings = state?.settings;
  return {
    numbers: [
      helpPhoneE164,
      state?.clinic.publishedPhoneE164,
      settings?.directLineE164,
      settings?.transferE164,
      settings?.urgentHelpE164,
      settings?.vetReferralE164,
    ],
    emails: [state?.address],
    serviceNames: state?.knowledge.services.map((s) => s.name) ?? [],
  };
}

/** The conversation as the model reads it: alternating, from the person, ending with this message. */
export function messagesFor(
  history: ChatTurnRequest["history"],
  text: string,
  allow: ScreenAllow,
): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of [...history, { role: "user" as const, text }]) {
    const content = screenText(item.text, allow).text.trim();
    if (!content) continue;
    if (out.length === 0 && item.role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === item.role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role: item.role, content });
  }
  return out;
}

export async function handleSupportChat(
  ctx: SupportChatContext,
  request: ChatTurnRequest,
  emit: (event: SupportEvent) => void,
): Promise<SupportOutcome> {
  const now = ctx.now ?? new Date();
  const helpPhone = helpContacts().phoneE164;
  const lines = supportLines(helpPhone);
  const finish = (outcome: SupportOutcome): SupportOutcome => {
    emit({ type: "done", outcome });
    log.info("support chat turn", { clinicId: ctx.clinicId, outcome });
    return outcome;
  };

  const read = await ctx.readAccount().catch(() => null);
  const allow = screenAllowFor(read?.state ?? null, helpPhone);
  const screened = screenText(request.text, allow);
  emit({ type: "screened", text: screened.text, notices: screenNotices(screened) });
  if (!screened.text.trim()) return finish("empty");

  if (!ctx.limiter.take("message", ctx.clinicId, ctx.deviceKey, now.getTime())) {
    emit({ type: "replace", text: lines.refusal });
    return finish("limited");
  }
  if (!read || !ctx.client) {
    emit({ type: "replace", text: lines.failure });
    return finish("failed");
  }

  // AYA's number is let through once the forwarding steps have given it: the
  // codes the chat repeats dial it. So are the carrier service numbers the
  // steps print (CARRIER_SERVICE_NUMBERS): a traditional AT&T landline sets
  // and undoes its busy and no-answer forwarding only by calling AT&T, and a
  // step that read "call AT&T on [number hidden]" could not be followed.
  const numbers = [...allow.numbers];
  const outputAllow: ScreenAllow = { ...allow, numbers };
  const { state, account } = read;
  const outcome = await runSupportTurn({
    client: ctx.client,
    system: buildSupportPrompt({
      clinicName: state.clinic.name,
      audience: audienceFor(state.clinic.specialty),
      agreementKind: state.clinic.agreementKind,
      timeZone: state.clinic.timezone,
      now,
    }),
    messages: messagesFor(request.history, screened.text, allow),
    screen: outputAllow,
    lines,
    emit,
    tools: {
      accountState: async () => account,
      forwardingSteps: async () => {
        const steps = await ctx.readForwarding();
        // A closed account's answer is the undo steps alone, with no number of AYA's.
        if (steps) numbers.push(...(steps.closed ? [] : [steps.ayaNumberE164]), ...CARRIER_SERVICE_NUMBERS);
        return steps;
      },
      linkTo: (setting) => (isLinkTarget(setting) ? linkTo(ctx.slug, setting) : null),
      escalate: (input) =>
        escalateToSupport(
          {
            clinicId: ctx.clinicId,
            deviceKey: ctx.deviceKey,
            actor: ctx.actor,
            limiter: ctx.limiter,
            readAccount: async () => {
              const fresh = await ctx.readAccount();
              return fresh ? { account: fresh.account, address: fresh.state.address } : null;
            },
            email: ctx.email,
            now,
            newId: ctx.newId,
          },
          input,
        ),
    },
  });
  return finish(outcome);
}

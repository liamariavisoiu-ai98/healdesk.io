import { createHmac, timingSafeEqual } from "node:crypto";

import { after } from "next/server";

import type { OpsApproval } from "@/db/schema";
import { parseDraft, serialiseDraft } from "@/lib/approvals/drafts";
import { draftHash } from "@/lib/approvals/kinds";
import { getApproval } from "@/lib/approvals/store";
import { parseSupportReplyPayload, SUPPORT_REPLY_KIND } from "@/lib/approvals/support-payload";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { readBoundedBody, type Operator, type OpsOutcome } from "@/lib/ops/api";
import { opDecideApproval } from "@/lib/ops/approval-ops";
import { supportActionSlackLine } from "@/lib/ops/slack";
import { opCloseSupportCase, opSnoozeSupportCase } from "@/lib/ops/support-case-ops";
import { opSaveSupportDraft } from "@/lib/ops/support-reply-ops";

import { actionOfFacts, actionView } from "./actions/tiers";
import { printRef } from "./case-vocab";
import { checkReplyText, currentReplyDraft, factsOfDraft, MAX_DRAFT_CHARS, normaliseDraftText, readCaseForReply, subjectForCase } from "./send";
import { failedRules } from "./send-checks";
import { slackApi, slackSupportConfig, type SlackSupportConfig } from "./slack-api";
import { checkSlackPasscode } from "./slack-passcode";
import { caseConsoleLink, escapeMrkdwn, syncCaseMessage } from "./slack-reply";

/**
 * /api/webhooks/slack: the buttons and dialogs of a support reply's Slack
 * message (ops automation Phase 7, lane P7i; the owner's decision of 26
 * October 2026). The Slack app's interactivity URL is
 * https://app.healdesk.io/api/webhooks/slack.
 *
 * Every request is Slack's, or refused: the signature (HMAC-SHA256 of
 * `v0:<timestamp>:<body>` with SLACK_SIGNING_SECRET, compared in constant
 * time), a timestamp within five minutes, a form-encoded body under 256 KB.
 * 404 while the feature is off (lib/support/slack-api.ts). Only the Slack
 * users in SLACK_OPERATOR_IDS may act; anyone else is told so privately and
 * nothing happens (one log line, ids only).
 *
 *   - Review and send: a dialog with the reply in an editable box (read from
 *     the database when it opens) and the approval passcode. On submit the
 *     passcode is checked by the console's verifier and lockout
 *     (@healdesk/catalog/approval-passcode), the version and the hash the
 *     dialog opened on are compared with the item's now, and then: the
 *     unchanged text approves the waiting item; an edited text is checked
 *     by the eight reply rules first (a failing rule's NAME comes back as
 *     the box's error, nothing is saved or sent), saved as the next draft
 *     through saveSupportDraft (which proposes it), and that new item is
 *     approved. The decision is the console's own path (opDecideApproval),
 *     recorded with the factor "passcode via slack" and the Slack user's id
 *     in the actor; the executor's checks, frozen text and hash rules are
 *     unchanged. A draft over Slack's 3,000-character box can only be
 *     approved unchanged here; edits go to the console.
 *   - Edit only: the same box without the passcode: a passing text is saved
 *     as the next draft (and proposed); nothing is sent.
 *   - Snooze 1 day and Close: snoozeSupportCase and closeSupportCase (reason
 *     no_reply_needed), as the console calls them.
 *
 * Slack must hear back within three seconds, so the decision itself (which
 * sends the email) runs after the answer (`after`), and its outcome reaches
 * the channel as the message's update and a private note. Nothing about the
 * passcode or the signing secret is ever logged. A Slack call that fails
 * changes no approval or case; Slack being down never touches the console.
 */

const MAX_BODY_BYTES = 256_000;
const MAX_SKEW_SECONDS = 5 * 60;
/** Slack's plain-text input takes at most this many characters. */
export const SLACK_INPUT_MAX = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The factor an approval from the Slack dialog is recorded under. */
export const SLACK_FACTOR = "passcode via slack";
/** The reason code a Slack approval is recorded under (APPROVE_REASONS). */
const SLACK_APPROVE_REASON = "owner_checked";
/** The reason Close gives (SUPPORT_CLOSED_REASONS). */
export const SLACK_CLOSE_REASON = "no_reply_needed";

// -----------------------------------------------------------------------------
// Slack's signature
// -----------------------------------------------------------------------------

/** Whether Slack signed this body with `secret` within five minutes of `nowSeconds`. */
export function verifySlackSignature(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  body: string,
  nowSeconds: number,
): boolean {
  if (!timestamp || !signature || !/^[0-9]{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`);
  const offered = Buffer.from(signature);
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}

// -----------------------------------------------------------------------------
// Who acts
// -----------------------------------------------------------------------------

/**
 * The operator an act from Slack is recorded against: the one operator
 * account (HEALDESK_ADMIN_EMAIL, as every console act is), named as coming
 * from Slack with the Slack user's id. Null when the address is not set: no
 * act is then recorded against nobody.
 */
export function slackOperator(slackUserId: string): Operator | null {
  const admin = env.adminEmail();
  if (!admin) return null;
  return { email: `${admin} via Slack ${slackUserId}`.slice(0, 200), request: { userAgent: `Slack interactivity (${slackUserId})` } };
}

// -----------------------------------------------------------------------------
// The payloads
// -----------------------------------------------------------------------------

type ButtonValue = { approvalId: string; caseId: string };

function parseButtonValue(raw: unknown): ButtonValue | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  try {
    const v = JSON.parse(raw) as { a?: unknown; c?: unknown };
    if (typeof v.a !== "string" || typeof v.c !== "string" || !UUID.test(v.a) || !UUID.test(v.c)) return null;
    return { approvalId: v.a, caseId: v.c };
  } catch {
    return null;
  }
}

type DialogMeta = ButtonValue & { draftVersion: number; draftHash: string; mode: "review" | "edit"; long: boolean };

function parseDialogMeta(raw: unknown): DialogMeta | null {
  if (typeof raw !== "string" || raw.length > 600) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const base = parseButtonValue(JSON.stringify({ a: m.a, c: m.c }));
    if (!base) return null;
    if (typeof m.v !== "number" || !Number.isSafeInteger(m.v) || m.v < 1) return null;
    if (typeof m.h !== "string" || !/^[0-9a-f]{64}$/.test(m.h)) return null;
    if (m.m !== "review" && m.m !== "edit") return null;
    return { ...base, draftVersion: m.v, draftHash: m.h, mode: m.m, long: m.l === true };
  } catch {
    return null;
  }
}

/** A waiting support reply item of this case, with its draft; or why not. */
async function waitingItem(
  value: ButtonValue,
): Promise<{ ok: true; item: OpsApproval; body: string; draftVersion: number; ref: string } | { ok: false; why: string }> {
  const item = await getApproval(value.approvalId);
  const payload = item ? parseSupportReplyPayload(item.payload) : null;
  if (!item || item.kind !== SUPPORT_REPLY_KIND || !payload || payload.caseId !== value.caseId) {
    return { ok: false, why: "That reply is not one this channel can act on." };
  }
  if (item.status !== "waiting") return { ok: false, why: "That reply is no longer waiting: the message now shows where it stands. Nothing was changed." };
  const body = parseDraft(item.draft)?.body;
  if (!body || !item.draftHash) return { ok: false, why: "The draft could not be read. Open the case in the console." };
  return { ok: true, item, body, draftVersion: payload.draftVersion, ref: printRef(payload.ref) };
}

// -----------------------------------------------------------------------------
// Answers
// -----------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const EMPTY = () => new Response(null, { status: 200 });

/** Errors shown under the dialog's boxes; the dialog stays open. */
function dialogErrors(errors: Record<string, string>): Response {
  return json({ response_action: "errors", errors });
}

/** A note only `user` sees, in the channel of the message. Never throws. */
async function privateNote(config: SlackSupportConfig, channel: string | null, user: string, text: string): Promise<void> {
  const result = await slackApi("chat.postEphemeral", config.token, { channel: channel ?? config.channel, user, text });
  if (!result.ok) log.warn("support slack: private note not posted", { reason: result.error });
}

/** The words of an ops outcome's refusal, or null when it succeeded. */
function refusalOf(outcome: OpsOutcome): string | null {
  if (outcome.status !== 200) return "error" in outcome.body ? outcome.body.error : "It could not be done.";
  return null;
}

// -----------------------------------------------------------------------------
// The dialog
// -----------------------------------------------------------------------------

function dialog(meta: DialogMeta, ref: string, clinicName: string | null, body: string, actionLine: string | null = null): Record<string, unknown> {
  const review = meta.mode === "review";
  const link = caseConsoleLink(meta.caseId);
  const blocks: Record<string, unknown>[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${escapeMrkdwn(ref)}${clinicName ? `, ${escapeMrkdwn(clinicName)}` : ""} · draft v${meta.draftVersion}` }],
    },
  ];
  // Lane D: the change approving makes first, closed words only (lib/ops/slack.ts).
  if (actionLine) blocks.push({ type: "section", text: { type: "mrkdwn", text: actionLine } });
  if (meta.long) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `This draft is longer than Slack's ${SLACK_INPUT_MAX.toLocaleString("en-US")}-character box, so it cannot be edited here: edit it in the console${link ? ` (<${link}|open ${escapeMrkdwn(ref)}>)` : ""}. You can approve it unchanged, exactly as shown in the channel.`,
      },
    });
  } else {
    blocks.push({
      type: "input",
      block_id: "reply",
      label: { type: "plain_text", text: "The reply, as the practice will read it" },
      hint: {
        type: "plain_text",
        text: review
          ? "Edit it if you need to. The eight reply checks run on what you submit; a failing check is named here and nothing is sent."
          : "Saved as the next draft version when every check passes. Nothing is sent.",
      },
      element: { type: "plain_text_input", action_id: "text", multiline: true, initial_value: body, max_length: SLACK_INPUT_MAX },
    });
  }
  if (review) {
    blocks.push({
      type: "input",
      block_id: "passcode",
      label: { type: "plain_text", text: "Approval passcode" },
      hint: { type: "plain_text", text: "The same 6-digit passcode the console takes. Slack shows it as you type and passes it to our host, which checks it and never stores it." },
      element: { type: "plain_text_input", action_id: "code", min_length: 6, max_length: 6, placeholder: { type: "plain_text", text: "6 digits" } },
    });
  }
  return {
    type: "modal",
    callback_id: review ? "support_review" : "support_edit",
    private_metadata: JSON.stringify({ a: meta.approvalId, c: meta.caseId, v: meta.draftVersion, h: meta.draftHash, m: meta.mode, l: meta.long }),
    title: { type: "plain_text", text: review ? "Review and send" : "Edit the draft" },
    submit: { type: "plain_text", text: review ? "Approve and send" : "Save draft" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// -----------------------------------------------------------------------------
// The route
// -----------------------------------------------------------------------------

export type SlackRouteDeps = {
  now?: () => Date;
  /** Runs work after the answer (Next's `after`); tests collect it. */
  defer?: (work: () => Promise<void>) => void;
};

type Payload = {
  type?: unknown;
  user?: { id?: unknown };
  trigger_id?: unknown;
  channel?: { id?: unknown };
  container?: { channel_id?: unknown };
  actions?: { action_id?: unknown; value?: unknown }[];
  view?: { id?: unknown; callback_id?: unknown; private_metadata?: unknown; state?: { values?: Record<string, Record<string, { value?: unknown }>> } };
};

const SLACK_ID = /^[A-Z0-9]{3,32}$/;

export async function slackInteractionWebhook(request: Request, deps: SlackRouteDeps = {}): Promise<Response> {
  const config = slackSupportConfig();
  if (!config) return new Response("Not found.", { status: 404 });
  const now = deps.now?.() ?? new Date();
  const defer = deps.defer ?? ((work) => after(work));

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return new Response("Unsupported.", { status: 415 });
  }
  const body = await readBoundedBody(request, MAX_BODY_BYTES);
  if (body === null) return new Response("Too large.", { status: 413 });
  if (
    !verifySlackSignature(
      config.signingSecret,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      body,
      Math.floor(now.getTime() / 1000),
    )
  ) {
    return new Response("Unauthorized.", { status: 401 });
  }

  let payload: Payload;
  try {
    const raw = new URLSearchParams(body).get("payload");
    payload = raw ? (JSON.parse(raw) as Payload) : {};
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const user = typeof payload.user?.id === "string" && SLACK_ID.test(payload.user.id) ? payload.user.id : null;
  const channelRaw = payload.channel?.id ?? payload.container?.channel_id;
  const channel = typeof channelRaw === "string" && SLACK_ID.test(channelRaw) ? channelRaw : null;
  if (!user) return new Response("Bad request.", { status: 400 });

  if (!config.operators.has(user)) {
    log.warn("support slack: refused a user not on SLACK_OPERATOR_IDS", { slackUser: user, type: typeof payload.type === "string" ? payload.type.slice(0, 40) : "unknown" });
    if (payload.type === "view_submission") return dialogErrors({ [submissionBox(payload)]: "You are not one of the operators who may act on support replies here." });
    defer(() => privateNote(config, channel, user, "You are not one of the operators who may act on support replies, so nothing was done."));
    return EMPTY();
  }
  const operator = slackOperator(user);
  if (!operator) {
    log.error("support slack: HEALDESK_ADMIN_EMAIL is not set, so no act can be recorded");
    if (payload.type === "view_submission") return dialogErrors({ [submissionBox(payload)]: "The host has no operator address set, so nothing can be recorded. Use the console." });
    return EMPTY();
  }

  try {
    if (payload.type === "block_actions") return await onButton(payload, { config, operator, user, channel, now, defer });
    if (payload.type === "view_submission") return await onSubmit(payload, { config, operator, user, channel, now, defer });
    return EMPTY();
  } catch (error) {
    log.error("support slack: act failed", { error: describeError(error) });
    if (payload.type === "view_submission") return dialogErrors({ [submissionBox(payload)]: "Something went wrong on our side. Nothing was sent. Try the console." });
    return EMPTY();
  }
}

/** A submitted dialog's error box, read from its metadata when it can be. */
function submissionBox(payload: Payload): "reply" | "passcode" {
  const meta = parseDialogMeta(payload.view?.private_metadata);
  return meta ? boxesOf(meta).text : fallbackBox(payload.view?.callback_id);
}

type Ctx = {
  config: SlackSupportConfig;
  operator: Operator;
  user: string;
  channel: string | null;
  now: Date;
  defer: (work: () => Promise<void>) => void;
};

async function onButton(payload: Payload, ctx: Ctx): Promise<Response> {
  const action = payload.actions?.[0];
  const id = typeof action?.action_id === "string" ? action.action_id : "";
  if (id === "support_open") return EMPTY();
  const value = parseButtonValue(action?.value);
  if (!value) return EMPTY();
  const refresh = () => syncCaseMessage(value.caseId, { now: ctx.now, force: true, config: ctx.config }).then(() => {});

  switch (id) {
    case "support_review":
    case "support_edit": {
      const found = await waitingItem(value);
      if (!found.ok) {
        ctx.defer(async () => {
          await refresh();
          await privateNote(ctx.config, ctx.channel, ctx.user, found.why);
        });
        return EMPTY();
      }
      const long = [...found.body].length > SLACK_INPUT_MAX;
      if (long && id === "support_edit") {
        const link = caseConsoleLink(value.caseId);
        ctx.defer(() =>
          privateNote(ctx.config, ctx.channel, ctx.user, `This draft is longer than Slack's box can hold: edit it in the console${link ? `: ${link}` : "."}`),
        );
        return EMPTY();
      }
      const read = await readCaseForReply(value.caseId);
      const meta: DialogMeta = {
        ...value,
        draftVersion: found.draftVersion,
        draftHash: found.item.draftHash!,
        mode: id === "support_review" ? "review" : "edit",
        long,
      };
      const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : "";
      const current = await currentReplyDraft(value.caseId);
      const actionLine =
        current && current.draftVersion === found.draftVersion ? supportActionSlackLine(actionView(actionOfFacts(current.factsJson))) : null;
      const view = dialog(meta, read ? printRef(read.supportCase.ref) : "the case", read?.clinicName ?? null, found.body, actionLine);
      // After the answer: Slack wants it within three seconds, and the trigger stays good that long from the click.
      ctx.defer(async () => {
        const opened = await slackApi("views.open", ctx.config.token, { trigger_id: triggerId, view });
        if (!opened.ok) {
          log.warn("support slack: dialog not opened", { reason: opened.error });
          await privateNote(ctx.config, ctx.channel, ctx.user, "The dialog could not be opened (Slack was slow or refused it). Press the button again, or use the console.");
        }
      });
      return EMPTY();
    }
    case "support_snooze": {
      const outcome = await opSnoozeSupportCase({ caseId: value.caseId, until: new Date(ctx.now.getTime() + DAY_MS).toISOString() }, ctx.operator, ctx.now);
      const refused = refusalOf(outcome);
      ctx.defer(async () => {
        await refresh();
        if (refused) await privateNote(ctx.config, ctx.channel, ctx.user, `Not snoozed: ${refused}`);
      });
      return EMPTY();
    }
    case "support_close": {
      const outcome = await opCloseSupportCase({ caseId: value.caseId, reason: SLACK_CLOSE_REASON }, ctx.operator, ctx.now);
      const refused = refusalOf(outcome);
      ctx.defer(async () => {
        await refresh();
        if (refused) await privateNote(ctx.config, ctx.channel, ctx.user, `Not closed: ${refused}`);
      });
      return EMPTY();
    }
    default:
      return EMPTY();
  }
}

/** What an approval decision answered, in words for the private note. */
function decisionNote(ref: string, outcome: OpsOutcome): string {
  if (outcome.status !== 200) return `${ref}: not approved. ${"error" in outcome.body ? outcome.body.error : ""}`.trim();
  const data = (outcome.body as { data: { status: string; message?: string | null; outcomeCode?: string } }).data;
  if (data.status === "executed") return data.outcomeCode === "sent" ? `${ref}: approved and sent.` : `${ref}: approved. ${data.message ?? ""}`.trim();
  return `${ref}: ${data.message ?? "not sent."}`;
}

/** The box a dialog's error goes under: one the dialog has (a long draft's has only the passcode, Edit only's only the reply). */
function boxesOf(meta: Pick<DialogMeta, "mode" | "long">): { text: "reply" | "passcode"; passcode: "passcode" | "reply" } {
  if (meta.mode === "edit") return { text: "reply", passcode: "reply" };
  return { text: meta.long ? "passcode" : "reply", passcode: "passcode" };
}

/** The box for an error before the dialog's metadata could be read: by its callback, a box every such dialog has. */
function fallbackBox(callback: unknown): "reply" | "passcode" {
  return callback === "support_edit" ? "reply" : "passcode";
}

type Prepared =
  | { ok: false; box: "reply" | "passcode"; message: string; refresh: boolean }
  | { ok: true; ref: string; approvalId: string | null };

/**
 * Everything before the decision, in order: the passcode (review only, with
 * the console's verifier and lockout, before any state changes); the item
 * still waiting on the version and text the dialog opened on; the reply
 * checks (on the unchanged draft, or on the edit before anything is saved);
 * for an edit, the save (which proposes it) and the proposed item pinned to
 * exactly that version and text. `approvalId` is what to approve, or null
 * when nothing is (Edit only).
 */
async function prepare(meta: DialogMeta, typed: unknown, code: unknown, ctx: Ctx): Promise<Prepared> {
  const boxes = boxesOf(meta);
  const fail = (box: "reply" | "passcode", message: string, refresh = false): Prepared => ({ ok: false, box, message, refresh });

  if (meta.mode === "review") {
    const check = await checkSlackPasscode(code, ctx.user, ctx.now.getTime());
    if (!check.ok) return fail(boxes.passcode, check.message);
  }

  const found = await waitingItem(meta);
  if (!found.ok || found.draftVersion !== meta.draftVersion || found.item.draftHash !== meta.draftHash) {
    return fail(
      boxes.text,
      found.ok ? "A newer draft replaced the one this dialog opened on. Nothing was sent. The message in the channel now shows the new one." : found.why,
      true,
    );
  }
  const unchanged = meta.long || typeof typed !== "string" || normaliseDraftText(typed) === normaliseDraftText(found.body) || typed.trim() === found.body.trim();
  if (unchanged && meta.mode === "edit") return { ok: true, ref: found.ref, approvalId: null };

  const read = await readCaseForReply(meta.caseId);
  if (!read) return fail(boxes.text, "The case could not be read. Nothing was changed.");
  const current = await currentReplyDraft(meta.caseId);
  const facts = current ? factsOfDraft(current) : [];
  if (unchanged) {
    // The checks as Send will run them, so a draft that would be refused is named here rather than burnt.
    const checks = await checkReplyText(found.body, { supportCase: read.supportCase, clinicName: read.clinicName, facts });
    if (!checks.ok) return fail(boxes.text, `Fails: ${failedRules(checks).join("; ")}. Nothing was sent: edit it first.`.slice(0, 1900));
    return { ok: true, ref: found.ref, approvalId: found.item.id };
  }

  const text = normaliseDraftText(typed);
  if (!text) return fail(boxes.text, `The reply must be 1 to ${MAX_DRAFT_CHARS.toLocaleString("en-US")} characters. Nothing was changed.`);
  // The checks before anything is saved: a failing rule is named, never the words, and nothing is kept or sent.
  const checks = await checkReplyText(text, { supportCase: read.supportCase, clinicName: read.clinicName, facts });
  if (!checks.ok) return fail(boxes.text, `Fails: ${failedRules(checks).join("; ")}. Nothing was saved or sent.`.slice(0, 1900));
  const saved = await opSaveSupportDraft({ caseId: meta.caseId, text }, ctx.operator, ctx.now);
  const refused = refusalOf(saved);
  if (refused) return fail(boxes.text, `${refused} Nothing was sent.`);
  const data = (saved.body as { data: { ok: boolean; failed: string[]; approvalId: string | null; draftVersion: number } }).data;
  if (!data.ok || !data.approvalId) {
    return fail(
      boxes.text,
      data.ok
        ? `Saved as draft v${data.draftVersion}, but it could not be put up for approval. Nothing was sent. Open the case in the console.`
        : `Saved as draft v${data.draftVersion}, but it now fails: ${data.failed.join("; ")}. Nothing was sent.`.slice(0, 1900),
      true,
    );
  }
  // The item proposed must be exactly the text just saved: a console save in between would make it someone else's draft.
  const proposed = await getApproval(data.approvalId);
  const proposedPayload = proposed ? parseSupportReplyPayload(proposed.payload) : null;
  const expectedHash = draftHash(serialiseDraft({ subject: subjectForCase(read.supportCase), body: text }));
  if (!proposed || proposedPayload?.draftVersion !== data.draftVersion || proposed.draftHash !== expectedHash) {
    return fail(boxes.text, "A newer draft was saved at the same moment, so your edit was not approved. Nothing was sent. The message in the channel now shows the newest one.", true);
  }
  return { ok: true, ref: found.ref, approvalId: meta.mode === "review" ? data.approvalId : null };
}

/** Approve through the console's own decision path; the outcome in words for the note. Never throws. */
async function approve(approvalId: string, ref: string, ctx: Ctx): Promise<string> {
  let outcome: OpsOutcome;
  try {
    outcome = await opDecideApproval(
      { id: approvalId, action: "approve", reasonCode: SLACK_APPROVE_REASON, codeChecked: true },
      ctx.operator,
      { now: ctx.now, factor: SLACK_FACTOR },
    );
  } catch (error) {
    log.error("support slack: decision failed", { error: describeError(error) });
    outcome = { status: 500, body: { error: "The decision could not be recorded. Check the case in the console.", code: "failed" } };
  }
  return decisionNote(ref, outcome);
}

/** A dialog that only says something: the working note, or the outcome. */
function noteView(text: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "support_note",
    title: { type: "plain_text", text: "Review and send" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(text) } }],
  };
}

export const WORKING_TEXT = "Working: checking your passcode and the reply rules, saving your edit and approving it. This dialog says how it went in a moment, and the message in the channel updates.";

async function onSubmit(payload: Payload, ctx: Ctx): Promise<Response> {
  const callback = payload.view?.callback_id;
  if (callback !== "support_review" && callback !== "support_edit") return EMPTY();
  const meta = parseDialogMeta(payload.view?.private_metadata);
  if (!meta || meta.mode !== (callback === "support_review" ? "review" : "edit")) {
    return dialogErrors({ [fallbackBox(callback)]: "This dialog could not be read. Nothing was changed." });
  }
  const values = payload.view?.state?.values ?? {};
  const typed = values.reply?.text?.value;
  const code = values.passcode?.code?.value;
  const refresh = () => syncCaseMessage(meta.caseId, { now: ctx.now, force: true, config: ctx.config }).then(() => {});

  // An edit to approve is the slow case (the passcode, the checks twice, the save, the proposal):
  // Slack is answered first with a working note, and the dialog is updated with the outcome.
  const viewId = typeof payload.view?.id === "string" && /^V[A-Z0-9]{2,30}$/.test(payload.view.id) ? payload.view.id : null;
  if (meta.mode === "review" && !meta.long && typeof typed === "string" && viewId) {
    const item = await getApproval(meta.approvalId);
    const body = item ? parseDraft(item.draft)?.body : null;
    const edited = body !== undefined && body !== null && normaliseDraftText(typed) !== normaliseDraftText(body) && typed.trim() !== body.trim();
    if (edited) {
      ctx.defer(async () => {
        const prepared = await prepare(meta, typed, code, ctx);
        let text: string;
        if (!prepared.ok) text = `Not sent. ${prepared.message}`;
        else text = await approve(prepared.approvalId!, prepared.ref, ctx);
        const updated = await slackApi("views.update", ctx.config.token, { view_id: viewId, view: noteView(text) });
        if (!updated.ok) log.warn("support slack: dialog not updated", { reason: updated.error });
        await refresh();
        await privateNote(ctx.config, ctx.channel, ctx.user, escapeMrkdwn(text));
      });
      return json({ response_action: "update", view: noteView(WORKING_TEXT) });
    }
  }

  const prepared = await prepare(meta, typed, code, ctx);
  if (!prepared.ok) {
    if (prepared.refresh) ctx.defer(refresh);
    return dialogErrors({ [prepared.box]: prepared.message });
  }
  if (!prepared.approvalId) {
    ctx.defer(refresh);
    return json({ response_action: "clear" });
  }
  const approvalId = prepared.approvalId;
  // Approve after the answer (it sends the email).
  ctx.defer(async () => {
    const note = await approve(approvalId, prepared.ref, ctx);
    await refresh();
    await privateNote(ctx.config, ctx.channel, ctx.user, escapeMrkdwn(note));
  });
  return json({ response_action: "clear" });
}

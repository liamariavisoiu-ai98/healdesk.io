import { and, desc, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsApprovals, supportSlackMessages, type OpsApproval, type SupportCase } from "@/db/schema";
import { parseDraft } from "@/lib/approvals/drafts";
import { listByStatus } from "@/lib/approvals/store";
import { parseSupportReplyPayload, SUPPORT_REPLY_KIND } from "@/lib/approvals/support-payload";
import { consoleOrigin } from "@/lib/email/lint";
import { describeError, log } from "@/lib/log";
import { packSections, slackName, SLACK_SECTION_MAX, SLACK_TAG } from "@/lib/ops/slack";

import { printRef } from "./case-vocab";
import { checkReplyText, currentReplyDraft, factsOfDraft, readCaseForReply } from "./send";
import { failedRules } from "./send-checks";
import { slackApi, slackSupportConfig, type SlackSupportConfig } from "./slack-api";

/**
 * A support reply, shown in the owner's Slack channel to read and act on
 * (ops automation Phase 7, lane P7i; the owner's decision of 26 October
 * 2026: "Show the draft reply text in Slack so I can read and approve it
 * there with the passcode. I accept that Slack has no BAA.").
 *
 * For support replies only (approval kind `support_reply_send`): one Slack
 * message per case, carrying the case's ref, the clinic's name, the urgency,
 * the reply-by day, the DRAFTED reply as the clinic would read it, the
 * checks' result (rule names only) and five buttons (Review and send, Edit
 * only, Open in console, Snooze 1 day, Close). Never the clinic's own email:
 * the text is read from the approval item's draft, which is ours. Every
 * other Slack message (lib/ops/slack.ts) is unchanged and carries no prose.
 *
 * Posted and kept true by `runSupportSlackSweep`, every minute from the
 * worker's billing-minute clock and hourly from the tick: a waiting item
 * with no message is posted (chat.postMessage); a new draft version, a
 * snooze or a decision updates the same message (chat.update), recorded in
 * support_slack_messages by its ts; an item decided, expired or whose case
 * closed turns the message final, with the buttons and the draft's words
 * gone. The Slack route (lib/support/slack-actions.ts) refreshes the
 * message at once after an act, through the same function. A Slack call
 * that fails changes nothing but this table's row: no approval, no case.
 */

/** Slack calls one sweep makes at most. */
const MAX_PER_RUN = 10;
/** The waits before the next try after a failed Slack call: 1, 5 and 30 minutes, then every 6 hours. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
const LEASE_MS = 60_000;

/** Slack's mrkdwn treats these three as control characters. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const URGENCY_WORDS: Readonly<Record<SupportCase["urgency"], string>> = {
  now: ":red_circle: now",
  today: ":large_orange_circle: today",
  this_week: ":large_blue_circle: this week",
};

/** "Tue 27 Oct" for an ISO day. */
function dayLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export type ReplyView = {
  caseId: string;
  /** Printed: "HD-7F3KQ". */
  ref: string;
  clinicName: string | null;
  urgency: SupportCase["urgency"];
  replyByOn: string;
  caseState: SupportCase["state"];
  snoozedUntil: Date | null;
  /** The item shown: the waiting one, else the case's newest. */
  item: Pick<OpsApproval, "id" | "status" | "outcomeCode"> | null;
  draftVersion: number | null;
  /** The drafted reply's body, only while the item waits. */
  draft: string | null;
  /** The checks on the draft now: the names of those that fail, or none. Null when not run. */
  failed: string[] | null;
};

/** Whether the message shows buttons: the item waits and the case is open. */
export function isActionable(view: ReplyView): boolean {
  return view.item?.status === "waiting" && view.caseState !== "closed";
}

/** The message is done: nothing about it will change again. */
function isFinal(view: ReplyView): boolean {
  if (view.caseState === "closed") return true;
  return view.item !== null && !["waiting", "approved"].includes(view.item.status);
}

/** What the message shows, as ids and codes: a different key means it is owed an update. */
export function viewKey(view: ReplyView): string {
  return [
    view.item?.id ?? "none",
    view.item?.status ?? "none",
    view.item?.outcomeCode ?? "none",
    `v${view.draftVersion ?? 0}`,
    view.caseState,
    view.snoozedUntil ? view.snoozedUntil.toISOString().slice(0, 10) : "awake",
    view.failed === null ? "unchecked" : view.failed.length === 0 ? "pass" : `fail${view.failed.length}`,
  ].join("|");
}

/** The console page of the case, or null when the console's origin is not set. */
export function caseConsoleLink(caseId: string): string | null {
  const origin = consoleOrigin();
  return origin ? `${origin}/admin/support/${caseId}` : null;
}

/** The final state in words, from the item's status and outcome code: never the reply's words. */
function finalLine(view: ReplyView): string {
  if (view.caseState === "closed" && view.item?.status !== "executed") return ":white_circle: The case is closed. Nothing more will be sent from here.";
  const item = view.item;
  if (!item) return ":white_circle: No reply is waiting any more.";
  switch (item.status) {
    case "approved":
      return ":hourglass_flowing_sand: Approved. Sending now.";
    case "executed":
      return item.outcomeCode === "sent"
        ? ":white_check_mark: Approved and sent to the practice."
        : ":hourglass_flowing_sand: Approved. The first try did not go; the support-send job tries again. Check the case in the console.";
    case "failed":
      return `:x: Approved, but not sent (\`${item.outcomeCode ?? "failed"}\`). Open the case in the console.`;
    case "rejected":
      return ":no_entry_sign: Rejected in the console. Nothing was sent.";
    case "expired":
      return item.outcomeCode === "case_closed"
        ? ":white_circle: The case closed. Nothing was sent."
        : item.outcomeCode === "window_passed"
          ? ":white_circle: The item's window passed. Nothing was sent."
          : ":white_circle: Replaced by a newer draft, or the case moved on. Nothing was sent from this version.";
    default:
      return "";
  }
}

export type SlackBlock = Record<string, unknown>;

/**
 * The message: its notification text and blocks. The draft's words appear
 * only while the item waits, escaped and split into sections within Slack's
 * 3,000 characters, never cut short.
 */
export function replyMessage(view: ReplyView): { text: string; blocks: SlackBlock[] } {
  const name = view.clinicName ? slackName(view.clinicName) : null;
  const headline = `Support reply to approve: ${view.ref}${name ? `, ${name}` : ""}`;
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `:speech_balloon: ${SLACK_TAG} *${escapeMrkdwn(headline)}*` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [
            `Urgency: ${URGENCY_WORDS[view.urgency]}`,
            `Reply by: ${dayLabel(view.replyByOn)}`,
            view.draftVersion ? `Draft v${view.draftVersion}` : null,
            view.caseState === "snoozed" && view.snoozedUntil ? `Snoozed until ${dayLabel(view.snoozedUntil.toISOString().slice(0, 10))}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
      ],
    },
  ];
  const link = caseConsoleLink(view.caseId);
  if (isActionable(view) && view.draft) {
    blocks.push({ type: "divider" });
    for (const piece of packSections(escapeMrkdwn(view.draft).split("\n"), SLACK_SECTION_MAX)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: piece, verbatim: true } });
    }
    blocks.push({ type: "divider" });
    const checks =
      view.failed === null
        ? ":grey_question: The checks could not be run now. The console runs them again before anything is sent."
        : view.failed.length === 0
          ? ":white_check_mark: Every check passes."
          : `:warning: Failing: ${view.failed.map((r) => escapeMrkdwn(r)).join("; ")}`;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: checks }] });
    const value = JSON.stringify({ a: view.item!.id, c: view.caseId });
    blocks.push({
      type: "actions",
      block_id: "support_reply",
      elements: [
        { type: "button", action_id: "support_review", style: "primary", text: { type: "plain_text", text: "Review and send" }, value },
        { type: "button", action_id: "support_edit", text: { type: "plain_text", text: "Edit only" }, value },
        ...(link ? [{ type: "button", action_id: "support_open", text: { type: "plain_text", text: "Open in console" }, url: link }] : []),
        { type: "button", action_id: "support_snooze", text: { type: "plain_text", text: "Snooze 1 day" }, value },
        {
          type: "button",
          action_id: "support_close",
          style: "danger",
          text: { type: "plain_text", text: "Close" },
          value,
          confirm: {
            title: { type: "plain_text", text: "Close this case?" },
            text: { type: "plain_text", text: `${view.ref} closes as "no reply needed" and nothing is sent.` },
            confirm: { type: "plain_text", text: "Close it" },
            deny: { type: "plain_text", text: "Keep it" },
          },
        },
      ],
    });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: finalLine(view) || ":white_circle: Nothing is waiting." } });
    if (link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${link}|Open ${view.ref} in the console>` }] });
  }
  return { text: headline, blocks };
}

// -----------------------------------------------------------------------------
// Reading what the message should show
// -----------------------------------------------------------------------------

/** The item a case's message shows: its waiting one, else its newest. */
async function itemForCase(caseId: string): Promise<OpsApproval | null> {
  const [row] = await unsafeDb
    .select()
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, SUPPORT_REPLY_KIND), sql`${opsApprovals.payload}->>'caseId' = ${caseId}`))
    .orderBy(sql`(${opsApprovals.status} = 'waiting') desc`, desc(opsApprovals.proposedAt))
    .limit(1);
  return row ?? null;
}

/** The case's message as it should be now, read from the database; null when the case is gone. */
export async function readReplyView(caseId: string): Promise<ReplyView | null> {
  const read = await readCaseForReply(caseId);
  if (!read) return null;
  const c = read.supportCase;
  const item = await itemForCase(caseId);
  const payload = item ? parseSupportReplyPayload(item.payload) : null;
  let draft: string | null = null;
  let failed: string[] | null = null;
  if (item && item.status === "waiting" && c.state !== "closed") {
    draft = parseDraft(item.draft)?.body ?? null;
    if (draft) {
      try {
        const current = await currentReplyDraft(caseId);
        const checks = await checkReplyText(draft, { supportCase: c, clinicName: read.clinicName, facts: current ? factsOfDraft(current) : [] });
        failed = checks.ok ? [] : failedRules(checks);
      } catch (error) {
        log.warn("support slack: checks not run", { error: describeError(error) });
      }
    }
  }
  return {
    caseId,
    ref: printRef(c.ref),
    clinicName: read.clinicName,
    urgency: c.urgency,
    replyByOn: c.replyByOn,
    caseState: c.state,
    snoozedUntil: c.snoozedUntil,
    item: item ? { id: item.id, status: item.status, outcomeCode: item.outcomeCode } : null,
    draftVersion: payload?.draftVersion ?? null,
    draft,
    failed,
  };
}

// -----------------------------------------------------------------------------
// Posting and updating
// -----------------------------------------------------------------------------

export type SyncOutcome = "posted" | "updated" | "unchanged" | "not_due" | "held" | "failed" | "nothing" | "off";

/**
 * Bring one case's message up to date: post it, update it, or leave it.
 * `force` ignores the wait after a failed call (an act from Slack just
 * changed it). Never throws, and touches nothing but support_slack_messages.
 */
export async function syncCaseMessage(
  caseId: string,
  options: { now?: Date; force?: boolean; config?: SlackSupportConfig | null } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const config = options.config === undefined ? slackSupportConfig() : options.config;
  if (!config) return "off";
  try {
    const view = await readReplyView(caseId);
    const [existing] = await unsafeDb.select().from(supportSlackMessages).where(eq(supportSlackMessages.caseId, caseId)).limit(1);
    if (!view) return "nothing";
    // A case never shown is posted only while it has a reply waiting.
    if (!existing?.ts && !isActionable(view)) {
      // A first post that never went, for an item no longer waiting: nothing to show any more.
      if (existing && !existing.final) {
        await unsafeDb.update(supportSlackMessages).set({ final: true, updatedAt: now }).where(eq(supportSlackMessages.caseId, caseId));
      }
      return "nothing";
    }
    const key = viewKey(view);
    if (existing?.shownKey === key) return "unchanged";
    if (!options.force && existing?.nextAt && existing.nextAt.getTime() > now.getTime()) return "not_due";

    // The lease: one Slack call per case at a time, across processes.
    const claimed = await unsafeDb
      .insert(supportSlackMessages)
      .values({ caseId, leaseUntil: new Date(now.getTime() + LEASE_MS), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: supportSlackMessages.caseId,
        set: { leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now },
        setWhere: sql`${supportSlackMessages.leaseUntil} is null or ${supportSlackMessages.leaseUntil} <= ${now}`,
      })
      .returning();
    const row = claimed[0];
    if (!row) return "held";

    // Read again under the lease: a decision made since the first read must not be written over.
    const fresh = (await readReplyView(caseId)) ?? view;
    const freshKey = viewKey(fresh);
    if (row.shownKey === freshKey) {
      await unsafeDb.update(supportSlackMessages).set({ leaseUntil: null }).where(eq(supportSlackMessages.caseId, caseId));
      return "unchanged";
    }
    const message = replyMessage(fresh);
    let result = row.ts && row.channel
      ? await slackApi("chat.update", config.token, { channel: row.channel, ts: row.ts, text: message.text, blocks: message.blocks })
      : await slackApi("chat.postMessage", config.token, { channel: config.channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false });
    let posted = !(row.ts && row.channel);
    // The old message was deleted by hand, or the channel changed: post a new one.
    if (!result.ok && !posted && ["message_not_found", "channel_not_found", "cant_update_message"].includes(result.error)) {
      result = await slackApi("chat.postMessage", config.token, { channel: config.channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false });
      posted = true;
    }
    if (result.ok) {
      const ts = posted ? result.ts : row.ts;
      const channel = posted ? (result.channel ?? config.channel) : row.channel;
      await unsafeDb
        .update(supportSlackMessages)
        .set({
          ...(ts && channel ? { ts, channel } : {}),
          approvalId: fresh.item?.id ?? null,
          draftVersion: fresh.draftVersion,
          shownKey: freshKey,
          final: isFinal(fresh),
          attempts: 0,
          lastError: null,
          nextAt: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(supportSlackMessages.caseId, caseId));
      return posted ? "posted" : "updated";
    }
    const attempts = row.attempts + 1;
    const backoff = result.retryAfterMs ?? BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
    // A first post that timed out may have been taken by Slack: wait half an hour, so a duplicate is rare.
    const wait = posted && /timeout|abort/.test(result.error) ? Math.max(backoff, 30 * 60_000) : backoff;
    await unsafeDb
      .update(supportSlackMessages)
      .set({ attempts: Math.min(attempts, 1000), lastError: result.error.slice(0, 120), nextAt: new Date(now.getTime() + wait), leaseUntil: null, updatedAt: now })
      .where(eq(supportSlackMessages.caseId, caseId));
    log.warn("support reply not shown in Slack", { reason: result.error, attempts });
    return "failed";
  } catch (error) {
    log.warn("support reply Slack message not synced", { error: describeError(error) });
    return "failed";
  }
}

/**
 * The sweep: every case with a reply waiting, and every message not yet
 * final, brought up to date; at most ten Slack calls a run. Not a switched
 * job: the four Slack settings are the switch, and while one is missing
 * nothing is read or written.
 */
export async function runSupportSlackSweep(now: Date = new Date()): Promise<{ status: "ok" | "failed"; note: string }> {
  const config = slackSupportConfig();
  if (!config) return { status: "ok", note: "Slack support replies are off: a SLACK_ setting is missing." };
  const waiting = await listByStatus(["waiting"], 200, [SUPPORT_REPLY_KIND]);
  const open = await unsafeDb
    .select({ caseId: supportSlackMessages.caseId })
    .from(supportSlackMessages)
    .where(eq(supportSlackMessages.final, false));
  const cases = new Set<string>();
  for (const item of waiting) {
    const p = parseSupportReplyPayload(item.payload);
    if (p) cases.add(p.caseId);
  }
  for (const row of open) cases.add(row.caseId);

  const counts: Partial<Record<SyncOutcome, number>> = {};
  let calls = 0;
  for (const caseId of cases) {
    if (calls >= MAX_PER_RUN) break;
    const outcome = await syncCaseMessage(caseId, { now, config });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === "posted" || outcome === "updated" || outcome === "failed") calls += 1;
  }
  const note = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  return { status: (counts.failed ?? 0) > 0 && !counts.posted && !counts.updated ? "failed" : "ok", note: note || "nothing to show" };
}

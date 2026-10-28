import { and, eq, inArray } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsApprovals, supportCases, type OpsApproval, type SupportCase } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { opsPeople } from "@/lib/support/people";
import { canMove, printRef, type SupportCaseState } from "@/lib/support/case-vocab";
import {
  checkReplyText,
  clinicWroteFirst,
  currentReplyDraft,
  factsOfDraft,
  deliverReply,
  freezeApproval,
  openReplyDraft,
  readCaseForReply,
  subjectForCase,
} from "@/lib/support/send";
import { runSupportActionForApproval, settleStaleRunning } from "@/lib/support/actions/execute";
import { ACTION_CHECK_ID, CHECK_RULES, checkActionClaim, type FactsUsed } from "@/lib/support/draft/checks";
import { actionOfFacts, actionView, settleStale, type ActionView, type SupportAction } from "@/lib/support/actions/tiers";
import { failedRules, type ReplyCheck } from "@/lib/support/send-checks";
import type { SendEmailOptions } from "@/lib/email/send";

import { serialiseDraft, type Draft } from "./drafts";
import type { ExecutionResult, Executor } from "./executors";
import {
  parseSupportReplyPayload,
  SUPPORT_PROPOSER,
  SUPPORT_REPLY_KIND,
  supportReplySubjectRef,
  type SupportReplyApprovalPayload,
} from "./support-payload";
import { moveStatus, propose, SERVICE_ACTOR, subjectAfterRejections, type EventActor } from "./store";

/**
 * The approval inbox's support reply (ops automation Phase 7, lane P7c;
 * design E5 §2.3, §5.A; owner decision D12): kind `support_reply_send`, one
 * item per reply draft version, which the owner approves, edits or rejects,
 * always with a fresh authenticator code (apps/web lib/admin/approval-decide.ts).
 *
 *   - payload: ids only (case, reply row, draft version, the case's ref);
 *   - draft: the reply as the clinic would read it, `{subject, body}`, in the
 *     item's `draft` column. The subject is fixed per topic and ref: an edit
 *     may change the body only;
 *   - due at the end of the case's reply-by day in New York, at once for a
 *     case of urgency `now`; expires after 14 days (nothing is ever sent by
 *     waiting: expiry only takes it off the list);
 *   - proposed when a case's draft passes every check (`proposeSupportReplyFor`:
 *     the operator's saveSupportDraft and Propose buttons, and lane P7b's
 *     drafter once it writes a passing draft), idempotent per (reply, version);
 *     a draft that fails a check is never proposed, so a listable table never
 *     holds a reply that failed (scripts/readonly-tables.ts lists ops_approvals);
 *   - approving runs `sendSupportReply`: the checks again, in send mode, on
 *     the exact text approved (the edit when there is one), refusing with the
 *     rules' names, never the words; then, when the draft proposed a
 *     Settings change still pending (lane D: an APPROVAL-tier change, or a
 *     DIRECT one held for approval), that change is made through the
 *     clinic's own Settings door (lib/support/actions/execute.ts), only
 *     while, under the case's lock, this item is still the case's current
 *     unapproved draft; if the reply then cannot go (replaced or closed in
 *     the same moment, the sending stopped) ops is told once per case
 *     (`support_action_reply_unsent`) to write to the clinic; and if it
 *     is refused there nothing is sent (`action_refused`), so the reply never
 *     says a change was made that was not; a change settled before (refused,
 *     not run) does not block a reply whose text passes the claim check;
 *     then the text is frozen on the reply row and sent (lib/support/send.ts). A case closed since, or a newer
 *     draft, sends nothing (`no_longer_needed`).
 */

export {
  isSupportReplyKind,
  parseSupportReplyPayload,
  SUPPORT_PROPOSER,
  SUPPORT_REPLY_KIND,
  supportReplySubjectRef,
  type SupportReplyApprovalPayload,
} from "./support-payload";

/** The end of an ISO day in a time zone, as an instant. */
export function endOfDayIn(isoDay: string, timeZone = "America/New_York"): Date {
  const [y, m, d] = isoDay.split("-").map(Number) as [number, number, number];
  // Midnight UTC of the next day, moved by the zone's offset at that instant.
  const nextUtc = Date.UTC(y, m - 1, d + 1);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nextUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(nextUtc + (nextUtc - local));
}

/** When the owner's yes is due: at once for a `now` case, else the end of its reply-by day. */
export function supportReplyDueAt(c: Pick<SupportCase, "urgency" | "replyByOn">, now: Date): Date {
  if (c.urgency === "now") return new Date(now.getTime() + 60 * 1000);
  const end = endOfDayIn(c.replyByOn);
  return end.getTime() > now.getTime() ? end : new Date(now.getTime() + 60 * 1000);
}

/** The states a case may be proposed from: a draft waits for Send. */
const PROPOSABLE: readonly SupportCaseState[] = ["drafted", "needs_edit"];

export type ProposeReplyOutcome =
  | { status: "proposed"; approvalId: string; draftVersion: number }
  | { status: "already_waiting"; approvalId: string | null; draftVersion: number }
  | { status: "checks_failed"; rules: string[]; draftVersion: number }
  | { status: "refused"; code: "no_case" | "closed" | "no_clinic" | "no_draft" | "not_a_reply" | "wrong_state"; state?: SupportCaseState };

/**
 * Propose a case's current draft for the owner's yes, if every check passes
 * on it. Expires any waiting item for an older version of the same reply
 * first (a newer draft replaces it). A `needs_edit` case whose draft now
 * passes moves to `drafted`. Idempotent: the same version already waiting is
 * `already_waiting`.
 */
export async function proposeSupportReplyFor(input: {
  caseId: string;
  now: Date;
  /** Who pressed the button, when an operator did (the `proposed` event names them). */
  actor?: EventActor;
  proposedBy?: string;
  tenantActor?: ActorContext;
}): Promise<ProposeReplyOutcome> {
  const read = await readCaseForReply(input.caseId, input.tenantActor);
  if (!read) return { status: "refused", code: "no_case" };
  const c = read.supportCase;
  if (c.state === "closed") return { status: "refused", code: "closed" };
  if (!c.subjectClinicId) return { status: "refused", code: "no_clinic" };
  if (!PROPOSABLE.includes(c.state)) return { status: "refused", code: "wrong_state", state: c.state };
  if (!(await clinicWroteFirst(c.id))) return { status: "refused", code: "not_a_reply" };
  const reply = await openReplyDraft(c.id);
  if (!reply || reply.draftText === null || reply.draftVersion === null) return { status: "refused", code: "no_draft" };
  const draftVersion = reply.draftVersion;

  // Every check again now, as Send will run them; and a drafter's draft must
  // also have passed check 1 (facts) when it was written, which needs the
  // model's run and so cannot be run here.
  const checks = await checkReplyText(
    reply.draftText,
    { supportCase: c, clinicName: read.clinicName, facts: factsOfDraft(reply) },
    input.tenantActor,
  );
  await expireOlderVersions(c.id, reply.id, input.now);
  const storedFailed = byDrafter(reply) && (reply.checksJson as { ok?: unknown } | null)?.ok !== true;
  if (!checks.ok || storedFailed) {
    const rules = failedRules(checks);
    return { status: "checks_failed", rules: storedFailed && rules.length === 0 ? [STORED_CHECKS_FAILED] : rules, draftVersion };
  }

  if (c.state === "needs_edit" && canMove("needs_edit", "drafted")) {
    await unsafeDb
      .update(supportCases)
      .set({ state: "drafted", updatedAt: input.now })
      .where(and(eq(supportCases.id, c.id), eq(supportCases.state, "needs_edit")));
  }
  const subject = subjectForCase(c);
  // As the inbox's draft reader reads it back (drafts.ts parseDraft), so the hash approved is the hash of what is sent.
  const draft = serialiseDraft({ subject, body: reply.draftText.replace(/\r\n?/g, "\n").trim() });
  const base = supportReplySubjectRef(reply.id, draftVersion);
  const subjectRef = input.actor ? await subjectAfterRejections(SUPPORT_REPLY_KIND, base) : base;
  const approvalId = await propose(
    {
      kind: SUPPORT_REPLY_KIND,
      subjectClinicId: c.subjectClinicId,
      subjectRef,
      payload: { caseId: c.id, messageId: reply.id, draftVersion, ref: c.ref },
      dueAt: supportReplyDueAt(c, input.now),
    },
    input.now,
    { draft, proposedBy: input.proposedBy ?? SUPPORT_PROPOSER, actor: input.actor ?? { label: SUPPORT_PROPOSER } },
  );
  if (approvalId) return { status: "proposed", approvalId, draftVersion };
  const [waiting] = await unsafeDb
    .select({ id: opsApprovals.id })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, SUPPORT_REPLY_KIND), eq(opsApprovals.subjectRef, subjectRef), eq(opsApprovals.status, "waiting")))
    .limit(1);
  return { status: "already_waiting", approvalId: waiting?.id ?? null, draftVersion };
}

/** Whether lane P7b's drafter wrote this draft (facts_json.by), rather than an operator. */
function byDrafter(row: { factsJson: unknown }): boolean {
  return (row.factsJson as { by?: unknown } | null)?.by === "drafter";
}

/** Shown when a drafter's draft failed its first check (facts) when it was written: edit it or draft again. */
export const STORED_CHECKS_FAILED = "The draft failed its checks when it was written: save an edit, or draft it again";

/** Take every waiting item of this case for another draft off the list: the current draft replaces it. */
export async function expireOlderVersions(caseId: string, currentMessageId: string, now: Date): Promise<number> {
  const waiting = await unsafeDb
    .select({ id: opsApprovals.id, payload: opsApprovals.payload })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, SUPPORT_REPLY_KIND), eq(opsApprovals.status, "waiting")));
  let expired = 0;
  for (const item of waiting) {
    const p = parseSupportReplyPayload(item.payload);
    if (!p || p.caseId !== caseId || p.messageId === currentMessageId) continue;
    if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "no_longer_needed" })) {
      expired += 1;
    }
  }
  return expired;
}

/** Take every waiting item of a case off the list (the case closed: lib/support/wire.ts passes `case_closed`). */
export async function expireCaseItems(caseId: string, now: Date, outcomeCode = "no_longer_needed"): Promise<number> {
  const waiting = await unsafeDb
    .select({ id: opsApprovals.id, payload: opsApprovals.payload })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, SUPPORT_REPLY_KIND), eq(opsApprovals.status, "waiting")));
  let expired = 0;
  for (const item of waiting) {
    if (parseSupportReplyPayload(item.payload)?.caseId !== caseId) continue;
    if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode })) {
      expired += 1;
    }
  }
  return expired;
}

// -----------------------------------------------------------------------------
// Still needed?
// -----------------------------------------------------------------------------

type Standing = {
  stillNeeded: boolean;
  supportCase: SupportCase | null;
  currentVersion: number | null;
  clinicName: string | null;
  /** The current draft's facts (check 5's billing facts). */
  facts: FactsUsed[];
  /** The current draft's proposed Settings change (lane D), or null. */
  action: SupportAction | null;
};

async function standing(payload: SupportReplyApprovalPayload, actor?: ActorContext, now: Date = new Date()): Promise<Standing> {
  const read = await readCaseForReply(payload.caseId, actor);
  if (!read) return { stillNeeded: false, supportCase: null, currentVersion: null, clinicName: null, facts: [], action: null };
  // The case's current draft: only it can be approved, and only while unapproved.
  const current = await currentReplyDraft(payload.caseId);
  return {
    stillNeeded:
      read.supportCase.state !== "closed" &&
      current !== null &&
      current.id === payload.messageId &&
      current.approvedAt === null &&
      current.draftVersion === payload.draftVersion,
    supportCase: read.supportCase,
    currentVersion: current?.draftVersion ?? null,
    clinicName: read.clinicName,
    facts: current ? factsOfDraft(current) : [],
    // A claim whose task died reads as refused, outcome unknown (actions/tiers.ts settleStale).
    action: current ? settleStale(actionOfFacts(current.factsJson), now) : null,
  };
}

/** Whether a waiting item's case has moved on: closed, a newer draft, or the reply already approved (the approvals job's sweep). */
export async function supportReplyResolved(item: OpsApproval): Promise<boolean> {
  const payload = parseSupportReplyPayload(item.payload);
  if (!payload) return true;
  try {
    return !(await standing(payload)).stillNeeded;
  } catch (error) {
    log.warn("support reply item not read", { error: describeError(error) });
    return false;
  }
}

// -----------------------------------------------------------------------------
// The packet
// -----------------------------------------------------------------------------

export type SupportReplyFacts = {
  kind: "support_reply_send";
  /** Printed: "HD-7F3KQ". */
  ref: string;
  caseId: string;
  topic: string;
  symptom: string;
  caseUrgency: SupportCase["urgency"];
  caseState: SupportCase["state"];
  replyByOn: string;
  draftVersion: number;
  /** The reply's draft version now; differs from draftVersion once a newer draft replaced this one. */
  currentDraftVersion: number | null;
  /** Each check on the draft as it stands, by id and rule; never the words. */
  checks: ReplyCheck[];
  /**
   * The Settings change the draft proposed (lane D), as closed words: the
   * switch's label, on/off or the choice's label, its tier and where it
   * stands. Approving runs a pending one before the reply is sent. Null: none.
   */
  action: ActionView | null;
};

export type SupportReplyPacket = {
  operation: "sendSupportReply";
  irreversible: true;
  stillNeeded: boolean;
  effect: string;
  facts: SupportReplyFacts;
  draft: { subject: string; body: string } | null;
};

export const SUPPORT_REPLY_EFFECT =
  "Sends this reply to the practice's one sign-in address, signed The Healdesk Team, under the subject shown. The checks run again on the text you approve; if one fails, nothing is sent and the rule is named.";

export async function supportReplyPacket(
  approval: OpsApproval,
  ctx: { actor: ActorContext; request?: RequestContext },
): Promise<SupportReplyPacket | null> {
  const payload = parseSupportReplyPayload(approval.payload);
  if (!payload) return null;
  const s = await standing(payload, ctx.actor);
  if (!s.supportCase) return null;
  const stored = parseStoredDraft(approval.draft);
  const checks = stored
    ? await checkReplyText(stored.body, { supportCase: s.supportCase, clinicName: s.clinicName, facts: s.facts }, ctx.actor)
    : { ok: false, results: [] };
  return {
    operation: "sendSupportReply",
    irreversible: true,
    stillNeeded: s.stillNeeded,
    effect: SUPPORT_REPLY_EFFECT,
    facts: {
      kind: "support_reply_send",
      ref: printRef(s.supportCase.ref),
      caseId: s.supportCase.id,
      topic: s.supportCase.category,
      symptom: s.supportCase.symptom,
      caseUrgency: s.supportCase.urgency,
      caseState: s.supportCase.state,
      replyByOn: s.supportCase.replyByOn,
      draftVersion: payload.draftVersion,
      currentDraftVersion: s.currentVersion,
      checks: checks.results.map((c) => ({ id: c.id, ok: c.ok, rule: c.rule })),
      action: actionView(s.action),
    },
    draft: stored,
  };
}

function parseStoredDraft(raw: string | null): { subject: string; body: string } | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as unknown;
    if (typeof d !== "object" || d === null) return null;
    const { subject, body } = d as Record<string, unknown>;
    return typeof subject === "string" && typeof body === "string" ? { subject, body } : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The executor
// -----------------------------------------------------------------------------

function fail(outcomeCode: string, message: string, extra: Partial<ExecutionResult> = {}): ExecutionResult {
  return { ok: false, outcomeCode, message, auditRecorded: null, ...extra };
}

const NO_LONGER_NEEDED = fail(
  "no_longer_needed",
  "The case has moved on since this was proposed (it was closed, a newer draft replaced this one, or the reply was already approved), so nothing was sent.",
);

/** Approving made the draft's Settings change, and then the reply could not go. */
const CHANGED_NOT_SENT = fail(
  "action_made_reply_unsent",
  "The Settings change was made, but the reply could not be sent (the case was closed or replaced in the same moment, or the clinic's sign-in is gone). Ops has been told: write to the clinic from hello@ to say what changed.",
);

const CHANGE_MADE_NOTE = " The Settings change it describes was made: write to the clinic from hello@ to say what changed.";

/** Tell ops, once per case, that a change was made from it and the clinic was not told (closed words: ids and the ref). */
async function tellChangeUnsent(c: SupportCase): Promise<void> {
  await notifyOpsOnce("support_action_reply_unsent", { clinicId: c.subjectClinicId ?? null, requestId: c.id }, { supportRef: printRef(c.ref) });
}

/** The label an approval is recorded under on the reply row: the case's assignee, or the team. */
function approvalLabel(c: SupportCase): string {
  return c.assigneeLabel ?? opsPeople()[0]!;
}

/**
 * Approve and send (`sendSupportReply`). `draft` is what the owner approved:
 * the stored draft, or his edit of its body (the inbox's generic draft path
 * has already linted it: subject rules, copy lint, links).
 */
export async function sendSupportReply(
  approval: OpsApproval,
  draft: Draft | null,
  now: Date,
  options: SendEmailOptions = {},
): Promise<ExecutionResult> {
  const payload = parseSupportReplyPayload(approval.payload);
  if (!payload || !draft) return fail("malformed_item", "This item's details could not be read, so nothing was sent.");
  // A change whose task died mid-run is settled first, so it neither counts as made nor blocks the reply for good.
  await settleStaleRunning(unsafeDb, payload.caseId, now);
  const s = await standing(payload, undefined, now);
  if (!s.stillNeeded || !s.supportCase) return NO_LONGER_NEEDED;
  const c = s.supportCase;
  if (!c.subjectClinicId || !(await clinicWroteFirst(c.id))) {
    return fail("not_a_reply", "This case has no message from the clinic to reply to, so nothing was sent.");
  }
  const subject = subjectForCase(c);
  // The case's topic changed since this was proposed: its subject is no longer the case's, so it is stale.
  if (parseStoredDraft(approval.draft)?.subject !== subject) return NO_LONGER_NEEDED;
  if (draft.subject !== subject) {
    return fail("subject_changed", "The subject of a support reply is fixed for its topic and cannot be edited, so nothing was sent. Edit the body only.");
  }
  // The checks again, in send mode, on exactly the text approved: the rules' names, never the words.
  const checks = await checkReplyText(draft.body, { supportCase: c, clinicName: s.clinicName, facts: s.facts });
  if (!checks.ok) {
    return fail("checks_failed", `Nothing was sent: the reply fails ${failedRules(checks).join("; ")}. Edit it and propose it again.`);
  }
  // Lane D: only a change still PENDING is made here, before the send, and
  // when this approval runs it and it does not happen (refused, or not run
  // because the case already made another), nothing is sent. A change that
  // was settled before (refused, not run, already so, an unknown outcome)
  // never blocks on its own: the claim check holds the text to what
  // happened, so a reply that says a person will look at it still goes,
  // and one that says it was made does not.
  // The change runs only while this item is still the case's current,
  // unapproved draft, checked under the case's lock, so a setting never
  // changes for a reply that can no longer be sent.
  let action = s.action;
  let changedNow = false;
  if (action?.status === "pending") {
    const ran = await runSupportActionForApproval({ caseId: c.id, messageId: payload.messageId, draftVersion: payload.draftVersion, now });
    if (ran.stale) return NO_LONGER_NEEDED;
    if (ran.action && ran.action.status !== "done" && ran.action.status !== "already") {
      return fail(
        "action_refused",
        ran.action.status === "running"
          ? "The Settings change this reply describes was already being made and its outcome is not known yet, so nothing was sent. Check the clinic's switches, then edit the reply and propose it again."
          : `The Settings change this reply describes was not made, so nothing was sent: ${ran.action.reason ?? "it was refused"} Edit the reply and propose it again.`,
      );
    }
    action = ran.action;
    changedNow = ran.action?.status === "done";
  }
  if (action && !checkActionClaim(draft.body, action).ok) {
    return fail("checks_failed", `Nothing was sent: the reply fails ${CHECK_RULES[ACTION_CHECK_ID]} Edit it and propose it again.`);
  }
  const frozen = await freezeApproval({
    caseId: c.id,
    messageId: payload.messageId,
    draftVersion: payload.draftVersion,
    subject,
    text: draft.body,
    approvedByLabel: approvalLabel(c),
    now,
  });
  if (frozen === "already_approved") return fail("already_sent", "This reply was already approved, so it was not sent again.");
  if (frozen !== "frozen") {
    if (changedNow) await tellChangeUnsent(c);
    return changedNow ? CHANGED_NOT_SENT : NO_LONGER_NEEDED;
  }
  const outcome = await deliverReply(payload.messageId, now, options);
  switch (outcome.status) {
    case "sent":
      return { ok: true, outcomeCode: "sent", message: null, auditRecorded: null, draftHashSent: outcome.hash };
    case "retrying":
      return {
        ok: true,
        outcomeCode: "send_retrying",
        message:
          "Approved, but the first try did not go, so the clinic has not received it yet. It is tried again only while the support send retries run on this host; if the clinic's Deliveries tab still shows it unsent, write to the clinic from hello@. The text cannot change now.",
        auditRecorded: null,
        draftHashSent: null,
      };
    case "stopped":
      // A change this approval made, with no reply to tell the clinic: ops writes to it.
      if (changedNow) await tellChangeUnsent(c);
      if (outcome.reason === "case_closed") return changedNow ? CHANGED_NOT_SENT : NO_LONGER_NEEDED;
      if (outcome.reason === "clinic_left") {
        return fail(
          "clinic_left",
          `The practice has no sign-in address any more (its account closed or its sign-in is gone), so nothing was sent.${changedNow ? CHANGE_MADE_NOTE : ""}`,
        );
      }
      return fail("send_failed", `The reply was approved but could not be sent as approved, so it was not sent. Ops has been told.${changedNow ? CHANGE_MADE_NOTE : ""}`);
    case "not_due":
      // Taken by another try in flight: it is sending this same frozen text.
      return {
        ok: true,
        outcomeCode: "send_retrying",
        message: "Approved; the send is already in progress.",
        auditRecorded: null,
        draftHashSent: null,
      };
  }
}

export const SUPPORT_REPLY_EXECUTOR: Executor = (approval, _operator, ctx) =>
  sendSupportReply(approval, ctx.draft, ctx.now ?? new Date());

/** The waiting support reply items, by case: for the console's case view. */
export async function waitingSupportItems(caseIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (caseIds.length === 0) return out;
  const rows = await unsafeDb
    .select({ id: opsApprovals.id, payload: opsApprovals.payload })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, SUPPORT_REPLY_KIND), inArray(opsApprovals.status, ["waiting"])));
  for (const r of rows) {
    const p = parseSupportReplyPayload(r.payload);
    if (p && caseIds.includes(p.caseId)) out.set(p.caseId, r.id);
  }
  return out;
}

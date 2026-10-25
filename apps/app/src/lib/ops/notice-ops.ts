import { and, eq } from "drizzle-orm";

import { billingNotices } from "@/db/schema";
import { renderContactDraft } from "@/lib/approvals/contact-drafts";
import { contactExtra, noticeDedupeKey } from "@/lib/approvals/contact-packets";
import {
  EXTEND_MAX_DAYS,
  EXTEND_MIN_DAYS,
  isDraftKind,
  NOTES_BY_KIND,
  parseContactPayload,
  parseFields,
  PHRASES,
  storableName,
  withFields,
  type ContactPayloads,
} from "@/lib/approvals/contact-payloads";
import { reminderPlanIn } from "@/lib/approvals/contact-reminders";
import { serialiseDraft } from "@/lib/approvals/drafts";
import { CONSOLE_PROPOSER, UUID } from "@/lib/approvals/kinds";
import { getApproval, propose } from "@/lib/approvals/store";
import { copyProblems, printableClinicName, subjectProblems } from "@/lib/email/lint";
import type { NoteCode, PhraseCode } from "@/lib/email/templates/contact-words";
import { audienceFor } from "@/lib/email/templates/context";
import { channelNextStep } from "@/lib/setup/channels";
import { stepsLeft, wizardFinished } from "@/lib/setup/screens";
import { readSetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

// api.ts imports this module for its dispatch, and this module borrows its
// helpers: safe, because nothing here touches them while the modules load.
import { actorFor, audit, clinicById, numberArg, ok, stringArg, type Operator, type OpsOutcome } from "./api";
import { readLifecycleViews } from "./lifecycle-ops";
import { operatorEventActor } from "./resign-ops";

/**
 * The operator's setup-contact buttons (ops automation lane P6f; design E2
 * "Manual buttons"; owner decisions D4, D6, D12). Each only PROPOSES an
 * item in the approval inbox, with its draft and the lifecycle watch's own
 * recommendation beside it; nothing is sent until the owner approves it
 * there with a fresh code.
 *
 *   - `proposeLifecycleNotice {clinicId, kind, days?, phrase?, note?}`:
 *       `setup_extended` (days 1 to 30, the recommendation's when not given):
 *       on approve, extendSetupDeadline runs first and the email goes only
 *       if it went through;
 *       `setup_waiting_on_us` (phrase): only while the clinic waits on us,
 *       once per entry into that stage; it extends nothing (D6);
 *       `setup_help_offer` (phrase): once per lifecycle stage entry.
 *   - `pullReminderForward {clinicId}`: "Send reminder now", the next of
 *     the six spec reminders, sooner, through the reminders' own sender; it
 *     never adds one (lib/approvals/contact-reminders.ts).
 *   - `previewApprovalDraft {id, fields}` (read): an email item's draft as
 *     it would read with other fields, rendered by its template, or the
 *     problems with those fields. Writes nothing.
 *
 * Each proposal records a security event naming the operator.
 */

const NOTICE_KINDS = ["setup_extended", "setup_waiting_on_us", "setup_help_offer"] as const;
type NoticeKind = (typeof NOTICE_KINDS)[number];

const SETUP_STAGES = new Set(["not_started", "in_setup", "waiting_on_us"]);
const HELP_STAGES = new Set(["not_started", "in_setup", "waiting_on_us", "partly_live"]);

type Refusal = { status: "refused"; message: string };
const refused = (message: string): OpsOutcome => ok({ status: "refused", message } satisfies Refusal);

function noteArg(kind: NoticeKind, value: unknown): NoteCode | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && (NOTES_BY_KIND[kind] as readonly string[]).includes(value) ? (value as NoteCode) : undefined;
}

export async function opProposeLifecycleNotice(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const kind = args.kind;
  if (typeof kind !== "string" || !(NOTICE_KINDS as readonly string[]).includes(kind)) {
    return refused(`kind is one of ${NOTICE_KINDS.join(", ")}.`);
  }
  const k = kind as NoticeKind;
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  if (clinic.billingClinicId) return refused("This is a location: its setup is its account's. Use the account's clinic.");
  const note = noteArg(k, args.note);
  if (note === undefined) return refused("The closing sentence must be one of the approved ones, or none.");
  const phraseRaw = args.phrase;
  const phrase =
    typeof phraseRaw === "string" && (PHRASES as readonly string[]).includes(phraseRaw) ? (phraseRaw as PhraseCode) : null;
  if (k !== "setup_extended" && !phrase) return refused(`Say what the email names: one of ${PHRASES.join(", ")}.`);

  const { views } = await readLifecycleViews({ actor: actorFor(operator), request: operator.request, now, clinicId: clinic.id });
  const seen = views[0];
  if (!seen) return refused("The lifecycle watch has no row for this clinic yet, so there is no stage to write to it about.");
  if (seen.ignored) return refused("This clinic is on the ignore list (one of our own test accounts), so nothing is sent to it.");
  const view = seen.view;

  const setup = await withTenant({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, async (tx) => {
    const state = await readSetupState(tx, { userId: null, now });
    if (!state) return null;
    const finished = wizardFinished(state.screens, state.progress);
    return {
      deadlineAt: state.billing?.setupDeadlineAt ?? null,
      offboarding: state.clinic.offboardingStartedAt !== null,
      timeZone: state.clinic.timezone,
      slug: state.clinic.slug,
      stepsLeftCount: stepsLeft(state.screens, state.progress),
      rows: state.channels.filter((c) => c.liveAt === null).map((c) => ({ channel: c.channel, status: channelNextStep(c, finished) })),
    };
  });
  if (!setup || setup.offboarding) return refused("The account is no longer being set up, so nothing is sent to it.");
  const ctx = {
    clinicName: storableName(printableClinicName(clinic.name)),
    audience: audienceFor(clinic.specialty),
    timeZone: setup.timeZone,
  };
  const stageSince = view.stageSince.toISOString();

  let proposal: { subjectRef: string; payload: ContactPayloads[NoticeKind]; blockedBy?: ("executed")[] };
  if (k === "setup_extended") {
    if (!SETUP_STAGES.has(view.stage)) return refused("Only a clinic still in its setup window can be given more time.");
    if (!setup.deadlineAt) return refused("This clinic has no setup deadline to extend.");
    const given = numberArg(args, "days");
    const days = given ?? view.recommendation.days ?? 7;
    if (!Number.isInteger(days) || days < EXTEND_MIN_DAYS || days > EXTEND_MAX_DAYS) {
      return refused(`Extend by a whole number of days, from ${EXTEND_MIN_DAYS} to ${EXTEND_MAX_DAYS}.`);
    }
    const fromDeadline = setup.deadlineAt.toISOString();
    proposal = {
      subjectRef: `${clinic.id}:${Math.floor(setup.deadlineAt.getTime() / 1000)}`,
      payload: {
        clinicId: clinic.id,
        clinicSlug: setup.slug,
        fromDeadline,
        days,
        stepsLeftCount: setup.stepsLeftCount,
        rows: setup.rows,
        note,
        ...ctx,
      },
    };
  } else if (k === "setup_waiting_on_us") {
    if (view.stage !== "waiting_on_us") return refused("The clinic is not waiting on us, so there is nothing to tell it.");
    proposal = {
      subjectRef: `${clinic.id}:${Math.floor(view.stageSince.getTime() / 1000)}`,
      payload: { clinicId: clinic.id, stageSince, phrase: phrase!, note, ...ctx },
      blockedBy: ["executed"],
    };
  } else {
    if (!HELP_STAGES.has(view.stage)) return refused("A five-minute call is offered only while setup is still open.");
    proposal = {
      subjectRef: `${clinic.id}:${view.stage}:${Math.floor(view.stageSince.getTime() / 1000)}`,
      payload: { clinicId: clinic.id, stage: view.stage, stageSince, phrase: phrase!, note, ...ctx },
      blockedBy: ["executed"],
    };
  }
  if (k !== "setup_extended") {
    const key = noticeDedupeKey(k, proposal.payload as ContactPayloads["setup_help_offer"]);
    const sent = await withTenant({ clinicId: clinic.id, actor: actorFor(operator) }, async (tx) => {
      const [row] = await tx.db
        .select({ id: billingNotices.id })
        .from(billingNotices)
        .where(and(eq(billingNotices.clinicId, tx.clinicId), eq(billingNotices.kind, k), eq(billingNotices.dedupeKey, key)))
        .limit(1);
      return row !== undefined;
    });
    if (sent) return refused("This email has already gone for this stage, so it is not offered again.");
  }

  const draft = serialiseDraft(renderContactDraft(k, proposal.payload));
  const approvalId = await propose({ kind: k, subjectClinicId: clinic.id, subjectRef: proposal.subjectRef, payload: proposal.payload }, now, {
    proposedBy: CONSOLE_PROPOSER,
    actor: operatorEventActor(operator),
    draft,
    blockedBy: proposal.blockedBy,
  });
  if (!approvalId) {
    return refused("This is already waiting in Approvals, or was decided there for this stage: nothing new was proposed.");
  }
  await audit(operator, "approval_proposed", { approvalId, kind: k, clinicId: clinic.id });
  return ok({ status: "proposed", approvalId });
}

const PLAN_WORDS = {
  not_billed: "This clinic has no billing row of its own: its reminders are its account's.",
  window_over: "The setup window is over, so there are no reminders left to send.",
  live: "A channel is live, so the six setup reminders have stopped.",
  last_reminder: "The next reminder is the sixth, which goes only on the window's last day, so it cannot be sent sooner.",
} as const;

export async function opPullReminderForward(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const plan = await withTenant({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, (tx) =>
    reminderPlanIn(tx, now),
  );
  if (!plan.ok) return refused(PLAN_WORDS[plan.reason]);
  const payload: ContactPayloads["setup_reminder_now"] = {
    clinicId: clinic.id,
    reminderNumber: plan.reminderNumber,
    normallyDueOn: plan.normallyDueOn,
  };
  const approvalId = await propose(
    { kind: "setup_reminder_now", subjectClinicId: clinic.id, subjectRef: `${clinic.id}:${plan.reminderNumber}`, payload },
    now,
    { proposedBy: CONSOLE_PROPOSER, actor: operatorEventActor(operator), blockedBy: ["executed"] },
  );
  if (!approvalId) return refused("This reminder is already waiting in Approvals, or was decided there: nothing new was proposed.");
  await audit(operator, "approval_proposed", { approvalId, kind: "setup_reminder_now", clinicId: clinic.id });
  return ok({ status: "proposed", approvalId, reminderNumber: plan.reminderNumber, normallyDueOn: plan.normallyDueOn });
}

export async function opPreviewApprovalDraft(args: Record<string, unknown>): Promise<OpsOutcome> {
  const id = stringArg(args, "id");
  if (!id || !UUID.test(id)) return refused("No such approval.");
  const item = await getApproval(id);
  if (!item || !isDraftKind(item.kind)) return refused("This item has no email to preview.");
  const payload = parseContactPayload(item.kind, item.payload);
  if (!payload) return refused("This item's details could not be read.");
  const parsed = parseFields(item.kind, args.fields);
  if (!parsed.ok) return ok({ status: "problems", problems: parsed.problems });
  const draft = renderContactDraft(item.kind, withFields(item.kind, payload, parsed.fields));
  const problems = [...subjectProblems(draft.subject), ...copyProblems(`${draft.subject}\n${draft.body}`)];
  if (problems.length > 0) return ok({ status: "problems", problems });
  return ok({
    status: "preview",
    draft: { subject: draft.subject, body: draft.body },
    editable: contactExtra(item.kind, item.payload, item.draft).editable,
  });
}

import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { normaliseReply, proposeRefusalWords, TEXT_RULE, type SendAnswer } from "@/components/admin/support-words";
import { Failure } from "@/components/admin/ui";
import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import { isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import {
  assignSupportCase,
  closeSupportCase,
  fetchClinics,
  fetchSupportCase,
  fetchSupportReplyApprovals,
  matchSupportCase,
  previewSupportReply,
  proposeSupportReply,
  regenerateSupportDraft,
  saveSupportDraft,
  snoozeSupportCase,
  SUPPORT_CLOSED_REASONS,
  type OpsResult,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { readSnoozeChoice, snoozeUntil } from "../snooze";
import { CaseView, type ClinicChoice } from "./CaseView";
import { PROPOSED_NOT_READ, sendEdit, waitingItemFor } from "./send-item";

/**
 * /admin/support/<case id>, one support case (ops automation Phase 7, lane
 * P7d): the facts, the draft and every control, drawn by ./CaseView.tsx from
 * one read of the case (getSupportCase, lane P7a with lane P7b's draft) and
 * one of the replies waiting in the approval inbox (listApprovals, family
 * support, lane P7c), so the view can say whether this case's reply already
 * waits for Send. A case with no clinic also reads the clinic list, for
 * Match.
 *
 * Every control is a server action here, each checking the operator itself
 * (a layout is not a security boundary) and the ids it was handed (uuids
 * from rows this page drew, words from closed lists), then calling the one
 * operation it names. Send is the approval inbox's decision: it finds the
 * waiting item for the case's current draft, or proposes the draft first
 * (proposeSupportReply, refused with the rules' names when a check fails),
 * then enters lib/admin/approval-decide.ts with the owner's fresh code,
 * carrying the editor's text as the item's edit only when it differs from
 * the draft the item holds (./send-item.ts); apps/app runs the checks again
 * on exactly that text and sends it or names the rule. Nothing is sent
 * without the code: the wrapper checks it before anything crosses.
 *
 * Each write revalidates this page and the list, so the case's new state is
 * drawn on the refresh the action brings. The actions close over nothing:
 * the case id comes back from the view with each call.
 */

export const metadata: Metadata = { title: "Support" };
export const dynamic = "force-dynamic";

const LIST = "/admin/support";

const UNAUTHENTICATED = { ok: false as const, code: "unauthenticated" as const, message: "Your session has ended. Sign in again to continue." };
const NO_CASE = "No such support case.";

function refused(message: string): OpsResult<never> {
  return { ok: false, code: "refused", message };
}

function refresh(caseId: string): void {
  revalidatePath(`${LIST}/${caseId}`);
  revalidatePath(LIST);
}

async function save(id: string, text: string, dropChange?: unknown) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  const body = normaliseReply(text);
  if (!body) return refused(TEXT_RULE);
  const result = dropChange === true ? await saveSupportDraft(id.toLowerCase(), body, true) : await saveSupportDraft(id.toLowerCase(), body);
  refresh(id.toLowerCase());
  return result;
}

async function check(id: string, text: string) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  const body = normaliseReply(text);
  if (!body) return refused(TEXT_RULE);
  return previewSupportReply(id.toLowerCase(), body);
}

async function regenerate(id: string) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  const result = await regenerateSupportDraft(id.toLowerCase());
  refresh(id.toLowerCase());
  return result;
}

async function send(id: string, code: string, text: string): Promise<OpsResult<SendAnswer>> {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  const body = normaliseReply(text);
  if (!body) return refused(TEXT_RULE);
  const caseId = id.toLowerCase();
  // The case's current draft, so the item found is for it and not for an older version.
  const current = await fetchSupportCase(caseId);
  if (!current.ok) return current;
  const version = current.data.draft?.version ?? null;
  const items = await fetchSupportReplyApprovals({ status: "waiting" });
  let item = items.ok ? waitingItemFor(items.data.items, caseId, version) : null;
  if (!item) {
    const proposed = await proposeSupportReply(caseId);
    if (!proposed.ok) return proposed;
    refresh(caseId);
    if (proposed.data.outcome === "checks_failed") {
      return { ok: true, data: { status: "not_proposed", message: proposeRefusalWords(proposed.data) } };
    }
    const again = await fetchSupportReplyApprovals({ status: "waiting" });
    item = again.ok ? (again.data.items.find((i) => i.id === proposed.data.approvalId) ?? waitingItemFor(again.data.items, caseId, proposed.data.draftVersion)) : null;
    if (!item) return { ok: true, data: { status: "not_proposed", message: PROPOSED_NOT_READ } };
  }
  const edit = sendEdit(item, body);
  if (!edit.ok) return { ok: true, data: { status: "not_proposed", message: edit.message } };
  const result = await decideApprovalWithCode(item.id, "approve", "owner_checked", code, edit.edit);
  refresh(caseId);
  return result;
}

async function snooze(id: string, choice: unknown) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  const read = readSnoozeChoice(choice);
  if (!read) return refused("Pick when the case comes back.");
  const until = snoozeUntil(read, new Date());
  if (!until.ok) return refused(until.message);
  const result = await snoozeSupportCase(id.toLowerCase(), until.until);
  refresh(id.toLowerCase());
  return result.ok ? { ok: true as const, data: { ...result.data, until: until.until } } : result;
}

async function assign(id: string, label: string) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  // A name as apps/app accepts one (lib/support/people.ts isPersonLabel); the list itself is apps/app's.
  if (typeof label !== "string" || !/^[A-Za-z][A-Za-z .'-]{0,59}$/.test(label) || label.trim() !== label) return refused("Pick a name from the list.");
  const result = await assignSupportCase(id.toLowerCase(), label);
  refresh(id.toLowerCase());
  return result;
}

async function match(id: string, clinicId: string) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  if (!isUuid(clinicId)) return refused("Pick a clinic from the list.");
  const result = await matchSupportCase(id.toLowerCase(), clinicId.toLowerCase());
  refresh(id.toLowerCase());
  return result;
}

async function close(id: string, reason: string) {
  "use server";
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!isUuid(id)) return refused(NO_CASE);
  if (!(SUPPORT_CLOSED_REASONS as readonly string[]).includes(reason)) return refused("Pick a reason from the list.");
  const result = await closeSupportCase(id.toLowerCase(), reason as (typeof SUPPORT_CLOSED_REASONS)[number]);
  refresh(id.toLowerCase());
  return result;
}

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const { caseId: raw } = await params;
  if (!isUuid(raw)) notFound();
  const caseId = raw.toLowerCase();
  const [view, waiting] = await Promise.all([fetchSupportCase(caseId), fetchSupportReplyApprovals({ status: "waiting" })]);
  if (isHostUnreachable(view)) return <HostStandbyPage title="Support" back={{ href: LIST, label: "← Support" }} />;
  const now = new Date().toISOString();

  const clinics: ClinicChoice[] | null =
    view.ok && view.data.case.clinicId === null
      ? await fetchClinics({ connectionState: false }).then((read) =>
          read.ok ? read.data.clinics.map((c) => ({ id: c.id, name: c.name, synthetic: c.dataClassification === "synthetic" })) : null,
        )
      : null;
  const item = view.ok && waiting.ok ? waitingItemFor(waiting.data.items, caseId, view.data.draft?.version ?? null) : null;

  return (
    <main className="mx-auto w-full max-w-page px-4 py-10 sm:px-8 lg:px-14">
      <a href={LIST} className="text-muted text-sm underline">
        ← Support
      </a>
      <h1 className="font-display mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]">Support</h1>
      {!view.ok ? (
        <Failure failure={view} what="the support case" />
      ) : (
        <CaseView
          key={view.data.draft?.messageId ?? "no-draft"}
          view={view.data}
          item={item}
          waitingRead={waiting.ok}
          clinics={clinics}
          now={now}
          actions={{ onSave: save, onCheck: check, onRegenerate: regenerate, onSend: send, onSnooze: snooze, onAssign: assign, onMatch: match, onClose: close }}
        />
      )}
    </main>
  );
}

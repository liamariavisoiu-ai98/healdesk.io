"use client";

import { useState } from "react";

import { onDay, whenWords } from "@/components/admin/approval-words";
import {
  accountLines,
  ageWords,
  alertLines,
  ASSIGN_NOTE,
  assignWords,
  CHECK_NOTE,
  checkName,
  checkWords,
  CLOSE_CHOICES,
  CLOSE_CONFIRM,
  CLOSE_NOTE,
  CLOSED_REASON_WORDS,
  CLOSED_WORDS,
  draftHeadWords,
  DRAFT_FACTS_HEADING,
  FACTS_NOT_READ,
  hiddenWords,
  inboundWords,
  MATCH_NOTE,
  matchWords,
  MAX_REPLY_CHARS,
  NO_CLINIC_FACTS,
  NO_DRAFT_FACTS,
  QUESTIONS_HEADING,
  REGENERATE_NOTE,
  regenerateWords,
  replyByWords,
  replySubject,
  SAVE_NOTE,
  saveWords,
  SEND_CONFIRM,
  SEND_NOTE,
  sendOutcomeWords,
  SIGN_OFF_NOTE,
  SNOOZE_NOTE,
  snoozedWords,
  SOURCE_WORDS,
  STATE_NOTES,
  STATE_WORDS,
  TOOL_WORDS,
  topicWords,
  transcriptWords,
  URGENCY_TONE,
  URGENCY_WORDS,
  waitingItemWords,
  type SendAnswer,
} from "@/components/admin/support-words";
import { ActionButton, ClinicId, CodeField, isCompleteCode, Section, Tag } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type {
  OpsResult,
  SupportCaseMoveOutcome,
  SupportCaseView,
  SupportClosedReason,
  SupportDraftSaved,
  SupportReplyApprovalItem,
  SupportReplyCheckView,
  SupportReplyPreview,
} from "@/lib/admin/ops-client";

import { dayBounds, SNOOZE_CHOICE_WORDS, type SnoozeChoice } from "../snooze";

/**
 * One support case (ops automation Phase 7, lane P7d; design E5 §2.5): the
 * facts the account shows (lane P7a's facts panel), the draft the assistant
 * wrote and the facts it relied on (lane P7b), the one editor where a reply
 * is typed, and every control, each going through the page's server action
 * to the operation it names (apps/app lib/ops/support-case-ops.ts,
 * support-draft-ops.ts, support-reply-ops.ts) or, for Send, to the approval
 * inbox's decision with the owner's fresh code (lib/admin/approval-decide.ts).
 *
 * The console shows facts and the draft, never the clinic's own words
 * (owner decision D15): a chat case carries none, and this view has no
 * element that could print inbound text. The editor is the one place free
 * text is typed (D12); its text goes only to Save draft, Check and Send,
 * and apps/app runs its checks on it each time, answering with the rules'
 * names, never the words.
 *
 * Which controls are offered follows the case's state as apps/app allows the
 * moves (lib/support/case-vocab.ts SUPPORT_CASE_MOVES, draft/store.ts
 * REGENERATE_FROM, lib/approvals/support-reply.ts PROPOSABLE): a refusal from
 * apps/app reaches this app only as the ops client's generic sentence, so
 * the view says why from the case's own facts instead of offering a button
 * that would be refused. Save draft and Check need a clinic and a case not
 * closed and not waiting on the clinic; Regenerate a drafted case or one
 * whose draft needs an edit; Send a reply already waiting in the inbox, or a
 * case Send can propose from (drafted or needs an edit); Match a case with
 * no clinic; Snooze, Assign and Close any case not closed.
 */

export type ClinicChoice = { id: string; name: string; synthetic: boolean };

export type CaseActions = {
  onSave: (caseId: string, text: string) => Promise<OpsResult<SupportDraftSaved>>;
  onCheck: (caseId: string, text: string) => Promise<OpsResult<SupportReplyPreview>>;
  onRegenerate: (caseId: string) => Promise<OpsResult<SupportCaseMoveOutcome>>;
  onSend: (caseId: string, code: string, text: string) => Promise<OpsResult<SendAnswer>>;
  onSnooze: (caseId: string, choice: SnoozeChoice) => Promise<OpsResult<SupportCaseMoveOutcome & { until: string }>>;
  onAssign: (caseId: string, label: string) => Promise<OpsResult<SupportCaseMoveOutcome>>;
  onMatch: (caseId: string, clinicId: string) => Promise<OpsResult<SupportCaseMoveOutcome>>;
  onClose: (caseId: string, reason: SupportClosedReason) => Promise<OpsResult<SupportCaseMoveOutcome>>;
};

export type CaseViewProps = {
  view: SupportCaseView;
  /** The reply waiting in the approval inbox for this case, when one is. */
  item: SupportReplyApprovalItem | null;
  /** Whether the waiting replies could be read; false says so beside Send. */
  waitingRead: boolean;
  /** The clinics Match may pick from, when the case names none; null when they could not be read. */
  clinics: ClinicChoice[] | null;
  /** The server's clock, ISO, for the snooze day field's bounds. */
  now: string;
  actions: CaseActions;
};

const LABEL = "text-muted block text-xs font-bold tracking-[0.06em] uppercase";
const SELECT = "border-line mt-1 rounded-sm border bg-white px-3 py-2.5";
const NOTE = "text-muted mt-1 max-w-[68ch] text-sm";

type Said = { status: "done" | "refused"; message: string; auditRecorded?: boolean };

/** The line the view says when the waiting replies could not be read: Send still proposes, and reads them again. */
export const WAITING_NOT_READ = "Whether a reply already waits for your Send could not be read; Send reads it again.";

/** Why the editor is read-only while the case waits on the clinic (case-vocab.ts: waiting_clinic moves only to new, snoozed or closed). */
export const WAITING_CLINIC_NOTE = "We replied, so the case takes no new draft while it waits on the clinic. If the clinic writes again the case comes back as new.";

/** Why a case with no clinic has no editor (support-reply-ops.ts, draft/store.ts: refused and never claimed). */
export const NO_CLINIC_REPLY = "No draft is written and no reply can go until the case names its clinic: use Match below.";

export function CaseView({ view, item, waitingRead, clinics, now, actions }: CaseViewProps) {
  const c = view.case;
  const caseId = c.id;
  const draft = view.draft;
  const [text, setText] = useState(draft?.text ?? "");
  const [checks, setChecks] = useState<{ from: "draft" | "check" | "save"; list: SupportReplyCheckView[] }>({ from: "draft", list: draft?.checks ?? [] });
  const [code, setCode] = useState("");
  const [snooze, setSnooze] = useState<SnoozeChoice["kind"]>("tomorrow");
  const [day, setDay] = useState("");
  const [label, setLabel] = useState(c.assigneeLabel ?? view.people[0] ?? "");
  const [clinicId, setClinicId] = useState(clinics?.[0]?.id ?? "");
  const [reason, setReason] = useState<SupportClosedReason>(CLOSE_CHOICES[0]!);

  const closed = c.state === "closed";
  const hasClinic = c.clinicId !== null;
  const editable = hasClinic && !closed && c.state !== "waiting_clinic";
  const canRegenerate = hasClinic && (c.state === "drafted" || c.state === "needs_edit");
  const canSend = hasClinic && !closed && (item !== null || c.state === "drafted" || c.state === "needs_edit");
  const length = [...text].length;
  const hidden = hiddenWords(c.hidden);
  const bounds = dayBounds(new Date(now));

  const said = <T,>(result: OpsResult<T>, words: (data: T) => Said): OpsResult<Said> => (result.ok ? { ok: true, data: words(result.data) } : result);

  return (
    <section id="support-case" className="mt-6">
      <div className="border-line rounded-md border bg-white p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {c.clinicId ? (
            <a href={clinicTabPath(c.clinicId, "care")} className="text-lg font-bold underline underline-offset-2">
              {c.clinicName ?? "A clinic with no printable name"}
            </a>
          ) : (
            <span className="text-lg font-bold">No clinic yet</span>
          )}
          <code className="font-mono text-sm select-all">{c.ref}</code>
          <Tag tone={URGENCY_TONE[c.urgency]}>{URGENCY_WORDS[c.urgency]}</Tag>
          <Tag tone={closed ? "muted" : "info"}>{STATE_WORDS[c.state]}</Tag>
        </div>
        {c.clinicId ? <ClinicId id={c.clinicId} /> : null}
        <p className="mt-3 text-sm">{topicWords(c.category, c.symptom)}</p>
        <p className="text-muted mt-1 text-sm">
          {SOURCE_WORDS[c.source]} · {inboundWords(c)} · {ageWords(c.ageHours)} ({whenWords(c.openedAt)}) ·{" "}
          <span className={c.pastDue ? "text-red-deep font-semibold" : undefined}>{replyByWords(c)}</span>
          {c.assigneeLabel ? ` · with ${c.assigneeLabel}` : " · with nobody yet"}
        </p>
        <p className="mt-2 text-sm">{STATE_NOTES[c.state]}</p>
        {c.state === "snoozed" && c.snoozedUntil ? <p className="text-muted mt-1 text-sm">Snoozed until {whenWords(c.snoozedUntil)}.</p> : null}
        {closed && c.closedAt ? (
          <p className="text-muted mt-1 text-sm">
            Closed {onDay(c.closedAt)}{c.closedReason ? `: ${CLOSED_REASON_WORDS[c.closedReason]}` : ""}.
          </p>
        ) : null}
        {c.lastOutboundAt ? <p className="text-muted mt-1 text-sm">Our last reply went {whenWords(c.lastOutboundAt)}.</p> : null}
        {hidden ? <p className="text-red-deep mt-2 text-sm font-semibold">{hidden}</p> : null}
      </div>

      <Section id="facts" title="The facts">
        {view.facts === null ? (
          <p className="text-sm">{NO_CLINIC_FACTS}</p>
        ) : (
          <>
            {view.facts.account === null ? (
              <p role="status" className="text-red-deep text-sm font-semibold">
                {FACTS_NOT_READ.account}
              </p>
            ) : (
              <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                {accountLines(view.facts.account).map(([name, value], i) => (
                  <div key={`${name}:${i}`} className="contents">
                    <dt className="text-muted">{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <h3 className="text-muted mt-4 text-xs font-bold tracking-[0.06em] uppercase">Alerts in the last {view.facts.days} days</h3>
            {view.facts.alerts === null ? (
              <p role="status" className="text-red-deep mt-1 text-sm font-semibold">
                {FACTS_NOT_READ.alerts}
              </p>
            ) : view.facts.alerts.length === 0 ? (
              <p className="text-muted mt-1 text-sm">None.</p>
            ) : (
              <ul className="mt-1 grid gap-0.5 text-sm">
                {alertLines(view.facts.alerts).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <h3 className="text-muted mt-4 text-xs font-bold tracking-[0.06em] uppercase">Transcript emails in the last {view.facts.days} days</h3>
            {view.facts.transcripts === null ? (
              <p role="status" className="text-red-deep mt-1 text-sm font-semibold">
                {FACTS_NOT_READ.transcripts}
              </p>
            ) : (
              <p className="mt-1 text-sm">{transcriptWords(view.facts.transcripts)}</p>
            )}
          </>
        )}
      </Section>

      <Section id="draft-facts" title={DRAFT_FACTS_HEADING}>
        {draft && draft.factsUsed.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted">
                <th className="pr-4 font-semibold">From</th>
                <th className="pr-4 font-semibold">Field</th>
                <th className="font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {draft.factsUsed.map((f, i) => (
                <tr key={i} className="border-line border-t">
                  <td className="py-1 pr-4">{TOOL_WORDS[f.tool]}</td>
                  <td className="py-1 pr-4">{f.field}</td>
                  <td className="py-1">{f.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted text-sm">{NO_DRAFT_FACTS}</p>
        )}
      </Section>

      <Section id="reply" title="Reply">
        <p className="text-sm">{draftHeadWords(draft)}</p>
        {!hasClinic ? (
          <p className="mt-2 text-sm font-semibold">{NO_CLINIC_REPLY}</p>
        ) : (
          <>
            {c.state === "waiting_clinic" ? <p className="mt-2 text-sm">{WAITING_CLINIC_NOTE}</p> : null}
            <p className="text-muted mt-3 text-sm">
              Subject: <span className="text-ink font-semibold">{item?.packet?.draft?.subject ?? replySubject(c.category, c.ref)}</span>
            </p>
            <label className="mt-2 block text-sm">
              <span className={LABEL}>Reply</span>
              <textarea
                name="reply"
                value={text}
                readOnly={!editable}
                onChange={(event) => setText(event.target.value)}
                rows={8}
                className="border-line mt-1 w-full rounded-sm border bg-white px-3 py-2 font-sans text-sm"
              />
            </label>
            <p className={NOTE}>
              {SIGN_OFF_NOTE} {length.toLocaleString("en-US")} of {MAX_REPLY_CHARS.toLocaleString("en-US")} characters.
            </p>

            <h3 className="text-muted mt-4 text-xs font-bold tracking-[0.06em] uppercase">
              Checks {checks.from === "draft" ? "on the draft as written" : checks.from === "check" ? "from Check just now" : "from the save just now"}
            </h3>
            {checks.list.length === 0 ? (
              <p className="text-muted mt-1 text-sm">No checks recorded yet.</p>
            ) : (
              <ul className="mt-1 grid gap-0.5 text-sm">
                {checks.list.map((check) => (
                  <li key={check.id} className={check.ok ? "text-done" : "text-red-deep font-semibold"}>
                    {check.ok ? `${checkName(check.id)}: passed` : `${checkName(check.id)}: ${check.rule}`}
                  </li>
                ))}
              </ul>
            )}

            {draft && draft.questionsForOps.length > 0 ? (
              <>
                <h3 className="text-muted mt-4 text-xs font-bold tracking-[0.06em] uppercase">{QUESTIONS_HEADING}</h3>
                <ul className="mt-1 grid gap-0.5 text-sm">
                  {draft.questionsForOps.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {editable ? (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <ActionButton
                    label="Save draft"
                    variant="primary"
                    disabled={length === 0 || length > MAX_REPLY_CHARS}
                    run={async () =>
                      said(await actions.onSave(caseId, text), (saved) => {
                        setChecks({ from: "save", list: saved.checks });
                        return { status: "done", message: saveWords(saved), auditRecorded: saved.auditRecorded };
                      })
                    }
                    done={(d) => d.message}
                  />
                  <p className={NOTE}>{SAVE_NOTE}</p>
                </div>
                <div>
                  <ActionButton
                    label="Check"
                    disabled={length === 0 || length > MAX_REPLY_CHARS}
                    run={async () =>
                      said(await actions.onCheck(caseId, text), (preview) => {
                        setChecks({ from: "check", list: preview.checks });
                        return { status: "done", message: checkWords(preview) };
                      })
                    }
                    done={(d) => d.message}
                  />
                  <p className={NOTE}>{CHECK_NOTE}</p>
                </div>
              </div>
            ) : null}

            {canRegenerate ? (
              <div className="mt-4">
                <ActionButton
                  label="Regenerate"
                  run={async () => said(await actions.onRegenerate(caseId), (moved) => ({ status: "done", message: regenerateWords(moved), auditRecorded: moved.auditRecorded }))}
                  done={(d) => d.message}
                />
                <p className={NOTE}>{REGENERATE_NOTE}</p>
              </div>
            ) : null}

            {canSend ? (
              <div className="border-line mt-5 border-t pt-4">
                {item ? <p className="text-done text-sm font-semibold">{waitingItemWords(item)}.</p> : null}
                {!waitingRead ? (
                  <p role="status" className="text-red-deep text-sm font-semibold">
                    {WAITING_NOT_READ}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <CodeField value={code} onChange={setCode} approval />
                  <ActionButton
                    label="Send"
                    variant="primary"
                    confirm={SEND_CONFIRM}
                    disabled={!isCompleteCode(code) || length === 0 || length > MAX_REPLY_CHARS}
                    run={async () =>
                      said(await actions.onSend(caseId, code, text), (answer) => {
                        const words = sendOutcomeWords(answer);
                        if (words.ok) setCode("");
                        return { status: words.ok ? "done" : "refused", message: words.text, ...(words.auditRecorded === null ? {} : { auditRecorded: words.auditRecorded }) };
                      })
                    }
                    done={(d) => d.message}
                  />
                </div>
                <p className={NOTE}>{SEND_NOTE}</p>
              </div>
            ) : null}
          </>
        )}
      </Section>

      {!closed ? (
        <Section id="case-controls" title="The case">
          <div className="grid gap-5">
            <div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className={LABEL}>Until</span>
                  <select name="snooze" value={snooze} onChange={(event) => setSnooze(event.target.value as SnoozeChoice["kind"])} className={SELECT}>
                    {(Object.keys(SNOOZE_CHOICE_WORDS) as SnoozeChoice["kind"][]).map((kind) => (
                      <option key={kind} value={kind}>
                        {SNOOZE_CHOICE_WORDS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                {snooze === "day" ? (
                  <label className="text-sm">
                    <span className={LABEL}>Day</span>
                    <input type="date" name="day" value={day} min={bounds.min} max={bounds.max} onChange={(event) => setDay(event.target.value)} className={SELECT} />
                  </label>
                ) : null}
                <ActionButton
                  label="Snooze"
                  disabled={snooze === "day" && day === ""}
                  run={async () =>
                    said(await actions.onSnooze(caseId, snooze === "day" ? { kind: "day", day } : { kind: snooze }), (moved) => ({
                      status: "done",
                      message: snoozedWords(moved.until),
                      auditRecorded: moved.auditRecorded,
                    }))
                  }
                  done={(d) => d.message}
                />
              </div>
              <p className={NOTE}>{SNOOZE_NOTE}</p>
            </div>

            <div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className={LABEL}>To</span>
                  <select name="label" value={label} onChange={(event) => setLabel(event.target.value)} className={SELECT}>
                    {view.people.map((person) => (
                      <option key={person} value={person}>
                        {person}
                      </option>
                    ))}
                  </select>
                </label>
                <ActionButton
                  label="Assign"
                  disabled={label === ""}
                  run={async () => said(await actions.onAssign(caseId, label), (moved) => ({ status: "done", message: assignWords(moved, label), auditRecorded: moved.auditRecorded }))}
                  done={(d) => d.message}
                />
              </div>
              <p className={NOTE}>{ASSIGN_NOTE}</p>
            </div>

            {!hasClinic ? (
              <div>
                {clinics === null ? (
                  <p role="status" className="text-red-deep text-sm font-semibold">
                    The clinics could not be read, so Match is not offered. Reload.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                      <span className={LABEL}>Clinic</span>
                      <select name="clinicId" value={clinicId} onChange={(event) => setClinicId(event.target.value)} className={SELECT}>
                        {clinics.map((clinic) => (
                          <option key={clinic.id} value={clinic.id}>
                            {clinic.name}
                            {clinic.synthetic ? " (synthetic)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ActionButton
                      label="Match"
                      disabled={clinicId === ""}
                      run={async () =>
                        said(await actions.onMatch(caseId, clinicId), (moved) => ({
                          status: "done",
                          message: matchWords(moved, clinics.find((clinic) => clinic.id === clinicId)?.name ?? "the clinic"),
                          auditRecorded: moved.auditRecorded,
                        }))
                      }
                      done={(d) => d.message}
                    />
                  </div>
                )}
                <p className={NOTE}>{MATCH_NOTE}</p>
              </div>
            ) : null}

            <div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className={LABEL}>Why</span>
                  <select name="reason" value={reason} onChange={(event) => setReason(event.target.value as SupportClosedReason)} className={SELECT}>
                    {CLOSE_CHOICES.map((choice) => (
                      <option key={choice} value={choice}>
                        {CLOSED_REASON_WORDS[choice]}
                      </option>
                    ))}
                  </select>
                </label>
                <ActionButton
                  label="Close"
                  variant="destructive"
                  confirm={CLOSE_CONFIRM}
                  run={async () => said(await actions.onClose(caseId, reason), (moved) => ({ status: "done", message: CLOSED_WORDS, auditRecorded: moved.auditRecorded }))}
                  done={(d) => d.message}
                />
              </div>
              <p className={NOTE}>{CLOSE_NOTE}</p>
            </div>
          </div>
        </Section>
      ) : null}
    </section>
  );
}

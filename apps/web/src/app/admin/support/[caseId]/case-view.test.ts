// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CHECK_NOTE,
  CLOSE_NOTE,
  DRAFT_FACTS_HEADING,
  FACTS_NOT_READ,
  MATCH_NOTE,
  NO_CLINIC_FACTS,
  NO_DRAFT_FACTS,
  QUESTIONS_HEADING,
  REGENERATE_NOTE,
  SAVE_NOTE,
  SEND_CONFIRM,
  SEND_NOTE,
  DROP_CHANGE_LABEL,
  SENDER_NOT_VERIFIED_WORDS,
  SIGN_OFF_NOTE,
  SNOOZE_NOTE,
  STATE_NOTES,
} from "@/components/admin/support-words";
import { UNAUDITED } from "@/components/admin/ui";
import type { OpsResult, SupportCaseView, SupportReplyApprovalItem } from "@/lib/admin/ops-client";

import { CaseView, NO_CLINIC_REPLY, WAITING_CLINIC_NOTE, WAITING_NOT_READ, type CaseActions } from "./CaseView";
import { CASE, CLINIC, DRAFT_TEXT, item, ITEM, NOW, view } from "./fixtures";

/**
 * The case view (lane P7d), per state and per control: the facts panel in
 * words, the draft's facts, the editor as the one text field, the eight
 * checks green or with the failed rule, the draft's version and author,
 * each control calling its action with the case's id and what the view
 * holds, the code required for Send, the outcome lines in apps/app's words,
 * and the states that hide a control apps/app would refuse. The view has no
 * element that could print a conversation's words: no text crosses but the
 * draft's own and the check rules'.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEVER: CaseActions = {
  onSave: async () => fail("save"),
  onCheck: async () => fail("check"),
  onRegenerate: async () => fail("regenerate"),
  onSend: async () => fail("send"),
  onSnooze: async () => fail("snooze"),
  onAssign: async () => fail("assign"),
  onMatch: async () => fail("match"),
  onClose: async () => fail("close"),
};

function fail(what: string): never {
  throw new Error(`${what} ran during a static render`);
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function render(v: SupportCaseView = view, options: { item?: SupportReplyApprovalItem | null; waitingRead?: boolean; clinics?: { id: string; name: string; synthetic: boolean }[] | null } = {}): string {
  return renderToStaticMarkup(h(CaseView, { view: v, item: options.item ?? null, waitingRead: options.waitingRead ?? true, clinics: options.clinics ?? null, now: NOW, actions: NEVER }));
}

const moved = (outcome: "done" | "unchanged" = "done") => ({ ok: true as const, data: { outcome, ref: "HD-7F3KQ", state: "snoozed" as const, auditRecorded: true } });

describe("a drafted case", () => {
  test("the head: the clinic linked to its Care tab, the ref, the badges, the topic, the age and reply day, who has it, the state's note", () => {
    const html = render();
    const page = text(html);
    expect(html).toContain('id="support-case"');
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain("Radiance Med Spa");
    expect(html).toContain('<code class="font-mono text-[15px] select-all">HD-7F3KQ</code>');
    expect(page).toContain(`Clinic id ${CLINIC}`);
    expect(page).toContain("Now");
    expect(page).toContain("Drafted");
    expect(page).toContain("Call forwarding: Calls ring out unanswered");
    expect(page).toContain("Portal support chat · 1 escalation from the portal chat · opened 3 hours ago (2 Nov 2026, 15:00 UTC) · reply by 3 Nov 2026 · with nobody yet");
    expect(page).toContain(STATE_NOTES.drafted);
    expect(page).not.toContain("patient details hidden");
    // The escalation's field codes never print as the case's words.
    for (const raw of ["calls_ring_out", "overflow_after_hours", "voip", "drafted"]) expect(page).not.toContain(raw);
  });

  test("the facts in words: the account, the alerts as names and times, the transcript emails as counts", () => {
    const page = text(render());
    expect(page).toContain("Setup finished");
    expect(page).toContain("Build: Agreement signed done");
    expect(page).toContain("Channel: Phone live, live since 20 Oct 2026");
    expect(page).toContain("Which calls reach AYA Overflow and after hours");
    expect(page).toContain("Phone carrier Verizon");
    expect(page).toContain("Direct line set");
    expect(page).toContain("Google Calendar connected and working");
    expect(page).toContain("Payment account (Stripe) not connected");
    expect(page).toContain("Package AYA Voice, 100 minutes");
    expect(page).toContain("Plan started yes, on 20 Oct 2026");
    expect(page).toContain("Used this period: Voice minutes 12 of 100");
    expect(page).toContain("The practice's email address deliverable");
    expect(page).toContain("Alerts in the last 14 days");
    expect(page).toContain("voice direct line loops, last 1 Nov 2026, 09:00 UTC");
    expect(page).toContain("Transcript emails in the last 14 days 3 delivered");
    // No phone number crosses.
    expect(page).not.toMatch(/\+?\d{7,}/);
  });

  test("the facts the draft relies on, the draft's version and author, the subject, the checks green, the questions for ops", () => {
    const html = render();
    const page = text(html);
    expect(page).toContain(DRAFT_FACTS_HEADING);
    expect(page).toContain("the account's state Channel: Phone live, live since 2026-10-20");
    expect(page).toContain("Draft 2, written by the assistant, confidence high, 2 Nov 2026, 15:30 UTC.");
    expect(page).toContain("Subject: Re: Your call forwarding (ref HD-7F3KQ)");
    expect(html).toContain(`<textarea name="reply" rows="8"`);
    expect(html).toContain(DRAFT_TEXT);
    expect(page).toContain(SIGN_OFF_NOTE);
    expect(page).toContain("of 1,500 characters");
    expect(page).toContain("Checks on the draft as written");
    for (const name of ["Facts: passed", "Screen: passed", "Names: passed", "Clinical: passed", "Promises: passed", "Claims: passed", "Shape: passed", "Other practices: passed"]) expect(page).toContain(name);
    expect(page).toContain(QUESTIONS_HEADING);
    expect(page).toContain("Has the practice's carrier changed since setup?");
  });

  test("the controls, each with its one line: Save draft, Check, Regenerate, Send with the code field, Snooze, Assign, Close; no Match on a case with a clinic", () => {
    const html = render();
    const page = text(html);
    for (const label of ["Save draft", "Check", "Regenerate", "Send", "Snooze", "Assign", "Close"]) expect(html).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    expect(html).not.toMatch(/<button[^>]*>Match<\/button>/);
    expect(page).toContain(SAVE_NOTE);
    expect(page).toContain(CHECK_NOTE);
    expect(page).toContain(REGENERATE_NOTE);
    expect(page).toContain(SEND_NOTE);
    expect(SEND_NOTE).toMatch(/^Nothing is sent until the code is entered\./);
    expect(page).toContain(SNOOZE_NOTE);
    expect(page).toContain(CLOSE_NOTE);
    expect(page).not.toContain(MATCH_NOTE);
    expect(page.match(/Approval passcode \(or authenticator code\)/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
    // The snooze choices and the close reasons from the closed lists; the people from the view.
    expect(page).toContain("Tomorrow, 09:00 New York");
    expect(page).toContain("In three days, 09:00 New York");
    expect(page).toContain("Replied by hand from the mailbox");
    expect(page).toContain("Spam");
    expect(page).not.toContain("The clinic did not write again");
    expect(html).toContain('<option value="Liam">Liam</option>');
  });

  test("a failed check shows the rule's sentence in red, never the words; a reply waiting in the inbox is said", () => {
    const failing = { ...view, draft: { ...view.draft!, checks: [...view.draft!.checks.slice(0, 2), { ...view.draft!.checks[2]!, ok: false }] } };
    const html = render(failing, { item });
    const page = text(html);
    expect(html).toMatch(/<li class="text-red-deep font-semibold">Names: The reply names no person/);
    expect(page).toContain("Names: The reply names no person: every capitalised word is a product, a place in the portal, a day, a month or the practice's own name.");
    expect(page).not.toContain("Names: passed");
    expect(page).toContain("Reply waiting for your Send since 2 Nov 2026, 15:31 UTC (draft 2).");
    expect(page).not.toContain(WAITING_NOT_READ);
    expect(text(render(view, { waitingRead: false }))).toContain(WAITING_NOT_READ);
  });

  test("a waiting reply that proposes a Settings change says it, in closed words, next to the draft; none says nothing", () => {
    const withAction = { ...item, packet: { ...item.packet!, facts: { ...item.packet!.facts, action: { label: "Website chat", value: "on", tier: "approval" as const, status: "pending" as const, senderVerified: true } } } };
    expect(text(render(view, { item: withAction }))).toContain("Proposed change: Website chat → on (made when you approve the reply).");
    expect(text(render(view, { item: withAction }))).not.toContain(SENDER_NOT_VERIFIED_WORDS);
    // A pending change offers the edit option that drops it; a settled one does not.
    expect(text(render(view, { item: withAction }))).toContain(DROP_CHANGE_LABEL);
    expect(render(view, { item: withAction })).toMatch(/<input[^>]*type="checkbox"[^>]*name="dropChange"/);
    const unverified = { ...withAction, packet: { ...withAction.packet, facts: { ...withAction.packet.facts, action: { ...withAction.packet.facts.action, senderVerified: false } } } };
    expect(text(render(view, { item: unverified }))).toContain(`Proposed change: Website chat → on (made when you approve the reply). ${SENDER_NOT_VERIFIED_WORDS}`);
    const done = { ...withAction, packet: { ...withAction.packet, facts: { ...withAction.packet.facts, action: { ...withAction.packet.facts.action, tier: "direct" as const, status: "done" as const } } } };
    expect(text(render(view, { item: done }))).toContain("Proposed change: Website chat → on (made).");
    expect(text(render(view, { item: done }))).not.toContain(DROP_CHANGE_LABEL);
    expect(text(render(view, { item }))).not.toContain("Proposed change");
  });

  test("the editor is the only text field, and the view has no element that could print inbound text", () => {
    const html = render(view, { item, clinics: [{ id: CLINIC, name: "Radiance Med Spa", synthetic: false }] });
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toMatch(/<input[^>]*type="text"/);
    expect(html).toMatch(/<input[^>]*name="code"/);
    const src = readFileSync(join(__dirname, "CaseView.tsx"), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src.match(/<textarea/g)).toHaveLength(1);
    // The messages' fields and the escalation never print: only ids from fixed lists are in them, and the view reads none of them as words.
    expect(src).not.toMatch(/\.fields\b/);
  });
});

describe("the other states", () => {
  test("a case with no clinic: no editor, no Save, Check, Send or Regenerate; Match offered with the clinics; the facts say why", () => {
    const unmatched: SupportCaseView = { ...view, case: { ...view.case, clinicId: null, clinicName: null, source: "email", state: "new" }, facts: null, draft: null };
    const html = render(unmatched, { clinics: [{ id: CLINIC, name: "Radiance Med Spa", synthetic: false }, { id: "4fa85f64-5717-4562-b3fc-2c963f66afa7", name: "Glow", synthetic: true }] });
    const page = text(html);
    expect(page).toContain("No clinic yet");
    expect(page).toContain(NO_CLINIC_FACTS);
    expect(page).toContain(NO_CLINIC_REPLY);
    expect(page).toContain("No draft yet.");
    expect(page).toContain(NO_DRAFT_FACTS);
    expect(html).not.toContain("<textarea");
    for (const label of ["Save draft", "Check", "Regenerate", "Send"]) expect(html).not.toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    expect(html).toMatch(/<button[^>]*>Match<\/button>/);
    expect(page).toContain(MATCH_NOTE);
    expect(page).toContain("Glow (synthetic)");
    expect(page).not.toContain("Approval passcode (or authenticator code)");
    // The clinics not read: Match is not offered, and the line says so.
    expect(text(render(unmatched, { clinics: null }))).toContain("The clinics could not be read, so Match is not offered.");
  });

  test("a case whose draft needs an edit: the failure's reason when the assistant wrote none, every control still offered", () => {
    const failed: SupportCaseView = {
      ...view,
      case: { ...view.case, state: "needs_edit" },
      draft: { ...view.draft!, version: null, text: null, checks: [], factsUsed: [], questionsForOps: [], confidence: null, failure: "model_unavailable" },
    };
    const page = text(render(failed));
    expect(page).toContain(STATE_NOTES.needs_edit);
    expect(page).toContain("No draft: the model is not available on this host (2 Nov 2026, 15:30 UTC).");
    expect(page).toContain(NO_DRAFT_FACTS);
    expect(page).toContain("No checks recorded yet.");
    for (const label of ["Save draft", "Check", "Regenerate", "Send"]) expect(render(failed)).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
  });

  test("a new case and one being drafted: Save draft and Check, but no Regenerate and no Send (apps/app refuses both)", () => {
    for (const state of ["new", "drafting"] as const) {
      const html = render({ ...view, case: { ...view.case, state }, draft: null });
      expect(html, state).toMatch(/<button[^>]*>Save draft<\/button>/);
      expect(html, state).toMatch(/<button[^>]*>Check<\/button>/);
      expect(html, state).not.toMatch(/<button[^>]*>Regenerate<\/button>/);
      expect(html, state).not.toMatch(/<button[^>]*>Send<\/button>/);
    }
    // Unless a reply already waits in the inbox: then Send decides it.
    expect(render({ ...view, case: { ...view.case, state: "new" } }, { item })).toMatch(/<button[^>]*>Send<\/button>/);
  });

  test("waiting on the clinic: the editor read-only, no Save, Check, Send or Regenerate, the last reply's time", () => {
    const html = render({ ...view, case: { ...view.case, state: "waiting_clinic", lastOutboundAt: "2026-11-02T16:00:00.000Z" } });
    const page = text(html);
    expect(page).toContain(STATE_NOTES.waiting_clinic);
    expect(page).toContain(WAITING_CLINIC_NOTE);
    expect(page).toContain("Our last reply went 2 Nov 2026, 16:00 UTC.");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    for (const label of ["Save draft", "Check", "Regenerate", "Send"]) expect(html).not.toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    for (const label of ["Snooze", "Assign", "Close"]) expect(html).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
  });

  test("snoozed: until when, Save draft and Check offered (a save wakes it), no Regenerate, no Send without a waiting reply", () => {
    const html = render({ ...view, case: { ...view.case, state: "snoozed", snoozedUntil: "2026-11-03T14:00:00.000Z" } });
    const page = text(html);
    expect(page).toContain("Snoozed until 3 Nov 2026, 14:00 UTC.");
    // Nothing on this host acts on the time yet (the watch is lane P7e's), so no line says the case comes back by itself.
    expect(page).not.toMatch(/comes back/i);
    expect(html).toMatch(/<button[^>]*>Save draft<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Regenerate<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Send<\/button>/);
  });

  test("closed: the reason, the editor read-only, and no control at all", () => {
    const html = render({ ...view, case: { ...view.case, state: "closed", closedAt: "2026-11-02T17:00:00.000Z", closedReason: "replied_by_hand" } });
    const page = text(html);
    expect(page).toContain(STATE_NOTES.closed);
    expect(page).toContain("Closed 2 Nov 2026: Replied by hand from the mailbox.");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    // The one button left is the clinic id's copy control; no control acts on the case.
    for (const label of ["Save draft", "Check", "Regenerate", "Send", "Snooze", "Assign", "Match", "Close"]) expect(html).not.toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(page).toContain("Copy id");
    expect(page).not.toContain("Approval passcode (or authenticator code)");
  });

  test("a part of the facts that could not be read says so, never a zero; hidden counts show when set", () => {
    const page = text(render({ ...view, case: { ...view.case, hidden: { numbers: 1, emails: 0, treatments: 2, clinical: 0 } }, facts: { days: 14, account: null, alerts: null, transcripts: null } }));
    expect(page).toContain(FACTS_NOT_READ.account);
    expect(page).toContain(FACTS_NOT_READ.alerts);
    expect(page).toContain(FACTS_NOT_READ.transcripts);
    expect(page).not.toContain("None.");
    expect(page).toContain("patient details hidden: 1 number, 2 treatments");
  });
});

describe("the controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  }
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  async function setValue(selector: string, value: string, event: "input" | "change" = "input"): Promise<void> {
    const node = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
    if (!node) throw new Error(`no field ${selector}`);
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    await act(async () => {
      setter?.call(node, value);
      node.dispatchEvent(new Event(event, { bubbles: true }));
    });
  }

  async function click(label: string): Promise<void> {
    await act(async () => {
      button(label).click();
    });
    await act(async () => {});
  }

  async function mount(actions: Partial<CaseActions>, v: SupportCaseView = view, options: { item?: SupportReplyApprovalItem | null; clinics?: { id: string; name: string; synthetic: boolean }[] | null } = {}): Promise<void> {
    await act(async () => {
      root.render(h(CaseView, { view: v, item: options.item ?? null, waitingRead: true, clinics: options.clinics ?? null, now: NOW, actions: { ...NEVER, ...actions } }));
    });
  }

  test("Save draft sends the case id and the editor's text, shows the version and the checks from the save", async () => {
    const onSave = vi.fn<CaseActions["onSave"]>(async () => ({
      ok: true,
      data: {
        ref: "HD-7F3KQ",
        draftVersion: 3,
        state: "needs_edit",
        approvalId: null,
        ok: false,
        checks: [{ id: "names", ok: false, rule: "The reply names no person." }],
        failed: ["The reply names no person."],
        auditRecorded: true,
      },
    }));
    await mount({ onSave });
    await setValue("textarea", "Hi Dana, forwarding is set.");
    await click("Save draft");
    expect(onSave).toHaveBeenCalledWith(CASE, "Hi Dana, forwarding is set.");
    expect(statuses()).toContain("Saved as draft 3. It fails: The reply names no person. Edit it and save again.");
    expect(container.textContent).toContain("Checks from the save just now");
    expect(container.textContent).toContain("Names: The reply names no person.");
    expect(container.textContent).not.toContain("Facts: passed");
  });

  test("Save draft with the drop option ticked asks apps/app to drop the pending change", async () => {
    const onSave = vi.fn<CaseActions["onSave"]>(async () => ({
      ok: true,
      data: { ref: "HD-7F3KQ", draftVersion: 3, state: "drafted", approvalId: null, ok: true, checks: [], failed: [], auditRecorded: true },
    }));
    const pending = { ...item, packet: { ...item.packet!, facts: { ...item.packet!.facts, action: { label: "Website chat", value: "on", tier: "approval" as const, status: "pending" as const, senderVerified: true } } } };
    await mount({ onSave }, view, { item: pending });
    await setValue("textarea", "Hi, a person at healdesk will look at website chat.");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="dropChange"]')!.click();
    });
    await click("Save draft");
    expect(onSave).toHaveBeenCalledWith(CASE, "Hi, a person at healdesk will look at website chat.", true);
  });

  test("Check sends the case id and the text, shows the rules from the check, and saves nothing; an empty editor disables both", async () => {
    const onCheck = vi.fn<CaseActions["onCheck"]>(async () => ({ ok: true, data: { ref: "HD-7F3KQ", ok: true, checks: view.draft!.checks, failed: [] } }));
    const onSave = vi.fn<CaseActions["onSave"]>();
    await mount({ onCheck, onSave });
    await click("Check");
    expect(onCheck).toHaveBeenCalledWith(CASE, DRAFT_TEXT);
    expect(onSave).not.toHaveBeenCalled();
    expect(statuses()).toContain("Every check passes.");
    expect(container.textContent).toContain("Checks from Check just now");
    await setValue("textarea", "");
    expect(button("Check").disabled).toBe(true);
    expect(button("Save draft").disabled).toBe(true);
    expect(container.textContent).toContain("0 of 1,500 characters");
  });

  test("Regenerate sends the case id and says the job writes the draft; an unaudited act says so", async () => {
    const onRegenerate = vi.fn<CaseActions["onRegenerate"]>(async () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "new", auditRecorded: false } }));
    await mount({ onRegenerate });
    await click("Regenerate");
    expect(onRegenerate).toHaveBeenCalledWith(CASE);
    expect(statuses()[0]).toBe(`A new draft is asked for: the case is new again, and the support-draft job writes the draft when it next runs. ${UNAUDITED}`);
  });

  test("Send runs nothing without six digits, asks once, sends the case id, the code and the editor's text, and says the reply went", async () => {
    const onSend = vi.fn<CaseActions["onSend"]>(async () => ({ ok: true, data: { status: "executed", outcomeCode: "sent", message: null, auditRecorded: true } }));
    await mount({ onSend }, view, { item });
    expect(button("Send").disabled).toBe(true);
    await setValue('input[name="code"]', "12345");
    expect(button("Send").disabled).toBe(true);
    await setValue('input[name="code"]', "123456");
    expect(button("Send").disabled).toBe(false);
    await setValue("textarea", `${DRAFT_TEXT} Thank you.`);
    await click("Send");
    expect(onSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain(SEND_CONFIRM);
    await click("Yes, send");
    expect(onSend).toHaveBeenCalledWith(CASE, "123456", `${DRAFT_TEXT} Thank you.`);
    expect(statuses()).toContain("Sent to the practice's one sign-in address.");
    // The code is spent: the field is cleared.
    expect(container.querySelector<HTMLInputElement>('input[name="code"]')!.value).toBe("");
  });

  test("a refused Send names the rule, never the words, and keeps the code field; a refused code says so", async () => {
    let answer: Awaited<ReturnType<CaseActions["onSend"]>> = {
      ok: true,
      data: { status: "failed", outcomeCode: "checks_failed", message: "Nothing was sent: the reply fails The reply names no person. Edit it and propose it again.", auditRecorded: true },
    };
    const onSend = vi.fn<CaseActions["onSend"]>(async () => answer);
    await mount({ onSend }, view, { item });
    await setValue('input[name="code"]', "654321");
    await click("Send");
    await click("Yes, send");
    const refused = statuses().find((s) => s.startsWith("Nothing was sent"));
    expect(refused).toBe("Nothing was sent: the reply fails The reply names no person. Edit it and propose it again.");
    expect(container.textContent).toContain("Approval passcode (or authenticator code)");
    expect(container.textContent).not.toContain("Dana");

    answer = { ok: true, data: { status: "code_refused", message: "That code is not right. Check the clock on your phone and try the next one. Nothing was changed." } };
    await click("Send");
    await click("Yes, send");
    expect(statuses()).toContain("That code is not right. Check the clock on your phone and try the next one. Nothing was changed.");

    answer = { ok: true, data: { status: "not_proposed", message: "Nothing was sent: the saved draft fails: The reply names no person. Edit it, press Save draft, then Send." } };
    await click("Send");
    await click("Yes, send");
    expect(statuses()).toContain("Nothing was sent: the saved draft fails: The reply names no person. Edit it, press Save draft, then Send.");
  });

  test("Snooze sends the choice and says until when; a picked day needs a day", async () => {
    const onSnooze = vi.fn<CaseActions["onSnooze"]>(async () => ({ ...moved(), data: { ...moved().data, until: "2026-11-03T14:00:00.000Z" } }));
    await mount({ onSnooze });
    await click("Snooze");
    expect(onSnooze).toHaveBeenCalledWith(CASE, { kind: "tomorrow" });
    expect(statuses()).toContain("Snoozed until 3 Nov 2026, 14:00 UTC.");
    await setValue('select[name="snooze"]', "three_days", "change");
    await click("Snooze");
    expect(onSnooze).toHaveBeenLastCalledWith(CASE, { kind: "three_days" });
    await setValue('select[name="snooze"]', "day", "change");
    expect(button("Snooze").disabled).toBe(true);
    const day = container.querySelector<HTMLInputElement>('input[name="day"]')!;
    expect(day.getAttribute("type")).toBe("date");
    // The bounds: tomorrow to 29 days on, in New York (NOW is 2 Nov 2026, 13:00 there).
    expect(day.getAttribute("min")).toBe("2026-11-03");
    expect(day.getAttribute("max")).toBe("2026-12-01");
    await setValue('input[name="day"]', "2026-11-10");
    await click("Snooze");
    expect(onSnooze).toHaveBeenLastCalledWith(CASE, { kind: "day", day: "2026-11-10" });
  });

  test("Assign sends the name picked from the people the view returned; Close asks once, then sends the reason picked", async () => {
    const onAssign = vi.fn<CaseActions["onAssign"]>(async () => moved("unchanged"));
    const onClose = vi.fn<CaseActions["onClose"]>(async () => moved());
    await mount({ onAssign, onClose });
    await setValue('select[name="label"]', "Liam", "change");
    await click("Assign");
    expect(onAssign).toHaveBeenCalledWith(CASE, "Liam");
    expect(statuses()).toContain("Already with Liam.");
    await setValue('select[name="reason"]', "duplicate", "change");
    await click("Close");
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Close this case? Closed is final.");
    await click("Yes, close");
    expect(onClose).toHaveBeenCalledWith(CASE, "duplicate");
    expect(statuses()).toContain("Closed.");
  });

  test("Match sends the clinic picked, on a case with no clinic", async () => {
    const onMatch = vi.fn<CaseActions["onMatch"]>(async () => moved());
    const unmatched: SupportCaseView = { ...view, case: { ...view.case, clinicId: null, clinicName: null, state: "new" }, facts: null, draft: null };
    await mount({ onMatch }, unmatched, { clinics: [{ id: CLINIC, name: "Radiance Med Spa", synthetic: false }, { id: "4fa85f64-5717-4562-b3fc-2c963f66afa7", name: "Glow", synthetic: true }] });
    await setValue('select[name="clinicId"]', "4fa85f64-5717-4562-b3fc-2c963f66afa7", "change");
    await click("Match");
    expect(onMatch).toHaveBeenCalledWith(CASE, "4fa85f64-5717-4562-b3fc-2c963f66afa7");
    expect(statuses()).toContain("Matched to Glow; the assistant drafts it when the support-draft job next runs.");
  });

  test("a failed call says the ops client's own sentence", async () => {
    const failure: OpsResult<never> = { ok: false, code: "refused", message: "The ops API refused this. The reason is in our logs; nothing was changed." };
    await mount({ onRegenerate: async () => failure });
    await click("Regenerate");
    expect(statuses()).toContain("The ops API refused this. The reason is in our logs; nothing was changed.");
    expect(ITEM).toHaveLength(36);
  });
});

describe("the view's source", () => {
  test("names the raw decision nowhere: Send goes through the page's action to the step-up wrapper", () => {
    for (const file of ["CaseView.tsx", "send-item.ts", "fixtures.ts"]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(/\bdecideApproval\b/);
    }
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toContain("decideApprovalWithCode(");
    expect(page).not.toMatch(/\bdecideApproval\b/);
  });
});

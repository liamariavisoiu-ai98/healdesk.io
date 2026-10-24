// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MARK_DONE_CONFIRM, RETELL_NOT_RECORDED, RUNS_NOTHING } from "@/components/admin/rights-words";
import type { OpsResult, RightsListView, RightsRowView } from "@/lib/admin/ops-client";

import { COPY_FAILED, EMPTY_WORDS, RightsTable, type CloseAction } from "./RightsTable";

/**
 * The Patient rights table (lane P6b): the sentence that the page runs
 * nothing; each open request with its clinic (linked to its Care tab), kind,
 * days, state chip and Retell step; "Copy command" copying the prepared
 * line and running nothing, and never drawn for a blocked row, which shows
 * apps/app's note instead; "Mark done" calling the close action with the
 * row's clinic and intake, and not drawn while an erasure's Retell step is
 * outstanding, the row saying why; a row with no intake saying how it
 * closes; the cut-off and unread warnings; empty and failed reads; and no
 * uuid on screen.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INTAKE = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const RECORD = "9a8b7c6d-1111-4222-8333-444455556666";
const ERASURE = "7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COMMAND = `bash infra/aws/scripts/run-task.sh patient-request ${CLINIC} access ops@healdesk.test 2026-10-21`;
const NEVER: CloseAction = async () => {
  throw new Error("a close ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const toRun: RightsRowView = {
  id: INTAKE,
  source: "intake",
  intakeId: INTAKE,
  recordId: null,
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  kind: "patient_request",
  askedFor: "access",
  verifiedVia: "unverified",
  receivedOn: "2026-10-21",
  dueOn: "2026-10-28",
  dueDerived: false,
  daysLeft: 4,
  state: "on_time",
  command: COMMAND,
  commandNote: null,
  retellStep: null,
  backupExpiresOn: null,
  closedOn: null,
};

const blocked: RightsRowView = {
  ...toRun,
  id: RECORD,
  intakeId: RECORD,
  kind: "erasure",
  askedFor: null,
  verifiedVia: "notice_address",
  dueOn: "2026-10-22",
  daysLeft: -2,
  state: "blocked",
  command: null,
  commandNote: "No portal route yet turns this request into a contact id",
};

/** An erasure intake whose deletion has run on the host and still owes its Retell step. */
const erasureRun: RightsRowView = {
  ...blocked,
  id: ERASURE,
  intakeId: ERASURE,
  recordId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  dueOn: "2026-10-27",
  daysLeft: 1,
  state: "due_soon",
  command: null,
  commandNote: null,
  retellStep: "outstanding",
  backupExpiresOn: "2026-11-25",
};

/** A deletion the host ran with no intake of its own. */
const erasureRecord: RightsRowView = {
  ...erasureRun,
  id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6e",
  source: "erasure_request",
  intakeId: null,
  recordId: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6e",
  verifiedVia: null,
  retellStep: "stamped",
  daysLeft: 0,
  state: "due_soon",
};

const list = (rows: RightsRowView[], more: Partial<RightsListView> = {}): OpsResult<RightsListView> => ({
  ok: true,
  data: { rows, count: rows.length, truncated: false, unreadClinics: 0, ...more },
});

function render(rights: OpsResult<RightsListView>): string {
  return renderToStaticMarkup(h(RightsTable, { rights, onClose: NEVER }));
}

describe("the table's words", () => {
  test("the sentence, then each row: clinic linked to Care, kind, days, state, Retell step, command, done; never a uuid", () => {
    const html = render(list([toRun, blocked, erasureRun, erasureRecord]));
    const page = text(html);
    expect(page.startsWith(RUNS_NOTHING)).toBe(true);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("A patient's own request, to pass on: to see their information");
    expect(page).toContain("21 Oct 2026");
    expect(page).toContain("28 Oct 2026");
    expect(page).toContain("4 business days left");
    expect(page).toContain("On time");
    expect(page).toContain("Blocked");
    expect(page).toContain("2 business days past");
    expect(page).toContain("Due soon");
    expect(page).toContain("1 business day left");
    expect(page).toContain("due today");
    expect(page).toContain("outstanding: record it on the clinic's Care tab");
    expect(page).toContain("recorded");
    expect(page).toContain("Copy command");
    expect(page).toContain(COMMAND);
    expect(page).toContain("Mark done");
    // The ids on screen are the clinic's name and the request's kind and dates: the one uuid is inside the command the owner runs.
    expect(text(html.replace(COMMAND, "")).match(UUID)).toBeNull();
    expect(page).not.toContain("patient_request");
    expect(page).not.toContain("on_time");
  });

  test("a patient's own request shows its command with apps/app's note that the practice's side is chased separately", () => {
    const runThenMark = "Run this on the host, then press Mark done here. The practice's own request is chased separately once it is recorded." as const;
    const page = text(render(list([{ ...toRun, commandNote: runThenMark }])));
    expect(page).toContain("Copy command");
    expect(page).toContain(COMMAND);
    expect(page).toContain(runThenMark);
    expect(page).toContain("Mark done");
  });

  test("a blocked row shows apps/app's note where its command would be, and no Copy command; the command text never appears for it", () => {
    const html = render(list([blocked]));
    const page = text(html);
    expect(page).toContain("No portal route yet turns this request into a contact id");
    expect(page).not.toContain("Copy command");
    expect(page).not.toContain("run-task.sh");
    // Blocked, with an intake and no Retell step owed: it can still be marked done once handled with the practice.
    expect(page).toContain("Mark done");
  });

  test("an erasure whose Retell step is outstanding has no Mark done and says why; a deletion with no intake says how it closes", () => {
    const run = text(render(list([erasureRun])));
    expect(run).toContain(RETELL_NOT_RECORDED);
    expect(run).not.toContain("Mark done");
    expect(run).toContain("Nothing to run: the deletion has run on the host.");
    const record = text(render(list([erasureRecord])));
    expect(record).toContain("Done once its Retell step is recorded");
    expect(record).not.toContain("Mark done");
    expect(record).not.toContain(RETELL_NOT_RECORDED);
  });

  test("empty, failed, cut off and clinics not read are each said, never as a zero", () => {
    expect(text(render(list([])))).toContain(EMPTY_WORDS);
    const failed = text(render({ ok: false, code: "failed", message: "The patient-rights requests could not be read." }));
    expect(failed).toContain("Could not read the patient-rights requests: The patient-rights requests could not be read.");
    expect(failed).not.toContain(EMPTY_WORDS);
    const cut = text(render(list([toRun], { count: 140, truncated: true })));
    expect(cut).toContain("Only the first 1 of 140 open requests are shown.");
    const unread = text(render(list([toRun], { unreadClinics: 2 })));
    expect(unread).toContain("2 clinic(s) could not be read, so their requests are missing below.");
    const nothing = text(render(list([], { unreadClinics: 1 })));
    expect(nothing).toContain("1 clinic(s) could not be read");
    expect(nothing).toContain(EMPTY_WORDS);
  });
});

describe("the two controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    writeText.mockClear();
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

  test("Copy command puts the row's line on the clipboard and runs nothing", async () => {
    const onClose = vi.fn<CloseAction>();
    await act(async () => {
      root.render(h(RightsTable, { rights: list([toRun]), onClose }));
    });
    await act(async () => {
      button("Copy command").click();
    });
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(button("Copied")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a clipboard that refuses is said, and the command stays on screen to select", async () => {
    writeText.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    await act(async () => {
      root.render(h(RightsTable, { rights: list([toRun]), onClose: NEVER }));
    });
    await act(async () => {
      button("Copy command").click();
    });
    await act(async () => {});
    expect(container.textContent).toContain(COPY_FAILED);
    expect(COPY_FAILED).toBe("Could not copy: select the command and copy it yourself.");
    expect(container.textContent).toContain(COMMAND);
    expect(button("Copy command")).toBeDefined();
  });

  test("Mark done on an intake linked to the request it became says the row stays open until the practice marks it received", async () => {
    const linked: RightsRowView = { ...toRun, recordId: RECORD, command: null, commandNote: null };
    const onClose = vi.fn<CloseAction>(async () => ({ ok: true, data: { outcome: "closed", status: "done", auditRecorded: true } }));
    await act(async () => {
      root.render(h(RightsTable, { rights: list([linked]), onClose }));
    });
    expect(container.textContent).toContain("Nothing to run: it is on the host, passed to the practice.");
    await act(async () => {
      button("Mark done").click();
    });
    expect(container.textContent).toContain("Closes this intake as done. The row stays open until the practice marks the request received.");
    await act(async () => {
      button("Yes, mark done").click();
    });
    await act(async () => {});
    expect(onClose).toHaveBeenCalledWith(CLINIC, INTAKE);
    expect(container.textContent).toContain("Marked done. The row stays open until the practice marks the request received.");
    // The row is still open after the re-read (its state follows the practice), and still says it.
    await act(async () => {
      root.render(h(RightsTable, { rights: list([linked]), onClose }));
    });
    expect(container.textContent).toContain("Marked done. The row stays open until the practice marks the request received.");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Mark done");
  });

  test("Mark done asks once, calls the close action with the row's clinic and intake, and says it; the line stays once the row has gone", async () => {
    const onClose = vi.fn<CloseAction>(async () => ({ ok: true, data: { outcome: "closed", status: "done", auditRecorded: true } }));
    await act(async () => {
      root.render(h(RightsTable, { rights: list([toRun]), onClose }));
    });
    await act(async () => {
      button("Mark done").click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain(MARK_DONE_CONFIRM);
    await act(async () => {
      button("Yes, mark done").click();
    });
    await act(async () => {});
    expect(onClose).toHaveBeenCalledWith(CLINIC, INTAKE);
    expect(container.textContent).toContain("Marked done.");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Mark done");
    // The page re-reads the list and the row is gone: the line stays.
    await act(async () => {
      root.render(h(RightsTable, { rights: list([]), onClose }));
    });
    expect(container.textContent).toContain("Marked done.");
    expect(container.textContent).toContain(EMPTY_WORDS);
  });

  test("a close the ops API refused is said on the row", async () => {
    const onClose = vi.fn<CloseAction>(async () => ({ ok: false, code: "refused", message: "The ops API refused this. The reason is in our logs; nothing was changed." }));
    await act(async () => {
      root.render(h(RightsTable, { rights: list([toRun]), onClose }));
    });
    await act(async () => {
      button("Mark done").click();
    });
    await act(async () => {
      button("Yes, mark done").click();
    });
    await act(async () => {});
    expect(container.textContent).toContain("The ops API refused this. The reason is in our logs; nothing was changed.");
    expect(button("Mark done")).toBeDefined();
  });
});

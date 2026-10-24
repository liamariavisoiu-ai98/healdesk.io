// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RecordRequestInput } from "./record-input";
import { NO_CLINICS, RecordRequestForm, type ClinicChoice, type RecordAction } from "./RecordRequestForm";

/**
 * The Patient rights page's "Record a request" form (lane P6b): every field a
 * choice from a list or a day, nothing typed; the request key a uuid minted
 * once when the form opens and sent with every submit, so a double click
 * records once; a new key only after a request was recorded; the outcome in
 * one line; and no form at all when the clinic list could not be read.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER = "6d1ffee1-2222-4d3b-8b9c-2a3f4e5d6c7b";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TODAY = "2026-10-24";
const clinics: ClinicChoice[] = [
  { id: CLINIC, name: "Radiance Med Spa", synthetic: false },
  { id: OTHER, name: "Demo Clinic", synthetic: true },
];
const NEVER: RecordAction = async () => {
  throw new Error("a record ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the form's words", () => {
  test("the fields, from the lists, with the submit named Record a request and the synthetic clinic marked", () => {
    const html = renderToStaticMarkup(h(RecordRequestForm, { clinics, today: TODAY, onRecord: NEVER }));
    const page = text(html);
    expect(page).toContain("Record a request");
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Demo Clinic (synthetic)");
    expect(page).toContain("Clinic");
    expect(page).toContain("What it asks for");
    expect(page).toContain("Day received");
    expect(page).toContain("How it was verified");
    expect(page).toContain("Erasure");
    expect(page).toContain("A patient's own request, to pass on");
    expect(page).toContain("It came from the clinic's notice address");
    // Not a patient's own request yet, so nothing asks what the patient asked for.
    expect(page).not.toContain("What the patient asked for");
    expect(html).toContain(`value="${TODAY}"`);
    expect(html).toContain(`max="${TODAY}"`);
    expect(html).not.toContain("<textarea");
    expect(html).not.toMatch(/type="text"/);
    const key = /name="requestKey" value="([^"]+)"/.exec(html)?.[1];
    expect(key).toMatch(UUID);
  });

  test("with no clinic list there is no form, and the one sentence says why", () => {
    for (const none of [null, []]) {
      const html = renderToStaticMarkup(h(RecordRequestForm, { clinics: none, today: TODAY, onRecord: NEVER }));
      expect(text(html)).toContain(NO_CLINICS);
      expect(html).not.toContain("<form");
    }
  });
});

describe("the request key and the outcome", () => {
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

  async function choose(name: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    if (!select) throw new Error(`no select "${name}"`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function submit(): Promise<void> {
    const form = container.querySelector("form");
    if (!form) throw new Error("no form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});
  }
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  test("the key is minted once when the form opens and sent with each submit; a recorded request mints the next", async () => {
    let answer: Awaited<ReturnType<RecordAction>> = {
      ok: true,
      data: { outcome: "already_recorded", id: OTHER, dueOn: "2026-11-04", auditRecorded: true },
    };
    const record = vi.fn<RecordAction>(async () => answer);
    await act(async () => {
      root.render(h(RecordRequestForm, { clinics, today: TODAY, onRecord: record }));
    });
    await choose("clinicId", OTHER);
    await choose("kind", "patient_request");
    expect(container.textContent).toContain("What the patient asked for");
    await choose("askedFor", "deletion");
    await choose("verifiedVia", "phone_confirmed");

    await submit();
    await submit();
    expect(record).toHaveBeenCalledTimes(2);
    const [first, second] = record.mock.calls.map((c) => c[0] as RecordRequestInput);
    expect(first).toEqual({ clinicId: OTHER, requestKey: first!.requestKey, kind: "patient_request", receivedOn: TODAY, verifiedVia: "phone_confirmed", askedFor: "deletion" });
    expect(first!.requestKey).toMatch(UUID);
    expect(second!.requestKey).toBe(first!.requestKey);
    expect(statuses()).toContain("Already recorded from this form, so nothing was added. It is due on 4 Nov 2026.");

    answer = { ok: true, data: { outcome: "recorded", id: OTHER, dueOn: "2026-10-30", auditRecorded: true } };
    await submit();
    expect((record.mock.calls[2]![0] as RecordRequestInput).requestKey).toBe(first!.requestKey);
    expect(statuses()).toContain("Recorded. It is due on 30 Oct 2026.");
    // Recorded: the form is a fresh one, so the next request is a new key.
    await submit();
    const fourth = record.mock.calls[3]![0] as RecordRequestInput;
    expect(fourth.requestKey).toMatch(UUID);
    expect(fourth.requestKey).not.toBe(first!.requestKey);
    // The choices stay: the next request of the same kind on the same day is one more row.
    expect(fourth).toMatchObject({ clinicId: OTHER, kind: "patient_request", askedFor: "deletion" });
  });

  test("a refusal and a failed call are each said in one line, and change nothing about the key", async () => {
    let answer: Awaited<ReturnType<RecordAction>> = { ok: true, data: { status: "refused", message: "A request cannot be received after today." } };
    const record = vi.fn<RecordAction>(async () => answer);
    await act(async () => {
      root.render(h(RecordRequestForm, { clinics, today: TODAY, onRecord: record }));
    });
    await submit();
    expect(statuses()).toContain("A request cannot be received after today.");
    answer = { ok: false, code: "unreachable", message: "Could not reach the ops API. It probably did not carry this out, but reload and check before trying again." };
    await submit();
    expect(statuses()).toContain("Could not reach the ops API. It probably did not carry this out, but reload and check before trying again.");
    const keys = record.mock.calls.map((c) => (c[0] as RecordRequestInput).requestKey);
    expect(new Set(keys).size).toBe(1);
    // An erasure sends nothing about what was asked.
    expect(record.mock.calls[0]![0]).toEqual({ clinicId: CLINIC, requestKey: keys[0], kind: "erasure", receivedOn: TODAY, verifiedVia: "notice_address" });
  });
});

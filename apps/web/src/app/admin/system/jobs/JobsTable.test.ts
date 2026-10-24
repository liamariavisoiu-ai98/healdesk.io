import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OpsJob } from "@/lib/admin/ops-client";

import { JobsTable } from "./JobsTable";

/**
 * The owner could not switch jobs on (24 October 2026): the column headed
 * "Switch" held a chip that only said "off" and the real button was the last
 * column. These pin that the Switch cell is the control, comes straight after
 * the job's name, says state and action, and that a long result note cannot
 * carry it out of view.
 */

const base: OpsJob = {
  name: "billing-notices",
  cadence: "every minute",
  enabled: false,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunNote: null,
  runningSince: null,
  phaseTwo: false,
};

function render(jobs: OpsJob[]): string {
  const markup = renderToStaticMarkup(
    createElement(JobsTable, {
      jobs: { ok: true, data: jobs },
      onToggle: async () => ({ ok: true as const, data: { status: "toggled", auditRecorded: true } as never }),
    }),
  );
  return markup.replace(/<!-- -->/g, "");
}

function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>.*?<\/button>/g)].map((m) => m[0]);
}

describe("Jobs table switch", () => {
  test("an off job has one enabled button saying state and action, not a status chip", () => {
    const html = render([base]);
    const [button] = buttons(html);
    expect(buttons(html)).toHaveLength(1);
    expect(button).toContain("Off · Turn on");
    expect(button).not.toContain('disabled=""');
    expect(html).not.toMatch(/>off</);
  });

  test("an on job says On · Turn off", () => {
    expect(buttons(render([{ ...base, enabled: true }]))[0]).toContain("On · Turn off");
  });

  test("a phase-two job that is off shows a disabled Phase two button", () => {
    const [button] = buttons(render([{ ...base, name: "attribution", phaseTwo: true }]));
    expect(button).toContain("Off · Phase two");
    expect(button).toContain('disabled=""');
  });

  test("the control is the first cell after the name and there is no trailing control column", () => {
    const html = render([base]);
    const row = html.slice(html.indexOf("<tbody>"));
    expect(row.indexOf("<button")).toBeLessThan(row.indexOf("every minute"));
    expect(html).not.toContain("Toggle");
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(5);
  });

  test("a long result note is clamped and carries its full text in a title", () => {
    const note = "x".repeat(900);
    const html = render([{ ...base, lastRunStatus: "ok", lastRunNote: note }]);
    expect(html).toContain("line-clamp-2");
    expect(html).toContain(`title="${note}"`);
  });
});

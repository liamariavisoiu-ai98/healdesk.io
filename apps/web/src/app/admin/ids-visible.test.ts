import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { CopyValue } from "./demos/DemoBuilder";
import { ClinicId } from "./ops/OpsConsole";

/**
 * Ids an operator has to quote (run-task.sh, the db-apply and db-query
 * workflows) are on screen as text, selectable, with a copy button, not only
 * inside a link address. Rendered to static markup.
 */

const CLINIC = "259b4543-6709-495e-b804-692cc37c9e97";

describe("ids on the admin pages", () => {
  test("a clinic card prints the clinic's id as selectable text with a copy control", () => {
    const html = renderToStaticMarkup(createElement(ClinicId, { id: CLINIC }));
    expect(html).toContain("Clinic id");
    expect(html).toContain(`<code class="font-mono select-all">${CLINIC}</code>`);
    expect(html).toContain("Copy id");
  });

  test("a demo row prints the demo's own id, labelled as a demo's", () => {
    const html = renderToStaticMarkup(createElement(CopyValue, { label: "Demo id", value: "demo-123" }));
    expect(html).toContain("Demo id");
    expect(html).toContain('<code class="font-mono select-all">demo-123</code>');
    expect(html).toContain(">Copy<");
  });
});

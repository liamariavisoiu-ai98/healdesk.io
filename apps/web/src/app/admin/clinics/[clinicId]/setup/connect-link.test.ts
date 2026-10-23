import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ConnectLink } from "./ConnectLink";

/**
 * The phase-two connect link on the Setup tab: behind a disclosure that
 * says it is not used in v1; the button's verb follows the connection
 * state; a clinic with an unused link is warned that another leaves both
 * live; a state that was not read says so rather than guessing.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the connect link", () => {
  test("is a closed disclosure marked phase two, with the state in words", () => {
    const html = renderToStaticMarkup(h(ConnectLink, { clinicId: CLINIC, connection: "none", onIssue: NEVER }));
    expect(html).toMatch(/^<details/);
    expect(html).not.toContain("<details open");
    const page = text(html);
    expect(page).toContain("Phase two: read-back connect link");
    expect(page).toContain("Not used in v1.");
    expect(page).toContain("Today: no credential and no link.");
    expect(page).toContain("Issue connect link");
    expect(page).not.toContain("already has an unused link");
  });

  test("an outstanding link changes the verb and warns about two live credentials", () => {
    const page = text(renderToStaticMarkup(h(ConnectLink, { clinicId: CLINIC, connection: "outstanding", onIssue: NEVER })));
    expect(page).toContain("Issue another link");
    expect(page).toContain("This clinic already has an unused link. Issuing another leaves both live until they are used or expire.");
    expect(text(renderToStaticMarkup(h(ConnectLink, { clinicId: CLINIC, connection: "connected", onIssue: NEVER })))).toContain("Issue another link");
  });

  test("a state that was not read is not guessed", () => {
    const page = text(renderToStaticMarkup(h(ConnectLink, { clinicId: CLINIC, connection: null, onIssue: NEVER })));
    expect(page).not.toContain("Today:");
    expect(page).toContain("Issue connect link");
    expect(text(renderToStaticMarkup(h(ConnectLink, { clinicId: CLINIC, connection: "unknown", onIssue: NEVER })))).toContain("Today: not checked on this read.");
  });
});

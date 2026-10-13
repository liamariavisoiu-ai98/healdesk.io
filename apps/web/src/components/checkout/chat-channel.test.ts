import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { choosePackage, type FunnelState, initialFunnel } from "@/lib/checkout/funnel";

import { PackageStep } from "./PackageStep";

/**
 * Which chat a clinic buys.
 *
 * Until 13 October 2026 a "Web OR Meta" card asked a second question, which
 * chat channel, and Meta alone waited on a catalog flag. Both are gone: the
 * chat is the package (AYA Web Chat or AYA Meta Chat, which includes the
 * website), and Meta is never sold without website chat. What is left to pin
 * is what a practice with no website can choose: every package but the two
 * with Web Chat, each closed one saying why.
 *
 * Rendered to static markup, as the other checkout tests read their
 * components: the question is what the buyer can choose and what they are
 * told.
 */

const noop = () => undefined;

function markup(state: FunnelState): string {
  return renderToStaticMarkup(
    h(PackageStep, {
      state,
      onPackage: noop,
      onSteps: noop,
      onInterval: noop,
      onContinue: noop,
    }),
  );
}

/** The package radio for one package id. */
function inputFor(html: string, id: string): string {
  const match = html.match(new RegExp(`<input(?=[^>]*name="package")(?=[^>]*value="${id}")[^>]*>`));
  if (!match) throw new Error(`No package input for ${id}`);
  return match[0];
}

const PACKAGE_IDS = ["voice", "webchat", "metachat", "voice-webchat", "voice-metachat"];

describe("the chat is the package", () => {
  test("five packages, each its own answer, and no second chat question", () => {
    const html = markup(initialFunnel());
    for (const id of PACKAGE_IDS) expect(inputFor(html, id)).not.toContain("disabled");
    expect(html).not.toContain("chatChannelChoice");
    expect(html).not.toContain("Which chat channel?");
    expect(html).not.toContain("waits for Meta to approve our app");
  });

  test("the package chosen is the one checked", () => {
    const html = markup(choosePackage(initialFunnel(), "metachat"));
    expect(inputFor(html, "metachat")).toContain("checked");
    expect(inputFor(html, "webchat")).not.toContain("checked");
  });
});

describe("with no website", () => {
  test("the packages with Web Chat cannot be picked, and say why; Meta Chat can", () => {
    const html = markup({ ...initialFunnel(), noWebsite: true });
    expect(inputFor(html, "webchat")).toContain("disabled");
    expect(inputFor(html, "voice-webchat")).toContain("disabled");
    for (const id of ["voice", "metachat", "voice-metachat"]) {
      expect(inputFor(html, id), id).not.toContain("disabled");
    }
    expect(html.match(/Needs a website/g)).toHaveLength(2);
  });
});

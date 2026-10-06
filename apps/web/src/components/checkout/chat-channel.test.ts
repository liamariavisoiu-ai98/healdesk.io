import { getPricingCard, META_SOLD_ALONE, type PricingCard } from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ChatChannelField } from "./CheckoutFlow";

/**
 * The chat-channel question on a "Web OR Meta" card.
 *
 * Meta on its own is on sale (catalog, META_SOLD_ALONE, opened 5 October
 * 2026), so both options can be chosen on both cards and nothing is
 * explained away. When the flag is closed, the Meta option on the chatbot
 * card is shown disabled with one line saying why, and /api/checkout refuses
 * the package; these tests then change with the flag.
 *
 * Rendered to static markup, the way the agreement copy link is: the question
 * is what the buyer can choose and what they are told.
 */

function card(id: string): PricingCard {
  const found = getPricingCard(id);
  if (!found) throw new Error(`No pricing card ${id}`);
  return found;
}

function markup(
  id: string,
  value: "web" | "meta" = "web",
  extra: { metaSoldAlone?: boolean; noWebsite?: boolean } = {},
): string {
  return renderToStaticMarkup(
    h(ChatChannelField, { card: card(id), value, onChange: () => undefined, ...extra }),
  );
}

/** The <input> of each option, by the label text that follows it. */
function inputFor(html: string, label: string): string {
  const match = html.match(new RegExp(`(<input[^>]*>)<span[^>]*>${label}</span>`));
  if (!match) throw new Error(`No option labelled ${label}`);
  return match[1]!;
}

describe("the Web OR Meta Chatbot card, with Meta sold alone", () => {
  test("the flag this is written against", () => {
    expect(META_SOLD_ALONE).toBe(true);
  });

  test("both options can be chosen and nothing is explained away", () => {
    const html = markup("chat-single", "meta");
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).not.toContain("disabled");
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).toContain("checked");
    expect(inputFor(html, "Website")).not.toContain("disabled");
    expect(html).not.toContain("waits for Meta to approve our app");
  });
});

describe("Meta beside the phone stays on sale", () => {
  test("both options can be chosen and nothing is explained away", () => {
    const html = markup("chat-voice", "meta");
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).not.toContain("disabled");
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).toContain("checked");
    expect(inputFor(html, "Website")).not.toContain("disabled");
    expect(html).not.toContain("waits for Meta to approve our app");
  });
});

/**
 * The flag closed, as it will be if Meta's App Review slips past the first
 * campaign: the field takes the flag as a prop so this branch is pinned now,
 * not discovered then.
 */
describe("with Meta not sold alone", () => {
  test("the chatbot card keeps the Meta option on screen, disabled, and says why", () => {
    const html = markup("chat-single", "web", { metaSoldAlone: false });
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).toContain("disabled");
    expect(inputFor(html, "Website")).not.toContain("disabled");
    expect(inputFor(html, "Website")).toContain("checked");
    expect(html).toContain(
      "On its own, Instagram, Messenger + WhatsApp waits for Meta to approve our app, so this package is website chat for now.",
    );
  });

  test("beside the phone, Meta is still a choice", () => {
    const html = markup("chat-voice", "meta", { metaSoldAlone: false });
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).not.toContain("disabled");
    expect(html).not.toContain("waits for Meta to approve our app");
  });
});

describe("with no website", () => {
  test("website chat cannot be picked, and the option says why", () => {
    const html = markup("chat-voice", "meta", { noWebsite: true });
    expect(inputFor(html, "Website")).toContain("disabled");
    expect(inputFor(html, "Instagram, Messenger \\+ WhatsApp")).not.toContain("disabled");
    expect(html).toContain("Needs a website");
  });
});

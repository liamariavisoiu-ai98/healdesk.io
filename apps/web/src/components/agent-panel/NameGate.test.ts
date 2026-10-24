import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { NameGate } from "./NameGate";
import { VoiceCard } from "./VoiceCard";

/**
 * The start of a personalised demo call, as static markup: which of the
 * pill's three states is showing, and that the homepage's card does not ask.
 * The transitions between them are CSS and the timers are the browser's; what
 * can be held here is the words, the labels and the state names.
 */

const gate = (props: Partial<Parameters<typeof NameGate>[0]>) =>
  renderToStaticMarkup(
    createElement(NameGate, {
      name: null,
      waitingText: "AYA will be with you in a moment",
      onSubmit: () => {},
      introDone: false,
      onIntroDone: () => {},
      ...props,
    }),
  );

describe("NameGate", () => {
  test("opens on Let's start with a loading icon", () => {
    const html = gate({});
    expect(html).toContain('data-phase="loading"');
    expect(html).toContain("Let’s start");
    expect(html).toContain("name-spinner");
  });

  test("asks for the name, with a label, a placeholder and a way to submit", () => {
    const html = gate({ introDone: true });
    expect(html).toContain('data-phase="ask"');
    expect(html).toContain("What’s your name?");
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>What\u2019s your name\?<\/label>/);
    expect(html).toContain('autoComplete="given-name"');
    expect(html).toContain('aria-label="Continue"');
  });

  test("once it has the name, closes round the waiting line with moving dots", () => {
    const html = gate({ name: "Sam", waitingText: "AYA will call you in a moment" });
    expect(html).toContain('data-phase="waiting"');
    expect(html).toContain("AYA will call you in a moment");
    expect(html).toContain("name-dots");
  });
});

describe("VoiceCard", () => {
  const card = (askName: boolean) =>
    renderToStaticMarkup(
      createElement(VoiceCard, {
        name: "Peachy Studio",
        callRoute: "/api/demo/x/retell",
        demoLine: null,
        ringNote: "One demo call.",
        askName,
      }),
    );

  test("the homepage's card goes straight to the button, as it always did", () => {
    expect(card(false)).toContain("Talk now");
    expect(card(false)).not.toContain("name-pill");
  });

  test("a personalised demo's card holds the button back until the name is asked", () => {
    const html = card(true);
    expect(html).not.toContain("Talk now");
    // The server cannot know a remembered name, so it draws room for the pill, not the question.
    expect(html).not.toContain("What’s your name?");
  });
});

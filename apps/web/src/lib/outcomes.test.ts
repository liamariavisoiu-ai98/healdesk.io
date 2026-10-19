import { describe, expect, test } from "vitest";

import { OUTCOMES } from "@/lib/outcomes";

/**
 * The homepage's outcomes say only what the product does.
 *
 * The Instagram outcome said "the whole thread is waiting in Conversations
 * when your team opens on Monday" until 19 October 2026. By design the words
 * of a Meta conversation are never kept (Meta signs no BAA): the portal's
 * Conversations shows when each person last wrote and what came of it, and
 * says "Messages on Instagram aren't kept" on the conversation itself
 * (apps/app conversations/[id]/page.tsx).
 */
const META = /\b(?:Instagram|Messenger|WhatsApp|DMs?)\b/;

describe("the outcomes keep no Meta conversation the product does not keep", () => {
  const meta = OUTCOMES.filter((o) => META.test(`${o.title} ${o.line} ${o.detail}`));

  test("there is a Meta outcome to read", () => {
    expect(meta.map((o) => o.id)).toContain("one-voice");
  });

  test.each(meta.map((o) => [o.id, o] as const))("%s", (_id, outcome) => {
    const words = `${outcome.line} ${outcome.detail}`;
    // No thread, message or transcript said to be in, or waiting in, the portal.
    expect(words).not.toMatch(
      /\b(?:thread|messages?|conversation|transcript|words)\b[^.]{0,60}\b(?:in|inside) (?:your )?(?:Conversations|the portal|your portal)\b/i,
    );
    expect(words).not.toMatch(/\bwaiting in Conversations\b/i);
  });

  test("the Instagram outcome says where the thread is, and that we keep none of it", () => {
    const detail = OUTCOMES.find((o) => o.id === "one-voice")!.detail;
    expect(detail).toContain("we keep none of the words");
    expect(detail).toContain("the thread stays in your own Instagram inbox");
  });
});

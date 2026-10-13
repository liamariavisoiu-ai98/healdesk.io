import { describe, expect, it } from "vitest";

import { parseRemembered, REMEMBER_MS } from "./remembered";
import { DEMO_LIFETIME_MS } from "./sessions";

describe("the visitor's remembered demo", () => {
  it("is offered for as long as a demo lives", () => {
    expect(REMEMBER_MS).toBe(DEMO_LIFETIME_MS);
  });

  it("is offered only while its week lasts", () => {
    const raw = JSON.stringify({ url: "https://healdesk.io/demo/peachy-studio-k7q2mz9xwa", host: "peachystudio.com", until: 2_000 });
    expect(parseRemembered(raw, 1_000)).toEqual({ url: "https://healdesk.io/demo/peachy-studio-k7q2mz9xwa", host: "peachystudio.com", until: 2_000 });
    expect(parseRemembered(raw, 2_000)).toBeNull();
  });

  it("offers nothing but a link to one of our demo pages, whatever the storage holds", () => {
    const at = (url: string) => parseRemembered(JSON.stringify({ url, host: "x.com", until: 9e15 }), 0);
    expect(at("https://evil.example/phish")).toBeNull();
    expect(at("javascript:alert(1)")).toBeNull();
    expect(at("https://healdesk.io/demo/a/../../admin")).toBeNull();
    expect(parseRemembered("not json", 0)).toBeNull();
    expect(parseRemembered(null, 0)).toBeNull();
  });
});

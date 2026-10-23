import { describe, expect, test } from "vitest";

import { GET } from "./route";

const ask = (headers: Record<string, string> = {}) => GET(new Request("https://healdesk.io/api/visitor-place", { headers }));

describe("GET /api/visitor-place", () => {
  test("names the town Vercel found, and is never cached", async () => {
    const res = await ask({ "x-vercel-ip-city": "San%20Diego" });
    expect(await res.json()).toEqual({ place: "San Diego" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("falls back to the country when the lookup has no city", async () => {
    expect(await (await ask({ "x-vercel-ip-country": "NO" })).json()).toEqual({ place: "Norway" });
  });

  test("says null off Vercel, so the screen keeps saying Current Location", async () => {
    expect(await (await ask()).json()).toEqual({ place: null });
  });
});

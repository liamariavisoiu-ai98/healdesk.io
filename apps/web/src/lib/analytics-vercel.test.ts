import { describe, expect, it } from "vitest";

import { vercelBeforeSend } from "./analytics-vercel";

const view = (url: string) => ({ type: "pageview" as const, url });

describe("Vercel Web Analytics beforeSend", () => {
  it("sends an ordinary page view unchanged", () => {
    expect(vercelBeforeSend(view("https://healdesk.io/pricing"), true)).toEqual(view("https://healdesk.io/pricing"));
  });

  it("sends nothing for a visitor who opted out or sends Global Privacy Control", () => {
    expect(vercelBeforeSend(view("https://healdesk.io/pricing"), false)).toBeNull();
  });

  it("sends nothing from the admin console or a personalised demo", () => {
    expect(vercelBeforeSend(view("https://healdesk.io/admin/ops"), true)).toBeNull();
    expect(vercelBeforeSend(view("https://healdesk.io/admin"), true)).toBeNull();
    expect(vercelBeforeSend(view("https://healdesk.io/demo/lumen-clinic-4vummpd29h"), true)).toBeNull();
  });

  it("drops the query string and fragment on the purchase pages", () => {
    expect(vercelBeforeSend(view("https://healdesk.io/get-started?lead=abc&plan=voice#top"), true)).toEqual(
      view("https://healdesk.io/get-started"),
    );
    expect(vercelBeforeSend(view("https://healdesk.io/start?token=secret"), true)).toEqual(view("https://healdesk.io/start"));
    expect(vercelBeforeSend(view("https://healdesk.io/welcome?ref=pi_123"), true)).toEqual(view("https://healdesk.io/welcome"));
  });

  it("keeps other pages' query strings as they were, and the event type", () => {
    expect(vercelBeforeSend({ type: "event" as const, url: "https://healdesk.io/pricing?utm=x" }, true)).toEqual({
      type: "event",
      url: "https://healdesk.io/pricing?utm=x",
    });
  });

  it("drops an event whose URL cannot be read", () => {
    expect(vercelBeforeSend(view("http://[bad"), true)).toBeNull();
  });
});

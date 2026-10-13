import { DEMO_SETUP_CREDIT_HOURS } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoUnsubscribeUrl, setupUnsubscribeUrl, verifyUnsubscribeTarget } from "@/lib/email";
import { markUnsubscribed, recordDemoUnlock } from "@/lib/leads";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";
import { site } from "@/lib/site";

import { demoFingerprint } from "./audit";
import { releaseHeldDemo } from "./build";
import { demoCheckout } from "./checkout";
import { cancelOfferEndedEmail, offerEndedEmail, scheduleOfferEndedEmail } from "./offer-ended";
import { normalizeProfile } from "./profile";
import {
  __resetDemoCacheForTests,
  createDemoSession,
  demoOfferEndsAt,
  getDemoSession,
  isDemoActive,
  isDemoOfferOpen,
  SELF_SERVE_DEMO,
  updateDemoSession,
  type DemoSession,
} from "./sessions";

/**
 * The demo's setup offer and the email that says it has ended
 * (lib/demo/offer-ended.ts), with Resend stubbed.
 *
 * What these pin: the offer lasts 48 hours from the request while the demo
 * lives its week; the email names the share the demo carried and has its
 * three ways on, the first a blank email to the team; it is scheduled for the
 * offer's last moment, once, only to an address that has not opted out, on a
 * demo nobody bought; a purchase calls it off; and its opt-out is its own.
 */

const HOUR = 60 * 60 * 1000;
const CREATED = new Date("2026-10-13T09:00:00.000Z");

type Sent = { url: string; body: Record<string, unknown> | null; idempotencyKey: string | null };

let sent: Sent[];
let refuse = false;

const resend = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.resend.com/")) throw new Error(`unexpected fetch ${String(url)}`);
  if (refuse) return new Response("already sent", { status: 422 });
  const headers = new Headers(init?.headers);
  sent.push({
    url: String(url),
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    idempotencyKey: headers.get("Idempotency-Key"),
  });
  return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
});

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
  vi.stubGlobal("fetch", resend);
  sent = [];
  refuse = false;
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

/** A demo that shipped three minutes after it was asked for, as the audit leaves it. */
async function shipped(input: { createdBy?: string; leadEmail?: string | null; clinicName?: string } = {}): Promise<DemoSession> {
  const created = await createDemoSession(
    {
      clinicName: input.clinicName ?? "Radiance Med Spa",
      websiteUrl: "https://radiancemedspa.com/",
      leadEmail: input.leadEmail === undefined ? "owner@radiancemedspa.com" : (input.leadEmail ?? undefined),
      createdBy: input.createdBy,
    },
    CREATED,
  );
  const ready = await updateDemoSession(created.slug, {
    status: "ready",
    readyAt: new Date(CREATED.getTime() + 3 * 60_000),
    auditVerdict: "pass",
  });
  return ready!;
}

const at = (hours: number) => new Date(CREATED.getTime() + hours * HOUR);

describe("the demo's setup offer", () => {
  it("lasts 48 hours from the request, while the demo itself lives its week", async () => {
    const demo = await shipped();
    expect(demoOfferEndsAt(demo).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(isDemoOfferOpen(demo, at(47.99).getTime())).toBe(true);
    expect(isDemoOfferOpen(demo, at(48).getTime())).toBe(false);
    expect(isDemoActive(demo, at(48).getTime())).toBe(true);
    expect(isDemoActive(demo, at(7 * 24 - 0.01).getTime())).toBe(true);
  });

  it("never outlives the demo, if its expiry was shortened by hand", async () => {
    const demo = await shipped();
    const cut = (await updateDemoSession(demo.slug, { expiresAt: at(10) }))!;
    expect(demoOfferEndsAt(cut).toISOString()).toBe(at(10).toISOString());
    expect(isDemoOfferOpen(cut, at(11).getTime())).toBe(false);
  });

  it("is what the purchase shows: the offer's end while it holds, nothing after", async () => {
    const demo = await shipped({ createdBy: SELF_SERVE_DEMO });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(30));
    expect(demoCheckout(demo)).toMatchObject({ offerEndsAt: "2026-10-15T09:00:00.000Z", offerPercent: 30 });
    vi.setSystemTime(at(49));
    expect(demoCheckout(demo).offerEndsAt).toBeUndefined();
  });
});

describe("the email that says it ended", () => {
  it("names the share the demo carried: 30% from a homepage demo, 50% from one we built", async () => {
    expect(offerEndedEmail(await shipped({ createdBy: SELF_SERVE_DEMO })).subject).toBe(
      "Your custom 30% discount just expired — chat with our team",
    );
    expect(offerEndedEmail(await shipped({ createdBy: "ops@healdesk.io" })).subject).toBe(
      "Your custom 50% discount just expired — chat with our team",
    );
  });

  it("has its three buttons in order: a blank email to the team, a call, the purchase", async () => {
    const demo = await shipped();
    const { html, text } = offerEndedEmail(demo);
    const hrefs = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]!.replace(/&amp;/g, "&")]);
    expect(hrefs.slice(0, 3)).toEqual([
      ["Chat with our team", `mailto:${site.email}?subject=About%20the%20Radiance%20Med%20Spa%20demo`],
      ["Book a demo", site.meeting.url],
      [`Get ${site.agent} now`, `${site.url}/demo/${demo.slug}/onboard`],
    ]);
    // The body is theirs to write: the mailto fills in the subject and nothing else.
    expect(hrefs[0]![1]).not.toContain("body=");
    // The text part stands on its own, with every way on.
    expect(text).toContain(site.email);
    expect(text).toContain(site.meeting.url);
    expect(text).toContain(`/demo/${demo.slug}/onboard`);
  });

  it("says the demo still works, and carries the opt-out and the postal address", async () => {
    const demo = await shipped();
    const { html, text } = offerEndedEmail(demo);
    expect(text).toContain("Your demo keeps working until Tuesday, October 20");
    for (const part of [html, text]) {
      expect(part).toContain(demoUnsubscribeUrl(demo.id).replace(/&/g, part === html ? "&amp;" : "&"));
      expect(part).toMatch(/Delaware|DE \d{5}|, [A-Z]{2} \d{5}/);
    }
  });

  it("escapes a clinic name read off a website before it goes into HTML", async () => {
    const demo = await shipped({ clinicName: `Glow <b>"Spa"</b>` });
    const { html } = offerEndedEmail(demo);
    expect(html).not.toContain("<b>");
    expect(html).toContain("Glow &lt;b&gt;&quot;Spa&quot;&lt;/b&gt;");
  });

  it("claims nothing v1 may not claim", async () => {
    const { html, text } = offerEndedEmail(await shipped());
    for (const part of [html, text]) {
      expect(part).not.toMatch(/revenue|HIPAA compliant|live in/i);
    }
  });
});

describe("scheduling it", () => {
  it("hands it to Resend for the offer's last moment, once, and keeps the id on the row", async () => {
    const demo = await shipped();
    const result = await scheduleOfferEndedEmail(demo, at(0.05));
    expect(result).toEqual({ status: "sent", providerId: "re_1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.resend.com/emails");
    expect(sent[0]!.body).toMatchObject({
      to: ["owner@radiancemedspa.com"],
      scheduled_at: "2026-10-15T09:00:00.000Z",
      subject: "Your custom 50% discount just expired — chat with our team",
    });
    expect(String(sent[0]!.body!.html)).toContain("Chat with our team");
    expect((sent[0]!.body!.headers as Record<string, string>)["List-Unsubscribe"]).toBe(`<${demoUnsubscribeUrl(demo.id)}>`);
    expect(sent[0]!.idempotencyKey).toBe(`demo-offer-ended:${demo.id}`);

    __resetDemoCacheForTests();
    const row = (await getDemoSession(demo.slug))!;
    expect(row.offerEmailId).toBe("re_1");
    expect(await scheduleOfferEndedEmail(row, at(1))).toEqual({ status: "skipped", reason: "already scheduled" });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for a demo with no address, one already bought, or one whose offer has ended", async () => {
    expect((await scheduleOfferEndedEmail(await shipped({ leadEmail: null }), at(1))).status).toBe("skipped");
    const bought = (await updateDemoSession((await shipped()).slug, { claimed: true }))!;
    expect((await scheduleOfferEndedEmail(bought, at(1))).status).toBe("skipped");
    expect((await scheduleOfferEndedEmail(await shipped(), at(DEMO_SETUP_CREDIT_HOURS))).status).toBe("skipped");
    expect(sent).toEqual([]);
  });

  it("leaves an address alone that opted out of our mail", async () => {
    const lead = await recordDemoUnlock({ email: "owner@radiancemedspa.com", isBusinessEmail: true });
    if (!lead.ok) throw new Error("the fake Sheet refused the lead");
    await markUnsubscribed(lead.leadId, "link");
    expect(await scheduleOfferEndedEmail(await shipped(), at(1))).toEqual({ status: "skipped", reason: "unsubscribed" });
    expect(sent).toEqual([]);
  });
});

describe("when a demo ships", () => {
  const profile = normalizeProfile(
    {
      clinic_name: "Radiance Med Spa",
      services: [{ name: "Signature facial", description: "", price: "$199", duration: "60 min" }],
      hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
      faqs: [],
    },
    "Radiance Med Spa",
  );

  it("an operator's release of a held demo schedules the email; the hold itself did not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(20));
    const created = await createDemoSession(
      { clinicName: "Radiance Med Spa", websiteUrl: "https://radiancemedspa.com/", leadEmail: "owner@radiancemedspa.com" },
      CREATED,
    );
    await updateDemoSession(created.slug, {
      status: "held",
      auditVerdict: "held",
      profile: profile as unknown as Record<string, unknown>,
      auditHash: demoFingerprint(profile),
    });
    expect(sent).toEqual([]);

    const released = await releaseHeldDemo(created.slug, "ops@healdesk.io");
    expect(released?.status).toBe("ready");
    const scheduled = sent.filter((s) => s.body?.scheduled_at);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.body).toMatchObject({ scheduled_at: "2026-10-15T09:00:00.000Z" });
    __resetDemoCacheForTests();
    expect((await getDemoSession(created.slug))!.offerEmailId).toMatch(/^re_/);
  });
});

describe("calling it off", () => {
  it("cancels the scheduled email when the demo is bought before the offer ends", async () => {
    const demo = await shipped();
    await scheduleOfferEndedEmail(demo, at(0.05));
    __resetDemoCacheForTests();
    const row = (await getDemoSession(demo.slug))!;
    expect(await cancelOfferEndedEmail(row, at(20))).toEqual({ status: "sent", providerId: "re_1" });
    expect(sent[1]!.url).toBe("https://api.resend.com/emails/re_1/cancel");
    __resetDemoCacheForTests();
    expect((await getDemoSession(demo.slug))!.offerEmailCancelledAt?.toISOString()).toBe(at(20).toISOString());
  });

  it("does nothing once the moment has passed, or when nothing was scheduled", async () => {
    const demo = await shipped();
    expect((await cancelOfferEndedEmail(demo, at(1))).status).toBe("skipped");
    await scheduleOfferEndedEmail(demo, at(0.05));
    __resetDemoCacheForTests();
    expect((await cancelOfferEndedEmail((await getDemoSession(demo.slug))!, at(48))).status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("puts a cancel Resend refuses to the team, and never throws", async () => {
    const demo = await shipped();
    await scheduleOfferEndedEmail(demo, at(0.05));
    __resetDemoCacheForTests();
    refuse = true;
    const result = await cancelOfferEndedEmail((await getDemoSession(demo.slug))!, at(20));
    expect(result.status).toBe("failed");
    const alerts = vi.mocked(console.info).mock.calls.filter((c) => c[0] === "[healdesk] internal alert");
    expect(JSON.stringify(alerts)).toContain("cancel re_1 in Resend");
  });
});

describe("its opt-out", () => {
  it("is signed for one demo, and no other link's shape is mistaken for it", () => {
    const id = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
    const token = new URL(demoUnsubscribeUrl(id)).searchParams.get("t");
    expect(verifyUnsubscribeTarget(token)).toEqual({ kind: "demo", id });
    expect(verifyUnsubscribeTarget(token!.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    const setup = new URL(setupUnsubscribeUrl(id)).searchParams.get("t");
    expect(verifyUnsubscribeTarget(setup)).toEqual({ kind: "setup", id });
    // A setup signature does not open a demo opt-out, or the other way round.
    expect(verifyUnsubscribeTarget(`d.${setup!.slice(2)}`)).toBeNull();
  });
});

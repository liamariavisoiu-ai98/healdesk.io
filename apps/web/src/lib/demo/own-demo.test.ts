import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the team hears about a homepage demo request, and when: once as it
 * arrives, and again only if a person has to step in. Every message goes to
 * hello@ and replies to the visitor.
 */

const sendSafely = vi.fn();
vi.mock("@/lib/email", () => ({ sendSafely: (...args: unknown[]) => sendSafely(...args) }));
const postInternalAlert = vi.fn();
vi.mock("@/lib/demo/alert", () => ({ postInternalAlert: (...args: unknown[]) => postInternalAlert(...args) }));
const runDemoBuild = vi.fn();
vi.mock("@/lib/demo/build", () => ({ runDemoBuild: (...args: unknown[]) => runDemoBuild(...args) }));
const getDemoSession = vi.fn();
vi.mock("@/lib/demo/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/sessions")>()),
  getDemoSession: (...args: unknown[]) => getDemoSession(...args),
}));

import { buildSelfServeDemo, problemNotice, provisionalClinicName, requestNotice } from "./own-demo";
import type { DemoSession } from "./sessions";

const SESSION = {
  id: "row-1",
  slug: "peachy-studio-k7q2mz9xwa",
  status: "building",
  websiteUrl: "https://www.peachystudio.com/",
  leadEmail: "owner@peachystudio.com",
  buildNote: null,
  emailSentAt: null,
} as unknown as DemoSession;

function sentTo() {
  return sendSafely.mock.calls.map(([message]) => message as { to: string; subject: string; replyTo?: string; tag: string });
}

describe("provisionalClinicName", () => {
  it("reads a name off the domain until the site has been read", () => {
    expect(provisionalClinicName(new URL("https://www.peachy-studio.com/"))).toBe("Peachy Studio");
    expect(provisionalClinicName(new URL("https://smithdental.co.uk/"))).toBe("Smithdental");
    expect(provisionalClinicName(new URL("https://a.io/"))).toBe("a.io");
  });
});

describe("the notices", () => {
  it("say where the request came from and how to answer it, and nothing a patient said", () => {
    const { subject, text } = requestNotice(SESSION);
    expect(subject).toBe("Demo request: peachystudio.com");
    expect(text).toContain("owner@peachystudio.com");
    expect(text).toContain("/demo/peachy-studio-k7q2mz9xwa");
    expect(text).toContain("/admin/demos");
    expect(problemNotice({ ...SESSION, buildNote: "No services found" }, "failed").text).toContain("No services found");
    expect(problemNotice(SESSION, "unsent").subject).toBe("Demo ready, email not sent: peachystudio.com");
  });

  it("call a demo the audit held what it is: built, unsent, and released from the console, not rebuilt", () => {
    const { subject, text } = problemNotice({ ...SESSION, status: "held", auditScore: 58, buildNote: null } as DemoSession, "held");
    expect(subject).toBe("Demo held for review: peachystudio.com");
    expect(text).toContain("was built, but its audit held it back");
    expect(text).toContain("owner@peachystudio.com has not been sent anything");
    expect(text).toContain("Audit score: 58/100.");
    expect(text).toContain("Releasing the demo there sends the link");
    expect(text).toContain("/admin/demos");
    expect(text).not.toMatch(/did not build|failed/i);
    // No score and no note: nothing blank where they would go.
    const bare = problemNotice({ ...SESSION, status: "held", auditScore: null } as DemoSession, "held").text;
    expect(bare).not.toContain("Audit score");
    expect(bare).not.toMatch(/\n\n\n/);
  });
});

describe("buildSelfServeDemo", () => {
  beforeEach(() => {
    sendSafely.mockReset().mockResolvedValue({ status: "sent", providerId: "re_1" });
    postInternalAlert.mockReset().mockResolvedValue(undefined);
    runDemoBuild.mockReset();
    getDemoSession.mockReset();
  });

  it("tells hello@ once, builds with the link emailed, and stops there when all went well", async () => {
    const ready = { ...SESSION, status: "ready", emailSentAt: new Date() };
    runDemoBuild.mockResolvedValue(ready);
    getDemoSession.mockResolvedValue(ready);
    await buildSelfServeDemo(SESSION);
    expect(runDemoBuild).toHaveBeenCalledWith(SESSION.slug, { sendEmail: true });
    expect(sentTo()).toEqual([
      expect.objectContaining({ to: "hello@healdesk.io", subject: "Demo request: peachystudio.com", replyTo: "owner@peachystudio.com", tag: "own-demo-request" }),
    ]);
    expect(postInternalAlert).toHaveBeenCalledTimes(1);
  });

  it("tells hello@ again when the build fails", async () => {
    const failed = { ...SESSION, status: "failed", buildNote: "The site could not be reached." };
    runDemoBuild.mockResolvedValue(failed);
    getDemoSession.mockResolvedValue(failed);
    await buildSelfServeDemo(SESSION);
    expect(sentTo().map((m) => m.subject)).toEqual(["Demo request: peachystudio.com", "Demo build failed: peachystudio.com"]);
    expect(sentTo()[1]).toMatchObject({ to: "hello@healdesk.io", replyTo: "owner@peachystudio.com", tag: "own-demo-failed" });
  });

  it("tells hello@ the audit held it, once, without calling it a failure or alerting twice", async () => {
    const held = { ...SESSION, status: "held", auditScore: 58, emailRequested: true };
    runDemoBuild.mockResolvedValue(held);
    getDemoSession.mockResolvedValue(held);
    await buildSelfServeDemo(SESSION);
    expect(sentTo().map((m) => m.subject)).toEqual(["Demo request: peachystudio.com", "Demo held for review: peachystudio.com"]);
    expect(sentTo()[1]).toMatchObject({ to: "hello@healdesk.io", replyTo: "owner@peachystudio.com", tag: "own-demo-held" });
    // The request's own alert only: lib/demo/build.ts raised the held one.
    expect(postInternalAlert).toHaveBeenCalledTimes(1);
  });

  it("tells hello@ when the demo built but the visitor's link could not be sent", async () => {
    const ready = { ...SESSION, status: "ready", emailSentAt: null };
    runDemoBuild.mockResolvedValue(ready);
    getDemoSession.mockResolvedValue(ready);
    await buildSelfServeDemo(SESSION);
    expect(sentTo().map((m) => m.tag)).toEqual(["own-demo-request", "own-demo-unsent"]);
  });

  it("never throws, whatever fails", async () => {
    sendSafely.mockRejectedValue(new Error("boom"));
    await expect(buildSelfServeDemo(SESSION)).resolves.toBeUndefined();
  });
});

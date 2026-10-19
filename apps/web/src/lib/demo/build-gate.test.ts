import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unsubscribeUrl } from "@/lib/email";
import { findLeadByEmail, leadForCommercialEmail, markUnsubscribed } from "@/lib/leads";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import type { AuditInput, AuditReport } from "./audit";
import { normalizeProfile } from "./profile";
import { __resetDemoCacheForTests, createDemoSession, getDemoSession, updateDemoSession } from "./sessions";

/**
 * The handoff gate inside the build (lib/demo/build.ts): the scrape, the
 * extraction and the audit's model calls are stubbed, the register is the
 * fake Sheet. What these pin: a demo turns `ready` and is mailed only after
 * the audit passes it; a near miss gets exactly one repair round with the
 * findings fed back; a held demo or an audit that cannot run never opens and
 * never mails, and tells the team; an edit after the audit un-clears the
 * email; and an operator's release ships a held demo, on the record.
 */

const send = vi.fn(async (_message: unknown) => ({ status: "sent" as const, providerId: "re_1" }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  send: (message: unknown) => send(message),
}));

const alert = vi.fn(async (_text: string) => undefined);
vi.mock("./alert", () => ({ postInternalAlert: (text: string) => alert(text) }));

vi.mock("./google-hours", () => ({ fetchGoogleHours: async () => null }));

vi.mock("./scrape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scrape")>()),
  scrapeClinicSite: async () => ({
    pages: [{ url: "https://smithdental.com/", title: "Smith Dental", text: "Teeth whitening $399. Open Mon–Fri 8am–5pm." }],
    brand: { name: "Smith Dental", logoUrl: null, color: null },
    source: "fetch",
    apifyNote: null,
  }),
}));

const RAW = {
  clinic_name: "Smith Dental",
  hours: [{ days: "Mon–Fri", hours: "8am–5pm" }],
  services: [{ name: "Teeth whitening", price: "$399" }],
};
const structureProfile = vi.fn(async (_pages: unknown, hints: { feedback?: readonly string[] }) =>
  normalizeProfile(hints.feedback ? { ...RAW, summary: "Repaired." } : RAW, "Smith Dental"),
);
vi.mock("./structure", () => ({ structureProfile: (...args: unknown[]) => structureProfile(...(args as [unknown, { feedback?: readonly string[] }])) }));

const auditDemo = vi.fn<(input: AuditInput) => Promise<AuditReport>>();
vi.mock("./audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audit")>()),
  auditDemo: (input: AuditInput) => auditDemo(input),
}));

const { handoffBlocker, releaseHeldDemo, runDemoBuild, sendDemoEmail } = await import("./build");
const { AuditUnavailableError, decide } = await import("./audit");

function report(overall: number, input: AuditInput, blockers = 0): AuditReport {
  const scores = { accuracy: overall, conversation: overall, personalisation: overall, voice: overall, presentation: overall };
  const issues = Array.from({ length: blockers }, () => ({
    severity: "blocker" as const,
    code: "invented_fact" as const,
    dimension: null,
    evidence: "Teeth whitening",
    where: "profile: services",
    problem: "Not on the site.",
    source: "model" as const,
  }));
  return {
    version: 1,
    model: "claude-opus-5-5",
    round: input.round,
    scores,
    overall,
    blockers: issues,
    findings: [],
    summary: "Summary.",
    probes: [],
    decision: decide({ overall, scores, blockers: issues }, { canRepair: input.canRepair }),
    previous: null,
  };
}

async function newDemo(emailRequested = true) {
  return createDemoSession({ clinicName: "Smith Dental", websiteUrl: "https://smithdental.com/", leadEmail: "owner@smith.com", emailRequested });
}

describe("the handoff gate", () => {
  beforeEach(() => {
    __setSheetsClientForTests(new FakeSheets());
    __resetSheetSchemaForTests();
    __resetDemoCacheForTests();
    send.mockClear();
    alert.mockClear();
    structureProfile.mockClear();
    auditDemo.mockReset();
  });
  afterEach(() => __setSheetsClientForTests(null));

  it("opens and mails a demo only once the audit passes it", async () => {
    auditDemo.mockImplementation(async (input) => report(88, input));
    const demo = await newDemo();
    const done = await runDemoBuild(demo.slug);
    expect(done?.status).toBe("ready");
    expect(done?.auditVerdict).toBe("pass");
    expect(done?.auditScore).toBe(88);
    expect(handoffBlocker(done!)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect((await getDemoSession(demo.slug, { fresh: true }))?.emailSentAt).not.toBeNull();
  });

  it("repairs a near miss once, with the findings fed back, and keeps the better round", async () => {
    auditDemo.mockImplementation(async (input) => report(input.round === 0 ? 74 : 86, input));
    const demo = await newDemo();
    const done = await runDemoBuild(demo.slug);
    expect(auditDemo).toHaveBeenCalledTimes(2);
    expect(structureProfile).toHaveBeenCalledTimes(2);
    expect(structureProfile.mock.calls[1]![1].feedback).toEqual([]);
    expect(done?.status).toBe("ready");
    expect(done?.auditVerdict).toBe("pass");
    expect((done?.profile as { summary?: string }).summary).toBe("Repaired.");
  });

  it("ships a demo that stays in the 70s after its repair, and flags it to the team", async () => {
    auditDemo.mockImplementation(async (input) => report(input.round === 0 ? 76 : 72, input));
    const demo = await newDemo();
    const done = await runDemoBuild(demo.slug);
    expect(done?.status).toBe("ready");
    expect(done?.auditVerdict).toBe("flagged");
    expect(done?.auditScore).toBe(76); // the better round
    expect(send).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatch(/shipped with a flag/);
  });

  it("holds a demo whose blocker survives the repair: never opens, never mails, tells the team", async () => {
    auditDemo.mockImplementation(async (input) => report(90, input, 1));
    const demo = await newDemo();
    const done = await runDemoBuild(demo.slug);
    expect(structureProfile.mock.calls[1]![1].feedback?.[0]).toMatch(/^profile: services: Not on the site\./);
    expect(done?.status).toBe("held");
    expect(done?.auditVerdict).toBe("held");
    expect(send).not.toHaveBeenCalled();
    expect(alert.mock.calls[0]![0]).toMatch(/Demo held for review: Smith Dental \(90\/100\)\. Not on the site\./);
    expect((await sendDemoEmail(done!)).status).toBe("skipped");
  });

  it("holds a demo the audit could not reach a verdict on", async () => {
    auditDemo.mockRejectedValue(new AuditUnavailableError("The grading call failed: overloaded"));
    const demo = await newDemo();
    const done = await runDemoBuild(demo.slug);
    expect(done?.status).toBe("held");
    expect(done?.auditVerdict).toBe("unavailable");
    expect(done?.buildNote).toMatch(/audit could not run/);
    expect(send).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("refuses to mail a demo whose profile changed after its audit", async () => {
    auditDemo.mockImplementation(async (input) => report(88, input));
    const demo = await newDemo(false);
    await runDemoBuild(demo.slug);
    expect(send).not.toHaveBeenCalled();
    const edited = await updateDemoSession(demo.slug, { profile: { ...RAW, services: [{ name: "Botox", price: "$9" }] } });
    expect(handoffBlocker(edited!)).toMatch(/changed after its audit/);
    expect((await sendDemoEmail(edited!)).status).toBe("skipped");
  });

  it("refuses to mail a ready demo that was never audited", async () => {
    const demo = await newDemo();
    const ready = await updateDemoSession(demo.slug, { status: "ready", profile: RAW });
    expect(handoffBlocker(ready!)).toMatch(/not passed its audit/);
  });

  it("lets an operator release a held demo, on the record, and sends the requested link", async () => {
    auditDemo.mockImplementation(async (input) => report(60, input));
    const demo = await newDemo();
    expect((await runDemoBuild(demo.slug))?.status).toBe("held");
    const released = await releaseHeldDemo(demo.slug, "founder");
    expect(released?.status).toBe("ready");
    expect(released?.auditVerdict).toBe("released");
    expect(released?.buildNote).toMatch(/^Released by founder/);
    expect(handoffBlocker(released!)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await releaseHeldDemo(demo.slug, "founder")).toBeNull(); // no longer held
  });

  /**
   * The demo-ready email can carry the demo's setup offer, so it is
   * commercial (Annex X1.10): until 19 October 2026 it had no opt-out, no
   * X1.9 footer and no idempotency key, and an operator could mail an
   * address that had asked us to stop.
   */
  it("mails the demo with the lead's one-click opt-out, keyed by the demo, never the address", async () => {
    auditDemo.mockImplementation(async (input) => report(88, input));
    const demo = await newDemo();
    await runDemoBuild(demo.slug);
    const message = send.mock.calls[0]![0] as {
      to: string;
      text: string;
      tag: string;
      unsubscribeUrl: string;
      idempotencyKey: string;
    };
    const lead = await findLeadByEmail("owner@smith.com");
    expect(lead).not.toBeNull();
    // A row opened for the opt-out records no consent: nurture never starts from it.
    expect(lead!.marketingConsent).toBe(false);
    expect(message.unsubscribeUrl).toBe(unsubscribeUrl(lead!.id));
    expect(message.text).toContain(`Stop these emails: ${message.unsubscribeUrl}`);
    expect(message.text).toContain("healdesk is a service of Viixi FZC");
    expect(message.text).toContain("Wilmington, DE 19801");
    expect(message.tag).toBe("demo-ready");
    expect(message.idempotencyKey).toBe(`hd-demo-ready-${demo.id}-1`);
    expect(message.idempotencyKey).not.toContain("smith.com");
  });

  it("never mails an address that unsubscribed or bounced, whoever presses Email", async () => {
    auditDemo.mockImplementation(async (input) => report(88, input));
    const demo = await newDemo(false);
    const done = await runDemoBuild(demo.slug);
    expect(send).not.toHaveBeenCalled();
    // The address opted out of an earlier email: the lead row says so.
    const lead = await leadForCommercialEmail("owner@smith.com", "test");
    await markUnsubscribed(lead!.id, "link");
    const result = await sendDemoEmail(done!);
    expect(result).toEqual({ status: "skipped", reason: "the address is unsubscribed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send without a lead row to keep its opt-out on", async () => {
    auditDemo.mockImplementation(async (input) => report(88, input));
    const demo = await newDemo(false);
    const done = await runDemoBuild(demo.slug);
    __setSheetsClientForTests(null);
    expect((await sendDemoEmail(done!)).status).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
});

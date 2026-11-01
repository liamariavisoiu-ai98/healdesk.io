import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { auditLog, clinics } from "@/db/schema";
import { addKnowledgeFileRows, FILE_AUDIT_RESOURCE, readKnowledgeFile } from "@/lib/knowledge-file/flow";
import { FILE_LIMITS, FILE_MODEL, type FileModelClient } from "@/lib/knowledge-file/read";
import { saveKnowledge } from "@/lib/portal/knowledge";
import { readKnowledge } from "@/lib/setup/knowledge";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * "Add from a file" against the database (portal redesign, owner,
 * 1 November 2026): the daily limit counted from the audit log, an audit row
 * with the file's kind and nothing of its content, and Add merging into the
 * page through the knowledge writers, a treatment's own deposit kept.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "knowledge-file-test" } as const;
const NOW = new Date("2026-11-01T12:00:00Z");
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF");

const ANSWER = {
  practiceKind: null,
  acceptsInsurance: "unknown",
  locations: [],
  services: [{ name: "HydraFacial", priceKind: "exact", priceUsd: 199, durationMinutes: 45 }],
  providers: [],
  policies: ["Deposits are kept for no-shows."],
  faqs: [{ question: "What should I wear?", answer: "Something comfortable." }],
};

function client(calls: { n: number }): FileModelClient {
  return {
    create: async () => {
      calls.n += 1;
      return {
        id: "msg",
        type: "message",
        role: "assistant",
        model: FILE_MODEL,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: JSON.stringify(ANSWER), citations: null }],
      } as unknown as Anthropic.Message;
    },
  };
}

let clinic: PortalClinic;
const ctx = () => ({ clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "the clinic's sign-in" });
const actor = () => ({ type: "user" as const, userId: clinic.userId, label: "the clinic's sign-in" });

describeDb("Add from a file", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    clinic = await provisionPortalClinic("filecard", { plan: "voice-webchat-1000-1000" });
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("ten files a day; the eleventh is refused without asking the model; each read leaves an audit row with its kind only", async () => {
    const calls = { n: 0 };
    for (let i = 0; i < FILE_LIMITS.perDay; i++) {
      const outcome = await readKnowledgeFile({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: actor(),
        bytes: PDF,
        client: client(calls),
        now: NOW,
      });
      expect(outcome.ok).toBe(true);
    }
    const eleventh = await readKnowledgeFile({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: actor(),
      bytes: PDF,
      client: client(calls),
      now: NOW,
    });
    expect(eleventh).toMatchObject({ ok: false, refusal: "daily_limit" });
    expect(calls.n).toBe(FILE_LIMITS.perDay);

    const rows = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      tx.db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.clinicId, clinic.clinicId), eq(auditLog.resourceType, FILE_AUDIT_RESOURCE))),
    );
    expect(rows).toHaveLength(FILE_LIMITS.perDay);
    for (const row of rows) expect(row.metadata).toEqual({ kind: "pdf" });
  });

  test("the rows offered are what the page does not have yet", async () => {
    const outcome = await readKnowledgeFile({
      clinicId: clinic.clinicId,
      userId: clinic.userId,
      actor: actor(),
      bytes: PDF,
      client: client({ n: 0 }),
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.map((r) => r.section)).toEqual(["prices", "policies", "quick_answers"]);
  });

  test("Add merges into the page through its writers: a changed price keeps its deposit, new rows are added", async () => {
    const seeded = await saveKnowledge(ctx(), "prices", {
      services: [
        { name: "Botox, 1 area", priceKind: "exact", price: 279, maxPrice: null, unit: null, durationMinutes: 30, depositUsd: 50 },
      ],
    });
    expect(seeded.ok).toBe(true);
    await saveKnowledge(ctx(), "policies", { policies: ["24 hours' notice to cancel."] });

    const saturday = {
      sun: [],
      mon: [["09:00", "17:00"]],
      tue: [["09:00", "17:00"]],
      wed: [["09:00", "17:00"]],
      thu: [["09:00", "17:00"]],
      fri: [["09:00", "17:00"]],
      sat: [["10:00", "14:00"]],
    };
    const result = await addKnowledgeFileRows(ctx(), [
      {
        id: "prices:botox, 1 area",
        section: "prices",
        kind: "changed",
        text: "",
        was: null,
        service: { name: "Botox, 1 area", priceKind: "exact", priceUsd: 299, maxUsd: null, unit: null, durationMinutes: null },
      },
      {
        id: "prices:hydrafacial",
        section: "prices",
        kind: "new",
        text: "",
        was: null,
        service: { name: "HydraFacial", priceKind: "exact", priceUsd: 199, maxUsd: null, unit: null, durationMinutes: 45 },
      },
      { id: "policies:x", section: "policies", kind: "new", text: "", was: null, policy: "Deposits are kept for no-shows." },
      {
        id: "quick_answers:x",
        section: "quick_answers",
        kind: "new",
        text: "",
        was: null,
        answer: { question: "What should I wear?", answer: "Something comfortable." },
      },
      { id: "hours:weekly", section: "hours", kind: "new", text: "", was: null, hours: saturday },
    ]);
    expect(result).toEqual({ ok: true, message: "5 things added to your page. AYA uses them from now on." });

    const k = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readKnowledge(tx.db, tx.clinicId));
    const botox = k.services.find((s) => s.name === "Botox, 1 area");
    expect(botox).toMatchObject({ priceFromUsd: 299, durationMinutes: 30, depositUsd: 50 });
    expect(k.services.find((s) => s.name === "HydraFacial")).toMatchObject({ priceFromUsd: 199, durationMinutes: 45 });
    expect(k.policies).toEqual(["24 hours' notice to cancel.", "Deposits are kept for no-shows."]);
    expect(k.quickAnswers.map((a) => a.question)).toContain("What should I wear?");
    const [row] = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      tx.db.select({ hours: clinics.openingHours }).from(clinics).where(eq(clinics.id, clinic.clinicId)),
    );
    expect((row?.hours as Record<string, unknown> | null)?.sat).toEqual([["10:00", "14:00"]]);
  });

  test("rows that are not the shape a read gives are refused, and nothing changes", async () => {
    const before = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readKnowledge(tx.db, tx.clinicId));
    expect(await addKnowledgeFileRows(ctx(), [{ section: "never_say", phrase: "x" }])).toEqual({
      ok: false,
      message: "Read the file again, then add from the new list.",
    });
    expect(await addKnowledgeFileRows(ctx(), [])).toEqual({ ok: false, message: "Choose something to add." });
    const after = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readKnowledge(tx.db, tx.clinicId));
    expect(after).toEqual(before);
  });

  test("a clinical policy added from a file is refused by the same screen as the form", async () => {
    const result = await addKnowledgeFileRows(ctx(), [
      { id: "p", section: "policies", kind: "new", text: "", was: null, policy: "Stop blood thinners a week before Botox." },
    ]);
    expect(result.ok).toBe(false);
  });
});

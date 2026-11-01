import type Anthropic from "@anthropic-ai/sdk";
import { PATIENT_MODEL_IDS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  checkFile,
  FILE_LIMITS,
  FILE_MODEL,
  fileRequest,
  pdfPageCount,
  readFileProfile,
  sniffFile,
  type FileModelClient,
} from "@/lib/knowledge-file/read";

/**
 * "Add from a file" (portal redesign, owner, 1 November 2026): what may be
 * read, the one request it makes, and what comes back.
 */

const PDF = (pages: number) =>
  new TextEncoder().encode(
    `%PDF-1.7\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n` +
      Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj << /Type /Page >> endobj\n`).join("") +
      "%%EOF",
  );
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const NOW = new Date("2026-11-01T12:00:00Z");

function answer(body: unknown, stop: Anthropic.Message["stop_reason"] = "end_turn"): FileModelClient {
  return {
    create: async () =>
      ({
        id: "msg",
        type: "message",
        role: "assistant",
        model: FILE_MODEL,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null }],
      }) as unknown as Anthropic.Message,
  };
}

const PROFILE = {
  practiceKind: "medspa",
  acceptsInsurance: "unknown",
  locations: [
    {
      label: "Lumen",
      hours: {
        sun: [],
        mon: [{ open: "09:00", close: "17:00" }],
        tue: [{ open: "09:00", close: "17:00" }],
        wed: [],
        thu: [],
        fri: [],
        sat: [{ open: "10:00", close: "14:00" }],
      },
    },
  ],
  services: [
    { name: "HydraFacial", priceKind: "exact", priceUsd: 199, durationMinutes: 45 },
    { name: "Botox", priceKind: "per_unit", priceUsd: 14, unit: "unit" },
  ],
  providers: [{ name: "Dr Someone", title: "MD" }],
  policies: ["24 hours' notice to cancel."],
  faqs: [{ question: "Where do I park?", answer: "Free parking behind the building." }],
};

describe("what may be read", () => {
  test("a file is known by its first bytes, never its name", () => {
    expect(sniffFile(PDF(1))).toBe("pdf");
    expect(sniffFile(JPEG)).toBe("jpeg");
    expect(sniffFile(PNG)).toBe("png");
    expect(sniffFile(new TextEncoder().encode("<html>"))).toBeNull();
  });

  test("a PDF's pages are counted from its page objects, not its page tree", () => {
    expect(pdfPageCount(PDF(3))).toBe(3);
    expect(pdfPageCount(new TextEncoder().encode("%PDF-1.7 compressed"))).toBeNull();
  });

  test("empty, too big, the wrong kind and too many pages are refused before anything reads them", () => {
    expect(checkFile(new Uint8Array())).toEqual({ refusal: "empty" });
    const big = new Uint8Array(FILE_LIMITS.maxBytes + 1);
    big.set(JPEG);
    expect(checkFile(big)).toEqual({ refusal: "too_big" });
    expect(checkFile(new TextEncoder().encode("hello"))).toEqual({ refusal: "wrong_type" });
    expect(checkFile(PDF(FILE_LIMITS.maxPages + 1))).toEqual({ refusal: "too_many_pages" });
    expect(checkFile(PDF(FILE_LIMITS.maxPages))).toEqual({ kind: "pdf" });
    expect(checkFile(PNG)).toEqual({ kind: "png" });
  });
});

describe("the one request", () => {
  test("a model the agreements cover, no server-side fallback, the shared schema", () => {
    const request = fileRequest(PDF(1), "pdf");
    expect(PATIENT_MODEL_IDS as readonly string[]).toContain(request.model);
    expect(request).not.toHaveProperty("fallbacks");
    expect(request.output_config?.format?.type).toBe("json_schema");
    const content = request.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
  });

  test("a photo goes as an image", () => {
    const content = fileRequest(JPEG, "jpeg").messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(content[0]).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
  });
});

describe("what comes back", () => {
  test("a price list becomes a profile, with no providers kept", async () => {
    const result = await readFileProfile(PDF(1), "pdf", answer(PROFILE), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.services.map((s) => s.name)).toEqual(["HydraFacial", "Botox"]);
    expect(result.profile.providers).toEqual([]);
    expect(result.profile.policies).toEqual(["24 hours' notice to cancel."]);
    expect(result.profile.faqs[0]?.question).toBe("Where do I park?");
  });

  test("no key, a failed call, a refusal or an answer that is not the shape are each a plain refusal", async () => {
    expect(await readFileProfile(PDF(1), "pdf", null, NOW)).toEqual({ ok: false, refusal: "unavailable" });
    const throws: FileModelClient = { create: async () => Promise.reject(new Error("down")) };
    expect(await readFileProfile(PDF(1), "pdf", throws, NOW)).toEqual({ ok: false, refusal: "unavailable" });
    expect(await readFileProfile(PDF(1), "pdf", answer(PROFILE, "refusal"), NOW)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
    expect(await readFileProfile(PDF(1), "pdf", answer("not json"), NOW)).toEqual({
      ok: false,
      refusal: "unreadable",
    });
  });

  test("a file with nothing usable in it says so", async () => {
    const empty = { ...PROFILE, locations: [], services: [], providers: [], policies: [], faqs: [] };
    expect(await readFileProfile(PNG, "png", answer(empty), NOW)).toEqual({ ok: false, refusal: "nothing_found" });
  });

  test("clinical text the model copied is screened out before anything is shown", async () => {
    const clinical = {
      ...PROFILE,
      policies: ["24 hours' notice to cancel.", "Avoid blood thinners for a week before your injection."],
    };
    const result = await readFileProfile(PDF(1), "pdf", answer(clinical), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.policies).toEqual(["24 hours' notice to cancel."]);
  });
});

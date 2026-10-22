import { describe, expect, test } from "vitest";
import { allVariants, buildInstantlyFiles, lowEnrichmentReason, renderTouch, TOUCHES } from "../src/enrich/instantly.ts";
import { copyViolations } from "../src/enrich/copy-guard.ts";

const lead = (o: Record<string, string> = {}) => ({
  list: "primary", exclude_reason: "", email: "sophie@velvet.com", first_name: "Sophie", last_name: "Lane",
  company: "Velvet Aesthetics Studio LLC", company_short: "Velvet Aesthetics Studio", site_host: "velvetaesthetics.com",
  website: "https://www.velvetaesthetics.com/", phone: "+15125550100", state: "Texas", segment: "injectables",
  booking_mode: "unverified", greeting: "Hi", subject_line: "Saturday calls",
  hook: "From Saturday 3pm to Tuesday 6am, that's 63 hours your phone could still be booking lip filler.",
  chat_surface: "your Instagram", closing_question: "Want the link to message her like a new client would?",
  scenario: "Picture someone messaging your Instagram about lip filler on a Saturday night. AYA answers, takes the time they want and passes it to your desk to confirm.",
  client_term: "clients", top_service: "lip filler", gap_hours: "63", closed_days: "Sunday, Monday", closes_at: "18:00", site_count: "",
  ...o,
});

describe("the Instantly files", () => {
  test("every fixed variant passes the copy guard", () => {
    for (const text of allVariants()) expect(copyViolations(text), text).toEqual([]);
  });

  test("a row arrives with its subject and four bodies written, and no merge tag left in them", () => {
    const { main, lowEnrichment, refused } = buildInstantlyFiles([lead()]);
    expect(refused).toEqual([]);
    expect(lowEnrichment).toHaveLength(0);
    const r = main[0]!;
    expect(r.subject_1).toBe("Saturday calls");
    expect(r.body_1.startsWith("Hi Sophie,\n\nFrom Saturday 3pm")).toBe(true);
    expect(r.body_1).toContain("velvetaesthetics.com and dressed in your branding.");
    expect(r.body_1).toContain("your Instagram.");
    expect(r.body_3).toContain("handle clients' data under it.");
    expect(r.body_4).toContain("Velvet Aesthetics Studio,");
    for (const b of [r.body_1, r.body_2, r.body_3, r.body_4]) expect(b).not.toMatch(/\{\{|\}\}|undefined/);
    // Instantly's own fields carry the short name and the bare domain.
    expect(r.company_name).toBe("Velvet Aesthetics Studio");
    expect(r.website).toBe("velvetaesthetics.com");
  });

  test("the spintax is fixed per address and varies across the list", () => {
    const a = renderTouch(TOUCHES[0], lead(), 1);
    expect(renderTouch(TOUCHES[0], lead(), 1)).toBe(a);
    const bodies = new Set(
      Array.from({ length: 30 }, (_, i) => renderTouch(TOUCHES[1], lead({ email: `p${i}@c.com` }), 2)),
    );
    expect(bodies.size).toBeGreaterThan(10);
  });

  test("no first name becomes 'there'", () => {
    expect(renderTouch(TOUCHES[3], lead({ first_name: "" }), 4).startsWith("Hi there,")).toBe(true);
  });

  test("thin rows go to the low-enrichment file with the reason", () => {
    expect(lowEnrichmentReason(lead())).toBe("");
    expect(lowEnrichmentReason(lead({ gap_hours: "", closed_days: "", closes_at: "19:00" }))).toBe("no opening hours found");
    expect(lowEnrichmentReason(lead({ top_service: "" }))).toBe("no service found on the site");
    const { main, lowEnrichment } = buildInstantlyFiles([lead(), lead({ email: "x@y.com", top_service: "", gap_hours: "", closed_days: "", closes_at: "" })]);
    expect(main).toHaveLength(1);
    expect(lowEnrichment[0]!.enrichment_note).toBe("no opening hours found; no service found on the site");
  });

  test("second contacts, unreadable sites and excluded rows are not in either file", () => {
    const { main, lowEnrichment } = buildInstantlyFiles([
      lead({ list: "second-contact" }), lead({ list: "unreadable" }), lead({ exclude_reason: "chain or franchise" }),
    ]);
    expect(main.length + lowEnrichment.length).toBe(0);
  });
});

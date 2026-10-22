import { describe, expect, test } from "vitest";
import { allVariants, buildInstantlyFiles, greetingName, lowEnrichmentReason, renderTouch, TOUCHES } from "../src/enrich/instantly.ts";
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

  test("excluded rows are in no file", () => {
    const f = buildInstantlyFiles([lead({ exclude_reason: "chain or franchise" })]);
    expect(f.main.length + f.lowEnrichment.length + f.secondContacts.length + f.unreadable.length).toBe(0);
  });

  test("a second contact gets the same four touches, in its own file, naming the primary contact", () => {
    const f = buildInstantlyFiles([
      lead({ clinic_id: "k1" }),
      lead({ list: "second-contact", clinic_id: "k1", email: "ops@velvet.com", first_name: "Tom", last_name: "Ray" }),
    ]);
    expect(f.main).toHaveLength(1);
    expect(f.secondContacts).toHaveLength(1);
    const t = f.secondContacts[0]!;
    expect(t.primary_contact).toBe("sophie@velvet.com");
    expect(t.body_1.startsWith("Hi Tom,")).toBe(true);
    expect(t.body_4).toContain("Velvet Aesthetics Studio");
  });

  test("a site that would not load gets one honest email and no preview", () => {
    const f = buildInstantlyFiles([
      lead({
        list: "unreadable", clinic_id: "u1", email: "dr@crawford.com", first_name: "Marcus", segment: "", site_host: "crawfordplasticsurgery.com",
        hook: "I went to look at crawfordplasticsurgery.com but couldn't get it to load properly.",
        top_offer: "If visitors hit the same thing, they might call instead, and AYA, our virtual assistant, can answer and book them in around the clock.",
        closing_question: "Who's catching those calls right now?",
      }),
      lead({ list: "unreadable", clinic_id: "u2", email: "x@y.com", site_host: "tiny.com", hook: "I went to look at tiny.com but couldn't find much on it.", top_offer: "o", closing_question: "q?" }),
    ]);
    expect(f.unreadable).toHaveLength(2);
    const u = f.unreadable[0]!;
    expect(u.subject_1).toBe("crawfordplasticsurgery.com not loading");
    expect(u.body_1).toBe(
      "Hi Marcus,\n\nI went to look at crawfordplasticsurgery.com but couldn't get it to load properly.\n\n" +
        "If visitors hit the same thing, they might call instead, and AYA, our virtual assistant, can answer and book them in around the clock.\n\n" +
        "Who's catching those calls right now?",
    );
    expect([u.body_2, u.body_3, u.body_4]).toEqual(["", "", ""]);
    expect(u.body_1).not.toMatch(/preview/i);
    expect(f.unreadable[1]!.subject_1).toBe("Quick question about tiny.com");
  });
});

describe("the name after 'Hi'", () => {
  test("a doctor is Dr. and the surname, never Dr. and the given name", () => {
    expect(greetingName("Dr. Jacob", "Smith")).toBe("Dr. Smith");
    expect(greetingName("Dr. Mark R.", "Lee")).toBe("Dr. Lee");
    expect(greetingName("Dr. Zen", "")).toBe("there");
    expect(greetingName("Dr.", "")).toBe("there");
    // The last-name field often holds a credential.
    for (const credential of ["L.Ac", "Lmt", "LMT", "Bsee", "DDS", "MD", "D.C."]) {
      expect(greetingName("Dr. Dom", credential), credential).toBe("there");
    }
    expect(greetingName("Dr. Dom", "McDonald")).toBe("Dr. McDonald");
  });
  test("initials, emoji and bare initialisms come off or become 'there'", () => {
    expect(greetingName("Jill M.", "Hart")).toBe("Jill");
    expect(greetingName("Matthew J", "Park")).toBe("Matthew");
    expect(greetingName("🏆 Jason", "Cole")).toBe("Jason");
    expect(greetingName("AJ", "Ray")).toBe("there");
    expect(greetingName("", "")).toBe("there");
    expect(greetingName("Monét", "")).toBe("Monét");
    expect(greetingName("Mary-Anne", "")).toBe("Mary-Anne");
  });
});


import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { greetingName, lowEnrichmentReason, splitLeads, unreadableSubject } from "../src/enrich/instantly.ts";
import { fixedText, spinGroups, TEMPLATE_COLUMNS, TEMPLATES, UNREADABLE_TEMPLATE, variablesIn } from "../src/enrich/templates.ts";
import { copyViolations } from "../src/enrich/copy-guard.ts";

const lead = (o: Record<string, string> = {}) => ({
  list: "primary", exclude_reason: "", email: "sophie@velvet.com", first_name: "Sophie", last_name: "Lane",
  company: "Velvet Aesthetics Studio LLC", company_short: "Velvet Aesthetics Studio", site_host: "velvetaesthetics.com",
  website: "https://www.velvetaesthetics.com/", phone: "+15125550100", state: "Texas", segment: "injectables",
  booking_mode: "unverified", greeting: "Hi", subject_line: "Saturday calls",
  hook: "From Saturday 3pm to Tuesday 6am, that's 63 hours your phone could still be booking lip filler.",
  chat_surface: "your Instagram", closing_question: "Want the link to message her like a new client would?",
  scenario: "Picture someone messaging your Instagram about lip filler on a Saturday night. AYA answers, takes the time they want and passes it to your desk to confirm in Boulevard.",
  client_term: "clients", top_service: "lip filler", hours_source: "google", gap_hours: "63", closed_days: "Sunday, Monday", closes_at: "18:00", site_count: "",
  top_offer: "AYA answers your calls and Instagram DMs.", clinic_id: "k1", classifier_evidence: "kept as it was",
  ...o,
});

describe("the tabs", () => {
  test("a row keeps every column it had and gains the three the templates and the tabs need", () => {
    const { main } = splitLeads([lead()]);
    const r = main[0]!;
    for (const k of Object.keys(lead())) expect(r, k).toHaveProperty(k);
    expect(r.classifier_evidence).toBe("kept as it was");
    expect(r.greeting_name).toBe("Sophie");
    expect(r.enrichment_note).toBe("");
    expect(r.primary_contact).toBe("");
  });

  test("thin rows go to the low-enrichment tab with the reason", () => {
    expect(lowEnrichmentReason(lead())).toBe("");
    expect(lowEnrichmentReason(lead({ gap_hours: "", closed_days: "", closes_at: "19:00" }))).toBe("no opening hours found");
    // A closing time from the clinic's own page is not Google's hours, and the hook ignores it.
    expect(lowEnrichmentReason(lead({ gap_hours: "", closed_days: "", closes_at: "16:00", hours_source: "website" }))).toBe("no opening hours found");
    expect(lowEnrichmentReason(lead({ gap_hours: "", closed_days: "", closes_at: "16:00" }))).toBe("");
    expect(lowEnrichmentReason(lead({ top_service: "" }))).toBe("no service found on the site");
    const t = splitLeads([lead(), lead({ email: "x@y.com", top_service: "", gap_hours: "", closed_days: "", closes_at: "" })]);
    expect(t.main).toHaveLength(1);
    expect(t.lowEnrichment[0]!.enrichment_note).toBe("no opening hours found; no service found on the site");
  });

  test("a second contact is its own tab and names the primary contact at the same clinic", () => {
    const t = splitLeads([
      lead(),
      lead({ list: "second-contact", email: "ops@velvet.com", first_name: "Tom", last_name: "Ray" }),
    ]);
    expect(t.main).toHaveLength(1);
    expect(t.secondContacts).toHaveLength(1);
    expect(t.secondContacts[0]!.primary_contact).toBe("sophie@velvet.com");
    expect(t.secondContacts[0]!.greeting_name).toBe("Tom");
  });

  test("a site that would not load is its own tab, with a subject and the one-email template", () => {
    const t = splitLeads([
      lead({
        list: "unreadable", clinic_id: "u1", email: "dr@crawford.com", first_name: "Marcus", segment: "", subject_line: "", greeting: "",
        site_host: "crawfordplasticsurgery.com",
        hook: "I went to look at crawfordplasticsurgery.com but couldn't get it to load properly.",
      }),
      lead({ list: "unreadable", clinic_id: "u2", email: "x@y.com", greeting: "", subject_line: "", site_host: "tiny.com", hook: "I went to look at tiny.com but couldn't find much on it." }),
    ]);
    expect(t.unreadable).toHaveLength(2);
    expect(t.unreadable[0]!.subject_line).toBe("crawfordplasticsurgery.com not loading");
    expect(t.unreadable[0]!.greeting).toBe("Hi");
    expect(t.unreadable[1]!.subject_line).toBe("Quick question about tiny.com");
    expect(unreadableSubject({ site_host: "a-very-long-clinic-domain-name-for-a-practice.com", hook: "x" })).toBe("Your website");
  });

  test("excluded rows are in no tab, and a refused phrase is reported", () => {
    const e = splitLeads([lead({ exclude_reason: "chain or franchise" })]);
    expect(e.main.length + e.lowEnrichment.length + e.secondContacts.length + e.unreadable.length).toBe(0);
    expect(splitLeads([lead({ hook: "We text your lapsed patients back." })]).refused.length).toBeGreaterThan(0);
  });
});

describe("the templates", () => {
  const all = [...TEMPLATES, UNREADABLE_TEMPLATE];

  test("every variable is a column the pipeline writes", () => {
    for (const t of all) {
      for (const name of variablesIn(`${t.subject}\n${t.body}`)) {
        expect(TEMPLATE_COLUMNS as readonly string[], `${t.name}: {{${name}}}`).toContain(name);
      }
    }
  });

  test("every variant passes the copy guard, and no spintax choice is empty or holds a variable", () => {
    for (const t of all) {
      expect(copyViolations(fixedText(t.body)), t.name).toEqual([]);
      for (const group of spinGroups(t.body)) {
        expect(group.length, `${t.name}: ${group}`).toBeGreaterThan(1);
        for (const choice of group) {
          expect(choice.trim(), `${t.name}: ${group}`).not.toBe("");
          expect(choice, `${t.name}: ${choice}`).not.toMatch(/\{|\}/);
        }
      }
    }
  });

  test("braces balance, and nothing is left unsaid", () => {
    for (const t of all) {
      const bare = t.body.replace(/\{\{[a-z_]+\}\}/g, "").replace(/\{[^{}|]*(\|[^{}|]*)+\}/g, "");
      expect(bare, t.name).not.toMatch(/[{}|]/);
    }
  });

  test("no link, no image, and the strategy's one ask", () => {
    for (const t of TEMPLATES) expect(t.body, t.name).not.toMatch(/https?:|www\.|<img|\[image/i);
    expect(TEMPLATES[0]!.body).toContain('"yes"');
    expect(TEMPLATES.map((t) => t.day)).toEqual([1, 3, 6, 10]);
    // The 50% is a surprise for a qualified buyer, so no template mentions it.
    for (const t of all) expect(t.body, t.name).not.toMatch(/50\s?%|discount|setup fee|48/i);
  });

  test("the sequence doc carries each template word for word", () => {
    const doc = readFileSync(new URL("../../../docs/outreach/sequences.md", import.meta.url), "utf8");
    for (const t of all) expect(doc, t.name).toContain(t.body);
  });
});

describe("the name after the greeting", () => {
  test("a doctor is Dr. and the surname, never Dr. and the given name", () => {
    expect(greetingName("Dr. Jacob", "Smith")).toBe("Dr. Smith");
    expect(greetingName("Dr. Mark R.", "Lee")).toBe("Dr. Lee");
    expect(greetingName("Dr. Zen", "")).toBe("there");
    expect(greetingName("Dr.", "")).toBe("there");
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

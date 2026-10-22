import { SEGMENTS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";
import { guessSpecialty, SPECIALTIES } from "../src/enrich/specialty.ts";

const g = (company: string, title = "Owner", industry = "medical practice", keywords = "", employees?: number) =>
  guessSpecialty({ company, title, industry, keywords, employees });

describe("specialty and top service from an Apollo row", () => {
  test("every specialty has a top service and a segment the pipeline knows", () => {
    for (const s of SPECIALTIES) {
      expect(s.topService.trim(), s.id).not.toBe("");
      expect(SEGMENTS as readonly string[], s.id).toContain(s.segment);
    }
  });

  test("aesthetic surgery is Botox, as the owner said", () => {
    const r = g("Defyne Plastic Surgery", "Plastic Surgeon");
    expect([r.label, r.topService, r.segment]).toEqual(["Plastic & cosmetic surgery", "Botox", "plastic-surgery"]);
    expect(r.basis).toBe("title");
  });

  test("a title outweighs the company name: a plastic surgeon at a 'beauty' brand runs a plastic surgery practice", () => {
    expect(g("Rockstar Beauty", "Plastic Surgeon").label).toBe("Plastic & cosmetic surgery");
  });

  test("the common specialties and their services", () => {
    expect(g("Tri-Century Eye Care", "CEO").topService).toBe("LASIK");
    expect(g("Manhattan Beach Dermatology", "Dermatologist & Owner").label).toBe("Dermatology");
    expect(g("Smile Studio", "Dentist").topService).toBe("dental implants");
    expect(g("Radiance Medspa", "Owner").label).toBe("Med spa & aesthetics");
    expect(g("Live Hydration Spa", "Owner", "health, wellness & fitness", "iv therapy, iv hydration").topService).toBe("IV therapy");
    expect(g("Anagen Hair Restoration", "CEO").topService).toBe("hair transplants");
    expect(g("Options Medical Weight Loss", "Founder").label).toBe("Weight loss & GLP-1");
    expect(g("Men's T Clinic", "Founding Partner").label).toBe("Hormone & men's health");
  });

  test("a weak word in the name does not decide against the keywords", () => {
    // "Wellness" is in every kind of clinic's name; acupuncture is what Shen Medicine does.
    const r = g("Shen Wellness", "Founder", "alternative medicine", "acupuncture, chinese herbology, holistic nutrition");
    expect(r.label).toBe("Acupuncture");
  });

  test("a company outside the clinic industries is not a clinic, whatever its keywords say", () => {
    const r = g("Soilytics", "CO-CEO", "environmental services", "agricultural surveying, farming, soil fertility");
    expect([r.label, r.segment]).toEqual(["Not a clinic", "not-a-target"]);
    expect(g("Syngenta", "Medical Director", "farming").label).toBe("Not a clinic");
  });

  test("a vendor's name marks a non-clinic, but a clinic called Capital is a clinic", () => {
    expect(g("Empower Pharmacy", "CEO", "pharmaceuticals").label).toBe("Not a clinic");
    expect(g("ADvance Media", "Managing Partner", "marketing & advertising").label).toBe("Not a clinic");
    expect(g("Capital Laser & Skin Care", "Founder and Director").label).toBe("Laser & skin clinic");
    // "Lab" at the front of a name is a brand, "Labs" at the end is a company.
    expect(g("Lab Fit Physical Therapy And Wellness Center", "Owner").label).toBe("Physical therapy & rehab");
    expect(g("Opu Labs", "Founder").label).toBe("Not a clinic");
    expect(g("Capital Center for Oral and Maxillofacial Surgery", "Oral & Maxillofacial Surgeon", "hospital & health care").label).toBe("Dental & orthodontics");
  });

  test("a product or agency in the keywords is not a local clinic, unless the clinical keywords dominate", () => {
    expect(g("Noom", "CEO", "health, wellness & fitness", "mobile app, weight loss, lifestyle, e-commerce").label).toBe("Product, online brand or agency");
    expect(g("Coast to Coast Sperm Donation", "CEO", "individual & family services", "fertility, donor conception, sperm donation, egg donation").label).toBe("Product, online brand or agency");
    // One product word among many treatments is still a med spa.
    expect(g("Med Lounge", "Co-Owner", "medical practice", "med spa, botox, cosmetic injectables, dermal fillers, supplements").label).toBe("Med spa & aesthetics");
  });

  test("a very large health system is not an owner-run clinic", () => {
    const r = g("Jefferson Healthcare", "General Surgeon", "hospital & health care", "orthopedics, hospital", 5000);
    expect([r.label, r.segment, r.basis]).toEqual(["Hospital / health system", "not-a-target", "size (health system)"]);
    // A large dental chain keeps its specialty. The size is flagged in its own column.
    expect(g("Aspen Dental", "Dentist", "medical practice", "dental", 10000).label).toBe("Dental & orthodontics");
  });

  test("no signal falls back to an honest label, never a guess", () => {
    expect(g("Acme Group", "Founder", "medical practice").label).toBe("Other medical practice");
    expect(g("Acme Group", "Founder", "").label).toBe("Unclear: review");
  });
});

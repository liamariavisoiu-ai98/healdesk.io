import type { SpecialtyId } from "@healdesk/catalog";

import type { ClinicProfile, ClinicService } from "./profile";

/**
 * What a demo makes up when the clinic's website did not show it (owner,
 * 1 November 2026: "if the website doesnt offer calendar, stripe, prices the
 * demo should 'invent them' just to show them the dream outcome. There
 * should be a visible disclaimer saying this wasn't available so we invented
 * this for demo purposes").
 *
 * Only for the live demo the owner tries, never for what is stored: the
 * profile in the register stays what the website said, so the build's audit
 * (lib/demo/audit.ts), which checks the profile against the website, never
 * reads a made-up price as a fact the reader invented. The chat route, the
 * voice routes and the demo page call this; the page's note lists every
 * item it made up (`invented`), worked out here and nowhere else, so the
 * note always matches what Aya says.
 *
 * Made up: a price for each treatment listed without one, a small sample menu
 * when no treatment was found, opening hours when none were found, and a
 * deposit and cancellation rule when none was found. The free times Aya
 * offers are always made up: a demo is never connected to a calendar.
 * Never made up: the address, the phone number or the team, which a caller
 * would act on.
 */

export type DemoSample = "calendar" | "prices" | "menu" | "hours" | "deposit";

export type DemoSamples = {
  /** The profile with the made-up values in place, for the live demo only. */
  profile: ClinicProfile;
  /** What was made up, in the order the note lists it; "calendar" always. */
  invented: DemoSample[];
};

/** Sample prices by the words a treatment's name carries, in the menu's own forms (demoPrice reads them). */
const SAMPLE_PRICES: readonly [RegExp, string][] = [
  [/\b(?:botox|dysport|xeomin|jeuveau|daxxify|neuro ?toxin|tox|wrinkle relax)/i, "$14/unit"],
  [/\b(?:filler|juvederm|restylane|rha|lip)/i, "from $650"],
  [/\bhydra ?facial/i, "$199"],
  [/\b(?:microneedling|morpheus|rf needling)/i, "from $350"],
  [/\blaser hair/i, "from $150"],
  [/\b(?:laser|ipl|bbl|resurfacing)/i, "from $300"],
  [/\b(?:sclerotherapy|spider vein|vein)/i, "from $350"],
  [/\b(?:semaglutide|tirzepatide|glp|weight)/i, "from $299"],
  [/\bkybella/i, "from $600"],
  [/\b(?:prp|prf)\b/i, "from $500"],
  [/\b(?:coolsculpt|body contour)/i, "from $750"],
  [/\b(?:peel)/i, "from $150"],
  [/\bfacial/i, "from $150"],
  [/\bwhitening/i, "$399"],
  [/\b(?:cleaning|hygiene|check-?up)/i, "$150"],
  [/\b(?:invisalign|aligner)/i, "from $3,500"],
  [/\bimplant/i, "from $3,000"],
  [/\b(?:veneer|crown)/i, "from $1,200"],
  [/\b(?:hair restoration|hair transplant|fue)/i, "from $4,000"],
  [/\bmassage/i, "$120"],
  [/\b(?:chiro|adjustment)/i, "$85"],
  [/\b(?:vaccin)/i, "from $30"],
  [/\b(?:exam|wellness)/i, "$65"],
  [/\bconsult/i, "Complimentary"],
];

/** A treatment's sample price: the closest kind on the list, else a general one. */
function samplePrice(name: string): string {
  return SAMPLE_PRICES.find(([kind]) => kind.test(name))?.[1] ?? "from $150";
}

/** A small sample menu for a clinic whose treatments were not found, by its kind of practice. */
function sampleMenu(specialty: SpecialtyId | null): ClinicService[] {
  const item = (name: string, price: string, duration: string | null = null): ClinicService => ({ name, description: null, price, duration });
  switch (specialty) {
    case "dental":
      return [item("New patient exam and cleaning", "$150", "1 hour"), item("Teeth whitening", "$399", "1 hour"), item("Invisalign consultation", "Complimentary", "30 min")];
    case "veterinary":
      return [item("Wellness exam", "$65", "30 min"), item("Vaccinations", "from $30"), item("Dental cleaning", "from $300")];
    case "massage-chiro":
      return [item("Massage, 60 minutes", "$120", "1 hour"), item("Chiropractic adjustment", "$85", "30 min"), item("New client consultation", "Complimentary", "30 min")];
    case "glp1":
      return [item("Weight loss consultation", "Complimentary", "30 min"), item("Semaglutide program", "from $299"), item("Tirzepatide program", "from $399")];
    case "hair-restoration":
      return [item("Hair restoration consultation", "Complimentary", "30 min"), item("PRP hair treatment", "from $500"), item("FUE hair transplant", "from $4,000")];
    default:
      return [item("Botox", "$14/unit", "30 min"), item("Lip filler", "from $650", "45 min"), item("HydraFacial", "$199", "1 hour"), item("Consultation", "Complimentary", "30 min")];
  }
}

/** Sample hours, the most common for a clinic: weekdays, nine to six. */
const SAMPLE_HOURS: ClinicProfile["hours"] = [{ days: "Mon-Fri", hours: "9am-6pm" }];

/** A sample deposit and cancellation rule. */
export const SAMPLE_DEPOSIT_POLICY = "A $50 deposit holds each appointment and comes off the treatment price. Cancel or move it at least 24 hours ahead to keep the deposit.";

/** A cancellation, deposit or no-show rule the demo can read (as gaps.ts reads it). */
const POLICY = /\b(cancel|cancell?ation|deposit|no[\s-]?show|late (?:arrival|fee)|reschedul)/i;

/** A price with a figure in it, or a free one (as gaps.ts reads it). */
function isPriced(price: string | null): boolean {
  return Boolean(price && (/\d/.test(price) || /\b(free|complimentary|no charge)\b/i.test(price)));
}

/** The profile for the live demo, with what the website did not show made up, and what was. */
export function withDemoSamples(profile: ClinicProfile): DemoSamples {
  const invented: DemoSample[] = ["calendar"];
  let services = profile.services;
  if (services.length === 0) {
    services = sampleMenu(profile.specialty);
    invented.push("menu");
  } else if (services.some((s) => !isPriced(s.price))) {
    services = services.map((s) => (isPriced(s.price) ? s : { ...s, price: samplePrice(s.name) }));
    invented.push("prices");
  }
  const hours = profile.hours.length > 0 ? profile.hours : SAMPLE_HOURS;
  if (profile.hours.length === 0) invented.push("hours");
  const rules = [...profile.policies, ...profile.faqs.map((f) => `${f.question} ${f.answer}`)].join("\n");
  const policies = POLICY.test(rules) ? profile.policies : [...profile.policies, SAMPLE_DEPOSIT_POLICY];
  if (!POLICY.test(rules)) invented.push("deposit");
  return { profile: { ...profile, services, hours, hoursSource: profile.hours.length > 0 ? profile.hoursSource : null, policies }, invented };
}

/** For the owner, on the demo page: what was made up, in plain words. */
export function sampleLabel(sample: DemoSample, profile: ClinicProfile): string {
  const offer = profile.specialty === "veterinary" || profile.specialty === "massage-chiro" ? "services" : "treatments";
  switch (sample) {
    case "calendar":
      return "The free times Aya offers: a demo isn't connected to your calendar";
    case "menu":
      return `Your ${offer} and their prices`;
    case "prices":
      return `Prices for the ${offer} we found without one`;
    case "hours":
      return "Your opening hours (Monday to Friday, 9 to 6)";
    case "deposit":
      return "A $50 deposit and its payment link, and a 24-hour cancellation rule";
  }
}

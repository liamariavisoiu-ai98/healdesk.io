import { createHash } from "node:crypto";

import type { SpecialtyId } from "@healdesk/catalog";

import { benchmarkById, benchmarkFor, CONSULTATION_PRICE, priceFigure } from "./benchmarks";
import type { ClinicProfile, ClinicService } from "./profile";

/**
 * What a demo makes up when the clinic's website did not show it (owner,
 * 1 November 2026: "if the website doesnt offer calendar, stripe, prices the
 * demo should 'invent them' just to show them the dream outcome. There
 * should be a visible disclaimer saying this wasn't available so we invented
 * this for demo purposes").
 *
 * A step of the build (lib/demo/build.ts, owner, 1 November 2026): once the
 * profile is final, `fillDemo` works out the fill, which is stored on the
 * demo's row beside the profile (`demoFill`), never merged into it, so the
 * audit (lib/demo/audit.ts) still checks the profile against the website
 * alone and the wizard's handoff never carries a made-up price. The fill is
 * checked as it is stored (`checkDemoFill`): a failure holds the demo like
 * any audit blocker. Every surface then reads the same stored values
 * (`liveDemo`): the chat route, the three voice routes and the demo page,
 * whose note lists every item (`invented`), so the note always matches what
 * Aya says. A row built before this step has no fill; it is worked out on
 * the request, as it was before.
 *
 * Made up: a price for each treatment listed without one, from the
 * benchmark table (lib/demo/benchmarks.ts; a treatment the table does not
 * cover gets "Price at consultation", no figure), a small sample menu when no
 * treatment was found, opening hours when none were found, and a deposit
 * and cancellation rule when none was found. The free times Aya offers are
 * always made up: a demo is never connected to a calendar.
 * Never made up: the address, the phone number, the team, parking,
 * insurance or financing, which a caller would act on.
 */

export type DemoSample = "calendar" | "prices" | "menu" | "hours" | "deposit";

/** Every kind the page's note can list, in its order. */
export const DEMO_SAMPLES: readonly DemoSample[] = ["calendar", "prices", "menu", "hours", "deposit"];

/**
 * One made-up item, with its basis: `benchmark` for a price from the table,
 * `consultation` for a treatment the table does not cover (no figure, so
 * nothing made up beyond the words), `sample` for the calendar, the menu, the
 * hours and the deposit rule.
 */
export type DemoFillItem =
  | { kind: "calendar"; basis: "sample" }
  | { kind: "price"; basis: "benchmark"; index: number; service: string; value: string; benchmark: string }
  | { kind: "price"; basis: "consultation"; index: number; service: string; value: string; benchmark: null }
  | { kind: "menu"; basis: "sample"; value: ClinicService[] }
  | { kind: "hours"; basis: "sample"; value: ClinicProfile["hours"] }
  | { kind: "deposit"; basis: "sample"; value: string };

/** The stored fill: the items, and the profile they were worked out for. */
export type DemoFill = {
  v: 1;
  /** `fillFingerprint` of the profile the fill was made for; a different profile gets a fresh fill. */
  profileHash: string;
  filledAt: string;
  items: DemoFillItem[];
};

export type DemoSamples = {
  /** The profile with the made-up values in place, for the live demo only. */
  profile: ClinicProfile;
  /** What was made up, in the order the note lists it; "calendar" always. */
  invented: DemoSample[];
  /** The fill the profile was made from. */
  fill: DemoFill;
};

/** A small sample menu for a clinic whose treatments were not found, by its kind of practice; prices from the table. */
function sampleMenu(specialty: SpecialtyId | null): ClinicService[] {
  const item = (name: string, duration: string | null = null): ClinicService => ({
    name,
    description: null,
    price: benchmarkFor(name, specialty)?.price ?? CONSULTATION_PRICE,
    duration,
  });
  switch (specialty) {
    case "dental":
      return [item("New patient exam and cleaning", "1 hour"), item("Teeth whitening", "1 hour"), item("Invisalign consultation", "30 min")];
    case "veterinary":
      return [item("Wellness exam", "30 min"), item("Vaccinations"), item("Dental cleaning")];
    case "massage-chiro":
      return [item("Massage, 60 minutes", "1 hour"), item("Chiropractic adjustment", "30 min"), item("New client consultation", "30 min")];
    case "glp1":
      return [item("Weight loss consultation", "30 min"), item("Semaglutide program"), item("Tirzepatide program")];
    case "hair-restoration":
      return [item("Hair restoration consultation", "30 min"), item("PRP hair treatment"), item("FUE hair transplant")];
    default:
      return [item("Botox", "30 min"), item("Lip filler", "45 min"), item("HydraFacial", "1 hour"), item("Consultation", "30 min")];
  }
}

/** Sample hours, the most common for a clinic: weekdays, nine to six. */
export const SAMPLE_HOURS: ClinicProfile["hours"] = [{ days: "Mon-Fri", hours: "9am-6pm" }];

/** A sample deposit and cancellation rule. */
export const SAMPLE_DEPOSIT_POLICY = "A $50 deposit holds each appointment and comes off the treatment price. Cancel or move it at least 24 hours ahead to keep the deposit.";

/** A cancellation, deposit or no-show rule the demo can read (as gaps.ts reads it). */
const POLICY = /\b(cancel|cancell?ation|deposit|no[\s-]?show|late (?:arrival|fee)|reschedul)/i;

/** A price with a figure in it, or a free one (as gaps.ts reads it). */
function isPriced(price: string | null): boolean {
  return Boolean(price && (/\d/.test(price) || /\b(free|complimentary|no charge)\b/i.test(price)));
}

function hasPolicy(profile: ClinicProfile): boolean {
  return POLICY.test([...profile.policies, ...profile.faqs.map((f) => `${f.question} ${f.answer}`)].join("\n"));
}

/** The profile a fill was made for, as a short hash. The profile is normalised (profileOf), so it hashes as stored. */
export function fillFingerprint(profile: ClinicProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
}

/** The fill for a profile: what the build stores, and what an old row works out on the request. */
export function fillDemo(profile: ClinicProfile, now: Date = new Date()): DemoFill {
  const items: DemoFillItem[] = [{ kind: "calendar", basis: "sample" }];
  if (profile.services.length === 0) {
    items.push({ kind: "menu", basis: "sample", value: sampleMenu(profile.specialty) });
  } else {
    profile.services.forEach((s, index) => {
      if (isPriced(s.price)) return;
      const benchmark = benchmarkFor(s.name, profile.specialty);
      items.push(
        benchmark
          ? { kind: "price", basis: "benchmark", index, service: s.name, value: benchmark.price, benchmark: benchmark.id }
          : { kind: "price", basis: "consultation", index, service: s.name, value: CONSULTATION_PRICE, benchmark: null },
      );
    });
  }
  if (profile.hours.length === 0) items.push({ kind: "hours", basis: "sample", value: SAMPLE_HOURS });
  if (!hasPolicy(profile)) items.push({ kind: "deposit", basis: "sample", value: SAMPLE_DEPOSIT_POLICY });
  return { v: 1, profileHash: fillFingerprint(profile), filledAt: now.toISOString(), items };
}

/** What the note lists for a fill, in its order. A price at consultation is no made-up figure, so it lists nothing. */
export function inventedBy(fill: DemoFill): DemoSample[] {
  const kinds = new Set<DemoSample>();
  for (const item of fill.items) {
    if (item.kind === "price") {
      if (item.basis === "benchmark") kinds.add("prices");
    } else kinds.add(item.kind);
  }
  return DEMO_SAMPLES.filter((k) => kinds.has(k));
}

/** The profile with a fill in place. Items that no longer fit the profile are skipped (the check catches them at build time). */
export function applyDemoFill(profile: ClinicProfile, fill: DemoFill): ClinicProfile {
  let services = profile.services;
  let hours = profile.hours;
  let policies = profile.policies;
  let hoursSource = profile.hoursSource;
  for (const item of fill.items) {
    switch (item.kind) {
      case "menu":
        if (profile.services.length === 0) services = item.value;
        break;
      case "price":
        if (services[item.index]?.name === item.service && !isPriced(services[item.index]!.price)) {
          services = services.map((s, i) => (i === item.index ? { ...s, price: item.value } : s));
        }
        break;
      case "hours":
        if (profile.hours.length === 0) {
          hours = item.value;
          hoursSource = null;
        }
        break;
      case "deposit":
        if (!policies.includes(item.value)) policies = [...policies, item.value];
        break;
      case "calendar":
        break;
    }
  }
  return { ...profile, services, hours, hoursSource, policies };
}

/** Decodes a stored fill; null for anything that is not one. */
export function demoFillOf(raw: unknown): DemoFill | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.profileHash !== "string" || !Array.isArray(o.items)) return null;
  return { v: 1, profileHash: o.profileHash, filledAt: typeof o.filledAt === "string" ? o.filledAt : "", items: o.items as DemoFillItem[] };
}

/**
 * The live demo's profile and its note: from the fill the build stored when
 * it was made for this profile, else worked out now (a row built before the
 * fill step, or one whose profile changed since). Every surface calls this.
 */
export function liveDemo(profile: ClinicProfile, stored: unknown = null): DemoSamples {
  const kept = demoFillOf(stored);
  const fill = kept && kept.profileHash === fillFingerprint(profile) ? kept : fillDemo(profile);
  return { profile: applyDemoFill(profile, fill), invented: inventedBy(fill), fill };
}

/** The profile for the live demo worked out now, with no stored fill. Kept for callers and tests that have only a profile. */
export function withDemoSamples(profile: ClinicProfile): DemoSamples {
  return liveDemo(profile, null);
}

/** For the voice call (DemoCallClinic.sampled): which values Aya has are samples. */
export function sampledForCall(fill: DemoFill): { prices: string[]; menu: boolean; hours: boolean; deposit: boolean } {
  return {
    prices: fill.items.flatMap((i) => (i.kind === "price" && i.basis === "benchmark" ? [i.service] : [])),
    menu: fill.items.some((i) => i.kind === "menu"),
    hours: fill.items.some((i) => i.kind === "hours"),
    deposit: fill.items.some((i) => i.kind === "deposit"),
  };
}

/**
 * The fill's sanity check, deterministic, run as the build stores it: it was
 * made for this profile; every item is a kind the page's note lists; every
 * benchmark price is the table's for that treatment and inside its published
 * range; every menu price is the table's; the hours and the deposit are the
 * samples, and each fills only what the website did not show. Each problem
 * is one sentence for the console; none means the fill may ship.
 */
export function checkDemoFill(profile: ClinicProfile, fill: DemoFill): string[] {
  const problems: string[] = [];
  if (fill.profileHash !== fillFingerprint(profile)) problems.push("The made-up values were worked out for a different profile.");
  const listed = new Set<string>(DEMO_SAMPLES);
  const seen = new Set<string>();
  for (const item of fill.items) {
    const kind = item.kind === "price" ? "prices" : item.kind;
    if (!listed.has(kind)) {
      problems.push(`A made-up item of kind "${String(item.kind)}" is not one the demo's note lists.`);
      continue;
    }
    switch (item.kind) {
      case "price": {
        const service = profile.services[item.index];
        if (!service || service.name !== item.service || isPriced(service.price)) {
          problems.push(`A made-up price for "${item.service}" fills no unpriced treatment on the menu.`);
          break;
        }
        if (item.basis === "consultation") {
          if (item.value !== CONSULTATION_PRICE) problems.push(`"${item.service}" was given "${item.value}" in place of a consultation.`);
          break;
        }
        const benchmark = benchmarkById(item.benchmark);
        const figure = priceFigure(item.value);
        if (!benchmark || benchmarkFor(item.service, profile.specialty)?.id !== benchmark.id) {
          problems.push(`The made-up price for "${item.service}" is not the benchmark for its kind.`);
        } else if (figure === null || figure < benchmark.range[0] || figure > benchmark.range[1]) {
          problems.push(`The made-up price ${item.value} for "${item.service}" is outside the benchmark range for ${benchmark.id}.`);
        }
        break;
      }
      case "menu":
        if (profile.services.length > 0) problems.push("A sample menu was made up for a clinic whose treatments were found.");
        for (const s of item.value) {
          const expected = benchmarkFor(s.name, profile.specialty)?.price ?? CONSULTATION_PRICE;
          if (s.price !== expected) problems.push(`The sample menu prices "${s.name}" at ${s.price ?? "nothing"}, not the benchmark.`);
        }
        break;
      case "hours":
        if (profile.hours.length > 0) problems.push("Sample hours were made up for a clinic whose hours were found.");
        if (JSON.stringify(item.value) !== JSON.stringify(SAMPLE_HOURS)) problems.push("The made-up hours are not the sample hours.");
        break;
      case "deposit":
        if (hasPolicy(profile)) problems.push("A sample deposit rule was made up for a clinic whose policy was found.");
        if (item.value !== SAMPLE_DEPOSIT_POLICY) problems.push("The made-up deposit rule is not the sample rule.");
        break;
      case "calendar":
        break;
    }
    if (item.kind !== "price") {
      if (seen.has(item.kind)) problems.push(`The made-up ${item.kind} appears twice.`);
      seen.add(item.kind);
    }
  }
  if (!seen.has("calendar")) problems.push("The made-up free times are missing from the fill.");
  return problems;
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
      return `Typical prices for the ${offer} we found without one`;
    case "hours":
      return "Your opening hours (Monday to Friday, 9 to 6)";
    case "deposit":
      return "A $50 deposit and its payment link, and a 24-hour cancellation rule";
  }
}

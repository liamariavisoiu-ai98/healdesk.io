import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  BACKUP_RETENTION_DAYS,
  getBaaTemplate,
  PAYMENTS_CLAUSE_BODY,
  PAYMENTS_CLAUSE_HEADING,
  prepareBaa,
  STATE_LAW_CLAUSE_HEADING,
  stateLawClauseBody140,
  TRANSCRIPT_RETENTION_DAYS,
  type BaaVariables,
} from "./baa";
import {
  BOOKING_SYSTEMS,
  bookingSyncFor,
  bookingSystemName,
  type BookingSystemId,
} from "./booking-systems";
import {
  CALENDAR_ACCOUNTS,
  CALENDAR_CLAUSE_HEADING,
  CALENDAR_CLAUSE_IDS,
  CALENDAR_LOCATION_PARAGRAPH,
  selectCalendarClause,
} from "./calendar-terms";
import {
  ANTHROPIC_RETENTION,
  applicableDpaClauses,
  CALENDAR_EVENT_FALLBACK_QUOTED,
  CALENDAR_PERSON_NOUNS,
  CURRENT_DPA_VERSION,
  currentDpaTemplate,
  DPA_ACTION_LABEL,
  DPA_ASSENT_LABEL,
  DPA_PRACTICE_DESCRIPTORS,
  DPA_TEMPLATES,
  DpaRenderError,
  dpaAssentSentence,
  getDpaTemplate,
  hashDpaText,
  isVeterinaryPractice,
  prepareDpa,
  renderDpa,
  type DpaVariables,
} from "./dpa";
import { dpaReviewDocument } from "./dpa-review";
import { plans, pricingCards } from "./plans";
import { regimeFor, specialties, type SpecialtyId } from "./specialties";
import { SUBPROCESSOR_NOTICE_HOURS, subprocessorNoticeClauseBody } from "./subprocessor-notice";

/**
 * The Data Protection Agreement, version dpa/1.0.0 (plan Part L): what it
 * must and must not say on every variant, read out of the rendered text,
 * because the text is what the owner releases and a practice signs.
 *
 * The golden hashes are frozen from this draft. Until the owner releases the
 * template an edit regenerates them in the same commit, with
 * docs/dpa-v1.0.0.txt; after the release they never move, and a change is a
 * new version at DPA_TEMPLATES[0].
 */

const SAMPLE: DpaVariables = {
  clinicLegalName: "Glow Med Spa LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@glowmedspa.test",
  effectiveDate: "2026-10-06",
  specialty: "med-spa",
  bookingSystem: "mindbody",
  calendarAccount: "personal",
};

const VET = { clinicLegalName: "Golden Paws Veterinary LLC", specialty: "veterinary" } as const;

/** One per status variant and calendar kind, and the systems that name a product. */
const VARIANTS: Record<string, Partial<DpaVariables>> = {
  // The sample in docs/dpa-v1.0.0.txt: answered No, Mindbody, a personal Google account.
  sample: {},
  notcovered_live_covered: { bookingSystem: "none", calendarAccount: "workspace_baa" },
  notcovered_live_uncovered: {
    specialty: "hair-restoration",
    bookingSystem: "calendly",
    calendarAccount: "workspace_no_baa",
  },
  notcovered_live_personal: {
    specialty: "massage-chiro",
    bookingSystem: "google_calendar",
    calendarAccount: "personal",
  },
  notcovered_notused_other: { bookingSystem: "other", calendarAccount: "workspace_no_baa" },
  vet_live_covered: { ...VET, bookingSystem: "none", calendarAccount: "workspace_baa" },
  vet_live_personal: { ...VET, bookingSystem: "gohighlevel", calendarAccount: "personal" },
  vet_notused_mindbody: { ...VET, bookingSystem: "mindbody", calendarAccount: "personal" },
};

/**
 * variant → sha256 of the assembled text. Frozen from the draft; see the
 * header. Regenerated on 13 October 2026 for the emailed transcript (BAA
 * 1.4.0's clauses 4, 11 and 14 in this document's words; the sample was
 * 7b4a1a97…bc49).
 */
const GOLDEN: Record<string, string> = {
  sample: "97058d2d2ca9ec0483a1cf2e2d459ee7d3ae3d0c9949ad38cc8dd052104dad05",
  notcovered_live_covered: "8c6d6208fcd9fb61ebc2a963769d7237abf0826960841cb92f849ecf69ea5ab1",
  notcovered_live_uncovered: "82c54ec7809a75bd0c6ebbcf86421783752ac70fbbdfa4c4652fdee83471e115",
  notcovered_live_personal: "a0022b647f6392e4889af06a623a9cd9b95f2ac45b32a6b7d74f3ac77674520b",
  notcovered_notused_other: "519ab25dbca268eb066bc4d7d4557e4338fa906645540fd036ecc76c5127988a",
  vet_live_covered: "cd06ffb631a2874f2d989d29dce2201b5523c685d533fd7863e35f76ea267ecd",
  vet_live_personal: "bdfc2a5f88a7cff623f589b8d1e5a1a91690ccd039f9326efee17e2c0571baa0",
  vet_notused_mindbody: "5dffa3fe690e4edee44aa8d4ebd6daaec60d5ba3ab46193eeecdfbe6838d2e9e",
};

const template = () => currentDpaTemplate();
const render = (overrides: Partial<DpaVariables>) =>
  prepareDpa(template(), { ...SAMPLE, ...overrides });

/** Text assertions compare through this: the 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

const DPA_SPECIALTIES = specialties
  .map((s) => s.id)
  .filter((id) => regimeFor(id) !== "hipaa") as SpecialtyId[];
const SYSTEMS = BOOKING_SYSTEMS.map((s) => s.id) as BookingSystemId[];

/** Every input the funnel can produce for a practice that signs the DPA. */
function everyAnswer(): Partial<DpaVariables>[] {
  const all: Partial<DpaVariables>[] = [];
  for (const specialty of DPA_SPECIALTIES) {
    for (const bookingSystem of SYSTEMS) {
      for (const calendarAccount of CALENDAR_ACCOUNTS) {
        all.push({ specialty, bookingSystem, calendarAccount });
      }
    }
  }
  return all;
}

/** The text of one numbered clause, from its number to the next clause's. */
function section(text: string, heading: string): string {
  const escaped = heading.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)(\\d+\\. ${escaped})\\n`).exec(text);
  expect(match, heading).not.toBeNull();
  const rest = text.slice(match!.index + match![1]!.length);
  const next = rest.slice(1).search(/\n\d+\. [A-Z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("DPA freeze", () => {
  for (const [name, hash] of Object.entries(GOLDEN)) {
    test(`${CURRENT_DPA_VERSION} / ${name} still renders the bytes drafted`, () => {
      expect(
        render(VARIANTS[name]!).hash,
        "The DPA text changed. Before release, regenerate these hashes and docs/dpa-v1.0.0.txt in the same commit; after release, add a new version.",
      ).toBe(hash);
    });
  }

  test("every variant is a distinct document", () => {
    const hashes = Object.values(GOLDEN);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("is registered once, namespaced, drafted and unreleased, and nothing in the text says so", () => {
    expect(DPA_TEMPLATES.map((t) => t.version)).toEqual(["dpa/1.0.0"]);
    expect(CURRENT_DPA_VERSION).toBe("dpa/1.0.0");
    expect(getDpaTemplate("dpa/1.0.0")).toBe(template());
    expect(getDpaTemplate("1.0.0")).toBeUndefined();
    expect(template().publishedOn).toBe("2026-10-06");
    // The owner's release is this flag, and only this flag.
    expect(template().approvedByCounsel).toBe(false);
    const text = render({}).text;
    expect(
      text.startsWith(
        "HEALDESK DATA PROTECTION AGREEMENT\nVersion 1.0.0 — executed electronically\n",
      ),
    ).toBe(true);
    expect(text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\[NAME|\{\{/);
  });

  test("the hash is SHA-256 of the exact text, and the clause ids are the variant", () => {
    const prepared = render({});
    expect(prepared.hash).toBe(hashDpaText(prepared.text));
    expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.version).toBe(CURRENT_DPA_VERSION);
    expect(prepared.clauseIds).toEqual(
      applicableDpaClauses(template(), { ...SAMPLE }).map((c) => c.id),
    );
  });
});

describe("DPA structure", () => {
  const ORDER = [
    "definitions",
    "status-not-covered",
    "instructions",
    "permitted-uses",
    "state-law",
    "payments",
    "data-sources",
    "google-calendar-not-used",
    "safeguards",
    "minimum-necessary",
    "subcontractors",
    "incidents",
    "requests",
    "confidentiality",
    "prohibited",
    "assistance",
    "term",
    "liability",
    "notices-and-law",
  ];

  test("the clause order is fixed: 22 registered, 19 render", () => {
    expect(template().clauses).toHaveLength(22);
    expect(render({}).clauseIds).toEqual(ORDER);
    const swap = (from: string, to: string) => (id: string) => (id === from ? to : id);
    expect(render(VARIANTS.vet_live_covered!).clauseIds).toEqual(
      ORDER.map(swap("status-not-covered", "status-veterinary")).map(
        swap("google-calendar-not-used", "google-calendar-covered"),
      ),
    );
    expect(render(VARIANTS.notcovered_live_personal!).clauseIds).toEqual(
      ORDER.map(swap("google-calendar-not-used", "google-calendar-uncovered")),
    );
  });

  // Renders the DPA for every answer the funnel can give: seconds of work, which a
  // loaded machine stretches past the five-second default.
  test("exactly one status clause and one calendar clause, for every answer the funnel can give", () => {
    const calendarIds = Object.values(CALENDAR_CLAUSE_IDS) as string[];
    for (const answers of everyAnswer()) {
      const ids = render(answers).clauseIds;
      const label = JSON.stringify(answers);
      expect(
        ids.filter((id) => id.startsWith("status-")),
        label,
      ).toHaveLength(1);
      expect(
        ids.filter((id) => calendarIds.includes(id)),
        label,
      ).toHaveLength(1);
      expect(ids, label).toHaveLength(19);
      expect(ids, label).toContain(
        isVeterinaryPractice(answers as DpaVariables) ? "status-veterinary" : "status-not-covered",
      );
    }
  }, 60_000);

  test("every clause predicate is total: it answers a boolean, whatever it is given", () => {
    const junk: unknown[] = [
      {},
      { specialty: undefined, bookingSystem: undefined, calendarAccount: undefined },
      { specialty: null, bookingSystem: null, calendarAccount: null },
      { specialty: "astrology", bookingSystem: "zenoti", calendarAccount: "gmail" },
      { specialty: 7, bookingSystem: ["none"], calendarAccount: { kind: "personal" } },
      { specialty: "veterinary", bookingSystem: "", calendarAccount: "" },
      { specialty: "dental", bookingSystem: "none", calendarAccount: "workspace_baa" },
      { ...SAMPLE, specialty: "toString" },
      { ...SAMPLE, bookingSystem: "constructor" },
    ];
    for (const variables of junk) {
      for (const clause of template().clauses) {
        let result: unknown;
        expect(
          () => {
            result = clause.appliesWhen(variables as DpaVariables);
          },
          `${clause.id} on ${JSON.stringify(variables)}`,
        ).not.toThrow();
        expect(typeof result, clause.id).toBe("boolean");
      }
    }
  });

  test("refuses to render with a missing or impossible variable", () => {
    const bad: Partial<Record<keyof DpaVariables, unknown>>[] = [
      { clinicLegalName: "" },
      { clinicLegalName: "   " },
      { clinicLegalName: undefined },
      { signatoryName: "" },
      { signatoryName: undefined },
      { signatoryEmail: "" },
      { signatoryEmail: undefined },
      { effectiveDate: "" },
      { effectiveDate: "not a date" },
      { specialty: undefined },
      { specialty: "astrology" },
      { specialty: "Veterinary & Pet Spas" },
      // A practice HIPAA always reaches signs the BAA, never this.
      { specialty: "plastic-surgery" },
      { specialty: "fertility" },
      { specialty: "dental" },
      { specialty: "glp1" },
      { bookingSystem: undefined },
      { bookingSystem: "zenoti" },
      { calendarAccount: undefined },
      { calendarAccount: "gmail" },
    ];
    for (const overrides of bad) {
      expect(
        () => renderDpa(template(), { ...SAMPLE, ...overrides } as DpaVariables),
        JSON.stringify(overrides),
      ).toThrow(DpaRenderError);
    }
  });

  test("a practice descriptor exists exactly for the specialties that may sign it", () => {
    for (const s of specialties) {
      const descriptor = DPA_PRACTICE_DESCRIPTORS[s.id];
      if (regimeFor(s.id) === "hipaa") expect(descriptor, s.id).toBeNull();
      else expect(descriptor, s.id).toMatch(/^an? .+ (practice|spa)$/);
    }
    expect(render({}).text).toContain(
      `Glow Med Spa LLC ("Practice"), a medical spa, dermatology or aesthetics\n  practice`,
    );
  });

  // Renders the DPA thirty-two times with the longest names: seconds of work, which a
  // loaded machine stretches past the five-second default.
  test("every line fits in 78 columns, the party and signatory lines included", () => {
    for (const answers of [...Object.values(VARIANTS), ...everyAnswer().slice(0, 24)]) {
      const text = render({
        ...answers,
        clinicLegalName: "The Very Long Legal Name Of A Practice That Keeps Going On And On LLC",
        signatoryName: "Alexandra Catherine Montgomery-Fitzwilliam Chen-Ramasubramanian",
        signatoryTitle: "Practice Owner and Medical Director of Operations",
      }).text;
      for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    }
  }, 60_000);
});

describe("what the DPA says", () => {
  // Renders the DPA for every answer the funnel can give: seconds of work, which a
  // loaded machine stretches past the five-second default.
  test("a veterinary practice's agreement never calls a person a patient, and neither does any other", () => {
    for (const answers of everyAnswer()) {
      // The one exception is the word the calendar event itself carries,
      // quoted as event.ts writes it for every practice: it names no person.
      const text = render(answers).text.split(CALENDAR_EVENT_FALLBACK_QUOTED).join("");
      expect(text, JSON.stringify(answers)).not.toMatch(/\bpatients?\b/i);
      expect(text, JSON.stringify(answers)).not.toMatch(/\bPHI\b/);
    }
    const vet = unwrap(render(VARIANTS.vet_live_covered!).text);
    expect(vet).toContain(
      "Practice is a veterinary practice or pet spa: it cares for animals. HIPAA protects health information about individuals, and an animal is not an individual under 45 CFR 160.103",
    );
    // The specialty is "Veterinary & Pet Spas": a grooming-only pet spa signs
    // this too, so nothing may state that every signer is a veterinary practice.
    expect(vet).not.toMatch(/(?<!Where )Practice is a veterinary practice[.,]/);
    expect(vet).toContain("the animal's owner or keeper. An animal is never a client.");
    expect(vet).toContain(
      "Each appointment carries a first name, the service and the time, and no other information about the client or the person booking.",
    );
    expect(vet).toContain(
      'The first name is the one given by the person booking, who may not be the client the appointment is for; where that name cannot be used, it is the word "Patient".',
    );
    expect(vet).toContain("and the name and species of the animal.");
    expect(vet).toContain(
      "Where Practice is a veterinary practice, state law may require it to keep what it knows about the animals in its care",
    );
    // The not-covered warranty, and the pause until a BAA replaces it, are not a vet's.
    const status = unwrap(section(render(VARIANTS.vet_live_covered!).text, "Practice's status"));
    expect(status).not.toMatch(
      /warrants|direct line|business associate agreement, which then replaces/,
    );
  }, 60_000);

  test("a practice that answered No warrants it, must say when that changes, and is paused until the BAA replaces this", () => {
    const text = unwrap(section(render({}).text, "Practice's status"));
    expect(text).toContain(
      "it sends no claim, eligibility check, prior authorisation or claim-status enquiry electronically to any health plan, itself or through anyone acting for it. Practice warrants that this is true on the effective date.",
    );
    expect(text).toContain(
      "Practice will tell healdesk in writing before it first sends any such transaction",
    );
    expect(text).toContain(
      "healdesk will pause the assistant for Practice until Practice signs healdesk's business associate agreement, which then replaces this agreement",
    );
    expect(text).toContain(
      "calls Practice forwards to healdesk pass straight through to Practice's direct line",
    );
    expect(text).not.toMatch(/veterinary|animal/i);
    for (const vetOnly of [
      "an animal in their care",
      "the name and species of the animal",
      "animals in its care",
    ]) {
      expect(unwrap(render({}).text), vetOnly).not.toContain(vetOnly);
    }
  });

  test("the subprocessor notice is 24 hours by email, with the right to object, in the shared sentence", () => {
    expect(SUBPROCESSOR_NOTICE_HOURS).toBe(24);
    for (const answers of Object.values(VARIANTS)) {
      const text = unwrap(render(answers).text);
      expect(text).toContain(unwrap(subprocessorNoticeClauseBody()));
      expect(text).toContain(
        "at least 24 hours' notice by email before adding one that will handle the information this agreement protects",
      );
      expect(text).toContain("Practice may terminate this agreement without penalty");
      expect(text).not.toMatch(/fifteen days|15 days/);
    }
  });

  test("Anthropic's 30-day retention is stated as BAA 1.2.1 states it", () => {
    const baa121 = unwrap(
      prepareBaa(getBaaTemplate("1.2.1")!, {
        clinicLegalName: "Golden Clinic LLC",
        specialty: "med-spa",
        signatoryName: "Alex Chen",
        signatoryEmail: "alex@golden.test",
        isCoveredEntity: true,
        attributionMode: "estimated",
        connectedPlatform: null,
        outboundMessaging: false,
        effectiveDate: "2026-09-13",
      } satisfies BaaVariables).text,
    );
    expect(baa121).toContain(`Anthropic ${ANTHROPIC_RETENTION}`);
    expect(unwrap(render({}).text)).toContain(`Anthropic ${ANTHROPIC_RETENTION}`);
  });

  test("the state-law clause is baa.ts's shared function in this document's words, and Payments its constant", () => {
    // The fuller clause BAA 1.3.0 carries, agreed between the funnel and the
    // BAA's pre-release redraft on 6 October 2026, in BAA 1.4.0's words since
    // 13 October (the transcript emailed, not kept): stateLawClauseBody140
    // with the subject "Client Information", its calendar text following the
    // booking sync, word for word.
    for (const answers of Object.values(VARIANTS)) {
      const variables = { ...SAMPLE, ...answers };
      const text = render(answers).text;
      const label = JSON.stringify(answers);
      const body = stateLawClauseBody140({
        subject: "Client Information",
        sync: bookingSyncFor(variables.bookingSystem),
      });
      expect(body, label).not.toMatch(/\bPHI\b|patient/i);
      expect(section(text, STATE_LAW_CLAUSE_HEADING), label).toBe(
        `5. ${STATE_LAW_CLAUSE_HEADING.toUpperCase()}\n\n${body}\n`,
      );
    }
    expect(unwrap(section(render({}).text, PAYMENTS_CLAUSE_HEADING))).toBe(
      unwrap(`6. ${PAYMENTS_CLAUSE_HEADING.toUpperCase()} ${PAYMENTS_CLAUSE_BODY}`),
    );
  });

  test("names other clauses by heading only where it has that heading", () => {
    // The shared state-law clause names this document's clauses by their
    // exact headings (baa.ts, STATE_LAW_HEADINGS.dpa); a heading changed here
    // has to change there too.
    for (const answers of everyAnswer()) {
      const text = render(answers).text;
      const headings = [...text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
      for (const [, heading] of unwrap(text).matchAll(/the clause headed "([^"]+)"/g)) {
        expect(
          headings.filter((h) => h === heading!.toUpperCase()),
          `${JSON.stringify(answers)}: "${heading}"`,
        ).toHaveLength(1);
      }
    }
  }, 60_000);

  // Renders BAA 1.3.0 and the DPA for every answer: seconds of work, which a
  // loaded machine stretches past the five-second default.
  test("the calendar clause is the one BAA 1.3.0 chooses, in the selector's words with the person a client", () => {
    const baa130 = getBaaTemplate("1.3.0")!;
    for (const answers of everyAnswer()) {
      const variables = { ...SAMPLE, ...answers };
      const prepared = render(answers);
      const label = JSON.stringify(answers);
      const selected = selectCalendarClause({
        bookingSystem: variables.bookingSystem,
        calendarAccount: variables.calendarAccount,
      });
      // The same clause id as BAA 1.3.0 renders for the same two answers.
      const baa = prepareBaa(baa130, {
        clinicLegalName: variables.clinicLegalName,
        specialty: "Med spa",
        signatoryName: variables.signatoryName,
        signatoryEmail: variables.signatoryEmail,
        effectiveDate: variables.effectiveDate,
        isCoveredEntity: false,
        attributionMode: "estimated",
        connectedPlatform: bookingSystemName(variables.bookingSystem),
        outboundMessaging: false,
        bookingSystem: variables.bookingSystem,
        calendarAccount: variables.calendarAccount,
      });
      expect(prepared.clauseIds, label).toContain(selected.clauseId);
      expect(baa.clauseIds, label).toContain(selected.clauseId);
      // Word for word the BAA's clause once the client is called a patient again.
      let dpaClause = unwrap(section(prepared.text, CALENDAR_CLAUSE_HEADING)).replace(
        /^\d+\. /,
        "",
      );
      for (const [patient, client] of CALENDAR_PERSON_NOUNS)
        dpaClause = dpaClause.split(client).join(patient);
      const baaClause = unwrap(section(baa.text, CALENDAR_CLAUSE_HEADING)).replace(/^\d+\. /, "");
      expect(dpaClause, label).toBe(baaClause);
      expect(unwrap(prepared.text), label).toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
    }
  }, 60_000);

  test("data sources promise calendar access only where the calendar clause, or an election, grants it", () => {
    const sources = (answers: Partial<DpaVariables>) =>
      unwrap(section(render(answers).text, "What healdesk reads from your systems"));
    expect(sources({})).toContain(
      "healdesk holds no credentials to Mindbody, or to any other practice-management or point-of-sale system",
    );
    // A booking system that reads no Google Calendar connects none; only an
    // election can give a location one, and then the clause stays true.
    expect(sources({})).toMatch(
      /during a call or chat, together with the calendar access any calendar election describes\.$/,
    );
    expect(sources(VARIANTS.notcovered_notused_other!)).not.toContain("Google Calendar clause");
    expect(sources(VARIANTS.notcovered_live_covered!)).toContain(
      "healdesk holds no credentials to any practice-management or point-of-sale system and reads nothing from one.",
    );
    expect(sources(VARIANTS.notcovered_live_covered!)).toContain(
      "during a call or chat, together with the calendar access the Google Calendar clause, or a calendar election that takes its place, describes.",
    );
  });

  test("what the assistant asks for is the booking catalogue as a ceiling, with no email, and nothing clinical", () => {
    const minimum = unwrap(
      section(render({}).text, "Minimum necessary, and who receives Client Information"),
    );
    expect(minimum).toContain(
      "a name, a telephone number, the service asked about, the times that suit them, whether they have been to Practice before, whether the visit is a consultation or a treatment, and any practitioner they prefer.",
    );
    // The one email address it names is Practice's own, where a transcript goes.
    expect(minimum.replace("the email address on Practice's healdesk account", "")).not.toMatch(
      /email address/,
    );
    expect(minimum).toContain(
      "It does not ask for a history, a medication or a diagnosis, and it never takes a card number.",
    );
    expect(minimum).toContain("its opening line says that it is an AI assistant");
    expect(minimum).toContain("No call audio is kept at all.");
    expect(minimum).toContain("It discloses Client Information to no one else.");
  });

  test("the term is the real offboarding clock: thirty days with the export delivered, ninety at most", () => {
    const term = unwrap(
      section(render({}).text, "Term, termination, and what happens to the information"),
    );
    expect(term).toContain(
      "Within thirty days after the Services end, healdesk will deliver to Practice an export",
    );
    expect(term).toContain(
      "at the first run once thirty days have passed since the Services ended, if the export has been delivered by then; otherwise at the first run after the export is delivered; and in any case at the first run once ninety days have passed since the Services ended, whether or not the export has been delivered.",
    );
    // Nothing of a client outlives destruction: since gates 6 and 7 a
    // deletion keeps no number, and destruction takes the rest.
    expect(term).toContain(
      "After it, healdesk holds no Client Information for Practice. Copies in encrypted database backups are deleted as those backups expire.",
    );
    expect(term).not.toMatch(/telephone number/);
    expect(term).toContain("nothing is destroyed because of the replacement");
    // Not the BAA's "within thirty days" destruction, which the code keeps only with the export delivered.
    expect(term).not.toMatch(/within thirty days of termination healdesk will return or destroy/i);
  });

  test("it carries no plan, price or channel: there is no such variable, and none reaches the text", () => {
    const base = render({});
    const withExtras = prepareDpa(template(), {
      ...SAMPLE,
      plan: "complete",
      planId: "web-voice",
      channels: ["web", "voice"],
      monthlyUsd: 897,
      price: 997,
      state: "WA",
      retentionDays: 30,
    } as unknown as DpaVariables);
    expect(withExtras.hash).toBe(base.hash);
    for (const answers of Object.values(VARIANTS)) {
      const text = render(answers).text;
      expect(text, JSON.stringify(answers)).not.toMatch(
        /\$|\bUSD\b|per month|monthly|annual|setup fee|package/i,
      );
      expect(text.replace(/health plans?/g, "")).not.toMatch(/\bplans?\b/i);
      for (const plan of plans) {
        expect(text).not.toContain(plan.name);
        expect(text).not.toContain(`"${plan.id}"`);
      }
      for (const card of pricingCards) expect(text).not.toContain(card.name);
      expect(text).not.toMatch(/Web Chatbot|Voice Agent|Meta Chatbot|FrontDesk/);
    }
  });

  test("names the party, notice address and Delaware law the BAA names", () => {
    const text = unwrap(render({}).text);
    expect(text).toContain(
      'Viixi FZC, a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates ("healdesk"), of 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to hello@healdesk.io',
    );
    // hello@ is healdesk's only email address (owner, 9 October 2026), as BAA 1.2.2 prints it.
    expect(text).not.toMatch(/legal@|privacy@/);
    expect(text).toContain("To healdesk: 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to hello@healdesk.io.");
    expect(text).toContain("governed by the laws of the State of Delaware");
    expect(text).toContain(
      "the email address of the signatory above, which is also the address of Practice's healdesk account",
    );
    expect(text).toContain("as section 14 of the Terms provides");
  });
});

/**
 * The funnel's pre-release changes (agreement-changes.md §12.14, "What remains
 * the funnel's to do"), each pinned against the clause BAA 1.3.0 states it
 * in, or against the shared clause it was reconciled with.
 */
describe("the DPA's pre-release text", () => {
  /** BAA 1.3.0, unwrapped, for the sample practice: the clauses the DPA follows. */
  const baa130 = () =>
    unwrap(
      prepareBaa(getBaaTemplate("1.3.0")!, {
        clinicLegalName: "Glow Med Spa LLC",
        specialty: "Med spa",
        signatoryName: "Alex Chen",
        signatoryEmail: "alex@glowmedspa.test",
        effectiveDate: "2026-10-06",
        isCoveredEntity: false,
        attributionMode: "estimated",
        connectedPlatform: "Mindbody",
        outboundMessaging: false,
        bookingSystem: "mindbody",
        calendarAccount: "personal",
      }).text,
    );

  test("defines a calendar election, as BAA 1.3.0's clause 1 does, and makes an accepted one part of it", () => {
    const definition =
      '"Calendar election" means the document, in the form healdesk provides, by which Practice sets the Google Calendar terms for one location, accepted for Practice by a person with authority to bind it. Once accepted, it forms part of this agreement.';
    expect(baa130()).toContain(definition);
    for (const answers of Object.values(VARIANTS)) {
      const text = render(answers).text;
      const definitions = unwrap(section(text, "Definitions"));
      expect(definitions, JSON.stringify(answers)).toContain(definition);
      // Defined before any clause uses the term: the state-law clause, the
      // data sources and the calendar clause's location paragraph all do.
      const flat = unwrap(text);
      expect(flat.search(/calendar election/i), JSON.stringify(answers)).toBe(
        flat.indexOf(definition) + 1,
      );
      expect(flat).toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
      expect(unwrap(section(text, "Notices, governing law, and interpretation"))).toContain(
        "This agreement (with any calendar election accepted under it), the Terms and the order Practice placed are the entire agreement",
      );
    }
  });

  test("a breach includes a state-law breach of security, as in BAA 1.3.0", () => {
    expect(unwrap(section(render({}).text, "Definitions"))).toContain(
      'A "breach" is the unauthorised acquisition of, or access to, Client Information that compromises its security, confidentiality or integrity, and also includes anything an applicable state breach-notification law treats as a breach of the security of Client Information.',
    );
  });

  test("every incident and breach is notified without unreasonable delay and within 60 calendar days, as BAA 1.3.0's one rule", () => {
    for (const answers of Object.values(VARIANTS)) {
      const incidents = unwrap(section(render(answers).text, "Reporting incidents and breaches"));
      // The spec's wording, one deadline for all three (owner, 9 October 2026).
      expect(incidents).toContain(
        "healdesk will notify Practice, by email to Practice's address in the Notices clause, of any of the following without unreasonable delay and in no case later than 60 calendar days after discovery: a. any use or disclosure of Client Information that this agreement does not permit, by healdesk or by a subcontractor; b. any breach; c. any security incident, including anything a state breach-notification law treats as a breach of the security of Client Information.",
      );
      // No other clock: not 1.2.1's five days, and not the internal 24 hours.
      expect(incidents).not.toMatch(/five (business|calendar) days|5 days|24 hours|twenty-four|immediately/i);
      expect(incidents).toContain(
        "Each notice is also a written report, sent to the same address and as complete as healdesk can then make it, and healdesk will add to the report promptly as information becomes available.",
      );
      for (const item of [
        "the identification of each client whose Client Information has been, or is reasonably believed by healdesk to have been, accessed, acquired, used or disclosed during the breach, sent by secure transfer as the Safeguards clause provides;",
        "a brief description of what happened, including the date of the breach and the date of its discovery;",
        "any steps clients should take to protect themselves from potential harm resulting from the breach;",
        "whether a law enforcement official required a notice to be delayed;",
      ]) {
        expect(incidents).toContain(item);
      }
      expect(incidents).toContain(
        "healdesk delays a notice only where a law enforcement official states that the notice would impede a criminal investigation or damage national security. It then delays it only for as long as the law that applies provides, and gives it as soon as that delay ends.",
      );
      // The shared clause's item f sends a state-law breach here.
      expect(unwrap(section(render(answers).text, STATE_LAW_CLAUSE_HEADING))).toContain(
        'report it, as the clause headed "Reporting incidents and breaches" provides for a breach.',
      );
    }
  });

  test('"without penalty" has the effect BAA 1.3.0 gives it, outside the liability exclusion and the indemnity', () => {
    const text = render({}).text;
    const term = unwrap(section(text, "Term, termination, and what happens to the information"));
    expect(term).toContain("Practice may also terminate it under the Subcontractors clause.");
    // The owner's rule of 12 October 2026, as 1.3.0's Term clause and Terms § 15 state it:
    // every termination ends the Services and the Fees that day; only Practice's termination
    // for healdesk's violation, or under the Subcontractors clause, is refunded, and only the
    // unused part of the paid period (dpa.md, gap 17).
    expect(term).toContain(
      "Terminating this agreement, however it is terminated, ends the Services on the same day, and no Fees accrue for any time after that day.",
    );
    expect(term).toContain(
      "Where Practice terminates because healdesk has violated a material term of this agreement, or under the Subcontractors clause, healdesk refunds the Fees Practice has paid for the time after that day: the prorated unused part of the subscription period Practice has paid for.",
    );
    expect(term).toContain(
      "The refund never includes a fee for setting up the Services or usage above the allowance already billed, and there is nothing to refund if Practice's subscription has not started under the Terms.",
    );
    expect(term).toContain(
      "Where healdesk terminates because Practice has materially breached this agreement, or this agreement ends in any other way, nothing is refunded.",
    );
    expect(term).toContain(
      "Terminating under the Subcontractors clause is therefore without penalty to Practice.",
    );
    // A replacing business associate agreement is not a termination: nothing stops.
    expect(term).toContain("the Services go on under it, and nothing is destroyed because of the replacement.");
    expect(unwrap(section(text, "Liability, and who indemnifies whom"))).toContain(
      "Nothing in this clause limits the refund the Term clause provides, and Practice's indemnity below does not extend to a claim for it.",
    );
    // And it prevails over the Terms on termination and the Fees, as 1.3.0's clause 1 does,
    // so the Terms' "not refundable" cannot take the refund back.
    expect(unwrap(section(text, "Definitions"))).toContain(
      "Where this agreement and the Terms conflict about Client Information, or about terminating this agreement and what then happens to the Services and the Fees, this agreement governs.",
    );
    // The promise it gives effect to, in the shared sentence.
    expect(unwrap(section(text, "Subcontractors"))).toContain(
      "Practice may terminate this agreement without penalty.",
    );
  });

  test("the instructions, requests and assistance clauses state each duty once, beside the shared clause", () => {
    const text = render({}).text;
    const shared = unwrap(section(text, STATE_LAW_CLAUSE_HEADING));
    const instructions = unwrap(section(text, "Practice's instructions"));
    const requests = unwrap(section(text, "Clients' requests"));
    const assistance = unwrap(section(text, "Assistance and audit"));

    // What the instructions are, and the notices and consents, are the shared clause's.
    expect(shared).toContain(
      "Practice's documented instructions to healdesk are this agreement and the settings Practice chooses in its portal, within the purposes below.",
    );
    expect(shared).toContain(
      "It will make sure its own notices, consents and any consumer health data privacy policy cover the processing this clause describes",
    );
    expect(instructions).toContain(
      `Practice's documented instructions to healdesk are those the clause headed "${STATE_LAW_CLAUSE_HEADING}" describes.`,
    );
    expect(instructions).not.toMatch(/through the Terms and the settings|is responsible for any notice/);
    // What only this clause says stays, the broader lawful-instruction promise included.
    expect(instructions).toContain(
      "healdesk will tell Practice if it believes an instruction would break a law that applies to Client Information, and need not follow that instruction.",
    );
    expect(instructions).toContain(
      "Practice will not ask healdesk to use or disclose Client Information in a way the law would not permit Practice itself to.",
    );

    // Deletion is the shared clause's item c; the help with any client's request stays here.
    expect(shared).toContain(
      "when Practice tells it to delete a person's information, delete it within ten business days from healdesk's own records",
    );
    expect(requests).toContain(
      `It will correct that information as Practice directs, and delete it as the clause headed "${STATE_LAW_CLAUSE_HEADING}" provides.`,
    );
    expect(requests).not.toContain("correct or delete that information as Practice directs");
    expect(requests).toContain(
      "healdesk will give Practice what it needs to answer within ten business days of Practice asking.",
    );
    // A request made to healdesk is any request, as the shared clause's pointer says, answered only in the reply.
    expect(shared).toContain(
      `A request made to healdesk directly is handled as the clause headed "Clients' requests" provides.`,
    );
    expect(requests).toContain(
      "If a client makes such a request, or any other request about their information, to healdesk itself rather than to Practice, healdesk will not act on it. It will pass the request to Practice within five business days and, in its reply to the client, tell them that healdesk cannot act on it and has passed it to Practice.",
    );

    // The state privacy laws' help is the shared clause's; every other law's stays here.
    expect(assistance).toContain(
      `For the state privacy laws, healdesk helps Practice as the clause headed "${STATE_LAW_CLAUSE_HEADING}" provides. For any other law that applies to Client Information, healdesk will give Practice the reasonable help it needs to meet its own obligations, including to answer a regulator or a client.`,
    );
    expect(assistance).toContain(
      "make its practices, books and records relating to Client Information available to a regulator",
    );
  });

  // A booking request's facts never change: drizzle/0039's trigger refuses a new
  // treatment or preferred_window even for the table owner (booking-transitions
  // test). So "correct that information as Practice directs", read alone,
  // promised a change the database forbids; BAA 1.3.0's audit found the same
  // promise in its clause 14(b) and fixed it (PT-17). The DPA takes that fix.
  test("a correction the record cannot take is appended and linked, in BAA 1.3.0's clause 14(b) words (PT-17)", () => {
    const pt17 = [
      "healdesk corrects a person's contact details in its own copy.",
      "It does not rewrite a booking request, an appointment record or the record of a conversation: it appends the amendment to that record and links the two, as 45 CFR 164.526(c)(1) provides.",
      "Every later export of that record, and every screen of healdesk's that shows it, then carries the amendment.",
    ];
    const baa = baa130();
    for (const sentence of pt17) expect(baa).toContain(sentence);
    // In this document's words: a correction, as a client asks for one, for a
    // client's details, and no HIPAA citation.
    const ours = pt17
      .map((s) =>
        s
          .replace(", as 45 CFR 164.526(c)(1) provides", "")
          .replaceAll("amendment", "correction")
          .replace("a person's", "a client's"),
      )
      .join(" ");
    expect(ours).not.toMatch(/amendment|CFR|\bpatient|\bPHI\b/i);
    for (const answers of Object.values(VARIANTS)) {
      const requests = unwrap(section(render(answers).text, "Clients' requests"));
      // Straight after the promise to correct, so the promise never reads alone.
      expect(requests, JSON.stringify(answers)).toContain(
        `It will correct that information as Practice directs, and delete it as the clause headed "${STATE_LAW_CLAUSE_HEADING}" provides. ${ours}`,
      );
    }
  });

  test("a deletion keeps a record of the request without the client's number, and its keyed references only for the backup window", () => {
    // Gates 6 and 7 (12 October 2026): the number no longer stays in
    // suppressions, and destruction takes everything, so neither clause
    // keeps a deleted client's number any more.
    const text = render({}).text;
    const requests = unwrap(section(text, "Clients' requests"));
    expect(requests).toContain(
      `When a client's information is deleted, healdesk keeps a record of the request that holds no telephone number, email address or name. For the ${BACKUP_RETENTION_DAYS} days in which a backup could still bring the information back, the record also holds one-way keyed references to the client's numbers, addresses and messaging accounts, and healdesk keeps Practice's own message asking for the deletion, both used only to delete the information again if a backup is restored; then both are removed.`,
    );
    expect(requests).not.toMatch(/telephone number of a client whose information is deleted is kept/);
    expect(unwrap(section(text, "Term, termination, and what happens to the information"))).not.toMatch(
      /except the telephone number/,
    );
  });

  // The owner's decision after BAA 1.3.0's second read (12 October 2026,
  // findings B1-B4): the Meta scoping says what the assistant is instructed
  // to do and that its replies are filtered, as clause 16 of 1.3.0 does,
  // never that it handles no clinical content or confirms no appointment.
  test("on Meta it describes the safeguards rather than promising the outcome, as BAA 1.3.0 does", () => {
    for (const [name, overrides] of Object.entries(VARIANTS)) {
      const prohibited = unwrap(section(render(overrides).text, "What healdesk is not authorised to do"));
      expect(prohibited, name).toContain(
        "where Practice connects them, the assistant replies there only inside a conversation the client started. It is instructed not to handle clinical content or confirm appointment details there and to move anything clinical to a call or to Practice's own secure route, and each reply the language model writes there is checked by automated filters designed to keep both out.",
      );
      expect(prohibited, name).not.toMatch(/handles no clinical content|confirms no appointment details/);
    }
  });
});

describe("retention during the term", () => {
  // BAA 1.3.0 clause 11's periods, which the nightly purge runs for every
  // DPA practice; until 12 October 2026 the DPA stated none (dpa.md, gap 2).
  // Since 13 October in BAA 1.4.0's words: the conversation's record without
  // the words, and nothing for the portal to shorten.
  test("states the purge's periods on every variant, and keeps no transcript for the portal to shorten", () => {
    for (const [name, overrides] of Object.entries(VARIANTS)) {
      const minimum = unwrap(
        section(render(overrides).text, "Minimum necessary, and who receives Client Information"),
      );
      expect(minimum, name).toContain(
        `healdesk keeps the record of each conversation, without what was said or written in it, for ${TRANSCRIPT_RETENTION_DAYS} days after it took place, and each appointment record for ${TRANSCRIPT_RETENTION_DAYS} days after the appointment's time.`,
      );
      expect(minimum, name).toContain(
        `It keeps each booking request for ${TRANSCRIPT_RETENTION_DAYS} days after the latest of when it was made, the time it was confirmed for and its appointment's time.`,
      );
      // No transcript is kept, and the portal's setting to shorten it is gone.
      expect(minimum, name).not.toMatch(/shorten/);
      expect(minimum, name).not.toContain("with its transcript");
      expect(minimum, name).toContain(
        `A backup copy of anything healdesk deletes expires within ${BACKUP_RETENTION_DAYS} days of the deletion.`,
      );
    }
  });

  // The owner's decision of 13 October 2026, as BAA 1.4.0 clauses 11 and 14
  // state it (apps/app lib/conversations/transcript-outbox.ts, drizzle/0069).
  test("emails each transcript to Practice's one address, holds one copy for seven days, and says who answers for it after", () => {
    const baa = unwrap(
      prepareBaa(getBaaTemplate("1.4.0")!, {
        clinicLegalName: "Glow Med Spa LLC",
        specialty: "Med spa",
        signatoryName: "Alex Chen",
        signatoryEmail: "alex@glowmedspa.test",
        effectiveDate: "2026-10-06",
        isCoveredEntity: false,
        attributionMode: "estimated",
        connectedPlatform: "Mindbody",
        outboundMessaging: false,
        bookingSystem: "mindbody",
        calendarAccount: "personal",
      }).text,
    );
    for (const [name, overrides] of Object.entries(VARIANTS)) {
      const text = render(overrides).text;
      const minimum = unwrap(section(text, "Minimum necessary, and who receives Client Information"));
      const transcripts =
        "healdesk does not keep transcripts. When a call or a website chat ends, healdesk emails its transcript to the email address on Practice's healdesk account, and to no other address, only over an encrypted connection, as the Safeguards clause provides. So that an email that fails or is returned can be sent again, healdesk holds one encrypted copy of the transcript until seven days after the email was first accepted for delivery or, if it never is, seven days after the transcript was queued for sending, and then deletes it. Until then healdesk may send the email again when a send fails or the email is returned, and when Practice asks. healdesk keeps no other copy of a transcript, apart from the backups described below; what Anthropic keeps is what the Subcontractors clause describes. Once healdesk's copy is deleted, the email is Practice's own record of what was said, and Practice is responsible for keeping, protecting and deleting it.";
      // The BAA's paragraph, word for word: it names no patient.
      expect(baa, name).toContain(transcripts);
      expect(minimum, name).toContain(transcripts);
      const requests = unwrap(section(text, "Clients' requests"));
      expect(requests, name).toContain(
        `healdesk holds a transcript only to deliver it to Practice, and only for the days the clause headed "Minimum necessary, and who receives Client Information" allows. After them healdesk has no transcript to give Practice, correct or delete: the email that carried it is Practice's own record, and Practice answers a request about a transcript from that email.`,
      );
      const stateLaw = unwrap(section(text, STATE_LAW_CLAUSE_HEADING));
      expect(stateLaw, name).toContain(
        "e. email Practice the transcript of each call and website chat, keep records of those conversations, without what was said or written in them, and of bookings,",
      );
      expect(stateLaw, name).not.toMatch(/kept as transcripts|keep transcripts/);
    }
  });
});

describe("assent", () => {
  test("labels its own document, never the BAA", () => {
    expect(DPA_ASSENT_LABEL).toBe("I agree to the Data Protection Agreement");
    expect(DPA_ACTION_LABEL).toBe("Sign and continue");
    expect(dpaAssentSentence("  Golden Paws LLC ")).toBe(
      "I agree to the Data Protection Agreement on behalf of Golden Paws LLC, and I confirm I am authorised to enter into it.",
    );
    expect(dpaAssentSentence("")).toContain("on behalf of my practice");
    expect(dpaAssentSentence("X")).not.toMatch(/Business Associate/);
  });
});

describe("docs/dpa-v1.0.0.txt", () => {
  const read = () =>
    readFileSync(fileURLToPath(new URL("../../../docs/dpa-v1.0.0.txt", import.meta.url)), "utf8");
  const RULE = "-".repeat(78);

  test("is exactly what the renderer produces: run npm run dpa:review -w @healdesk/catalog after any clause change", () => {
    expect(read() === dpaReviewDocument(), "docs/dpa-v1.0.0.txt is stale: run npm run dpa:review -w @healdesk/catalog").toBe(true);
  });

  test("the sample is exactly what a practice that answered No, on Mindbody and a personal account, signs", () => {
    const doc = read();
    const parts = doc.split(`\n${RULE}\n\n`);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[1]!.trimEnd()).toBe(render({}).text);
    expect(doc).toContain(GOLDEN.sample);
  });

  // Renders the DPA for every answer the funnel can give: seconds of work, which a
  // loaded machine stretches past the five-second default.
  test("every clause that renders only for some practices is printed as it renders", () => {
    const flat = unwrap(read());
    for (const answers of everyAnswer()) {
      // The appendix prints the veterinary clauses for the vet sample practice.
      const vet = isVeterinaryPractice(answers as DpaVariables);
      const text = render(
        vet ? { ...answers, clinicLegalName: VET.clinicLegalName } : answers,
      ).text;
      for (const heading of [
        "Definitions",
        "Practice's status",
        STATE_LAW_CLAUSE_HEADING,
        "What healdesk reads from your systems",
        CALENDAR_CLAUSE_HEADING,
        "Minimum necessary, and who receives Client Information",
        "Confidentiality",
      ]) {
        const body = unwrap(section(text, heading).replace(/^\d+\. [^\n]+\n/, ""));
        expect(flat, `${heading} for ${JSON.stringify(answers)}`).toContain(body);
      }
    }
  }, 60_000);
});

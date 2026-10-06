import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  getBaaTemplate,
  PAYMENTS_CLAUSE_BODY,
  PAYMENTS_CLAUSE_HEADING,
  prepareBaa,
  STATE_LAW_CLAUSE_BODY,
  STATE_LAW_CLAUSE_HEADING,
  type BaaVariables,
} from "./baa";
import { BOOKING_SYSTEMS, bookingSystemName, type BookingSystemId } from "./booking-systems";
import {
  CALENDAR_ACCOUNTS,
  CALENDAR_CLAUSE_IDS,
  CALENDAR_LOCATION_PARAGRAPH,
  selectCalendarClause,
} from "./calendar-terms";
import {
  ANTHROPIC_RETENTION,
  applicableDpaClauses,
  CALENDAR_PERSON_NOUNS,
  CURRENT_DPA_VERSION,
  currentDpaTemplate,
  DPA_ACTION_LABEL,
  DPA_ASSENT_LABEL,
  DPA_PRACTICE_DESCRIPTORS,
  DPA_STATE_LAW_CLAUSE_BODY,
  DPA_STATE_LAW_EDITS,
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

/** variant → sha256 of the assembled text. Frozen from the draft; see the header. */
const GOLDEN: Record<string, string> = {
  sample: "bc4ab48ea0f315f167d3593f21f9fd207a2801abb1a68a71650a55df6010f854",
  notcovered_live_covered: "949fc016193ee6fa363c842fce2916cd0c1812b3376b2257489f80d8f8b08622",
  notcovered_live_uncovered: "2a4cb0c9f3961dee6cb68dee30c40b0f96af1e2ce23d11f4a1fa62cf560c5806",
  notcovered_live_personal: "d53e5a4518ec3bf6c0e8b406d128064108f27e5f551826e9a59ece1abbe1e42c",
  notcovered_notused_other: "70c6c967944dd65b293752df2b53898eb0ead1c16d5ef04042225426ddac5573",
  vet_live_covered: "8d6b55b91f1e29d9e8548eb907fe9af54f63d01d00d4932defc198663e6e1a75",
  vet_live_personal: "273a2f69ea5b080fa5a740f5e1dbea7b024173fb54da927826b3c6dc1cfaf51e",
  vet_notused_mindbody: "759839ef6f1352ba6de1a3578dbd9439d756218454c6c74bf93d3ccca2a98b59",
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
  });

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
  });
});

describe("what the DPA says", () => {
  test("a veterinary practice's agreement never calls a person a patient, and neither does any other", () => {
    for (const answers of everyAnswer()) {
      const text = render(answers).text;
      expect(text, JSON.stringify(answers)).not.toMatch(/\bpatients?\b/i);
    }
    const vet = unwrap(render(VARIANTS.vet_live_covered!).text);
    expect(vet).toContain(
      "Practice is a veterinary practice or pet spa: it cares for animals. HIPAA protects health information about individuals, and an animal is not an individual under 45 CFR 160.103",
    );
    // The specialty is "Veterinary & Pet Spas": a grooming-only pet spa signs
    // this too, so nothing may state that every signer is a veterinary practice.
    expect(vet).not.toMatch(/(?<!Where )Practice is a veterinary practice[.,]/);
    expect(vet).toContain("the animal's owner or keeper. An animal is never a client.");
    expect(vet).toContain("Each appointment carries the client's first name");
    expect(vet).toContain("and the name and species of the animal.");
    expect(vet).toContain(
      "Where Practice is a veterinary practice, state law may require it to keep what it knows about the animals in its care",
    );
    // The not-covered warranty, and the pause until a BAA replaces it, are not a vet's.
    const status = unwrap(section(render(VARIANTS.vet_live_covered!).text, "Practice's status"));
    expect(status).not.toMatch(
      /warrants|direct line|business associate agreement, which then replaces/,
    );
  });

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

  test("the state-law and Payments clauses quote baa.ts's constants, with only the edits recorded", () => {
    const [from, to] = DPA_STATE_LAW_EDITS.opening;
    expect(STATE_LAW_CLAUSE_BODY).toBe(
      `${from}${DPA_STATE_LAW_CLAUSE_BODY.slice(to.length)} ${DPA_STATE_LAW_EDITS.droppedLastSentence}`,
    );
    expect(DPA_STATE_LAW_CLAUSE_BODY).not.toMatch(/\bPHI\b|patient/);
    const text = render({}).text;
    expect(section(text, STATE_LAW_CLAUSE_HEADING)).toContain(
      `${STATE_LAW_CLAUSE_HEADING.toUpperCase()}\n\n`,
    );
    expect(unwrap(section(text, STATE_LAW_CLAUSE_HEADING))).toContain(DPA_STATE_LAW_CLAUSE_BODY);
    expect(unwrap(section(text, PAYMENTS_CLAUSE_HEADING))).toBe(
      unwrap(`6. ${PAYMENTS_CLAUSE_HEADING.toUpperCase()} ${PAYMENTS_CLAUSE_BODY}`),
    );
  });

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
      let dpaClause = unwrap(section(prepared.text, "Practice's Google Calendar")).replace(
        /^\d+\. /,
        "",
      );
      for (const [patient, client] of CALENDAR_PERSON_NOUNS)
        dpaClause = dpaClause.split(client).join(patient);
      const baaClause = unwrap(section(baa.text, "Practice's Google Calendar")).replace(
        /^\d+\. /,
        "",
      );
      expect(dpaClause, label).toBe(baaClause);
      expect(unwrap(prepared.text), label).toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
    }
  });

  test("data sources promise calendar access only where the calendar clause grants it", () => {
    const sources = (answers: Partial<DpaVariables>) =>
      unwrap(section(render(answers).text, "What healdesk reads from your systems"));
    expect(sources({})).toContain(
      "healdesk holds no credentials to Mindbody, or to any other practice-management or point-of-sale system",
    );
    expect(sources({})).toMatch(/during a call or chat\.$/);
    expect(sources(VARIANTS.notcovered_live_covered!)).toContain(
      "healdesk holds no credentials to any practice-management or point-of-sale system and reads nothing from one.",
    );
    expect(sources(VARIANTS.notcovered_live_covered!)).toContain(
      "during a call or chat, together with the calendar access the Google Calendar clause describes.",
    );
    expect(sources(VARIANTS.notcovered_notused_other!)).not.toContain("calendar access");
  });

  test("what the assistant asks for is the booking catalogue as a ceiling, with no email, and nothing clinical", () => {
    const minimum = unwrap(
      section(render({}).text, "Minimum necessary, and who receives Client Information"),
    );
    expect(minimum).toContain(
      "a name, a telephone number, the service asked about, the times that suit them, whether they have been to Practice before, whether the visit is a consultation or a treatment, and any practitioner they prefer.",
    );
    expect(minimum).not.toMatch(/email address/);
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
    expect(term).toContain(
      "healdesk holds no Client Information for Practice except the telephone number of any client who asked to have their information deleted",
    );
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
      'Viixi FZC, a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates ("healdesk"), of 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to legal@healdesk.io',
    );
    expect(text).toContain("governed by the laws of the State of Delaware");
    expect(text).toContain(
      "the email address of the signatory above, which is also the address of Practice's healdesk account",
    );
    expect(text).toContain("as section 14 of the Terms provides");
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

  test("the sample is exactly what a practice that answered No, on Mindbody and a personal account, signs", () => {
    const doc = read();
    const parts = doc.split(`\n${RULE}\n\n`);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[1]!.trimEnd()).toBe(render({}).text);
    expect(doc).toContain(GOLDEN.sample);
  });

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
        "What healdesk reads from your systems",
        "Practice's Google Calendar",
        "Minimum necessary, and who receives Client Information",
        "Confidentiality",
      ]) {
        const body = unwrap(section(text, heading).replace(/^\d+\. [^\n]+\n/, ""));
        expect(flat, `${heading} for ${JSON.stringify(answers)}`).toContain(body);
      }
    }
  });
});

import {
  BAA_RELEASE_OVERLAP,
  BAA_TEMPLATES,
  BaaRenderError,
  CALENDAR_CLAUSE_IDS_1_3,
  CALENDAR_LOCATION_PARAGRAPH,
  CURRENT_BAA_VERSION,
  currentCalendarElection,
  currentDirectBookingAddendum,
  getBaaTemplate,
  hashCalendarElection,
  hashDirectBookingAddendum,
  MIN_ACCEPTABLE_BAA_VERSION,
  prepareBaa,
  renderCalendarElection,
  renderDirectBookingAddendum,
  selectCalendarClause,
  subprocessorNoticeClauseBody,
  type BaaVariables,
  type CalendarElectionVariables,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

/**
 * The clause library is frozen per template version, and this is the freeze.
 *
 * Every acceptance row stores the SHA-256 of the exact text the clinic
 * signed. That hash is only evidence if the same template version still
 * renders the same bytes years later — and the versions share clause objects
 * (1.0.0 and 0.1.0-draft share one array, and 1.2.0 reuses 1.0.0 and 1.1.0
 * objects by lookup; see packages/catalog/src/baa.ts), so editing a clause
 * "for the next version" silently rewrites what every existing signer's
 * hash points at. The golden hashes below make that edit a failing test.
 *
 * The rule the failure enforces: a change to any clause body, heading,
 * order, predicate or the preamble is a NEW template version. Add it at
 * BAA_TEMPLATES[0] with approvedByCounsel decided honestly, add its hashes
 * here, and leave the old version's entries alone — they are the record.
 *
 * Regenerate a hash only when you have deliberately published a new version:
 *   npx tsx -e 'import("@healdesk/catalog").then(...)' — or simply run this
 *   test and copy the "received" value for the NEW version only.
 *
 * 1.3.0 was released on 2026-10-12 and is what clinics sign; its hashes are
 * the record from that day on (docs/counsel/agreement-changes.md §12.12,
 * §12.15). 1.2.2 was released on 2026-10-09 and replaced outright by 1.3.0
 * before any clinic signed it; it is frozen like the rest. 1.2.1 was
 * released on 2026-10-01 and replaced by 1.2.2 before any clinic signed it.
 * 1.0.0 and 0.1.0-draft have been signed; their hashes never move. 1.2.0 was
 * offered for part of 1 October and is frozen too. 1.1.0-draft was
 * superseded by 1.2.0 without ever being offered; it is frozen too, because
 * docs/counsel/ quotes its rendering.
 */

const BASE: BaaVariables = {
  clinicLegalName: "Golden Clinic LLC",
  specialty: "med-spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@golden.test",
  isCoveredEntity: true,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: false,
  effectiveDate: "2026-09-13",
  // Read only from 1.3.0 on; every earlier version renders the same bytes
  // whatever they hold, which the golden loop below proves by rendering
  // every version with them set.
  bookingSystem: "none",
  calendarAccount: "workspace_baa",
};

/** Text assertions compare through this: the 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ");

/** Shared by every version. The two 1.1.0-only selections are in VARIANTS_1_1. */
const VARIANTS: Record<string, Partial<BaaVariables>> = {
  covered_estimated: {},
  notcovered_estimated: { isCoveredEntity: false },
  unknown_estimated: { isCoveredEntity: null },
  covered_outbound: { outboundMessaging: true },
  // bookingSystem is read only by 1.3.0, whose guard requires the platform it
  // names to be the booking system's.
  covered_verified_boulevard: {
    attributionMode: "verified",
    connectedPlatform: "Boulevard",
    bookingSystem: "boulevard",
  },
};

/** version → variant → sha256 of the assembled text. Append-only. */
const GOLDEN: Record<string, Record<string, string>> = {
  // Released on 2026-10-12 and offered from that day (agreement-changes.md
  // §12.15). Frozen from the release: these are the bytes clinics sign.
  // Moved while it was a draft by the pre-release audit's redraft of 6
  // October 2026 (§12.12, §12.14), on 7 October by clause 11's sentence
  // giving booking requests their own period, on 9 October by the owner's
  // decisions that 1.2.2 carries too (§13), and last by the release audit's
  // two text fixes of 12 October (§12.15): the period for transcripts in
  // clause 11, and the appointment record in clause 14(b). No
  // covered_verified_boulevard: 1.3.0 refuses verified reporting, which it
  // does not describe (HRC-17).
  "1.3.0": {
    covered_estimated: "2235429b5b23f49ae004ad2d414bfba630e108bdd36f7793dd1712859844d607",
    notcovered_estimated: "ff38a96ddd458be2cda8b846e3f88563f2478605051520210ea1899911cf5757",
    unknown_estimated: "1106e91ca18edc9c390808b2898510d6a4c3356dfa56c1d5c35d59f84568f741",
    // Identical to covered_estimated by design, as in 1.2.x: no clause reads
    // outboundMessaging.
    covered_outbound: "2235429b5b23f49ae004ad2d414bfba630e108bdd36f7793dd1712859844d607",
  },
  // Released on 2026-10-09 and offered until 1.3.0 replaced it on 2026-10-12
  // (agreement-changes.md §13). No clinic signed it; frozen from the release
  // all the same, as every released version is.
  "1.2.2": {
    covered_estimated: "e6cfb7356be47a223bf8802f8d762f78844e0106af29fe772ca03eab85621893",
    notcovered_estimated: "07551348644ed59f47dd0a8ae5ff66ccb6297334d9360a25a6ec70bb247f4127",
    unknown_estimated: "ecdd2ce97442408babcf39326aae73442540474b60113234e5b23df3b56456bf",
    // Identical to covered_estimated by design, as in 1.2.0 and 1.2.1: no
    // clause reads outboundMessaging. Asserted below rather than left to look
    // like a typo.
    covered_outbound: "e6cfb7356be47a223bf8802f8d762f78844e0106af29fe772ca03eab85621893",
    covered_verified_boulevard: "d75c7113583d6b13ff11efc02e459e30671f074024f12ce5b09396be6756f06a",
  },
  // Released on 2026-10-01 and replaced by 1.2.2 on 2026-10-09, before any
  // clinic signed it. Frozen like every other superseded version.
  "1.2.1": {
    covered_estimated: "618ac4a585a42f23d70865042c5a02e0b4765c07b6e65ba8ecf586e8f386cfd3",
    notcovered_estimated: "e25654221985d32abf70894a1094183bea6807bb1672517792524f55489e6938",
    unknown_estimated: "b804a6234271183a37a532fa46ab7ca9af3c44c814324d62819e2827c058f37a",
    // Identical to covered_estimated by design, as in 1.2.0: no clause reads
    // outboundMessaging. Asserted below rather than left to look like a typo.
    covered_outbound: "618ac4a585a42f23d70865042c5a02e0b4765c07b6e65ba8ecf586e8f386cfd3",
    covered_verified_boulevard: "2c46b7591f2aa7faf6ea82ba0f4f610bb598aacd8559a602a4e8f88027d39ba3",
  },
  // Offered for part of 1 October 2026, then replaced by 1.2.1 for five
  // accuracy fixes. Frozen like every other superseded version.
  "1.2.0": {
    covered_estimated: "f91e1a91870060d46383b827f2e13ce25026802eae1f03b8c91ddf64b19f857b",
    notcovered_estimated: "76ca06a2278624fb25f80196f4ac09ae02126bc0428b0cc7ea5faac79cb133de",
    unknown_estimated: "14263cb8fdf727eab8f62d2a65297054dfae8bbee6f6d5d494abb91791cfe0b0",
    // Identical to covered_estimated by design: v1 is inbound only, and 1.2.0
    // registers no clause keyed to outboundMessaging. Asserted below rather
    // than left to look like a typo.
    covered_outbound: "f91e1a91870060d46383b827f2e13ce25026802eae1f03b8c91ddf64b19f857b",
    covered_verified_boulevard: "add485c326b9b8a8ce638852ad50b012a143df636fe9b3e96bd72d421578b928",
  },
  "1.0.0": {
    covered_estimated: "5a41c9f462386a8ee10d56510e9a6cde6ac360bd5994bca62ddb136dc22596d1",
    notcovered_estimated: "a661fd17d3265e43e559a1cd757475c1ebe9219ce3cf5a7f9691225e74ed69ce",
    unknown_estimated: "3e760495855a168b75cc09982e9b99866d0d7caaaf7cf79d6b1fdf659bd2036a",
    covered_outbound: "2237de75745e9d321cb40dd94d78a953c2aefb8b0f11250b746921a1cb459de2",
    covered_verified_boulevard: "a5ed2a49f75fe51738faa1b034478744d4c4be507568b4ef0abe804d9628514f",
  },
  "1.1.0-draft": {
    covered_estimated: "04b0f770a6d74fb58f359b9327bffe1e92ad8536771dccd0bc8310c36de83d17",
    notcovered_estimated: "4680127d9b109aa4f6629405daffea050838424c6c67c4feac40c656d5b073cc",
    unknown_estimated: "139ecbcbf9bcebf1ece1fda5f5a495820551062762fbddde2f69a405e872fa0f",
    // Identical to covered_estimated by design: the consent warranty is gone
    // and outboundMessaging keys only reactivation-gate, which a covered
    // clinic never gets. Asserted below rather than left to look like a typo.
    covered_outbound: "04b0f770a6d74fb58f359b9327bffe1e92ad8536771dccd0bc8310c36de83d17",
    covered_verified_boulevard: "6865ae146439bc9a518c55d5552893b3720c42b76794ad4518fd7b72f42dd40c",
  },
  "0.1.0-draft": {
    covered_estimated: "c3b3dd686657413921e674bed4a1bc3a38f14a5dfd1322c1f53657a2123c0e6b",
    notcovered_estimated: "36272d6588e9223a41b5ad4b390d4136172d4adb8569f87c29ba43b563b5bb97",
    unknown_estimated: "cb20dcffef44d969b48083db8e9a4cf32c440c59e43cda5908c4e1313d2bd8a5",
    covered_outbound: "6177d45f5b1c85951b5a2cca1851fd2945fe3078d651c664989b0d38f88ef588",
    covered_verified_boulevard: "fe7f6b48d5066d7723c0d397a0e414f48412985119ad393bba8e479afbd633a5",
  },
};

describe("BAA template freeze", () => {
  test("every published version has golden hashes, and nothing else does", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(BAA_TEMPLATES.map((t) => t.version).sort());
    expect(GOLDEN[CURRENT_BAA_VERSION]).toBeDefined();
  });

  for (const [version, variants] of Object.entries(GOLDEN)) {
    for (const [name, hash] of Object.entries(variants)) {
      test(`${version} / ${name} still renders the bytes that were signed`, () => {
        const template = getBaaTemplate(version);
        expect(template, `template ${version} was removed — signed hashes point at it`).toBeDefined();
        const prepared = prepareBaa(template!, { ...BASE, ...VARIANTS[name]! });
        expect(
          prepared.hash,
          `The ${version} agreement text changed. A clause edit is a NEW template version, never a rewrite of one people signed.`,
        ).toBe(hash);
      });
    }
  }

  test("the variants genuinely differ — the predicates are live, not decorative", () => {
    // One coincidence is by design and is asserted as such: outboundMessaging
    // selects nothing since 1.2.0, so covered_outbound IS covered_estimated.
    // Every other variant is a distinct document. 1.3.0, the current
    // version, has no covered_verified_boulevard (it refuses verified
    // reporting), so this reads both it and 1.2.2, which has all five.
    for (const version of [CURRENT_BAA_VERSION, "1.2.2"]) {
      const golden = GOLDEN[version]!;
      expect(golden.covered_outbound, version).toBe(golden.covered_estimated);
      const distinct = Object.entries(golden)
        .filter(([name]) => name !== "covered_outbound")
        .map(([, hash]) => hash);
      expect(new Set(distinct).size, version).toBe(Object.keys(golden).length - 1);
    }
    expect(Object.keys(GOLDEN["1.2.2"]!)).toEqual(Object.keys(VARIANTS));
  });
});

/**
 * 1.1.0-draft only: the two selections the booking-and-callbacks design of
 * 23 September 2026 added to BaaSelections. They are kept out of VARIANTS
 * because no 1.0.0 or 0.1.0-draft clause reads them — a signed document must
 * render the same bytes whatever they hold, which the first test below pins.
 */
const DRAFT_110 = "1.1.0-draft";

const VARIANTS_1_1: Record<string, Partial<BaaVariables>> = {
  covered_direct: { bookingMode: "direct" },
  covered_calendar: { calendarWrite: { platform: "Cal.com" } },
};

/** variant → sha256, for 1.1.0-draft. Regenerated only with the draft. */
const GOLDEN_1_1: Record<string, string> = {
  covered_direct: "4ed0605511e23346001cf5591d84932368c3beda8c82fad0f60d147af25dfb6a",
  covered_calendar: "b427452bc54b546be6902c053b5200da8a7554893cc0ee53d285dca420713800",
};

describe("1.1.0-draft: booking mode, calendar write and callbacks", () => {
  const draft = () => getBaaTemplate(DRAFT_110)!;
  const render = (overrides: Partial<BaaVariables>) => prepareBaa(draft(), { ...BASE, ...overrides });
  const everyVariant = () => [
    ...Object.values(VARIANTS),
    ...Object.values(VARIANTS_1_1),
    { outboundMessaging: true, isCoveredEntity: null } as Partial<BaaVariables>,
  ];

  for (const [name, hash] of Object.entries(GOLDEN_1_1)) {
    test(`${DRAFT_110} / ${name} still renders the bytes under review`, () => {
      expect(render(VARIANTS_1_1[name]!).hash).toBe(hash);
    });
  }

  test("the signed versions ignore both selections — nothing anyone signed can change", () => {
    for (const version of ["1.0.0", "0.1.0-draft"]) {
      const template = getBaaTemplate(version)!;
      const base = prepareBaa(template, BASE).hash;
      expect(base).toBe(GOLDEN[version]!.covered_estimated);
      for (const overrides of Object.values(VARIANTS_1_1)) {
        expect(prepareBaa(template, { ...BASE, ...overrides }).hash, version).toBe(base);
      }
      expect(prepareBaa(template, { ...BASE, bookingMode: "desk_confirms", calendarWrite: null }).hash).toBe(base);
    }
  });

  test("the new variants are distinct documents", () => {
    const hashes = new Set([...Object.values(GOLDEN[DRAFT_110]!), ...Object.values(GOLDEN_1_1)]);
    // Five shared variants of which two coincide by design (below), plus two new ones.
    expect(hashes.size).toBe(Object.keys(VARIANTS).length - 1 + Object.keys(VARIANTS_1_1).length);
  });

  test("direct-booking renders only for bookingMode \"direct\", and is the addendum's clause", () => {
    expect(render({}).clauseIds).not.toContain("direct-booking");
    expect(render({ bookingMode: "desk_confirms" }).clauseIds).not.toContain("direct-booking");
    const direct = render({ bookingMode: "direct" });
    expect(direct.clauseIds).toContain("direct-booking");
    expect(direct.text).toContain("DIRECT BOOKING, BY PRACTICE'S ELECTION");
    expect(unwrap(direct.text)).toContain("on telephone calls only");
    expect(render({ bookingMode: "desk_confirms" }).hash).toBe(render({}).hash);
  });

  test("calendar-write renders only with a calendar; data-sources-none only without one", () => {
    const none = render({});
    expect(none.clauseIds).toContain("data-sources-none");
    expect(none.clauseIds).not.toContain("calendar-write");
    expect(none.clauseIds).not.toContain("data-sources-calendar-only");
    expect(unwrap(none.text)).toContain("holds no credentials");
    expect(render({ calendarWrite: null }).hash).toBe(none.hash);

    const calendar = render({ calendarWrite: { platform: "Cal.com" } });
    expect(calendar.clauseIds).toContain("calendar-write");
    expect(calendar.clauseIds).toContain("data-sources-calendar-only");
    expect(calendar.clauseIds).not.toContain("data-sources-none");
    expect(calendar.text).toContain("WHAT HEALDESK WRITES TO YOUR CALENDAR");
    expect(calendar.text).toContain("Practice has connected Cal.com");
    expect(unwrap(calendar.text)).toContain("never a telephone number or a patient's email address");
    expect(unwrap(calendar.text)).toContain("Apart from the calendar access described in the calendar clause");

    // A verified clinic that also writes to a calendar keeps the verified
    // data-sources clause and gains calendar-write.
    const verified = render({
      attributionMode: "verified",
      connectedPlatform: "Boulevard",
      calendarWrite: { platform: "Cal.com" },
    });
    expect(verified.clauseIds).toContain("data-sources-verified");
    expect(verified.clauseIds).toContain("calendar-write");

    // Exactly one data-sources clause, always.
    for (const overrides of [...everyVariant(), { attributionMode: "verified", connectedPlatform: "Boulevard", calendarWrite: { platform: "Cal.com" } } as Partial<BaaVariables>]) {
      const sources = render(overrides).clauseIds.filter((id) => id.startsWith("data-sources-"));
      expect(sources, JSON.stringify(overrides)).toHaveLength(1);
    }
  });

  test("the safeguards clause carves out the telephone only — no SMS permission", () => {
    const safeguards = draft().clauses.find((c) => c.id === "safeguards")!;
    const body = unwrap(safeguards.body(BASE));
    expect(body).toContain("healdesk sends no SMS");
    expect(body).not.toMatch(/by SMS|text message|may send/);
    expect(body).toContain("callback described in the Callbacks clause");
  });

  test("no 1.1.0 variant carries a consent warranty; every one carries the callbacks clause", () => {
    for (const overrides of everyVariant()) {
      const prepared = render(overrides);
      const label = JSON.stringify(overrides);
      expect(prepared.clauseIds, label).not.toContain("outbound-consent");
      expect(prepared.clauseIds, label).toContain("consented-callbacks");
      const text = unwrap(prepared.text);
      expect(text, label).not.toMatch(/warrants that|holds the consents/);
      expect(text, label).toContain("CALLBACKS, AND WHOSE CONSENT THEY REST ON");
      expect(text, label).toContain("Practice gives no warranty about it");
      expect(text, label).toContain("send no text messages, reminders or marketing of any kind");
    }
  });

  test("outboundMessaging no longer changes a covered clinic's 1.1.0 document", () => {
    // Reactivation is not offered; both signing paths pass false. The field
    // keys only reactivation-gate, which needs an unresolved covered-entity
    // status — so for a covered clinic the two golden hashes coincide.
    expect(GOLDEN[DRAFT_110]!.covered_outbound).toBe(GOLDEN[DRAFT_110]!.covered_estimated);
    expect(render({ outboundMessaging: true, isCoveredEntity: null }).clauseIds).toContain("reactivation-gate");
    expect(render({ outboundMessaging: false, isCoveredEntity: null }).clauseIds).not.toContain("reactivation-gate");
  });
});

/**
 * 1.2.2, offered from 9 October 2026 until 1.3.0 replaced it outright on 12
 * October, before any clinic signed it: what it must and must not
 * contain, pinned on every reachable variant. These are the product rules the
 * v1 spec puts into the agreement (docs/v1-product-spec.md, "HIPAA and BAA
 * position"), read out of the rendered text rather than the clause list,
 * because the text is what a clinic signs. 1.2.2 is 1.2.1 with the owner's
 * three changes of 9 October 2026 (B1–B3 in baa.ts; agreement-changes.md
 * §13), pinned below with the rest; the next describe holds it to exactly
 * those three.
 */
describe("1.2.2: the agreement offered until 1.3.0's release", () => {
  const V122 = "1.2.2";
  const v122 = () => getBaaTemplate(V122)!;
  const render = (overrides: Partial<BaaVariables>) => prepareBaa(v122(), { ...BASE, ...overrides });
  /** Every selection any version has ever read, in every state checkout can and cannot produce. */
  const everyVariant = (): Partial<BaaVariables>[] => [
    ...Object.values(VARIANTS),
    ...Object.values(VARIANTS_1_1),
    { outboundMessaging: true, isCoveredEntity: null },
    { bookingMode: "direct", calendarWrite: { platform: "Cal.com" }, outboundMessaging: true },
  ];

  test("was released, is replaced outright by 1.3.0, and is no longer signable", () => {
    expect(CURRENT_BAA_VERSION).toBe("1.3.0");
    expect(BAA_TEMPLATES[1]).toBe(v122());
    expect(v122().approvedByCounsel).toBe(true);
    expect(v122().publishedOn).toBe("2026-10-09");
    // No overlap: no clinic had signed it, and the owner decided on 12
    // October 2026 that 1.3.0 replaces it outright (plan C19).
    expect(BAA_RELEASE_OVERLAP).not.toHaveProperty(V122);
    const text = render({}).text;
    expect(text).toContain("Version 1.2.2 — executed electronically");
    expect(text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\[NAME, TITLE\]/);
    // The signatory block is in the preamble, so the notices clause points
    // up at it. 1.1.0's wording pointed "below", at nothing.
    expect(unwrap(text)).toContain("the email address of the signatory above");
    expect(unwrap(text)).not.toContain("signatory below");
  });

  test("the selections v1 does not ask about change nothing — one document per clinic", () => {
    // outboundMessaging, bookingMode and calendarWrite stay on the type (the
    // 1.0.0 and 1.1.0-draft predicates read them) but no 1.2.0 clause does.
    // Both signing paths pass false / "desk_confirms" / null; a document that
    // moved with any of them would be a signature on a variant nobody could
    // reproduce from what checkout recorded.
    const base = render({}).hash;
    expect(base).toBe(GOLDEN[V122]!.covered_estimated);
    for (const overrides of [
      ...Object.values(VARIANTS_1_1),
      { bookingMode: "desk_confirms", calendarWrite: null },
      { outboundMessaging: true },
      { bookingMode: "direct", calendarWrite: { platform: "Cal.com" }, outboundMessaging: true },
    ] as Partial<BaaVariables>[]) {
      expect(render(overrides).hash, JSON.stringify(overrides)).toBe(base);
    }
    expect(GOLDEN[V122]!.covered_outbound).toBe(GOLDEN[V122]!.covered_estimated);
  });

  test("no outbound, callback, direct-booking or Cal.com clause is reachable", () => {
    for (const overrides of everyVariant()) {
      const prepared = render(overrides);
      const label = JSON.stringify(overrides);
      for (const gone of [
        "outbound-consent",
        "reactivation-gate",
        "consented-callbacks",
        "direct-booking",
        "calendar-write",
        "data-sources-calendar-only",
      ]) {
        expect(prepared.clauseIds, label).not.toContain(gone);
      }
      expect(unwrap(prepared.text), label).not.toMatch(
        /warrants that|holds the consents|Callbacks clause|called back|Cal\.com|DIRECT BOOKING|reactivation/i,
      );
    }
  });

  test("the clause order is fixed, and exactly one data-sources clause applies", () => {
    const EXPECTED = [
      "definitions",
      "practice-status",
      "permitted-uses",
      "data-sources-none",
      "google-calendar",
      "own-use",
      "practice-duties",
      "safeguards",
      "minimum-necessary",
      "reporting",
      "subcontractors",
      "patient-rights",
      "acting-in-your-place",
      "prohibited",
      "term",
      "liability",
      "records-to-hhs",
      "notices-and-law",
    ];
    expect(render({}).clauseIds).toEqual(EXPECTED);
    // The phase-two read-back, unreachable from checkout while verified
    // attribution is not offered, swaps one clause and nothing else.
    expect(render(VARIANTS.covered_verified_boulevard!).clauseIds).toEqual(
      EXPECTED.map((id) => (id === "data-sources-none" ? "data-sources-verified" : id)),
    );
    for (const overrides of everyVariant()) {
      const sources = render(overrides).clauseIds.filter((id) => id.startsWith("data-sources-"));
      expect(sources, JSON.stringify(overrides)).toHaveLength(1);
    }
  });

  test("says what the spec says it must, on every variant", () => {
    for (const overrides of everyVariant()) {
      const text = unwrap(render(overrides).text);
      const label = JSON.stringify(overrides);
      // The model-retention rule, with the number (spec, "Five rules", third),
      // and the exception Anthropic's own retention page carries: flagged or
      // legally required content may be kept for up to two years. 1.2.0
      // omitted the exception, which is why 1.2.1 exists (finding A3).
      expect(text, label).toContain(
        "Anthropic retains conversation content for 30 days, for abuse detection and security, and then deletes it, except content its automated trust-and-safety systems flag or the law requires it to keep, which it may retain for up to two years",
      );
      expect(text, label).toContain("Anthropic never trains on that content");
      // A5: the transcript retention period the spec requires to be stated.
      expect(text, label).toContain("healdesk keeps transcripts and conversation records for 90 days");
      expect(text, label).toContain("no call audio is kept at all");
      // A2: what healdesk reads, not what Google's scope permits.
      expect(text, label).toContain("reads when that calendar is free or busy and the appointments healdesk itself created");
      expect(text, label).toContain("it does not read or store them");
      // A4: the email sentence matches the fail-closed SES design.
      expect(text, label).toContain("An email whose receiving server will not negotiate encryption is failed, not sent");
      expect(text, label).not.toContain("email included");
      // A1: the FTC Health Breach Notification Rule does not reach a clinic.
      expect(text, label).not.toContain("FTC Health Breach");
      expect(text, label).toContain("state breach-notification and consumer-health-privacy laws");
      expect(text, label).toContain("healdesk may not use PHI to train, fine-tune or evaluate any model");
      expect(text, label).toContain("at least fifteen days' notice");
      // Inbound only, in the safeguards exception.
      expect(text, label).toContain("a patient who telephones has chosen the telephone");
      expect(text, label).toContain("healdesk places no calls and sends no SMS");
      // The Google Calendar clause.
      expect(text, label).toContain("PRACTICE'S GOOGLE CALENDAR");
      expect(text, label).toContain("Practice connects its own Google Calendar by OAuth");
      expect(text, label).toContain("never a telephone number or an email address");
      expect(text, label).toContain("moves, edits or cancels nothing it did not create");
      expect(text, label).toContain(
        "Google's business associate agreement covers Calendar only where Practice's Google Workspace administrator has accepted it",
      );
      // Minimum data and channels.
      expect(text, label).toContain("what a receptionist would write on a callback slip");
      expect(text, label).toContain("does not ask for a history, a medication or a diagnosis");
      expect(text, label).toContain("never takes a card number");
      expect(text, label).toContain(
        "its opening line says that it is an AI assistant and, on a call, that the call is transcribed",
      );
      expect(text, label).toContain("Practice cannot switch that statement off");
      // Meta, scoped rather than papered.
      expect(text, label).toContain("Disclose PHI to any advertising or analytics platform");
      expect(text, label).toContain(
        "Instagram, Messenger and WhatsApp are operated by Meta, which signs no business associate agreement",
      );
      expect(text, label).toContain("handles no clinical content, confirms no appointment details");
      // The owner's liability allocation, stated once and matching Terms §13–14.
      expect(text, label).toContain("To the fullest extent the law allows, healdesk is not liable to Practice");
      expect(text, label).toContain(
        "limited to the Fees paid or payable by Practice in the twelve months before the event",
      );
      expect(text, label).toContain(
        "does not apply to healdesk's wilful misconduct or gross negligence, or to any liability the law does not allow to be limited",
      );
      expect(text, label).toContain("as section 14 of the Terms provides");
      expect(text, label).toContain(
        "the cost of investigating a security incident and of notifying patients, regulators, the media and anyone else about a breach",
      );
      expect(text, label).toContain("including where the claim alleges negligence on healdesk's part");
      expect(text, label).toContain(
        "nothing in it relieves healdesk of a civil money penalty a regulator imposes on healdesk itself, which no contract can shift",
      );
      expect(text, label).toContain("healdesk does not carry liability insurance");
      // Reporting defers to that allocation rather than restating it, and the
      // 1.0.0 sentence that put notification costs on healdesk is gone.
      expect(text, label).toContain("is allocated by the Liability clause");
      expect(text, label).not.toContain("obligation to bear the cost of notifying");
      // B3: the spec's reporting wording, one deadline for all three, so a
      // breach never gets a looser one than a lesser incident.
      expect(text, label).toContain(
        "a. any use or disclosure of PHI not permitted by this agreement, without unreasonable delay and in no case later than 60 calendar days after healdesk becomes aware of it;",
      );
      expect(text, label).toContain(
        "b. any breach of unsecured PHI, without unreasonable delay and in no case later than 60 calendar days after discovery. A breach is treated as discovered on the first day it is known",
      );
      expect(text, label).toContain(
        "as 45 CFR 164.410(a)(2) provides; c. any security incident, without unreasonable delay and in no case later than 60 calendar days after healdesk becomes aware of it — except routine unsuccessful attempts that compromised nothing",
      );
      expect(text, label).not.toMatch(
        /five calendar days|within five business days of (healdesk )?becoming aware|Five days is|24 hours|twenty-four/i,
      );
      expect(text, label).toContain("45 CFR 164.410(c)");
      // B1: the list on request, never at a URL; the notice and the
      // objection right are 1.2.1's.
      expect(text, label).toContain(
        "healdesk will give Practice its current list of these subcontractors on Practice's written request to healdesk's email address in the Notices clause, and will give Practice at least fifteen days' notice by email before adding one that will handle PHI. If Practice objects on reasonable grounds before the change takes effect, Practice may terminate under the Term clause without penalty.",
      );
      expect(text, label).not.toMatch(/subprocessors|healdesk\.io\/(?!terms)/);
      // B2: hello@ is healdesk's only email address, in the party line and
      // the Notices clause alike.
      expect(text, label).toContain(
        'Viixi FZC, a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates ("healdesk"), of 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to hello@healdesk.io',
      );
      expect(text, label).toContain(
        "To healdesk: 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to hello@healdesk.io.",
      );
      expect(
        [...text.matchAll(/[\w.+-]+@healdesk\.io/g)].map((m) => m[0]),
        label,
      ).toEqual(["hello@healdesk.io", "hello@healdesk.io"]);
      // Entire agreement, replacing earlier versions.
      expect(text, label).toContain("replace any earlier version of this agreement");
    }
  });

  test("every line fits in 78 columns, the party lines included", () => {
    // The 1.1.0 draft printed the entity, its form and the notice address on
    // one 200-character line. The downloadable copy is plain text, and the
    // wrap is what makes it read the same everywhere; the preamble's party
    // lines now go through it too, however long the practice's name.
    const text = render({
      clinicLegalName: "The Very Long Legal Name Of A Practice That Keeps Going LLC",
    }).text;
    for (const line of text.split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(78);
    }
  });
});

/**
 * 1.2.2 is 1.2.1 with the owner's three changes of 9 October 2026 and
 * nothing else (baa.ts, B1–B3): the subcontractor list on request, hello@ as
 * the notice email, and the spec's reporting wording. 1.2.1 was released on 1
 * October and no clinic signed it; it stays registered and frozen, below the
 * go-live floor.
 */
describe("1.2.2 against 1.2.1: exactly the owner's three changes", () => {
  const v121 = () => getBaaTemplate("1.2.1")!;
  const v122 = () => getBaaTemplate("1.2.2")!;
  const body = (version: string, id: string) =>
    getBaaTemplate(version)!.clauses.find((c) => c.id === id)!.body(BASE);

  test("every clause but reporting, subcontractors and notices is 1.2.1's own object, in the same order", () => {
    expect(v122().clauses.map((c) => c.id)).toEqual(v121().clauses.map((c) => c.id));
    const changed = new Set(["reporting", "subcontractors", "notices-and-law"]);
    v122().clauses.forEach((clause, i) => {
      if (changed.has(clause.id)) expect(clause, clause.id).not.toBe(v121().clauses[i]);
      else expect(clause, clause.id).toBe(v121().clauses[i]);
    });
  });

  test("inside the changed clauses and the preamble, everything but the change is 1.2.1's, word for word", () => {
    // B1: the subcontractors clause's first two paragraphs.
    const [flow121, models121, list121] = body("1.2.1", "subcontractors").split("\n\n");
    const [flow122, models122, list122] = body("1.2.2", "subcontractors").split("\n\n");
    expect(flow122).toBe(flow121);
    expect(models122).toBe(models121);
    expect(unwrap(list121!)).toContain("healdesk.io/subprocessors");
    expect(unwrap(list122!)).not.toContain("healdesk.io/subprocessors");
    // B2: the Notices clause and the preamble, with hello@ for legal@ (the
    // same length, so the wrap breaks the same lines) and the version line.
    expect(body("1.2.2", "notices-and-law")).toBe(
      body("1.2.1", "notices-and-law").replace("legal@healdesk.io", "hello@healdesk.io"),
    );
    expect(v122().preamble(BASE)).toBe(
      v121()
        .preamble(BASE)
        .replace("Version 1.2.1 —", "Version 1.2.2 —")
        .replace("legal@healdesk.io", "hello@healdesk.io"),
    );
    // B3: the reporting clause's opening line and its 164.410(c) paragraph.
    const reporting121 = body("1.2.1", "reporting").split("\n\n");
    const reporting122 = body("1.2.2", "reporting").split("\n\n");
    expect(reporting122).toHaveLength(3);
    expect(reporting122[0]).toBe(reporting121[0]);
    expect(reporting122[2]).toBe(reporting121[2]);
  });

  test("1.2.1 stays registered, released and frozen, and is no longer offered", () => {
    expect(v121().approvedByCounsel).toBe(true);
    expect(v121().publishedOn).toBe("2026-10-01");
    expect(BAA_TEMPLATES.indexOf(v121())).toBeGreaterThan(BAA_TEMPLATES.indexOf(v122()));
    expect(CURRENT_BAA_VERSION).toBe("1.3.0");
    expect(BAA_RELEASE_OVERLAP).not.toHaveProperty("1.2.1");
    const text = unwrap(prepareBaa(v121(), BASE).text);
    expect(text).toContain("Version 1.2.1 — executed electronically");
    expect(text).toContain("healdesk.io/subprocessors");
    expect(text).toContain("legal@healdesk.io");
    expect(text).toContain("in no case later than five calendar days after discovery");
  });
});

/**
 * 1.3.0, the calendar-dependent agreement (plan §2, owner decisions of 5 and 6
 * October 2026), released on 12 October 2026 (plan C19). Two answers choose
 * its calendar clause: the booking system, whose sync direction decides
 * whether healdesk connects at all, and the kind of Google account, which
 * decides whether Google's business associate agreement covers the calendar.
 * These pin what it must and must not say on every variant, read out of the
 * rendered text, because the text is what the release audit read and a
 * practice signs.
 */
const V130 = "1.3.0";

/** 1.3.0's own variants: each calendar kind, and the booking systems that name a product. */
const VARIANTS_1_3: Record<string, Partial<BaaVariables>> = {
  uncovered_nobaa: { calendarAccount: "workspace_no_baa" },
  uncovered_personal: { calendarAccount: "personal" },
  notused_mindbody: { bookingSystem: "mindbody", connectedPlatform: "Mindbody" },
  notused_other: { bookingSystem: "other" },
  live_calcom: { bookingSystem: "calcom", connectedPlatform: "Cal.com" },
  live_highlevel_personal: {
    bookingSystem: "gohighlevel",
    connectedPlatform: "HighLevel",
    calendarAccount: "personal",
  },
  live_calendly_nobaa: {
    bookingSystem: "calendly",
    connectedPlatform: "Calendly",
    calendarAccount: "workspace_no_baa",
  },
};

/** variant → sha256, for 1.3.0. Frozen from the release (12 October 2026), and recorded in §12.12. */
const GOLDEN_1_3: Record<string, string> = {
  uncovered_nobaa: "a37e8909d30fc42941efa331d03a714eedf69488e377da3165a1927cce8dc578",
  uncovered_personal: "9622fe3e337d3693e06b2873182535d9c12333be1182662761031aafeaa0c1f5",
  notused_mindbody: "ad456a7f09c1b17f3c6c9d1f3cfc5dd6de0cd90d2244242712101002b6735e5e",
  notused_other: "d0634fa22bc85786c44314f6f8019dfb1d1248cddd4a378487ee4bc68648e6eb",
  live_calcom: "a30f9dbafc13c7a9076ed9e542c909693607dedf8354b1a083c35f987bb9d1d8",
  live_highlevel_personal: "79b5b5fb08c06e5ad94ea5f6b4c41f55dd94631be73e71ed1ab9e30d03e89d97",
  live_calendly_nobaa: "bc9905270da8fa75968ba80e8070de1275cbbf5856a25abf838f939a21463331",
};

describe("1.3.0: the calendar-dependent agreement", () => {
  const v130 = () => getBaaTemplate(V130)!;
  const render = (overrides: Partial<BaaVariables>) =>
    prepareBaa(v130(), { ...BASE, ...overrides });
  /**
   * Every selection any version reads, in states checkout can and cannot
   * produce, except verified reporting, which 1.3.0 refuses (asserted below).
   */
  const everyVariant = (): Partial<BaaVariables>[] => [
    ...Object.values(VARIANTS).filter((overrides) => overrides.attributionMode !== "verified"),
    ...Object.values(VARIANTS_1_3),
    ...Object.values(VARIANTS_1_1),
    { outboundMessaging: true, isCoveredEntity: null },
    {
      isCoveredEntity: false,
      bookingSystem: "boulevard",
      connectedPlatform: "Boulevard",
      calendarAccount: "personal",
    },
  ];

  for (const [name, hash] of Object.entries(GOLDEN_1_3)) {
    test(`${V130} / ${name} still renders the bytes released`, () => {
      expect(render(VARIANTS_1_3[name]!).hash).toBe(hash);
    });
  }

  test("is the current template, released by the owner, and replaced 1.2.2 outright", () => {
    expect(BAA_TEMPLATES[0]!.version).toBe(CURRENT_BAA_VERSION);
    expect(CURRENT_BAA_VERSION).toBe(V130);
    expect(BAA_TEMPLATES[1]!.version).toBe("1.2.2");
    expect(v130().approvedByCounsel).toBe(true);
    expect(v130().publishedOn).toBe("2026-10-12");
    // No overlap, and the go-live floor is 1.3.0: no clinic had signed 1.2.2
    // (owner, 12 October 2026; plan C19).
    expect(BAA_RELEASE_OVERLAP).toEqual({});
    expect(MIN_ACCEPTABLE_BAA_VERSION).toBe(V130);
    // Nothing in the text marks it a draft, so the release itself moved no
    // hash; the release audit's two text fixes did (§12.15).
    const text = render({}).text;
    expect(text).toContain("Version 1.3.0 — executed electronically");
    expect(text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\[NAME, TITLE\]/);
  });

  test("the variants are distinct documents, except where an answer has nothing to change", () => {
    const hashes = [...Object.values(GOLDEN[V130]!), ...Object.values(GOLDEN_1_3)];
    // covered_outbound is covered_estimated, as in every version since 1.2.0.
    expect(GOLDEN[V130]!.covered_outbound).toBe(GOLDEN[V130]!.covered_estimated);
    expect(new Set(hashes).size).toBe(hashes.length - 1);
    // Google Calendar alone and no booking system both book live and name no product.
    expect(render({ bookingSystem: "google_calendar" }).hash).toBe(
      GOLDEN[V130]!.covered_estimated,
    );
    // A manual system's answer about the Google account is kept in case it
    // changes, and changes nothing in the document.
    for (const calendarAccount of ["workspace_baa", "workspace_no_baa", "personal"] as const) {
      expect(
        render({ ...VARIANTS_1_3.notused_mindbody, calendarAccount }).hash,
        calendarAccount,
      ).toBe(GOLDEN_1_3.notused_mindbody);
    }
  });

  test("ignores what it does not read, and nothing earlier reads what it adds", () => {
    const base = render({}).hash;
    for (const overrides of [
      { outboundMessaging: true },
      ...Object.values(VARIANTS_1_1),
      { bookingMode: "desk_confirms", calendarWrite: null },
    ] as Partial<BaaVariables>[]) {
      expect(render(overrides).hash, JSON.stringify(overrides)).toBe(base);
    }
    for (const version of ["1.2.2", "1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      const template = getBaaTemplate(version)!;
      const without = prepareBaa(template, {
        ...BASE,
        bookingSystem: undefined,
        calendarAccount: undefined,
      });
      expect(without.hash, version).toBe(GOLDEN[version]!.covered_estimated);
      for (const overrides of Object.values(VARIANTS_1_3)) {
        // Hold the platform name fixed: earlier versions do read that one.
        expect(
          prepareBaa(template, { ...BASE, ...overrides, connectedPlatform: null }).hash,
          `${version} ${JSON.stringify(overrides)}`,
        ).toBe(without.hash);
      }
    }
  });

  test("the render guard refuses a document the practice never answered for", () => {
    for (const bad of [
      { bookingSystem: undefined },
      { bookingSystem: "zenoti" },
      { calendarAccount: undefined },
      { calendarAccount: "gmail" },
      // The platform it names must be the booking system's own name.
      { connectedPlatform: "Mindbody" },
      { bookingSystem: "mindbody" },
      { bookingSystem: "gohighlevel", connectedPlatform: "GoHighLevel" },
      { bookingSystem: "google_calendar", connectedPlatform: "Google Calendar only" },
      { bookingSystem: "other", connectedPlatform: "Something else" },
      // Verified reporting is the phase-two read-back, which 1.3.0 does not
      // describe, whatever system it would read (HRC-17, ICD-35).
      VARIANTS.covered_verified_boulevard,
      { attributionMode: "verified", bookingSystem: "calcom", connectedPlatform: "Cal.com" },
      { attributionMode: "verified", bookingSystem: "mindbody", connectedPlatform: "Mindbody" },
    ] as unknown as Partial<BaaVariables>[]) {
      expect(() => render(bad), JSON.stringify(bad)).toThrow(BaaRenderError);
    }
    expect(() => render(VARIANTS.covered_verified_boulevard!)).toThrow(
      /no verified-reporting clause/,
    );
    // No earlier version has a guard, so nothing about them changes.
    for (const version of ["1.2.2", "1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      expect(getBaaTemplate(version)!.validate, version).toBeUndefined();
    }
  });

  test("the clause order is fixed; exactly one data-sources clause and one calendar clause apply", () => {
    const EXPECTED = [
      "definitions",
      "practice-status",
      "permitted-uses",
      "state-law",
      "data-sources-none",
      "google-calendar-covered",
      "payments",
      "own-use",
      "practice-duties",
      "safeguards",
      "minimum-necessary",
      "reporting",
      "subcontractors",
      "patient-rights",
      "acting-in-your-place",
      "prohibited",
      "term",
      "liability",
      "records-to-hhs",
      "notices-and-law",
    ];
    const swap = (from: string, to: string) => (id: string) => (id === from ? to : id);
    // The phase-two `data-sources-verified` is not registered: 22 clauses, 20 render.
    expect(v130().clauses).toHaveLength(22);
    expect(v130().clauses.map((c) => c.id)).not.toContain("data-sources-verified");
    expect(render({}).clauseIds).toEqual(EXPECTED);
    expect(render(VARIANTS_1_3.uncovered_personal!).clauseIds).toEqual(
      EXPECTED.map(swap("google-calendar-covered", "google-calendar-uncovered")),
    );
    expect(render(VARIANTS_1_3.notused_mindbody!).clauseIds).toEqual(
      EXPECTED.map(swap("google-calendar-covered", "google-calendar-not-used")),
    );
    // The phase-two read-back is refused rather than rendered (HRC-17).
    expect(() => render(VARIANTS.covered_verified_boulevard!)).toThrow(BaaRenderError);
    for (const overrides of everyVariant()) {
      const ids = render(overrides).clauseIds;
      const label = JSON.stringify(overrides);
      expect(
        ids.filter((id) => id.startsWith("data-sources-")),
        label,
      ).toHaveLength(1);
      expect(
        ids.filter((id) => (CALENDAR_CLAUSE_IDS_1_3 as readonly string[]).includes(id)),
        label,
      ).toHaveLength(1);
      expect(ids, label).not.toContain("google-calendar");
    }
  });

  test("each calendar clause is the shared body, then the location paragraph", () => {
    for (const overrides of everyVariant()) {
      const variables = { ...BASE, ...overrides };
      const prepared = render(overrides);
      const selected = selectCalendarClause({
        bookingSystem: variables.bookingSystem!,
        calendarAccount: variables.calendarAccount!,
      });
      const label = JSON.stringify(overrides);
      expect(prepared.clauseIds, label).toContain(selected.clauseId);
      expect(prepared.text, label).toContain(`6. GOOGLE CALENDAR\n\n${selected.body}\n\n`);
      expect(unwrap(prepared.text), label).toContain(
        unwrap(`${selected.body} ${CALENDAR_LOCATION_PARAGRAPH}`),
      );
    }
  });

  test("data sources name every source, and calendar access only where the calendar clause grants it", () => {
    const between = (overrides: Partial<BaaVariables>, from: string, to: string) => {
      const text = unwrap(render(overrides).text);
      return text.slice(text.indexOf(from), text.indexOf(to));
    };
    const sources = (overrides: Partial<BaaVariables>) =>
      between(overrides, "5. WHAT HEALDESK READS FROM PRACTICE'S SYSTEMS", "6. GOOGLE CALENDAR");
    const stateLaw = (overrides: Partial<BaaVariables>) =>
      between(overrides, "4. WHERE PRACTICE IS NOT A COVERED ENTITY", "5. WHAT HEALDESK READS");
    for (const live of [{}, VARIANTS_1_3.uncovered_personal!, VARIANTS_1_3.live_calcom!]) {
      const label = JSON.stringify(live);
      expect(sources(live), label).toContain(
        "Apart from the access to Practice's Google Calendar that the Google Calendar clause describes, healdesk holds no credentials to",
      );
      expect(sources(live), label).toContain(
        "d. Practice's Google Calendar: what the Google Calendar clause, or a calendar election that takes its place, says healdesk reads from it.",
      );
      expect(stateLaw(live), label).toContain(
        'free and busy times on each calendar that the clause headed "Google Calendar", or a calendar election that takes its place, lets healdesk use',
      );
    }
    // A manual system connects nothing: no calendar access, data or recipient
    // except under a calendar election (ICD-04, PT-05, SL-09, HRC-16).
    for (const manual of [VARIANTS_1_3.notused_mindbody!, VARIANTS_1_3.notused_other!]) {
      const label = JSON.stringify(manual);
      expect(sources(manual), label).not.toContain("the Google Calendar clause");
      expect(sources(manual), label).toContain(
        "Apart from any Google Calendar that a calendar election lets healdesk use, healdesk holds no credentials to",
      );
      expect(sources(manual), label).toContain(
        "d. any Google Calendar that a calendar election lets healdesk use: what that election says healdesk reads from it.",
      );
      expect(stateLaw(manual), label).not.toContain("free and busy times on each calendar");
      expect(stateLaw(manual), label).toContain(
        "take a booking request for Practice's staff to confirm in Practice's own system or, where a calendar election for a location provides for it",
      );
      expect(stateLaw(manual), label).toContain(
        "So is any Google Calendar that a calendar election connects.",
      );
    }
    // Every source of PHI, on every variant (PT-04, ICD-11).
    for (const overrides of everyVariant()) {
      const label = JSON.stringify(overrides);
      const text = sources(overrides);
      expect(text, label).toContain("The PHI healdesk receives for Practice comes from:");
      expect(text, label).toContain(
        "a. the people who call Practice, or write to it in a website chat or on Instagram, Messenger or WhatsApp: what they say or write, with the telephone number, messaging-account identifier or network address it comes from;",
      );
      expect(text, label).toContain(
        "b. Practice's staff: what they enter, confirm or correct through healdesk",
      );
      expect(text, label).toContain(
        "c. Practice's payment processor: its notice of whether a payment link healdesk sent has been paid",
      );
      expect(text, label).not.toMatch(/patients themselves|estimated reporting/);
    }
    // The system is named when it has a name.
    expect(sources(VARIANTS_1_3.notused_mindbody!)).toContain(
      "healdesk holds no credentials to Mindbody or to any other booking, practice-management or point-of-sale system Practice uses, and reads nothing from them.",
    );
    expect(sources(VARIANTS_1_3.live_calcom!)).toContain(
      "healdesk holds no credentials to Cal.com or to any other booking",
    );
    expect(sources({})).toContain(
      "healdesk holds no credentials to any booking, practice-management or point-of-sale system Practice uses, and reads nothing from one.",
    );
  });

  test("every clause it names is a heading of the same document", () => {
    // A clause is named either as 'the clause headed "…"', exactly, or as
    // "the … clause" by the opening words of its heading, which clause 20
    // says is how a name resolves (ICD-22). Each must find exactly one.
    for (const overrides of everyVariant()) {
      const label = JSON.stringify(overrides);
      const { text } = render(overrides);
      const headings = [...text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
      const flat = unwrap(text);
      let named = 0;
      for (const [, heading] of flat.matchAll(/the clause headed "([^"]+)"/gi)) {
        named += 1;
        expect(
          headings.filter((h) => h === heading!.toUpperCase()),
          `${label}: "${heading}"`,
        ).toHaveLength(1);
      }
      for (const [, words] of flat.matchAll(/\b[Tt]he ((?:[A-Z][\w']*,? ?)+?) clause\b/g)) {
        named += 1;
        const opening = words!.trim().replace(/,$/, "").toUpperCase();
        expect(
          headings.filter(
            (h) => h === opening || h.startsWith(`${opening} `) || h.startsWith(`${opening},`),
          ),
          `${label}: "the ${words} clause"`,
        ).toHaveLength(1);
      }
      expect(named, label).toBeGreaterThan(20);
    }
  }, 30_000);

  test("says what the spec, the owner and the pre-release audit require, on every variant", () => {
    for (const overrides of everyVariant()) {
      const text = unwrap(render(overrides).text);
      const label = JSON.stringify(overrides);
      // The party block: the registered address, never the mailbox; the
      // specialty as the catalogue writes it (ICD-18, ICD-20, PT-19, PT-27).
      expect(text, label).toContain(
        'Viixi FZC ("healdesk"), a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates, whose registered address is Business Center, Sharjah Publishing City Free Zone, Sharjah, United Arab Emirates',
      );
      expect(text, label).toContain('("Practice"), a practice in the field of');
      expect(text, label).not.toContain("of 800 N King Street");
      expect(text, label).toContain("as the Definitions clause defines those terms");
      expect(text, label).not.toContain("Services defined in the Terms");
      // Definitions the Terms do not give (ICD-19, ICD-23, ICD-26, ICD-33).
      expect(text, label).toContain('"Services" means everything healdesk provides to Practice');
      expect(text, label).toContain('"Fees" means the amounts Practice pays or owes healdesk');
      // The pass-through after the end does not keep the Services, and so this
      // agreement, running (ICD-19, PT-25; verification of 7 October 2026).
      expect(text, label).toContain(
        "The Services end when Practice's subscription under the Terms ends, however it ends; passing forwarded calls through to Practice's direct line after that, as the Terms provide, does not continue them.",
      );
      // The first location is the first order's, which a practice moving from
      // 1.2.1 to this version also has (ICD-26).
      expect(text, label).toContain(
        "This clause governs the calendar of Practice's first location, the one set up under the first order Practice placed for the Services.",
      );
      expect(text, label).toContain(
        "also includes anything an applicable state breach-notification law treats as a breach of the security of patient information",
      );
      expect(text, label).toContain("Once accepted, it forms part of this agreement.");
      // Practice's status, plainly, and the laws that apply whatever it is.
      expect(text, label).toContain(
        "state breach-notification and medical-confidentiality laws may also apply to both parties",
      );
      expect(text, label).not.toContain("does NOT transmit");
      expect(text, label).not.toContain("FTC Health Breach");
      // Permitted uses: the own-use exception, and CMIA whatever the status
      // (ICD-01, HRC-08, HRC-12, ICD-34).
      expect(text, label).toContain(
        "Except for what that clause permits, healdesk may not use or disclose PHI in a way that would violate the HIPAA Privacy Rule if done by Practice.",
      );
      expect(text, label).toContain(
        "under Cal. Civ. Code 56.10(c)(3), whether or not Practice is a covered entity",
      );
      // The state-law clause: one statement each, the more protective clause
      // governing, 35-day backups (HRC-09, ICD-03, SL-01, SL-02, SL-10).
      expect(text, label).toContain(
        "WHERE PRACTICE IS NOT A COVERED ENTITY This clause applies for any period in which Practice is not a covered entity",
      );
      expect(text, label).toContain(
        "PHI applies to it. healdesk is Practice's service provider and processor",
      );
      expect(text, label).toContain("the one that protects patient information more governs");
      expect(text, label).toContain(
        "Practice's documented instructions to healdesk are this agreement and the settings Practice chooses in its portal",
      );
      expect(text, label).toContain("the Connecticut Data Privacy Act");
      expect(text, label).toContain("within 35 days after that");
      expect(text, label).not.toMatch(/return-or-destroy|six months|email addresses/);
      // Payments: a link only where one can be sent, none on a call (PT-11).
      expect(text, label).toContain(
        "PAYMENTS Where Practice takes deposits, healdesk may send a payment link in a website chat or an Instagram, Messenger or WhatsApp conversation.",
      );
      expect(text, label).toContain(
        "On a call it sends none, and flags any deposit for Practice's staff to collect.",
      );
      expect(text, label).toContain("Neither ever carries a service name or any clinical detail.");
      expect(text, label).toContain("healdesk never takes card numbers.");
      // Own use: de-identify first, then combine, and never re-identify; the
      // regulation's confidentiality condition; the public commitment.
      expect(text, label).toContain(
        "healdesk may de-identify Practice's PHI in accordance with 45 CFR 164.514(b)",
      );
      expect(text, label).toContain(
        "It will not re-identify, or try to re-identify, any individual",
      );
      expect(text, label).toContain(
        "It commits publicly, at healdesk.io/privacy, to keep and use that information only in de-identified form",
      );
      expect(text, label).toContain(
        "any instance of which it is aware in which the confidentiality of the PHI has been breached",
      );
      // Safeguards: a covenant, the calls the product passes on, inbound only.
      expect(text, label).toContain(
        "healdesk keeps PHI at rest only in the United States, always encrypted, and lets a subcontractor handle PHI only if that subcontractor does the same.",
      );
      expect(text, label).toContain(
        "An email whose receiving server will not negotiate encryption is failed, not sent",
      );
      expect(text, label).toContain("healdesk places no calls to patients and sends no SMS");
      // Minimum necessary: the catalogue's fields, no email, and the periods
      // the purge keeps (PT-02, PT-28).
      expect(text, label).toContain("the assistant asks the person booking for no more than");
      expect(text, label).toContain("It asks for no email address");
      expect(text, label).toContain(
        "healdesk keeps each conversation, with its transcript, for 90 days after it took place",
      );
      // A booking request has a period of its own, run from dates nothing
      // moves once it is decided (app_purge_booking_requests, drizzle/0054),
      // so it no longer goes with its contact; the contact stays while any
      // record of theirs does (purge step 3). The text said the request was
      // kept with the person, which the purge stopped doing in 0054
      // (tests/booking-request-destruction.test.ts holds the purge to this).
      expect(text, label).toContain(
        "It keeps each booking request for 90 days after the latest of when it was made, the time it was confirmed for and its appointment's time.",
      );
      expect(text, label).toContain(
        "A person's contact details are kept while any conversation, appointment record or booking request of theirs is kept, and in any case until 90 days after the last time those details were recorded or changed.",
      );
      expect(text, label).not.toContain("A booking request is kept with the contact details");
      // The portal shortens transcripts and no other period (Settings,
      // clinic_settings.transcript_retention_days; release audit, 12 October
      // 2026), in the DPA's words.
      expect(text, label).toContain("Practice may shorten the period for transcripts in its portal.");
      expect(text, label).not.toContain("shorten these periods");
      expect(text, label).toContain(
        "A backup copy of anything healdesk deletes expires within 35 days of the deletion.",
      );
      expect(text, label).toContain("No call audio is kept at all.");
      // Reporting: one rule for every practice and one deadline for all
      // three, the spec's wording (owner, 9 October 2026), and the report's
      // contents (HRC-05, HRC-06, HRC-12, PT-16).
      expect(text, label).toContain(
        "healdesk will notify Practice, by email to Practice's address in the Notices clause, of any of the following without unreasonable delay and in no case later than 60 calendar days after discovery: a. any use or disclosure of PHI that this agreement does not permit",
      );
      expect(text, label).toContain(
        "healdesk delays a notice only where a law enforcement official states that the notice would impede a criminal investigation or damage national security.",
      );
      expect(text, label).toContain("as 45 CFR 164.412, or the state law that applies, provides");
      expect(text, label).toContain("the date of the breach and the date of its discovery");
      expect(text, label).toContain("any steps individuals should take to protect themselves");
      expect(text, label).not.toContain("five calendar days");
      // The internal 24-hour target is not a promise in the text.
      expect(text, label).not.toMatch(/24 hours of discovery|twenty-four hours|immediately following discovery/i);
      // The notice is itself the written report, so the identification of
      // each individual is due with it to the extent known (45 CFR
      // 164.410(c); verification of the redraft, 7 October 2026).
      expect(text, label).toContain(
        "Each notice is also a written report, sent to the same address and as complete as healdesk can then make it, and healdesk will add to the report promptly as information becomes available.",
      );
      expect(text, label).not.toContain("follow each notice with a written report");
      // Subcontractors: Anthropic in covenant form, its retention as its own
      // terms state it, the list on request (never at a URL), and 24 hours'
      // notice to the notice address.
      expect(text, label).toContain(
        "only under a business associate agreement with healdesk signed before any patient's information reaches it",
      );
      expect(text, label).toContain(
        "Anthropic retains conversation content for 30 days, for abuse detection and security, and then deletes it, except content its automated trust-and-safety systems flag or the law requires it to keep, which it may retain for up to two years",
      );
      expect(text, label).toContain(subprocessorNoticeClauseBody());
      expect(text, label).toContain(
        "healdesk will give Practice its current list of its subcontractors on Practice's written request to healdesk's email address in the Notices clause",
      );
      expect(text, label).not.toContain("subprocessors");
      expect(text, label).toContain("at least 24 hours' notice by email");
      expect(text, label).toContain(
        "The notice goes to Practice's address in the Notices clause and names the subcontractor, what it will receive and why.",
      );
      expect(text, label).not.toContain("fifteen days");
      // Patient rights: "Practice"; contact details corrected in place, and
      // an amendment appended to a booking request, an appointment record or
      // the record of a conversation, as record_amendments does (gate 8;
      // release audit, 12 October 2026); and a request answered only in
      // healdesk's reply.
      expect(text, label).toContain(
        "healdesk corrects a person's contact details in its own copy. It does not rewrite a booking request, an appointment record or the record of a conversation: it appends the amendment to that record and links the two, as 45 CFR 164.526(c)(1) provides. Every later use and export of that record then carries the amendment.",
      );
      expect(text, label).not.toContain("Where the record can be changed");
      expect(text, label).toContain("in its reply to the patient, tell them");
      // Inbound only: healdesk replies to a patient who writes.
      expect(text, label).toContain("WHERE HEALDESK ACTS IN PRACTICE'S PLACE");
      expect(text, label).toContain("to a patient who writes, are both of those");
      expect(text, label).not.toContain("sending messages in");
      // Meta, carved out of the advertising ban expressly (HRC-10, ICD-14).
      expect(text, label).toContain("except by replying on Instagram, Messenger or WhatsApp");
      // Term: termination ends the Services; destruction as the product does
      // it; uses and disclosures limited (HRC-02, HRC-03, HRC-07, PT-01).
      expect(text, label).toContain(
        "Terminating this agreement ends the Services on the same day.",
      );
      // The DPA's rule, in its words: "delivered", never "downloaded" (redraft
      // brief, 7 October 2026), with the 90-day cap stated for an export never
      // delivered.
      expect(text, label).toContain(
        "Within thirty days after the Services end, healdesk will deliver to Practice, without being asked, an export of the patient information it holds for Practice, in a usable electronic form.",
      );
      expect(text, label).toContain(
        "It will do so thirty days after the Services end if the export has been delivered by then; otherwise as soon as the export is delivered; and in any case no later than ninety days after the Services end, whether or not the export has been delivered.",
      );
      expect(text, label).not.toMatch(/download|asked for it/i);
      expect(text, label).toContain("within 35 days after the destruction above");
      expect(text, label).toContain(
        "limit further uses and disclosures of it to those purposes that make its return or destruction infeasible",
      );
      // Liability: Terms §13 and §14, without "revenue" (ICD-16, PT-26).
      expect(text, label).toContain(
        "limited to the Fees Practice paid healdesk in the twelve months before the event giving rise to the claim",
      );
      expect(text, label).not.toContain("as section 14 of the Terms provides");
      // The Term clause's refund is outside the exclusion and the indemnity,
      // as Terms §13 keeps its own refund outside its limits (HRC-07, SUB-03).
      expect(text, label).toContain(
        "Nothing in this clause limits the refund the Term clause provides, and Practice's indemnity below does not extend to a claim for it.",
      );
      expect(text, label).toContain(
        "The defence of a claim is conducted as the last paragraph of section 14 of the Terms provides.",
      );
      // Notices: email to hello@ is enough, the mailbox is only a mailing
      // address, and a clause named by its heading's words is that clause
      // (ICD-22, ICD-31). hello@ is healdesk's only address (owner, 9 October
      // 2026).
      expect(text, label).toContain(
        "Notices to healdesk go by email to hello@healdesk.io, which is enough on its own.",
      );
      expect(text, label).not.toMatch(/legal@|privacy@/);
      expect(text, label).toContain(
        "That mailing address is not a place of business, a registered office or an address for service of process.",
      );
      expect(text, label).toContain(
        "That is the email address on Practice's healdesk account, or the signatory's email address above until that account exists",
      );
      expect(text, label).toContain("is the numbered clause whose heading contains those words");
      expect(text, label).toContain(
        "This agreement (with any calendar election accepted under it)",
      );
      // Inbound only, no booking election, and no revenue claim.
      expect(text, label).not.toMatch(
        /warrants that|holds the consents|Callbacks clause|called back|DIRECT BOOKING|reactivation/i,
      );
      expect(text, label).not.toMatch(/revenue/i);
      // The calendar clause never promises a revocation at Google.
      const variables = { ...BASE, ...overrides };
      const calendar = selectCalendarClause({
        bookingSystem: variables.bookingSystem!,
        calendarAccount: variables.calendarAccount!,
      });
      expect(calendar.body, label).not.toMatch(/revok/i);
    }
  });

  test("every line fits in 78 columns, the party lines included", () => {
    for (const overrides of everyVariant()) {
      const text = render({
        ...overrides,
        clinicLegalName: "The Very Long Legal Name Of A Practice That Keeps Going LLC",
      }).text;
      for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    }
  });
});

/**
 * The direct-booking addendum is the document a practice actually accepts
 * (on its setup link, once counsel approves it); the clause in 1.1.0-draft is
 * the same text. Its hash is stored on the clinic row, so it is frozen here
 * exactly as the BAA is.
 */
describe("direct-booking addendum freeze", () => {
  const ADDENDUM_VARS = {
    clinicLegalName: "Golden Clinic LLC",
    signatoryName: "Alex Chen",
    signatoryTitle: "Owner",
    acceptedOn: "2026-09-13",
  };

  /** addendum version → sha256 of the rendered text. Append-only. */
  const GOLDEN_ADDENDUM: Record<string, string> = {
    "direct-booking-addendum/1.0.0": "3f7d58697b3c0737b400d32922b22a56204b0837d2cdb220b8defc226a696cb3",
  };

  test("the current addendum has a golden hash and still renders those bytes", () => {
    const current = currentDirectBookingAddendum();
    expect(GOLDEN_ADDENDUM[current.version], `no golden hash for ${current.version}`).toBeDefined();
    const text = renderDirectBookingAddendum(ADDENDUM_VARS, current);
    expect(
      hashDirectBookingAddendum(text),
      "The addendum text changed. A practice's stored election hash points at the old text — add a new version instead.",
    ).toBe(GOLDEN_ADDENDUM[current.version]);
  });

  test("the addendum and the draft's direct-booking clause are the same words", () => {
    const clause = getBaaTemplate(DRAFT_110)!.clauses.find((c) => c.id === "direct-booking")!;
    const addendum = renderDirectBookingAddendum(ADDENDUM_VARS);
    expect(addendum).toContain(clause.body(BASE));
    expect(addendum).toContain(`1. ${clause.heading.toUpperCase()}`);
    expect(unwrap(addendum)).toContain("who confirms authority to bind Practice");
  });

  test("it is not approved, so nothing offers it yet", () => {
    // Flipping this ships with counsel's sign-off; the setup page's Direct
    // booking section and the console's booking-mode switch both key on it.
    expect(currentDirectBookingAddendum().approvedByCounsel).toBe(false);
  });
});

/**
 * The calendar election is the document a location's later calendar terms
 * are accepted on (plan §2.6). Its hash is to be stored on each election row
 * (plan C7), so it is frozen here exactly as the BAA and the addendum are.
 */
describe("calendar election freeze", () => {
  const ELECTION_VARS: CalendarElectionVariables = {
    clinicLegalName: "Golden Clinic LLC",
    locationName: "Golden Clinic, Main Street",
    agreementVersion: "1.3.0",
    agreementEffectiveDate: "2026-09-13",
    bookingSystem: "none",
    calendarAccount: "personal",
    signatoryName: "Alex Chen",
    signatoryTitle: "Owner",
    electedOn: "2026-09-14",
  };

  /** election version → sha256 of the rendered text. Append-only. */
  const GOLDEN_ELECTION: Record<string, string> = {
    // Moved in place by the pre-release audit's calendar edits (6 October
    // 2026), while it was unreleased (§12.14). Released with BAA 1.3.0 on 12
    // October 2026, which moved no byte of it (§12.15): frozen from then.
    "calendar-election/1.0.0": "63586893a436803155ee71811ea17a8d71800a0d90ce41e1b3d9c596650a02aa",
  };

  test("the current election has a golden hash and still renders those bytes", () => {
    const current = currentCalendarElection();
    expect(GOLDEN_ELECTION[current.version], `no golden hash for ${current.version}`).toBeDefined();
    expect(
      hashCalendarElection(renderCalendarElection(ELECTION_VARS, current)),
      "The election text changed. An election row's stored hash points at the old text — add a new version instead.",
    ).toBe(GOLDEN_ELECTION[current.version]);
  });

  test("its clause is the BAA 1.3.0 clause, word for word, without the location paragraph", () => {
    const election = renderCalendarElection(ELECTION_VARS);
    const selected = selectCalendarClause(ELECTION_VARS);
    const agreement = prepareBaa(getBaaTemplate(V130)!, {
      ...BASE,
      calendarAccount: "personal",
    });
    expect(agreement.clauseIds).toContain(selected.clauseId);
    expect(election).toContain(selected.body);
    expect(agreement.text).toContain(selected.body);
    expect(unwrap(election)).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
  });

  test("it is released with BAA 1.3.0, so an election under it counts for every clinic", () => {
    // Released on 12 October 2026 (plan C19). Before, a draft election counted
    // only for a demo clinic (plan A10); the database's copy of the list,
    // app_calendar_election_released(), names it since the release migration
    // (tests/database-audit.test.ts holds the two together).
    expect(currentCalendarElection().approvedByCounsel).toBe(true);
    expect(currentCalendarElection().publishedOn).toBe("2026-10-12");
  });
});

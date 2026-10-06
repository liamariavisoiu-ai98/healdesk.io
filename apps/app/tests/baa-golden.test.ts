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
 * 1.2.1 was released on 2026-10-01 and is what clinics sign; its hashes are
 * the record from that day on. 1.0.0 and 0.1.0-draft have been signed; their
 * hashes never move. 1.2.0 was offered for part of that day and is frozen like
 * the rest. 1.1.0-draft was superseded by 1.2.0 without ever being
 * offered; it is frozen too, because docs/counsel/ quotes its rendering.
 * 1.3.0 is drafted at BAA_TEMPLATES[1] and not released; its hashes are
 * frozen from the first draft, so the audit before release reads exactly
 * what will be signed, and an edit before then regenerates them in the same
 * commit (docs/counsel/agreement-changes.md §12).
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
  // Drafted, not released. Frozen from the first draft all the same: these
  // are the bytes the release audit reads and a practice will sign.
  "1.3.0": {
    covered_estimated: "770462be01a012ff4221f5a5aabed7503dcb710c5437925d0652d9dde1247d16",
    notcovered_estimated: "16b86e85dfc65a421d7e319534c2f8d18b8fbdc9307cb2269fc6d9d0715915f9",
    unknown_estimated: "70f8f05cafa4784b2c2107a1d3099a20c8c1b789a66bcc4339886e054fde9ae6",
    // Identical to covered_estimated by design, as in 1.2.x: no clause reads
    // outboundMessaging.
    covered_outbound: "770462be01a012ff4221f5a5aabed7503dcb710c5437925d0652d9dde1247d16",
    covered_verified_boulevard: "7361318a1050ceac11a9c0718a6f357d5595f1de85c7cabaa86270fa18cf28db",
  },
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
    const current = GOLDEN[CURRENT_BAA_VERSION]!;
    // One coincidence is by design and is asserted as such: outboundMessaging
    // selects nothing in 1.2.x, so covered_outbound IS covered_estimated.
    // Every other variant is a distinct document.
    expect(current.covered_outbound).toBe(current.covered_estimated);
    const distinct = Object.entries(current)
      .filter(([name]) => name !== "covered_outbound")
      .map(([, hash]) => hash);
    expect(new Set(distinct).size).toBe(Object.keys(VARIANTS).length - 1);
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
 * 1.2.1, the offered version: what it must and must not contain, pinned on
 * every reachable variant. These are the product rules the v1 spec puts into
 * the agreement (docs/v1-product-spec.md, "HIPAA and BAA position"), read out
 * of the rendered text rather than the clause list, because the text is what
 * a clinic signs.
 */
describe("1.2.1: the offered agreement", () => {
  const CURRENT = "1.2.1";
  const current = () => getBaaTemplate(CURRENT)!;
  const render = (overrides: Partial<BaaVariables>) => prepareBaa(current(), { ...BASE, ...overrides });
  /** Every selection any version has ever read, in every state checkout can and cannot produce. */
  const everyVariant = (): Partial<BaaVariables>[] => [
    ...Object.values(VARIANTS),
    ...Object.values(VARIANTS_1_1),
    { outboundMessaging: true, isCoveredEntity: null },
    { bookingMode: "direct", calendarWrite: { platform: "Cal.com" }, outboundMessaging: true },
  ];

  test("is the current template, released rather than drafted", () => {
    expect(CURRENT_BAA_VERSION).toBe(CURRENT);
    expect(current().approvedByCounsel).toBe(true);
    expect(current().publishedOn).toBe("2026-10-01");
    const text = render({}).text;
    expect(text).toContain("Version 1.2.1 — executed electronically");
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
    expect(base).toBe(GOLDEN[CURRENT]!.covered_estimated);
    for (const overrides of [
      ...Object.values(VARIANTS_1_1),
      { bookingMode: "desk_confirms", calendarWrite: null },
      { outboundMessaging: true },
      { bookingMode: "direct", calendarWrite: { platform: "Cal.com" }, outboundMessaging: true },
    ] as Partial<BaaVariables>[]) {
      expect(render(overrides).hash, JSON.stringify(overrides)).toBe(base);
    }
    expect(GOLDEN[CURRENT]!.covered_outbound).toBe(GOLDEN[CURRENT]!.covered_estimated);
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
      expect(text, label).toContain("in no case later than five calendar days after discovery");
      expect(text, label).toContain("45 CFR 164.410(c)");
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
 * 1.3.0, the calendar-dependent draft (plan §2, owner decisions of 5 and 6
 * October 2026). Two answers choose its calendar clause: the booking system,
 * whose sync direction decides whether healdesk connects at all, and the kind
 * of Google account, which decides whether Google's business associate
 * agreement covers the calendar. These pin what it must and must not say on
 * every variant, read out of the rendered text, because the text is what the
 * release audit reads and a practice will sign.
 */
const DRAFT_130 = "1.3.0";

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

/** variant → sha256, for 1.3.0. Regenerated only with the draft, and recorded in §12. */
const GOLDEN_1_3: Record<string, string> = {
  uncovered_nobaa: "cb845bcaa7b1e8c542fbef66d20ac4b7428242b0a0e08eba9a344c53582a6071",
  uncovered_personal: "25d848c43076aebc26f2273325abd11943cb6311e0e42a93978f143b06aa29f5",
  notused_mindbody: "53a9d5482e16a12abf346ae33821659d2707b8290365dfd29420f60abb85840a",
  notused_other: "0752e2848c767633bc3e2418911f91d82810d957ce0dc07225bb3cf24d4bd7d9",
  live_calcom: "d725371aeab66183b4b54f821d0b0a53878f30c4e013bf26200ac72c7cc08720",
  live_highlevel_personal: "144acc18c9e0cd1d08ed33ac160d67ac7d4a8197e3a93b9d8cb2a77141c9fc9d",
  live_calendly_nobaa: "f2d0aed20eb500a1e5c3c278048e0a8a1b7854c5cb8628abe69777c8e7b67da3",
};

describe("1.3.0: the calendar-dependent draft", () => {
  const draft = () => getBaaTemplate(DRAFT_130)!;
  const render = (overrides: Partial<BaaVariables>) =>
    prepareBaa(draft(), { ...BASE, ...overrides });
  /** Every selection any version reads, in states checkout can and cannot produce. */
  const everyVariant = (): Partial<BaaVariables>[] => [
    ...Object.values(VARIANTS),
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
    test(`${DRAFT_130} / ${name} still renders the bytes drafted`, () => {
      expect(render(VARIANTS_1_3[name]!).hash).toBe(hash);
    });
  }

  test("is drafted below the offered version, unreleased, and nothing offers it", () => {
    expect(BAA_TEMPLATES[0]!.version).toBe(CURRENT_BAA_VERSION);
    expect(CURRENT_BAA_VERSION).toBe("1.2.1");
    expect(BAA_TEMPLATES[1]!.version).toBe(DRAFT_130);
    expect(draft().approvedByCounsel).toBe(false);
    // Nothing to overlap until 1.3.0 is released (plan C19).
    expect(BAA_RELEASE_OVERLAP).toEqual({});
    // Nothing in the text marks it a draft, so releasing it moves no hash;
    // an edit the audit makes before then does, in the same commit.
    const text = render({}).text;
    expect(text).toContain("Version 1.3.0 — executed electronically");
    expect(text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\[NAME, TITLE\]/);
  });

  test("the variants are distinct documents, except where an answer has nothing to change", () => {
    const hashes = [...Object.values(GOLDEN[DRAFT_130]!), ...Object.values(GOLDEN_1_3)];
    // covered_outbound is covered_estimated, as in every version since 1.2.0.
    expect(GOLDEN[DRAFT_130]!.covered_outbound).toBe(GOLDEN[DRAFT_130]!.covered_estimated);
    expect(new Set(hashes).size).toBe(hashes.length - 1);
    // Google Calendar alone and no booking system both book live and name no product.
    expect(render({ bookingSystem: "google_calendar" }).hash).toBe(
      GOLDEN[DRAFT_130]!.covered_estimated,
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
    for (const version of ["1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
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
    ] as unknown as Partial<BaaVariables>[]) {
      expect(() => render(bad), JSON.stringify(bad)).toThrow(BaaRenderError);
    }
    // No earlier version has a guard, so nothing about them changes.
    for (const version of ["1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
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
    expect(draft().clauses).toHaveLength(23);
    expect(render({}).clauseIds).toEqual(EXPECTED);
    expect(render(VARIANTS_1_3.uncovered_personal!).clauseIds).toEqual(
      EXPECTED.map(swap("google-calendar-covered", "google-calendar-uncovered")),
    );
    expect(render(VARIANTS_1_3.notused_mindbody!).clauseIds).toEqual(
      EXPECTED.map(swap("google-calendar-covered", "google-calendar-not-used")),
    );
    // The phase-two read-back swaps the data-sources clause, and Boulevard is manual.
    expect(render(VARIANTS.covered_verified_boulevard!).clauseIds).toEqual(
      EXPECTED.map(swap("data-sources-none", "data-sources-verified")).map(
        swap("google-calendar-covered", "google-calendar-not-used"),
      ),
    );
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
      expect(prepared.text, label).toContain(`PRACTICE'S GOOGLE CALENDAR\n\n${selected.body}\n\n`);
      expect(unwrap(prepared.text), label).toContain(
        unwrap(`${selected.body} ${CALENDAR_LOCATION_PARAGRAPH}`),
      );
    }
  });

  test("data sources promise calendar access only where the calendar clause grants it", () => {
    const sources = (overrides: Partial<BaaVariables>) => {
      const text = unwrap(render(overrides).text);
      return text.slice(
        text.indexOf("WHAT HEALDESK READS FROM YOUR SYSTEMS"),
        text.indexOf("PRACTICE'S GOOGLE CALENDAR"),
      );
    };
    for (const live of [{}, VARIANTS_1_3.uncovered_personal!, VARIANTS_1_3.live_calcom!]) {
      expect(sources(live), JSON.stringify(live)).toContain(
        "during a call or chat, together with the calendar access the Google Calendar clause describes.",
      );
    }
    for (const manual of [VARIANTS_1_3.notused_mindbody!, VARIANTS_1_3.notused_other!]) {
      expect(sources(manual), JSON.stringify(manual)).toContain("during a call or chat.");
      expect(sources(manual), JSON.stringify(manual)).not.toContain("calendar access");
    }
    // The first sentence is 1.2.1's, naming the system when it has a name.
    expect(sources(VARIANTS_1_3.notused_mindbody!)).toContain(
      "healdesk holds no credentials to Mindbody, or to any other practice-management or point-of-sale system",
    );
    expect(sources(VARIANTS_1_3.live_calcom!)).toContain(
      "healdesk holds no credentials to Cal.com,",
    );
    expect(sources({})).toContain(
      "healdesk holds no credentials to any practice-management or point-of-sale system and reads nothing from one.",
    );
  });

  test("says what the spec, the owner and the 1 October review require, on every variant", () => {
    for (const overrides of everyVariant()) {
      const text = unwrap(render(overrides).text);
      const label = JSON.stringify(overrides);
      // 24 hours' notice of a new subcontractor, the right to object kept
      // (owner, 6 October 2026), in the one shared sentence.
      expect(text, label).toContain(subprocessorNoticeClauseBody());
      expect(text, label).toContain("at least 24 hours' notice by email");
      expect(text, label).not.toContain("fifteen days");
      // Q8: the Payments clause and the state-law clause, as drafted for
      // 1.2.1 in agreement-changes.md §6 and §9, and the 164.514(b) citation.
      expect(text, label).toContain(
        "PAYMENTS Where Practice takes deposits, healdesk creates a payment link through Practice's own payment processor.",
      );
      expect(text, label).toContain(
        "no service name or clinical detail, including in metadata and the statement descriptor. healdesk never takes card numbers.",
      );
      expect(text, label).toContain(
        "WHERE PRACTICE IS NOT A COVERED ENTITY healdesk processes patient information only on Practice's documented instructions",
      );
      expect(text, label).toContain(
        "The reporting, subcontractor, security and return-or-destroy clauses of this agreement apply to that information as they apply to PHI.",
      );
      expect(text, label).toContain(
        "aggregate statistics about the Services, de-identified under 45 CFR 164.514(b)",
      );
      // Every 1.2.1 accuracy fix stays.
      expect(text, label).toContain("which it may retain for up to two years");
      expect(text, label).toContain(
        "healdesk keeps transcripts and conversation records for 90 days",
      );
      expect(text, label).toContain(
        "An email whose receiving server will not negotiate encryption is failed, not sent",
      );
      expect(text, label).toContain("state breach-notification and consumer-health-privacy laws");
      expect(text, label).not.toContain("FTC Health Breach");
      // Inbound only, no booking election, and no revenue claim (the
      // phase-two read-back's 1.0.0 clause is the one place that measures
      // revenue, and checkout cannot reach it in v1).
      expect(text, label).toContain("healdesk places no calls and sends no SMS");
      expect(text, label).not.toMatch(
        /warrants that|holds the consents|Callbacks clause|called back|DIRECT BOOKING|reactivation/i,
      );
      if ({ ...BASE, ...overrides }.attributionMode !== "verified") {
        expect(text, label).not.toMatch(/revenue/i);
      }
      // The calendar clause never promises a revocation at Google. (1.0.0's
      // verified data-sources clause speaks of the practice revoking access
      // to its own system, which is a different thing.)
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
    "calendar-election/1.0.0": "d047b3894a46da62c737b2058e7dfedd1134c7c0f8be4517962c6e43b91be8be",
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
    const agreement = prepareBaa(getBaaTemplate(DRAFT_130)!, {
      ...BASE,
      calendarAccount: "personal",
    });
    expect(agreement.clauseIds).toContain(selected.clauseId);
    expect(election).toContain(selected.body);
    expect(agreement.text).toContain(selected.body);
    expect(unwrap(election)).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
  });

  test("it is not released, so only a demo clinic's election may count", () => {
    // Released with BAA 1.3.0 (plan C19). Until then a draft election counts
    // only for a demo clinic (plan A10), which C6 and C7 enforce.
    expect(currentCalendarElection().approvedByCounsel).toBe(false);
  });
});

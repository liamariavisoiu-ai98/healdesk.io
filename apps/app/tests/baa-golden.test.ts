import {
  BAA_TEMPLATES,
  CURRENT_BAA_VERSION,
  currentDirectBookingAddendum,
  getBaaTemplate,
  hashDirectBookingAddendum,
  prepareBaa,
  renderDirectBookingAddendum,
  type BaaVariables,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

/**
 * The clause library is frozen per template version, and this is the freeze.
 *
 * Every acceptance row stores the SHA-256 of the exact text the clinic
 * signed. That hash is only evidence if the same template version still
 * renders the same bytes years later — and both published versions share one
 * clause array (`CLAUSES` in packages/catalog/src/baa.ts), so editing a clause
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
 * 1.1.0-draft is under counsel review, so its hashes are regenerated when the
 * draft is deliberately revised (last: 29 September 2026, the callbacks,
 * calendar-write and direct-booking clauses) and never otherwise. 1.0.0 and
 * 0.1.0-draft have been signed; their hashes never move.
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
};

/** Text assertions compare through this: the 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ");

/** Shared by every version. The two 1.1.0-only selections are in VARIANTS_1_1. */
const VARIANTS: Record<string, Partial<BaaVariables>> = {
  covered_estimated: {},
  notcovered_estimated: { isCoveredEntity: false },
  unknown_estimated: { isCoveredEntity: null },
  covered_outbound: { outboundMessaging: true },
  covered_verified_boulevard: { attributionMode: "verified", connectedPlatform: "Boulevard" },
};

/** version → variant → sha256 of the assembled text. Append-only. */
const GOLDEN: Record<string, Record<string, string>> = {
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
    const hashes = new Set(Object.values(GOLDEN[CURRENT_BAA_VERSION]!));
    expect(hashes.size).toBe(Object.keys(VARIANTS).length);
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

import {
  applicableClauses,
  BAA_RELEASE_OVERLAP,
  BaaRenderError,
  BAA_EXPLAINER,
  BOOKING_SYSTEMS,
  buildBaaSelections,
  CALENDAR_ACCOUNTS,
  CALENDAR_CLAUSE_IDS_1_3,
  currentBaaTemplate,
  CURRENT_BAA_VERSION,
  getBaaTemplate,
  getPlatform,
  hashBaaText,
  isBaaVersionAcceptable,
  MIN_ACCEPTABLE_BAA_VERSION,
  NO_PLATFORM_ID,
  platforms,
  prepareBaa,
  renderBaa,
  SIGNATURE_HEADER,
  sign,
  specialties,
  supportsVerifiedAttribution,
  templateReadsCalendarAccount,
  TIMESTAMP_HEADER,
  type BaaVariables,
} from "@healdesk/catalog";
import { assentSentence, BAA_ASSENT_LABEL } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { POST as signRoute } from "@/app/api/agreements/route";
import {
  AgreementError,
  agreementKindForRequest,
  getAgreement,
  prepareAgreement,
  signableTemplate,
  signAgreement,
  unboundAgreements,
  validateSignRequest,
  type SignableOptions,
  type SignAgreementRequest,
  type SignedAgreement,
} from "@/lib/agreements";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * Signing the BAA, before payment.
 *
 * The properties defended here are the ones that would be hard to reconstruct
 * after a dispute: that the stored text is the text the signer saw, that it
 * cannot be edited afterwards, and that a signature can only ever belong to one
 * account.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Text assertions compare through this: the 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ");

const VARS: BaaVariables = {
  clinicLegalName: "Radiance Med Spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  effectiveDate: "2026-08-18",
  specialty: "Med spa",
  isCoveredEntity: false,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: true,
};

const validSignRequest = (over: Record<string, unknown> = {}) =>
  ({
  clinicLegalName: "Radiance Med Spa",
  specialty: "med-spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  isCoveredEntity: false,
  attributionMode: "estimated",
  platform: "none",
  assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
    ...over,
  }) as SignAgreementRequest;

/** The effective date the render tests pin, so no test depends on the day it runs. */
const DATE = "2026-10-06";

/**
 * The variables signAgreement built before plan C3, line for line: the
 * picker's platform named by its catalogue name and "none" by nothing, the
 * specialty's display name, and the fixed values v1 never asks about. Main's
 * checkout still builds its preview this way and hashes it, so a 1.2.1
 * signature has to come out of the server byte for byte as it did then, or
 * the displayed-hash check refuses the buyer at the last step.
 */
function legacyVariables(request: SignAgreementRequest, effectiveDate: string): BaaVariables {
  return {
    clinicLegalName: request.clinicLegalName.trim(),
    signatoryName: request.signatoryName.trim(),
    signatoryTitle: request.signatoryTitle?.trim() || undefined,
    signatoryEmail: request.signatoryEmail.trim().toLowerCase(),
    effectiveDate,
    specialty: specialties.find((s) => s.id === request.specialty)?.name ?? request.specialty,
    isCoveredEntity: request.isCoveredEntity,
    attributionMode: request.attributionMode,
    connectedPlatform:
      request.platform === NO_PLATFORM_ID
        ? null
        : (getPlatform(request.platform ?? "")?.name ?? null),
    outboundMessaging: false,
    bookingMode: "desk_confirms",
    calendarWrite: null,
  };
}

/**
 * Standing in for the release of 1.3.0 (plan C19), which makes it the current
 * version. Until then it is a draft nothing can sign, so a test that signs or
 * renders one as signed passes this, and says so. It changes which version is
 * current and nothing else: the draft's own approval flag stays false.
 */
const RELEASED_1_3 = { current: getBaaTemplate("1.3.0")! } satisfies SignableOptions;

/** The refusal a synchronous call makes, so a test can read the field it names. */
function refusal(run: () => unknown): AgreementError {
  try {
    run();
  } catch (error) {
    if (error instanceof AgreementError) return error;
    throw error;
  }
  throw new Error("Expected an AgreementError; nothing was refused.");
}

describe("rendering", () => {
  test("names the practice and the signer in the document itself", () => {
    const text = renderBaa(currentBaaTemplate(), VARS);

    expect(text).toContain("Radiance Med Spa");
    expect(text).toContain("Alex Chen, Owner");
    expect(text).toContain("alex@radiance.test");
    // Rendered, not templated: no placeholder may survive into a contract.
    expect(text).not.toMatch(/\{\{/);
  });

  test("a missing value throws rather than rendering a contract naming nobody", () => {
    // The dangerous failure is not a crash, it's a silently empty party name —
    // a document that looks complete and binds no one.
    expect(() =>
      renderBaa(currentBaaTemplate(), { ...VARS, clinicLegalName: "  " }),
    ).toThrow(BaaRenderError);
    expect(() =>
      renderBaa(currentBaaTemplate(), { ...VARS, signatoryName: "" }),
    ).toThrow(BaaRenderError);
  });

  test("a placeholder that survives assembly throws instead of shipping", () => {
    // Clause bodies are functions now, so the old {{name}} substitution can no
    // longer leak. This guards the remaining route: someone writes a clause
    // with template syntax the assembler no longer honours, and it renders
    // literally into a contract.
    const broken = {
      ...currentBaaTemplate(),
      clauses: [
        {
          id: "leaky",
          heading: "Leaky",
          appliesWhen: () => true,
          body: () => "Between {{clinicLegalName}} and whoever.",
        },
      ],
    };
    expect(() => renderBaa(broken, VARS)).toThrow(/placeholder/i);
  });

  test("a clause that renders empty throws rather than leaving a numbered blank", () => {
    const broken = {
      ...currentBaaTemplate(),
      clauses: [
        { id: "hollow", heading: "Hollow", appliesWhen: () => true, body: () => "   " },
      ],
    };
    expect(() => renderBaa(broken, VARS)).toThrow(/hollow/i);
  });

  test("an agreement with no applicable clauses is refused", () => {
    // Not a hypothetical: a future predicate written with the wrong comparison
    // could exclude everything, and an empty contract that still hashes and
    // stores is the worst possible outcome — it looks like evidence.
    const empty = { ...currentBaaTemplate(), clauses: [] };
    expect(() => renderBaa(empty, VARS)).toThrow(/cannot be an agreement/i);
  });

  test("the title is optional and leaves no dangling comma", () => {
    const text = renderBaa(currentBaaTemplate(), {
      ...VARS,
      signatoryTitle: undefined,
    });
    expect(text).toContain("Alex Chen\n");
    expect(text).not.toContain("Alex Chen,");
  });

  test("covered-entity status changes the document, all three ways", () => {
    const yes = renderBaa(currentBaaTemplate(), { ...VARS, isCoveredEntity: true });
    const no = renderBaa(currentBaaTemplate(), { ...VARS, isCoveredEntity: false });
    const unknown = renderBaa(currentBaaTemplate(), {
      ...VARS,
      isCoveredEntity: null,
    });

    expect(yes).toMatch(/is\s+therefore\s+a\s+covered\s+entity/);
    expect(no).toMatch(/may\s+therefore\s+not\s+be\s+a\s+covered\s+entity/i);
    // 1.2.0 (via 1.1.0's practice-status clause): the practice NOTIFIES its
    // status; healdesk no longer "determines" or "confirms" it.
    expect(unwrap(unknown)).toContain(
      "has not yet notified healdesk whether it is a covered entity",
    );

    // Three genuinely different documents, so three different hashes.
    expect(new Set([hashBaaText(yes), hashBaaText(no), hashBaaText(unknown)]).size)
      .toBe(3);
  });

  test("the hash is of the rendered text, so two clinics never share one", () => {
    const a = prepareBaa(currentBaaTemplate(), VARS);
    const b = prepareBaa(currentBaaTemplate(), {
      ...VARS,
      clinicLegalName: "Glow Clinic",
    });

    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe(hashBaaText(a.text));
  });

  test("rendering is deterministic — the same inputs hash the same", () => {
    expect(prepareBaa(currentBaaTemplate(), VARS).hash).toBe(
      prepareBaa(currentBaaTemplate(), VARS).hash,
    );
  });

  test("the draft template says so in its own body", () => {
    // Belt and braces with approvedByCounsel: someone reading only the document
    // must be able to see it isn't executable.
    if (!currentBaaTemplate().approvedByCounsel) {
      expect(renderBaa(currentBaaTemplate(), VARS)).toMatch(/DRAFT/);
    }
  });

  test("the offered template is released, says so, and carries no draft wording", () => {
    // 1.2.1 was released on 2026-10-01 on the owner's own review, without
    // external counsel (the doc comment on approvedByCounsel in
    // packages/catalog/src/baa.ts records that). The document itself must
    // read as executable: a DRAFT line, or the 1.1.0 acceptance placeholder,
    // in an offered agreement is the draft preamble leaking into production.
    expect(CURRENT_BAA_VERSION).toBe("1.2.1");
    expect(currentBaaTemplate().approvedByCounsel).toBe(true);
    const text = renderBaa(currentBaaTemplate(), VARS);
    expect(text).toContain("Version 1.2.1 — executed electronically");
    expect(text).not.toMatch(/DRAFT|NOT FOR EXECUTION|\[NAME, TITLE\]/);
    // The party is the legal entity, not the trade name alone.
    expect(unwrap(text)).toContain('Viixi FZC, a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates ("healdesk")');
  });
});

describe("the assent sentence", () => {
  test("mentions no consent warranty, because no offered agreement contains one", () => {
    // Until 1.2.0 the fixed label ended "and confirm the consent warranty
    // above", and no offered document had carried that warranty since
    // outboundMessaging went false on both signing paths. The words beside
    // the checkbox are the evidence of what was agreed to; they have to
    // describe the document above them. Rows signed under the old label keep
    // it — that is what storing the label is for.
    expect(BAA_ASSENT_LABEL).toBe("I agree to the Business Associate Agreement");
    expect(assentSentence("Radiance Med Spa")).toBe(
      "I agree to the Business Associate Agreement on behalf of Radiance Med Spa, and I confirm I am authorised to enter into it.",
    );
    expect(assentSentence("  ")).toContain("on behalf of my practice");
  });
});

/**
 * Every reachable agreement, enumerated.
 *
 * This is the test that makes "the contract adapts to what they bought" and
 * "a lawyer has approved the contract" compatible claims. The clause
 * predicates are pure, so the variant set is finite and can be walked — and
 * counsel reviews that matrix once instead of an unbounded set of documents.
 *
 * If a future clause makes the set combinatorially large, that is the signal
 * that it has stopped being reviewable, and this test failing to enumerate is
 * the right way to find out.
 */
describe("every variant the funnel can produce", () => {
  // outboundMessaging is not an axis any more. In 1.0.0 it keyed the consent
  // warranty and the reactivation gate; 1.2.0 has neither clause, so the
  // field has no contractual consequence and a variant per value would be
  // two names for one document. The test below pins that it stays that way.
  const AXES = {
    isCoveredEntity: [true, false, null] as const,
    attributionMode: ["estimated", "verified"] as const,
    connectedPlatform: [null, "Boulevard"] as const,
  };

  const variants: BaaVariables[] = [];
  for (const isCoveredEntity of AXES.isCoveredEntity) {
    for (const attributionMode of AXES.attributionMode) {
      for (const connectedPlatform of AXES.connectedPlatform) {
        // Verified with no platform is unreachable — the funnel only offers
        // verified once a connectable platform is chosen, and signAgreement
        // rejects the combination. Skip rather than assert on a document
        // that can never be signed.
        if (attributionMode === "verified" && connectedPlatform === null) {
          continue;
        }
        variants.push({
          ...VARS,
          isCoveredEntity,
          attributionMode,
          connectedPlatform,
          // What both signing paths pass.
          outboundMessaging: false,
        });
      }
    }
  }

  test("there are exactly as many as the axes predict", () => {
    // 3 × ((1 estimated × 2 platforms) + (1 verified × 1 platform)) = 9
    expect(variants).toHaveLength(9);
  });

  test.each(variants.map((v) => [describeVariant(v), v] as const))(
    "%s renders a complete agreement",
    (_label, variables) => {
      const text = renderBaa(currentBaaTemplate(), variables);

      // Names both parties, and no placeholder survives.
      expect(text).toContain(variables.clinicLegalName);
      expect(text).toContain("healdesk");
      expect(text).not.toMatch(/\{\{/);
      expect(text).not.toMatch(/undefined|\[object/);

      // The obligations that must be in EVERY agreement, whatever they bought.
      for (const required of [
        "definitions",
        "practice-status",
        "permitted-uses",
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
      ]) {
        expect(
          applicableClauses(currentBaaTemplate(), variables).map((c) => c.id),
        ).toContain(required);
      }
    },
  );

  test("every variant is a distinct document with a distinct hash", () => {
    // If two variants hash the same, one of the axes is not actually changing
    // the agreement — which means we are asking a question that has no
    // contractual consequence, and should stop asking it.
    const hashes = variants.map((v) => hashBaaText(renderBaa(currentBaaTemplate(), v)));
    expect(new Set(hashes).size).toBe(variants.length);
  });

  test("exactly one data-source clause applies, always", () => {
    // These two are mutually exclusive and jointly exhaustive. A clinic whose
    // contract describes both a connection and no connection, or neither, is
    // the failure this asserts against.
    for (const variables of variants) {
      const ids = applicableClauses(currentBaaTemplate(), variables).map(
        (c) => c.id,
      );
      const sources = ids.filter((id) => id.startsWith("data-sources-"));
      expect(sources).toHaveLength(1);
    }
  });

  test("only a verified clinic's agreement describes reading their systems", () => {
    for (const variables of variants) {
      const text = renderBaa(currentBaaTemplate(), variables);
      if (variables.attributionMode === "verified") {
        expect(text).toMatch(/READ-ONLY access/);
        expect(text).toContain(variables.connectedPlatform!);
      } else {
        // The important half: a clinic that connected nothing must not be
        // handed a contract describing credentials we do not hold.
        expect(text).toMatch(/holds no\s+credentials/);
        expect(text).not.toMatch(/READ-ONLY access/);
        // v1 reads nothing from any practice system; a clinic that named its
        // platform (a Mindbody or Boulevard clinic in manual booking mode)
        // reads that about its own system, by name.
        if (variables.connectedPlatform) {
          expect(unwrap(text)).toContain(
            `holds no credentials to ${variables.connectedPlatform}, or to any other practice-management or point-of-sale system`,
          );
        }
        // And no v1 agreement claims revenue: the figure v1 may state is
        // booked value, and the BAA states no figure at all.
        expect(text).not.toMatch(/revenue/i);
      }
    }
  });

  test("outbound messaging has no contractual consequence, and no outbound clause is reachable", () => {
    // v1 is inbound only. 1.0.0 keyed the consent warranty and the
    // reactivation gate to outboundMessaging; 1.2.0 registers neither clause,
    // so flipping the field must change nothing — which is why it is no
    // longer an axis above. A variant that DID change would mean an outbound
    // clause had found its way back into the offered template.
    for (const variables of variants) {
      const off = prepareBaa(currentBaaTemplate(), variables);
      const on = prepareBaa(currentBaaTemplate(), { ...variables, outboundMessaging: true });
      expect(on.hash).toBe(off.hash);
      for (const prepared of [off, on]) {
        for (const gone of ["outbound-consent", "reactivation-gate", "consented-callbacks", "direct-booking"]) {
          expect(prepared.clauseIds).not.toContain(gone);
        }
        expect(prepared.text).not.toMatch(/warrants that|holds the consents|reactivation|called back/i);
      }
    }
  });

  test("clause numbering is contiguous and starts at 1", () => {
    for (const variables of variants) {
      const text = renderBaa(currentBaaTemplate(), variables);
      const numbers = [...text.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) =>
        Number(m[1]),
      );
      expect(numbers).toEqual(
        Array.from({ length: numbers.length }, (_, i) => i + 1),
      );
    }
  });
});

function describeVariant(v: BaaVariables): string {
  return [
    `ce=${String(v.isCoveredEntity)}`,
    v.attributionMode,
    v.connectedPlatform ?? "no-platform",
  ].join("/");
}

/**
 * 1.3.0, enumerated the same way. It is drafted at BAA_TEMPLATES[1] and not
 * offered, but every document it can produce is walked now, so the audit
 * before its release reads the whole matrix rather than a sample. The
 * variables are built by buildBaaSelections, the one builder both signing
 * paths will call, so this is the set the funnel can actually produce.
 *
 * Two answers join the axes: the booking system, of which one live system
 * (no booking system) and one manual one (Boulevard) stand for the rest, and
 * the kind of Google account. Whether the practice declared itself a covered
 * entity does not limit the calendar kind (owner, Q3), so the axes are
 * crossed in full. Verified reporting is not an axis here: 1.3.0 refuses it
 * (pre-release audit, HRC-17), which the last test pins.
 */
describe("every 1.3.0 variant the funnel will produce", () => {
  const DRAFT = "1.3.0";
  const draft = () => getBaaTemplate(DRAFT)!;
  const SIGNER = {
    clinicLegalName: VARS.clinicLegalName,
    signatoryName: VARS.signatoryName,
    signatoryTitle: VARS.signatoryTitle,
    signatoryEmail: VARS.signatoryEmail,
    effectiveDate: VARS.effectiveDate,
  };

  const inputs: { label: string; variables: BaaVariables }[] = [];
  for (const isCoveredEntity of [true, false, null] as const) {
    for (const bookingSystem of ["none", "boulevard"] as const) {
      for (const calendarAccount of CALENDAR_ACCOUNTS) {
        const selections = buildBaaSelections({
          specialtyId: "med-spa",
          attributionMode: "estimated",
          bookingSystem,
          isCoveredEntity,
          calendarAccount,
          template: draft(),
        });
        inputs.push({
          label: [`ce=${String(isCoveredEntity)}`, bookingSystem, calendarAccount].join("/"),
          variables: { ...selections, ...SIGNER },
        });
      }
    }
  }

  /** One input per distinct document, in enumeration order. */
  const documents = [
    ...new Map(
      inputs.map((input) => [hashBaaText(renderBaa(draft(), input.variables)), input]),
    ).values(),
  ];

  test("there are exactly as many documents as the axes predict", () => {
    // 3 covered-entity answers × 3 account kinds × (live, manual) = 18
    // inputs. A manual system connects to no calendar, so its account answer
    // is kept and changes nothing: 3 × (3 live documents + 1 manual) = 12.
    expect(inputs).toHaveLength(18);
    expect(documents).toHaveLength(12);
  });

  test.each(documents.map((d) => [d.label, d.variables] as const))(
    "%s renders a complete agreement",
    (_label, variables) => {
      const text = renderBaa(draft(), variables);
      const ids = applicableClauses(draft(), variables).map((c) => c.id);
      expect(text).toContain(variables.clinicLegalName);
      expect(text).toContain("Version 1.3.0 — executed electronically");
      expect(text).not.toMatch(/\{\{|undefined|\[object/);
      for (const required of [
        "definitions",
        "practice-status",
        "permitted-uses",
        "state-law",
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
      ]) {
        expect(ids).toContain(required);
      }
      // Exactly one data-sources clause and exactly one calendar clause.
      expect(ids.filter((id) => id.startsWith("data-sources-"))).toHaveLength(1);
      expect(
        ids.filter((id) => (CALENDAR_CLAUSE_IDS_1_3 as readonly string[]).includes(id)),
      ).toHaveLength(1);
      const numbers = [...text.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    },
  );

  test("the calendar clause follows the two answers, and nothing else", () => {
    for (const { label, variables } of inputs) {
      const ids = applicableClauses(draft(), variables).map((c) => c.id);
      const expected =
        variables.bookingSystem === "boulevard"
          ? "google-calendar-not-used"
          : variables.calendarAccount === "workspace_baa"
            ? "google-calendar-covered"
            : "google-calendar-uncovered";
      expect(ids, label).toContain(expected);
    }
  });

  test("no agreement describes reading the practice's systems, and none claims revenue", () => {
    for (const { label, variables } of documents) {
      const text = renderBaa(draft(), variables);
      expect(text, label).toMatch(/holds no\s+credentials/);
      expect(text, label).not.toMatch(/READ-ONLY access|revenue/i);
    }
  });

  test("refuses verified reporting, the phase-two read-back it does not describe", () => {
    // Fenced at signing too (HEALDESK_PHASE_TWO_ATTRIBUTION), but the
    // document refuses it itself, so no caller can produce one (HRC-17).
    for (const bookingSystem of ["boulevard", "mindbody", "calcom"] as const) {
      const selections = buildBaaSelections({
        specialtyId: "med-spa",
        attributionMode: "verified",
        bookingSystem,
        isCoveredEntity: true,
        calendarAccount: "workspace_baa",
        template: draft(),
      });
      expect(() => renderBaa(draft(), { ...selections, ...SIGNER }), bookingSystem).toThrow(
        BaaRenderError,
      );
    }
  });

  test("is not signable while it is a draft", () => {
    // Signing accepts the current template, or a released version still
    // inside its release overlap; 1.3.0 is neither until its release (plan
    // C19), so it is offered from then, never before.
    const request = validSignRequest({
      templateVersion: DRAFT,
      platform: undefined,
      bookingSystem: "none",
      calendarAccount: "workspace_baa",
    });
    expect(refusal(() => validateSignRequest(request))).toMatchObject({
      field: "templateVersion",
    });
    expect(refusal(() => prepareAgreement(request, DATE))).toMatchObject({
      field: "templateVersion",
    });
    expect(draft().approvedByCounsel).toBe(false);
  });
});

describe("the explainer shown before payment", () => {
  test("pin-cites every claim it makes to its own subparagraph", () => {
    // Not all of these live in 164.504: the security-incident duty is in the
    // Security Rule at 164.314(a)(2)(i)(C), and termination is at (e)(2)(iii).
    // An earlier draft asserted they were all in 164.504(e)(2)(ii), which is a
    // checkable claim about the law that was wrong.
    for (const term of BAA_EXPLAINER.terms) {
      expect(term.citation).toMatch(/^164\.(504|314|410)/);
      expect(term.plain.length).toBeGreaterThan(15);
    }
  });

  test("leads with the use-and-disclosure limit, which is what answers the objection", () => {
    // The copy asks "why do I need a contract if you already promise not to
    // train on my data?" — and (e)(2)(i)/(ii)(A) is the answer. A version that
    // posed the question and omitted the answer shipped once; this stops it.
    expect(BAA_EXPLAINER.terms[0]!.citation).toContain("(e)(2)(i)");
    expect(BAA_EXPLAINER.terms[0]!.plain).toMatch(/enforceable limit/i);
  });

  test("keeps the qualifier on return-or-destroy", () => {
    // 164.504(e)(2)(ii)(J) says "if feasible" and provides a fallback. For a
    // voice product holding recordings, dropping that is the likeliest
    // "you told me it was fine" hook in the whole summary.
    const destroy = BAA_EXPLAINER.terms.find((t) =>
      t.citation.includes("(J)"),
    );
    expect(destroy!.plain).toMatch(/not feasible/i);
  });

  test("names the rule it is describing", () => {
    expect(BAA_EXPLAINER.lead).toContain("164.502(e)");
    expect(BAA_EXPLAINER.objection).toContain("164.504(e)");
  });

  test("disclaims being legal advice, and says the agreement governs", () => {
    // A vendor explaining the law to a customer is useful and is also where
    // "you told me it was fine" arguments start.
    expect(BAA_EXPLAINER.disclaimer).toMatch(/not\s+legal advice/i);
    expect(BAA_EXPLAINER.disclaimer).toMatch(/not your lawyer/i);
    expect(BAA_EXPLAINER.disclaimer).toMatch(/agreement governs/i);
  });
});

/**
 * The go-live floor (docs/counsel/agreement-changes.md §10).
 *
 * Go-live refuses an account whose agreement in effect is older than
 * MIN_ACCEPTABLE_BAA_VERSION; the database holds the same set as an
 * allow-list, and tests/database-audit.test.ts proves the two agree.
 */
describe("the go-live floor", () => {
  test("is a released version, and a fresh signature always clears it", () => {
    // Signing produces the current version or, inside a release overlap, the
    // released version the current one replaced (signableTemplate reads
    // BAA_RELEASE_OVERLAP). If the current version were below the floor, no
    // new clinic could go live at all; if a version in the overlap were, a
    // buyer could sign it and then be refused at go-live, so a release that
    // raises the floor past the version it replaces does not list that one.
    const floor = getBaaTemplate(MIN_ACCEPTABLE_BAA_VERSION);
    expect(floor?.approvedByCounsel).toBe(true);
    expect(isBaaVersionAcceptable(CURRENT_BAA_VERSION)).toBe(true);
    expect(isBaaVersionAcceptable(MIN_ACCEPTABLE_BAA_VERSION)).toBe(true);
    for (const version of Object.keys(BAA_RELEASE_OVERLAP)) {
      expect(isBaaVersionAcceptable(version), version).toBe(true);
    }
  });

  test("refuses every superseded version, every draft, and anything unregistered", () => {
    // 1.3.0 is a draft until the owner releases it (agreement-changes.md
    // §12), and the other drafts were never executable. Releasing 1.3.0
    // changes this list along with the floor, on purpose.
    for (const version of ["1.3.0", "1.2.0", "1.1.0-draft", "1.0.0", "0.1.0-draft", "1.3", "9.9.9", ""]) {
      expect(isBaaVersionAcceptable(version), version).toBe(false);
    }
  });
});

describe("validation", () => {
  test("accepts a complete signature", () => {
    expect(() => validateSignRequest(validSignRequest())).not.toThrow();
  });

  test("a one-character name is not a signature", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ signatoryName: "A" })),
    ).toThrow(AgreementError);
  });

  test("'I don't know' is a valid answer to the covered-entity question", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ isCoveredEntity: null })),
    ).not.toThrow();
    // But an absent answer is not — it would silently pick a clause.
    expect(() =>
      validateSignRequest(validSignRequest({ isCoveredEntity: undefined })),
    ).toThrow(/bills insurance/i);
  });

  test("refuses at signature an address the mail layer could not send to", () => {
    // This is the earliest point a bad address can be caught and the one that
    // decides what goes on an append-only legal record. The check used to be
    // `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/` — negated classes, which accept every
    // code point they do not name — so a non-ASCII mailbox name passed here
    // and was refused later by the transport: a signed agreement whose
    // counterparty could never be sent their copy, on a row nobody can amend.
    expect(() =>
      validateSignRequest(
        validSignRequest({ signatoryEmail: "günter@clinic.test" }),
      ),
    ).toThrow(/work email/i);

    // An internationalised DOMAIN is the other case. It has an A-label, the
    // transport converts it at send time, and refusing it here would turn away
    // a practice at an address we can reach perfectly well.
    expect(() =>
      validateSignRequest(
        validSignRequest({ signatoryEmail: "gunter@klinik-münchen.test" }),
      ),
    ).not.toThrow();
  });

  test("refuses a stale template version", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ templateVersion: "0.0.0-ancient" })),
    ).toThrow(AgreementError);
  });

  test("requires the assent label, because it is the evidence of what was clicked", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ assentLabel: "" })),
    ).toThrow(AgreementError);
  });

  test("refuses an assent label that is not the published one, exactly", () => {
    // The whole reason the column exists is that enforceability turns on the
    // wording of the assent action. A client that reports different words —
    // an old build, or a tampered request — must not be able to freeze them
    // into the record as "what the button said".
    expect(() =>
      validateSignRequest(
        validSignRequest({
          // The label every build before 1.2.0 sent — exactly the case the
          // check exists for: a stale bundle reporting words the current
          // agreement does not say.
          assentLabel:
            "I agree to the Business Associate Agreement and confirm the consent warranty above",
        }),
      ),
    ).toThrow(/does not match/);
    expect(() =>
      validateSignRequest(validSignRequest({ assentLabel: `${BAA_ASSENT_LABEL} ` })),
    ).not.toThrow(); // surrounding whitespace is trimmed, nothing else is forgiven
    expect(() =>
      validateSignRequest(validSignRequest({ assentLabel: BAA_ASSENT_LABEL.toLowerCase() })),
    ).toThrow(/does not match/);
  });

  test("rejects a malformed displayed-document hash", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ displayedHash: "not-a-hash" })),
    ).toThrow(/hash/i);
    // Absent is allowed — a browser with no Web Crypto still has to be able to
    // sign, and the omission is recorded on the row rather than passing silently.
    expect(() =>
      validateSignRequest(validSignRequest({ displayedHash: undefined })),
    ).not.toThrow();
  });

  test("refuses verified reporting while phase two is off", () => {
    // Checkout no longer offers verified attribution, but a hand-crafted
    // request could still ask for it, and the clause it selects describes
    // read-only access to a practice system and "revenue", neither of which
    // v1 has. The same flag that keeps the phase-two jobs off keeps this
    // clause unsignable.
    delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    expect(() =>
      validateSignRequest(
        validSignRequest({ attributionMode: "verified", platform: "boulevard" }),
      ),
    ).toThrow(/not offered in v1/);

    process.env.HEALDESK_PHASE_TWO_ATTRIBUTION = "true";
    try {
      expect(() =>
        validateSignRequest(
          validSignRequest({ attributionMode: "verified", platform: "boulevard" }),
        ),
      ).not.toThrow();
    } finally {
      delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    }
  });
});

/**
 * Which agreement a practice signs is agreementKindFor's to decide (packages/
 * catalog/src/agreement-kind.ts), and this endpoint signs only the business
 * associate agreement. A practice the decision sends anywhere else is
 * refused by name, never handed a BAA.
 */
describe("which agreement a request signs", () => {
  test("a veterinary practice is refused, because there is no agreement it can sign yet", () => {
    // It could sign a BAA here before plan C3. HIPAA does not reach a practice
    // whose patients are animals, and the DPA it signs instead is unreleased.
    for (const isCoveredEntity of [true, false, null]) {
      expect(
        refusal(() =>
          validateSignRequest(validSignRequest({ specialty: "veterinary", isCoveredEntity })),
        ),
      ).toMatchObject({ message: "This specialty can't sign up yet.", field: "specialty" });
    }
  });

  test("a med spa that bills no insurance still signs the BAA while the DPA is unreleased", () => {
    expect(() =>
      validateSignRequest(validSignRequest({ specialty: "med-spa", isCoveredEntity: false })),
    ).not.toThrow();
    expect(agreementKindForRequest({ specialty: "med-spa", isCoveredEntity: false })).toBe("baa");
  });

  test("a plastic surgery practice signs the BAA, whatever it answers", () => {
    for (const isCoveredEntity of [true, false, null]) {
      expect(() =>
        validateSignRequest(validSignRequest({ specialty: "plastic-surgery", isCoveredEntity })),
      ).not.toThrow();
      // Released or not, the DPA is never this practice's agreement.
      expect(
        agreementKindForRequest(
          { specialty: "plastic-surgery", isCoveredEntity },
          { dpaReleased: true },
        ),
      ).toBe("baa");
    }
  });

  test("once the DPA is released, a practice it would sign is refused here, not handed a BAA", () => {
    // The branch the funnel's DPA change replaces with DPA signing.
    for (const request of [
      { specialty: "med-spa", isCoveredEntity: false },
      { specialty: "hair-restoration", isCoveredEntity: false },
      { specialty: "veterinary", isCoveredEntity: null },
    ]) {
      expect(
        refusal(() => agreementKindForRequest(request, { dpaReleased: true })),
        request.specialty,
      ).toMatchObject({ field: "specialty" });
    }
    // "Yes" and "I don't know" still sign the BAA, as the covered-entity
    // question's "not_sure" does.
    for (const isCoveredEntity of [true, null]) {
      expect(
        agreementKindForRequest({ specialty: "med-spa", isCoveredEntity }, { dpaReleased: true }),
      ).toBe("baa");
    }
  });

  test("signing directly refuses the same practice, before anything is rendered", () => {
    expect(
      refusal(() => prepareAgreement(validSignRequest({ specialty: "veterinary" }), DATE)),
    ).toMatchObject({ field: "specialty" });
  });
});

/**
 * The current version signs; so does the released version a release
 * replaced, until the deadline in BAA_RELEASE_OVERLAP, because a release
 * reaches the two apps in two deploys (plan §2.2). The map is empty and 1.3.0
 * a draft until that release, so these tests stand in for it as plan C19 is
 * to make it: 1.3.0 current, and 1.2.1 in the overlap.
 */
describe("which versions can be signed", () => {
  const release = (now: string, deadline = "2026-10-09T12:00:00Z"): SignableOptions => ({
    ...RELEASED_1_3,
    releaseOverlap: { "1.2.1": deadline },
    now: new Date(now),
  });

  test("only the current version while the release overlap is empty", () => {
    // Empty until the release sets it (plan C19), and emptied again once both
    // production deployments are verified (plan C20).
    expect(BAA_RELEASE_OVERLAP).toEqual({});
    expect(signableTemplate(CURRENT_BAA_VERSION)).toBe(currentBaaTemplate());
    for (const version of ["1.3.0", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      expect(
        refusal(() => signableTemplate(version)),
        version,
      ).toMatchObject({
        message: expect.stringMatching(/has been updated/),
        field: "templateVersion",
      });
    }
  });

  test("after a release, the version it replaced signs until its deadline, and not from that instant", () => {
    expect(signableTemplate("1.2.1", release("2026-10-09T11:59:59.999Z")).version).toBe("1.2.1");
    expect(() => signableTemplate("1.2.1", release("2026-10-09T12:00:00.000Z"))).toThrow(
      /has been updated/,
    );
    expect(() => signableTemplate("1.2.1", release("2026-10-10T00:00:00Z"))).toThrow(
      /has been updated/,
    );
    // The overlap names one version; an older one stays refused inside it.
    expect(() => signableTemplate("1.2.0", release("2026-10-08T00:00:00Z"))).toThrow(
      /has been updated/,
    );
    // And the released version signs whatever the clock says.
    expect(signableTemplate("1.3.0", release("2099-01-01T00:00:00Z")).version).toBe("1.3.0");
  });

  test("a draft is never signable through the overlap, even when one is listed by mistake", () => {
    // Listed, the draft would otherwise be signable through the public
    // endpoint until the deadline, and provisioning binds what was signed.
    for (const draft of ["1.3.0", "1.1.0-draft", "0.1.0-draft"]) {
      expect(
        refusal(() =>
          signableTemplate(draft, { releaseOverlap: { [draft]: "2999-01-01T00:00:00Z" } }),
        ),
        draft,
      ).toMatchObject({ field: "templateVersion" });
    }
    // What refuses them is that they were never released: a released
    // version listed the same way signs.
    expect(
      signableTemplate("1.2.0", { releaseOverlap: { "1.2.0": "2999-01-01T00:00:00Z" } }).version,
    ).toBe("1.2.0");
  });

  test("a deadline is an ISO 8601 instant with its own offset, or the window is closed", () => {
    const before = "2026-10-06T00:00:00Z";
    for (const deadline of [
      "next Tuesday",
      "",
      "2026-13-45T99:00:00Z",
      // No offset: Date.parse would read it in the server's own time zone.
      "2026-10-12T12:00:00",
      // Forms Date.parse reads that are not ISO 8601 instants.
      "Oct 12 2026",
      "2026/10/12",
      "2026-10-12",
      "2026-10-12 12:00:00Z",
      // Impossible dates and times, which Date.parse rolls forward.
      "2026-02-30T12:00:00Z",
      "2026-10-12T24:00:00Z",
    ]) {
      expect(() => signableTemplate("1.2.1", release(before, deadline)), deadline).toThrow(
        /has been updated/,
      );
    }
    for (const deadline of [
      "2026-10-12T12:00:00Z",
      "2026-10-12T12:00Z",
      "2026-10-12T12:00:00.250Z",
      "2026-10-12T16:00:00+04:00",
      "2026-10-12T07:00:00-05:00",
    ]) {
      expect(signableTemplate("1.2.1", release(before, deadline)).version, deadline).toBe("1.2.1");
    }
    // The offset is read as written, whatever the server's zone: one instant
    // written three ways closes at the same moment.
    for (const deadline of [
      "2026-10-12T12:00:00Z",
      "2026-10-12T16:00:00+04:00",
      "2026-10-12T07:00:00-05:00",
    ]) {
      expect(
        signableTemplate("1.2.1", release("2026-10-12T11:59:59.999Z", deadline)).version,
        deadline,
      ).toBe("1.2.1");
      expect(
        () => signableTemplate("1.2.1", release("2026-10-12T12:00:00Z", deadline)),
        deadline,
      ).toThrow(/has been updated/);
    }
  });

  test("a version nobody registered is unknown, even when the overlap lists it", () => {
    expect(
      refusal(() =>
        signableTemplate("9.9.9", { releaseOverlap: { "9.9.9": "2099-01-01T00:00:00Z" } }),
      ),
    ).toMatchObject({ message: "Unknown agreement version.", field: "templateVersion" });
    expect(refusal(() => signableTemplate(undefined))).toMatchObject({ field: "templateVersion" });
  });

  test("validation reads the release, overlap and clock it is given, and the real ones otherwise", () => {
    const replaced = validSignRequest({ templateVersion: "1.2.1" });
    expect(() => validateSignRequest(replaced, release("2026-10-09T11:00:00Z"))).not.toThrow();
    expect(() => validateSignRequest(replaced, release("2026-10-09T13:00:00Z"))).toThrow(
      /has been updated/,
    );
    // The wall clock, when no time is given.
    for (const [deadline, signs] of [
      ["2999-01-01T00:00:00Z", true],
      ["2000-01-01T00:00:00Z", false],
    ] as const) {
      const run = () =>
        validateSignRequest(replaced, { ...RELEASED_1_3, releaseOverlap: { "1.2.1": deadline } });
      if (signs) expect(run, deadline).not.toThrow();
      else expect(run, deadline).toThrow(/has been updated/);
    }
    // The real release and overlap, when none is given: 1.2.1 is current,
    // and nothing older is listed.
    expect(() => validateSignRequest(replaced)).not.toThrow();
    expect(() => validateSignRequest(validSignRequest({ templateVersion: "1.2.0" }))).toThrow(
      /has been updated/,
    );
  });
});

/**
 * The booking system and the Google account kind (plan §3.3; the C2
 * interface agreed with the funnel). Until the funnel's M2 ships, main's
 * checkout sends only the phase-two `platform`, so a version before 1.3.0
 * takes either; 1.3.0 needs both calendar answers, and a platform only as the
 * booking system's own; an unknown value is refused whatever the version
 * reads. The 1.3.0 requests here sign as if it were released (RELEASED_1_3).
 */
describe("the answers that choose the document", () => {
  const v130 = (over: Record<string, unknown>) =>
    validSignRequest({ templateVersion: "1.3.0", platform: undefined, ...over });

  test("the platform is optional once the booking system can name the practice's system", () => {
    // These tests read the current version as one before 1.3.0.
    expect(templateReadsCalendarAccount(currentBaaTemplate())).toBe(false);
    for (const platform of [undefined, null]) {
      expect(() =>
        validateSignRequest(validSignRequest({ platform, bookingSystem: "mindbody" })),
      ).not.toThrow();
    }
    // What main's checkout sends today, on its own, signs as it always has.
    expect(() => validateSignRequest(validSignRequest({ platform: "zenoti" }))).not.toThrow();
  });

  test("a version before 1.3.0 needs one of the two, and names the field to send", () => {
    for (const absent of [undefined, null]) {
      expect(
        refusal(() =>
          validateSignRequest(validSignRequest({ platform: absent, bookingSystem: absent })),
        ),
      ).toMatchObject({ field: "bookingSystem" });
    }
    // The account kind names no system, so it cannot stand in for one.
    expect(
      refusal(() =>
        validateSignRequest(validSignRequest({ platform: undefined, calendarAccount: "personal" })),
      ),
    ).toMatchObject({ field: "bookingSystem" });
  });

  test("an unknown answer is refused by name, even where the version ignores it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ platform: "not-a-platform" }, "platform"],
      [{ platform: "" }, "platform"],
      [{ platform: 7 }, "platform"],
      // Zenoti is a phase-two platform, not one of the v1 answers.
      [{ bookingSystem: "zenoti" }, "bookingSystem"],
      [{ bookingSystem: "" }, "bookingSystem"],
      // The current version reads no account kind; an unknown one is still refused.
      [{ calendarAccount: "gmail" }, "calendarAccount"],
      [{ calendarAccount: true }, "calendarAccount"],
    ];
    for (const [over, field] of cases) {
      expect(
        refusal(() => validateSignRequest(validSignRequest(over))),
        JSON.stringify(over),
      ).toMatchObject({ field });
    }
    expect(
      refusal(() =>
        validateSignRequest(
          v130({ bookingSystem: "none", calendarAccount: "gmail" }),
          RELEASED_1_3,
        ),
      ),
    ).toMatchObject({ message: "Unknown kind of Google account.", field: "calendarAccount" });
  });

  test("1.3.0 needs both calendar answers, by name, and a platform stands in for neither", () => {
    for (const over of [
      { calendarAccount: "personal" },
      { platform: "boulevard", calendarAccount: "personal" },
    ]) {
      expect(refusal(() => validateSignRequest(v130(over), RELEASED_1_3))).toMatchObject({
        field: "bookingSystem",
      });
    }
    for (const calendarAccount of [undefined, null]) {
      expect(
        refusal(() =>
          validateSignRequest(v130({ bookingSystem: "none", calendarAccount }), RELEASED_1_3),
        ),
      ).toMatchObject({ field: "calendarAccount" });
    }
    for (const system of BOOKING_SYSTEMS) {
      for (const calendarAccount of CALENDAR_ACCOUNTS) {
        expect(
          () =>
            validateSignRequest(v130({ bookingSystem: system.id, calendarAccount }), RELEASED_1_3),
          `${system.id}/${calendarAccount}`,
        ).not.toThrow();
      }
    }
  });

  test("1.3.0 takes a platform only as the booking system's own, so the row cannot name two", () => {
    // The acceptance keeps a platform that was sent, beside the booking
    // system, and a reader of the signed row may read either: Mindbody beside
    // Cal.com would put a one-way system next to live calendar terms.
    for (const [platform, bookingSystem] of [
      ["mindbody", "calcom"],
      ["zenoti", "gohighlevel"],
      ["boulevard", "none"],
      ["none", "boulevard"],
      ["calcom", "calendly"],
      // "Something else" has no phase-two platform, so it takes only "none".
      ["zenoti", "other"],
    ]) {
      expect(
        refusal(() =>
          validateSignRequest(
            v130({ platform, bookingSystem, calendarAccount: "workspace_baa" }),
            RELEASED_1_3,
          ),
        ),
        `${platform}/${bookingSystem}`,
      ).toMatchObject({
        message: "The platform doesn't match the booking system.",
        field: "platform",
      });
    }
    // Its own phase-two platform, or "none" for a system without one, signs.
    for (const system of BOOKING_SYSTEMS) {
      const own = system.phaseTwoPlatformId ?? NO_PLATFORM_ID;
      expect(
        () =>
          validateSignRequest(
            v130({ platform: own, bookingSystem: system.id, calendarAccount: "personal" }),
            RELEASED_1_3,
          ),
        `${own}/${system.id}`,
      ).not.toThrow();
    }
    // A version before 1.3.0 names the picker's platform and takes both as
    // sent, as the addendum agreed with the funnel: a Zenoti clinic answers
    // "Something else", and its 1.2.1 document names Zenoti.
    expect(() =>
      validateSignRequest(validSignRequest({ platform: "zenoti", bookingSystem: "other" })),
    ).not.toThrow();
  });

  test("verified reporting needs a system to read in the document it renders", () => {
    process.env.HEALDESK_PHASE_TWO_ATTRIBUTION = "true";
    try {
      const verified = (over: Record<string, unknown>) =>
        validSignRequest({ attributionMode: "verified", platform: undefined, ...over });
      // Before 1.3.0, the booking system's phase-two platform when no platform came...
      expect(() => validateSignRequest(verified({ bookingSystem: "boulevard" }))).not.toThrow();
      expect(
        refusal(() => validateSignRequest(verified({ bookingSystem: "calendly" }))),
      ).toMatchObject({
        field: "attributionMode",
        message: expect.stringMatching(/nothing is connected/),
      });
      expect(
        refusal(() => validateSignRequest(verified({ bookingSystem: "calcom" }))),
      ).toMatchObject({
        field: "attributionMode",
        message: expect.stringMatching(/Cal\.com has none/),
      });
      // ...and the picker's platform first, because that is what the document names.
      expect(
        refusal(() =>
          validateSignRequest(verified({ platform: "none", bookingSystem: "boulevard" })),
        ),
      ).toMatchObject({ field: "attributionMode" });

      // 1.3.0 names the booking system, so that is what has to be readable,
      // and a platform sent beside it can only be the same system.
      const verified130 = (over: Record<string, unknown>) =>
        v130({ attributionMode: "verified", calendarAccount: "workspace_baa", ...over });
      for (const platform of [undefined, "boulevard"]) {
        expect(() =>
          validateSignRequest(verified130({ bookingSystem: "boulevard", platform }), RELEASED_1_3),
        ).not.toThrow();
      }
      expect(
        refusal(() => validateSignRequest(verified130({ bookingSystem: "none" }), RELEASED_1_3)),
      ).toMatchObject({
        field: "attributionMode",
        message: expect.stringMatching(/nothing is connected/),
      });
      expect(
        refusal(() => validateSignRequest(verified130({ bookingSystem: "calcom" }), RELEASED_1_3)),
      ).toMatchObject({ field: "attributionMode", message: expect.stringMatching(/has none/) });
    } finally {
      delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    }
  });
});

/**
 * What the server renders, held against what signing rendered before plan C3
 * and against what the funnel's preview will render, without a database.
 * signAgreement stores exactly prepareAgreement's output; the signing tests
 * below prove that against a written row.
 */
describe("the server's render", () => {
  const v121 = getBaaTemplate("1.2.1")!;

  test("1.2.1 is byte for byte what signing rendered before, for every platform the picker offers", () => {
    for (const platform of platforms) {
      for (const attributionMode of ["estimated", "verified"] as const) {
        if (attributionMode === "verified" && !supportsVerifiedAttribution(platform)) continue;
        const request = validSignRequest({
          templateVersion: "1.2.1",
          platform: platform.id,
          attributionMode,
        });
        const { variables, prepared } = prepareAgreement(request, DATE);
        expect(prepared.hash, `${platform.id}/${attributionMode}`).toBe(
          prepareBaa(v121, legacyVariables(request, DATE)).hash,
        );
        expect(variables.connectedPlatform).toBe(
          platform.id === NO_PLATFORM_ID ? null : platform.name,
        );
      }
    }
  });

  test("a booking system alone names its phase-two platform, as the picker would have", () => {
    for (const system of BOOKING_SYSTEMS) {
      const request = validSignRequest({
        templateVersion: "1.2.1",
        platform: undefined,
        bookingSystem: system.id,
      });
      const picked = validSignRequest({
        templateVersion: "1.2.1",
        platform: system.phaseTwoPlatformId ?? NO_PLATFORM_ID,
      });
      expect(prepareAgreement(request, DATE).prepared.hash, system.id).toBe(
        prepareBaa(v121, legacyVariables(picked, DATE)).hash,
      );
    }
  });

  test("when both come, the picker's platform names a 1.2.1 document, and the answers change nothing", () => {
    // A Zenoti clinic answers the v1 question "Something else", and its 1.2.1
    // document names Zenoti, as the preview on its screen does.
    const both = validSignRequest({
      templateVersion: "1.2.1",
      platform: "zenoti",
      bookingSystem: "other",
      calendarAccount: "personal",
    });
    const { variables, prepared } = prepareAgreement(both, DATE);
    expect(variables.connectedPlatform).toBe("Zenoti");
    expect(prepared.hash).toBe(prepareBaa(v121, legacyVariables(both, DATE)).hash);
    // 1.2.1 reads neither answer, so neither reaches what it renders from.
    expect(variables).not.toHaveProperty("bookingSystem");
    expect(variables).not.toHaveProperty("calendarAccount");
  });

  test("1.3.0 renders through buildBaaSelections, naming the booking system and carrying both answers", () => {
    const request = validSignRequest({
      templateVersion: "1.3.0",
      platform: undefined,
      bookingSystem: "gohighlevel",
      calendarAccount: "personal",
    });
    const { template, variables, prepared } = prepareAgreement(request, DATE, RELEASED_1_3);
    expect(template.version).toBe("1.3.0");
    expect(variables).toMatchObject({
      connectedPlatform: "HighLevel",
      bookingSystem: "gohighlevel",
      calendarAccount: "personal",
    });
    expect(variables).not.toHaveProperty("bookingSync");
    expect(prepared.clauseIds).toContain("google-calendar-uncovered");
    const preview = buildBaaSelections({
      specialtyId: "med-spa",
      attributionMode: "estimated",
      bookingSystem: "gohighlevel",
      isCoveredEntity: false,
      calendarAccount: "personal",
      template,
    });
    expect(prepared.hash).toBe(
      prepareBaa(template, {
        ...preview,
        clinicLegalName: "Radiance Med Spa",
        signatoryName: "Alex Chen",
        signatoryTitle: "Owner",
        signatoryEmail: "alex@radiance.test",
        effectiveDate: DATE,
      }).hash,
    );
    // A platform sent beside it can only be the booking system's own, and
    // changes nothing the document says.
    expect(
      prepareAgreement({ ...request, platform: "gohighlevel" }, DATE, RELEASED_1_3).prepared.hash,
    ).toBe(prepared.hash);
  });

  test("renders the version the request names when it may be signed, not whichever is current", () => {
    // Inside the overlap after a release, a buyer who loaded 1.2.1 signs 1.2.1.
    const release = { ...RELEASED_1_3, releaseOverlap: { "1.2.1": "2999-01-01T00:00:00Z" } };
    expect(
      prepareAgreement(validSignRequest({ templateVersion: "1.2.1" }), DATE, release).prepared
        .version,
    ).toBe("1.2.1");
    // What the endpoint refuses is refused here too, so a direct caller cannot
    // render a draft or a superseded version for a row either.
    for (const templateVersion of ["1.3.0", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      const request = validSignRequest({
        templateVersion,
        platform: undefined,
        bookingSystem: "none",
        calendarAccount: "personal",
      });
      expect(
        refusal(() => prepareAgreement(request, DATE)),
        templateVersion,
      ).toMatchObject({
        message: expect.stringMatching(/has been updated/),
        field: "templateVersion",
      });
    }
    expect(
      refusal(() => prepareAgreement(validSignRequest({ templateVersion: "0.0.0-ancient" }), DATE)),
    ).toMatchObject({ message: "Unknown agreement version.", field: "templateVersion" });
  });

  test("a direct caller's missing or unknown answer is refused by name, not as a template bug", () => {
    for (const [over, field, options] of [
      [
        { templateVersion: "1.3.0", platform: undefined, bookingSystem: "none" },
        "calendarAccount",
        RELEASED_1_3,
      ],
      [
        { templateVersion: "1.3.0", platform: "none", calendarAccount: "personal" },
        "bookingSystem",
        RELEASED_1_3,
      ],
      [
        {
          templateVersion: "1.3.0",
          platform: "mindbody",
          bookingSystem: "calcom",
          calendarAccount: "personal",
        },
        "platform",
        RELEASED_1_3,
      ],
      [{ platform: undefined }, "bookingSystem", {}],
      [{ bookingSystem: "zenoti" }, "bookingSystem", {}],
      [{ calendarAccount: "gmail" }, "calendarAccount", {}],
    ] as [Record<string, unknown>, string, SignableOptions][]) {
      expect(
        refusal(() => prepareAgreement(validSignRequest(over), DATE, options)),
        JSON.stringify(over),
      ).toMatchObject({ field });
    }
    // Verified reporting with nothing to read gets the precise answer on this
    // path too, not "we couldn't prepare your agreement".
    expect(
      refusal(() =>
        prepareAgreement(
          validSignRequest({ attributionMode: "verified", platform: "calcom" }),
          DATE,
        ),
      ),
    ).toMatchObject({
      field: "attributionMode",
      message: expect.stringMatching(/Cal\.com has none/),
    });
  });
});

/**
 * The endpoint answers a refusal with 422 and the field it names, which is
 * what a client keys its message to. Every request here is refused before
 * anything is written, so no database is needed.
 */
describe("POST /api/agreements", () => {
  const SECRET = "provision-secret-for-agreement-tests";

  async function post(body: Record<string, unknown>): Promise<Response> {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return signRoute(
      new Request("https://app.healdesk.io/api/agreements", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
        },
        body: raw,
      }),
    );
  }

  test("refuses an unknown answer, or a practice this agreement is not for, with 422 naming the field", async () => {
    vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
    try {
      for (const [over, field] of [
        [{ bookingSystem: "zenoti" }, "bookingSystem"],
        [{ calendarAccount: "gmail" }, "calendarAccount"],
        [{ platform: undefined }, "bookingSystem"],
        [{ specialty: "veterinary" }, "specialty"],
        // The draft, until its release: refused as a version, never signed.
        [
          { templateVersion: "1.3.0", bookingSystem: "none", calendarAccount: "personal" },
          "templateVersion",
        ],
      ] as [Record<string, unknown>, string][]) {
        const response = await post({ ...validSignRequest(over) });
        expect(response.status, JSON.stringify(over)).toBe(422);
        expect(await response.json()).toMatchObject({ field });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describeDb("signing", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("stores the exact rendered text and a hash that matches it", async () => {
    const signed = await signAgreement(validSignRequest(), {
      ipAddress: "203.0.113.7",
      userAgent: "TestAgent/1.0",
    });

    const stored = await getAgreement(signed.agreementId);
    expect(stored).toBeDefined();
    expect(stored!.text).toBe(signed.text);
    expect(hashBaaText(stored!.text)).toBe(stored!.hash);
    expect(stored!.text).toContain("Radiance Med Spa");
    // Unbound until payment provisions an organization.
    expect(stored!.organizationId).toBeNull();
  });

  test("the server renders the document, not the caller", async () => {
    // A caller sending its own `text` or `hash` must not be able to influence
    // what is stored — the record has to be the server's own render.
    const signed = await signAgreement(
      validSignRequest({
        text: "I agree to nothing at all.",
        hash: "deadbeef",
      }) as never,
    );

    const stored = await getAgreement(signed.agreementId);
    expect(stored!.text).not.toContain("nothing at all");
    expect(stored!.hash).not.toBe("deadbeef");
    expect(stored!.hash).toBe(hashBaaText(stored!.text));
  });

  test("captures who signed, when, and what the button said", async () => {
    const signed = await signAgreement(
      validSignRequest({ clinicLegalName: "Evidence Clinic" }),
      { ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)" },
    );

    const { rows } = await getMigratorPool().query<{
      assent_label: string;
      accepted_by_name: string;
      accepted_by_title: string;
      ip_address: string;
      user_agent: string;
      variables: Record<string, unknown>;
    }>(
      `select assent_label, accepted_by_name, accepted_by_title, ip_address,
              user_agent, variables
         from baa_acceptances where id = $1`,
      [signed.agreementId],
    );

    const row = rows[0]!;
    // The FULL sentence beside the checkbox, derived on the server from the
    // validated clinic name — not the fixed label the client sent as proof.
    expect(row.assent_label).toBe(assentSentence("Evidence Clinic"));
    expect(row.accepted_by_name).toBe("Alex Chen");
    expect(row.accepted_by_title).toBe("Owner");
    expect(row.ip_address).toBe("203.0.113.9");
    expect(row.user_agent).toBe("Mozilla/5.0 (Test)");
    // The variables let the render be reproduced independently of the stored text.
    expect(row.variables.clinicLegalName).toBe("Evidence Clinic");
  });

  test("the runtime role can bind an agreement but never rewrite one", async () => {
    const signed = await signAgreement(
      validSignRequest({ clinicLegalName: "Immutable Clinic" }),
    );

    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      // Everything that is evidence is immutable by GRANT, not by convention —
      // so it survives a bug in our own code.
      for (const column of [
        "rendered_text = 'something else'",
        "document_hash = 'deadbeef'",
        "accepted_by_name = 'someone else'",
        "assent_label = 'Continue'",
        "accepted_at = now()",
      ]) {
        await expect(
          app.query(`update baa_acceptances set ${column} where id = $1`, [
            signed.agreementId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      }

      await expect(
        app.query(`delete from baa_acceptances`),
      ).rejects.toMatchObject({ code: "42501" });

      // Since 0031 the binding columns are not writable directly either — the
      // only write path to organization_id/bound_at is app_bind_agreement().
      for (const column of ["bound_at = now()", "organization_id = 'org_x'"]) {
        await expect(
          app.query(`update baa_acceptances set ${column} where id = $1`, [
            signed.agreementId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      }

      // And that path works, once, for an organisation that exists.
      const orgId = `org_bind_${signed.agreementId.slice(0, 8)}`;
      await getMigratorPool().query(
        `insert into organization (id, name, slug, created_at) values ($1, 'Immutable Group', $2, now())`,
        [orgId, `${orgId}-slug`],
      );
      const bound = await app.query<{ v: { clinicLegalName: string } }>(
        `select app_bind_agreement($1::uuid, $2::text) as v`,
        [signed.agreementId, orgId],
      );
      expect(bound.rows[0]!.v.clinicLegalName).toBe("Immutable Clinic");
    } finally {
      await app.end();
    }
  });

  test("the stored document reflects what they bought, and records the variant", async () => {
    // The end-to-end version of the variant tests: a verified clinic and an
    // estimated one sign genuinely different contracts through the real API
    // path, and each row carries the clause list that produced it. Verified
    // reporting is phase two, so the flag that admits it is set for this test
    // only (and cleared in the finally below).
    process.env.HEALDESK_PHASE_TWO_ATTRIBUTION = "true";
    const verified = await signAgreement(
      validSignRequest({
        clinicLegalName: "Verified Clinic",
        signatoryEmail: "v@example.test",
        attributionMode: "verified",
        platform: "boulevard",
      }),
    );
    const estimated = await signAgreement(
      validSignRequest({
        clinicLegalName: "Estimated Clinic",
        signatoryEmail: "e@example.test",
      }),
    );

    expect(verified.text).toMatch(/READ-ONLY access/);
    expect(verified.text).toContain("Boulevard");
    expect(estimated.text).not.toMatch(/READ-ONLY access/);
    expect(verified.hash).not.toBe(estimated.hash);

    expect(verified.clauseIds).toContain("data-sources-verified");
    expect(estimated.clauseIds).toContain("data-sources-none");

    const { rows } = await getMigratorPool().query<{
      variables: { appliedClauses?: string[]; attributionMode?: string };
    }>(`select variables from baa_acceptances where id = $1`, [
      verified.agreementId,
    ]);
    expect(rows[0]!.variables.appliedClauses).toContain("data-sources-verified");
    expect(rows[0]!.variables.attributionMode).toBe("verified");
    delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
  });

  test("refuses verified reporting for a platform with nothing to read", async () => {
    // Otherwise the contract would describe a data flow that cannot exist.
    // Phase two is switched on so this test reaches that check rather than
    // the earlier "not offered in v1" refusal.
    process.env.HEALDESK_PHASE_TWO_ATTRIBUTION = "true";
    try {
      await expect(
        signAgreement(
          validSignRequest({ attributionMode: "verified", platform: "none" }),
        ),
      ).rejects.toThrow(/nothing is connected|has none|nothing to read/i);
    } finally {
      delete process.env.HEALDESK_PHASE_TWO_ATTRIBUTION;
    }
  });

  test("agreements signed but never paid for are surfaced, not lost", async () => {
    await signAgreement(validSignRequest({ clinicLegalName: "Abandoned Clinic" }));

    const pending = await unboundAgreements();
    expect(pending.some((a) => a.clinicName === "Abandoned Clinic")).toBe(true);
  });

  test("an unknown or malformed id returns nothing rather than throwing", async () => {
    expect(await getAgreement("not-a-uuid")).toBeUndefined();
    expect(
      await getAgreement("11111111-1111-4111-8111-111111111111"),
    ).toBeUndefined();
  });

  async function storedVariables(agreementId: string): Promise<Record<string, unknown>> {
    const { rows } = await getMigratorPool().query<{ variables: Record<string, unknown> }>(
      `select variables from baa_acceptances where id = $1`,
      [agreementId],
    );
    return rows[0]!.variables;
  }

  test("today's checkout request still signs, against the hash its preview displayed", async () => {
    // Main's checkout sends the picker's platform and hashes a preview built
    // as legacyVariables builds it. The server now renders through
    // buildBaaSelections; a byte of drift would refuse this buyer at the last
    // step. Only Date is faked, and only for the call, so the effective date
    // is known without stalling the pg driver's own timers.
    const request = validSignRequest({
      clinicLegalName: "Preview Clinic",
      templateVersion: "1.2.1",
      platform: "mindbody",
    });
    const displayedHash = prepareBaa(getBaaTemplate("1.2.1")!, legacyVariables(request, DATE)).hash;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DATE}T15:00:00.000Z`));
    let signed: SignedAgreement;
    try {
      signed = await signAgreement({ ...request, displayedHash });
    } finally {
      vi.useRealTimers();
    }

    expect(signed.hash).toBe(displayedHash);
    const variables = await storedVariables(signed.agreementId);
    expect(variables).toMatchObject({
      platformId: "mindbody",
      connectedPlatform: "Mindbody",
      effectiveDate: DATE,
      displayedHashVerified: true,
    });
    expect(variables).not.toHaveProperty("bookingSystem");
    expect(variables).not.toHaveProperty("calendarAccount");
  });

  test("stores the answers as sent, beside the variant and outside the hash", async () => {
    const request = validSignRequest({
      clinicLegalName: "Answers Clinic",
      templateVersion: "1.2.1",
      platform: "boulevard",
      bookingSystem: "boulevard",
      calendarAccount: "workspace_no_baa",
    });
    const signed = await signAgreement(request);

    const variables = await storedVariables(signed.agreementId);
    expect(variables).toMatchObject({
      platformId: "boulevard",
      bookingSystem: "boulevard",
      calendarAccount: "workspace_no_baa",
      connectedPlatform: "Boulevard",
      appliedClauses: signed.clauseIds,
    });
    // The row holds exactly what prepareAgreement renders for the request...
    const effectiveDate = String(variables.effectiveDate);
    expect(signed.hash).toBe(prepareAgreement(request, effectiveDate).prepared.hash);
    // ...and 1.2.1 renders neither calendar answer: the same document, by
    // hash, as the request that sent only the platform.
    const platformOnly = validSignRequest({
      clinicLegalName: "Answers Clinic",
      templateVersion: "1.2.1",
      platform: "boulevard",
    });
    expect(signed.hash).toBe(prepareAgreement(platformOnly, effectiveDate).prepared.hash);
  });

  test("a request that names only the booking system stores no platform", async () => {
    const signed = await signAgreement(
      validSignRequest({
        clinicLegalName: "System Clinic",
        templateVersion: "1.2.1",
        platform: undefined,
        bookingSystem: "gohighlevel",
      }),
    );
    const variables = await storedVariables(signed.agreementId);
    expect(variables).not.toHaveProperty("platformId");
    expect(variables).not.toHaveProperty("calendarAccount");
    expect(variables.bookingSystem).toBe("gohighlevel");
    // A 1.2.1 document names HighLevel by its phase-two name, as the picker did.
    expect(variables.connectedPlatform).toBe("GoHighLevel");
  });

  async function acceptanceCount(): Promise<number> {
    const { rows } = await getMigratorPool().query<{ n: string }>(
      `select count(*) as n from baa_acceptances`,
    );
    return Number(rows[0]!.n);
  }

  test("a direct call signs only what the endpoint would, and a draft or superseded version writes nothing", async () => {
    // Before plan C3 signAgreement rendered the current template whatever the
    // request said. Now that it renders the version the request names, it has
    // to refuse what validation refuses, or a caller that skips validation (an
    // operator script, a future portal action) could write a draft's row,
    // which provisioning would bind to a live account until plan C15.
    const request = (templateVersion: string) =>
      validSignRequest({
        clinicLegalName: "Draft Clinic",
        templateVersion,
        platform: undefined,
        bookingSystem: "none",
        calendarAccount: "workspace_baa",
      });
    const before = await acceptanceCount();
    for (const templateVersion of ["1.3.0", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      await expect(signAgreement(request(templateVersion)), templateVersion).rejects.toMatchObject({
        field: "templateVersion",
      });
    }
    // Listed in the overlap by mistake, a draft is still refused: only a
    // released version can be the one a release replaced.
    for (const templateVersion of ["1.3.0", "1.1.0-draft", "0.1.0-draft"]) {
      const listed = { releaseOverlap: { [templateVersion]: "2999-01-01T00:00:00Z" } };
      await expect(
        signAgreement(request(templateVersion), {}, listed),
        templateVersion,
      ).rejects.toMatchObject({ field: "templateVersion" });
    }
    expect(await acceptanceCount()).toBe(before);
  });

  test("once 1.3.0 is released (stood in for here), its signature carries both answers", async () => {
    const signed = await signAgreement(
      validSignRequest({
        clinicLegalName: "Released Clinic",
        templateVersion: "1.3.0",
        platform: undefined,
        bookingSystem: "none",
        calendarAccount: "workspace_baa",
      }),
      {},
      RELEASED_1_3,
    );
    expect(signed.version).toBe("1.3.0");
    expect(signed.clauseIds).toContain("google-calendar-covered");
    // The stand-in makes 1.3.0 current and nothing else: what the row and
    // its audit event record about release is the template's own flag.
    expect(signed.approvedByCounsel).toBe(false);

    const variables = await storedVariables(signed.agreementId);
    expect(variables).toMatchObject({
      bookingSystem: "none",
      calendarAccount: "workspace_baa",
      connectedPlatform: null,
      appliedClauses: signed.clauseIds,
    });
    expect(variables).not.toHaveProperty("platformId");
    const { rows } = await getMigratorPool().query<{ document_version: string }>(
      `select document_version from baa_acceptances where id = $1`,
      [signed.agreementId],
    );
    expect(rows[0]!.document_version).toBe("1.3.0");
  });

  test("inside the overlap after a release, the version it replaced signs as itself, and not after", async () => {
    const request = validSignRequest({
      clinicLegalName: "Overlap Clinic",
      templateVersion: "1.2.1",
      platform: "calcom",
    });
    const open = { ...RELEASED_1_3, releaseOverlap: { "1.2.1": "2999-01-01T00:00:00Z" } };
    const signed = await signAgreement(request, {}, open);
    expect(signed.version).toBe("1.2.1");
    expect(signed.text).toContain("Version 1.2.1");

    const before = await acceptanceCount();
    await expect(
      signAgreement(request, {}, { ...open, now: new Date("2999-01-01T00:00:00Z") }),
    ).rejects.toMatchObject({ field: "templateVersion" });
    expect(await acceptanceCount()).toBe(before);
  });

  test("a direct call refused for its answers or its practice writes nothing", async () => {
    const before = await acceptanceCount();

    await expect(
      signAgreement(validSignRequest({ clinicLegalName: "Vet Clinic", specialty: "veterinary" })),
    ).rejects.toMatchObject({ field: "specialty" });
    const unanswered = validSignRequest({
      clinicLegalName: "Unanswered Clinic",
      templateVersion: "1.3.0",
      platform: undefined,
      bookingSystem: "calendly",
    });
    await expect(signAgreement(unanswered, {}, RELEASED_1_3)).rejects.toMatchObject({
      field: "calendarAccount",
    });
    await expect(
      signAgreement(
        {
          ...unanswered,
          platform: "mindbody",
          bookingSystem: "calcom",
          calendarAccount: "personal",
        },
        {},
        RELEASED_1_3,
      ),
    ).rejects.toMatchObject({ field: "platform" });

    expect(await acceptanceCount()).toBe(before);
  });
});

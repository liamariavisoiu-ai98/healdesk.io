import {
  applicableClauses,
  BaaRenderError,
  BAA_EXPLAINER,
  currentBaaTemplate,
  CURRENT_BAA_VERSION,
  hashBaaText,
  prepareBaa,
  renderBaa,
  type BaaVariables,
} from "@healdesk/catalog";
import { assentSentence, BAA_ASSENT_LABEL } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AgreementError,
  getAgreement,
  signAgreement,
  unboundAgreements,
  validateSignRequest,
  type SignAgreementRequest,
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
});

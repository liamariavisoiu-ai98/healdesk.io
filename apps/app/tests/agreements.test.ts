import {
  BaaRenderError,
  BAA_EXPLAINER,
  currentBaaTemplate,
  CURRENT_BAA_VERSION,
  hashBaaText,
  prepareBaa,
  renderBaa,
} from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AgreementError,
  getAgreement,
  signAgreement,
  unboundAgreements,
  validateSignRequest,
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

const VARS = {
  clinicLegalName: "Radiance Med Spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  effectiveDate: "2026-08-18",
  specialty: "Med spa",
  isCoveredEntity: false,
} as const;

const validSignRequest = (over: Record<string, unknown> = {}) => ({
  clinicLegalName: "Radiance Med Spa",
  specialty: "med-spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  isCoveredEntity: false,
  assentLabel: "I agree to the Business Associate Agreement",
  templateVersion: CURRENT_BAA_VERSION,
  ...over,
});

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

  test("an unknown placeholder throws instead of rendering literally", () => {
    const broken = {
      ...currentBaaTemplate(),
      body: "Between {{clinicLegalName}} and {{whoeverThisIs}}.",
    };
    expect(() => renderBaa(broken, VARS)).toThrow(/whoeverThisIs/);
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

    expect(yes).toMatch(/is\s+therefore a covered entity/);
    expect(no).toMatch(/may\s+therefore not be a covered entity/i);
    expect(unknown).toMatch(/has not yet determined/);

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
    expect(row.assent_label).toBe("I agree to the Business Associate Agreement");
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

      // The one permitted write: binding it to an organization.
      await expect(
        app.query(
          `update baa_acceptances set bound_at = now() where id = $1`,
          [signed.agreementId],
        ),
      ).resolves.toBeTruthy();
    } finally {
      await app.end();
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

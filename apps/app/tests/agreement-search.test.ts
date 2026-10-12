import { BAA_ASSENT_LABEL } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  AgreementSearchError,
  searchAgreements,
  type AgreementRow,
} from "@/lib/agreements/search";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * The register of signed agreements.
 *
 * What is defended here is the honesty of the answer, because every failure
 * this module can have looks like a correct empty result:
 *
 *   - a `%` or a `_` in a clinic's legal name silently turning into a wildcard,
 *     so a search returns a practice that did not sign;
 *   - a backslash in a name making the same search return nothing at all;
 *   - pagination dropping a row between pages, which is indistinguishable from
 *     "that agreement was never signed" and is the one thing a register must
 *     never say;
 *   - a date filter that is off by one day at the boundary, which hides
 *     everything signed on the day the operator asked about.
 *
 * So the fixtures are built as MATCHED PAIRS: for every trap there is a decoy
 * row that a buggy implementation returns and a correct one does not. A test
 * that only asserted "the row I wanted came back" would pass with the wildcard
 * bug fully present.
 *
 * The last test is the other kind of property: the list must not carry the
 * agreement text. That is not a formatting preference. `rendered_text` is the
 * whole contract, and a search that returned it would be a bulk export of
 * every agreement the company has ever signed, dressed as a listing.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Appears in every seeded rendered_text and must never reach a caller. */
const TEXT_MARKER = "ZZ-FULL-AGREEMENT-BODY-MARKER-ZZ";

const V_CURRENT = "1.1.0-draft";
const V_PRIOR = "1.0.0-draft";
const V_ANCIENT = "0.9.0-draft";

/** 64 lowercase hex, from a chosen prefix. */
function digest(prefix: string): string {
  return (prefix + "0".repeat(64)).slice(0, 64);
}

/**
 * Two hashes that share four characters and differ at the fifth, so a prefix
 * search can be shown to be a prefix search rather than a substring one.
 */
const H_RADIANCE = digest("0f3ab7c1");
const H_LAKESIDE = digest("0f3ac8d2");

const DAY_MS = 86_400_000;
/** Terminated, but nowhere near its six-year floor. Relative, so it stays true. */
const TERMINATED_RECENTLY = new Date(Date.now() - DAY_MS).toISOString();

type SeedRow = {
  key: string;
  /** Omitted entirely for the row that carries no clinic name in its variables. */
  clinic?: string;
  name: string;
  email: string;
  title?: string;
  version: string;
  hash: string;
  /** ISO instant, inserted as a timestamptz parameter. Microseconds honoured. */
  acceptedAt: string;
  terminatedAt?: string;
  copySentAt?: string;
};

/**
 * Ordered newest first, which is the order the register returns them in.
 * Anything relying on that order below reads this list.
 */
const CORPUS: SeedRow[] = [
  {
    key: "radiance",
    clinic: "Radiance Med Spa",
    name: "Alex Chen",
    email: "alex@radiance.test",
    title: "Owner",
    version: V_CURRENT,
    hash: H_RADIANCE,
    acceptedAt: "2026-06-01T09:00:00.000000Z",
    copySentAt: "2026-06-02T09:00:00.000000Z",
  },
  {
    key: "lakeside",
    clinic: "Lakeside Dental",
    name: "Dana Ruiz",
    email: "dana@lakeside.test",
    title: "Practice Manager",
    version: V_CURRENT,
    hash: H_LAKESIDE,
    acceptedAt: "2026-05-15T10:00:00.000000Z",
  },
  // Two signatures 333 MICROseconds apart. A cursor that round-trips through a
  // JavaScript Date collapses them onto the same millisecond and loses one.
  {
    key: "microA",
    clinic: "Micro Precision A",
    name: "Rae Lindqvist",
    email: "rae@micro.test",
    version: V_CURRENT,
    hash: digest("aa11"),
    acceptedAt: "2026-05-01T12:30:00.123789Z",
  },
  {
    key: "microB",
    clinic: "Micro Precision B",
    name: "Sam Oyelaran",
    email: "sam@micro.test",
    version: V_CURRENT,
    hash: digest("aa22"),
    acceptedAt: "2026-05-01T12:30:00.123456Z",
  },
  // Exactly midnight UTC: the inclusive lower bound of a date-only filter.
  {
    key: "percent",
    clinic: "Half Price 50% Clinic",
    name: "Mia Okafor",
    email: "mia@halfprice.test",
    version: V_PRIOR,
    hash: digest("bb11"),
    acceptedAt: "2026-04-01T00:00:00.000000Z",
    copySentAt: "2026-04-03T00:00:00.000000Z",
  },
  // The last microsecond of a UTC day: the inclusive upper bound.
  {
    key: "percentDecoy",
    clinic: "Half Price 50 Dollars Clinic",
    name: "Rob Vance",
    email: "rob@halfprice.test",
    version: V_PRIOR,
    hash: digest("bb22"),
    acceptedAt: "2026-03-01T23:59:59.999999Z",
  },
  {
    key: "underscore",
    clinic: "Bright_Smile Dental",
    name: "Ines Duarte",
    email: "ines@bright.test",
    version: V_PRIOR,
    hash: digest("cc11"),
    acceptedAt: "2026-02-15T08:00:00.000000Z",
    terminatedAt: TERMINATED_RECENTLY,
    copySentAt: "2026-02-16T08:00:00.000000Z",
  },
  {
    key: "underscoreDecoy",
    clinic: "BrightXSmile Dental",
    name: "Ken Ito",
    email: "ken@brightx.test",
    version: V_PRIOR,
    hash: digest("cc22"),
    acceptedAt: "2026-02-01T08:00:00.000000Z",
  },
  {
    key: "backslash",
    clinic: "Back\\Slash Clinic",
    name: "Yuki Sato",
    email: "yuki@backslash.test",
    version: V_PRIOR,
    hash: digest("dd11"),
    acceptedAt: "2026-01-20T08:00:00.000000Z",
  },
  // Signed before the variables carried a clinic name. Still a legal record,
  // and still has to be findable by the person who signed it.
  {
    key: "nameless",
    name: "Wren Abiola",
    email: "wren@nameless.test",
    version: V_PRIOR,
    hash: digest("ee11"),
    acceptedAt: "2026-01-10T08:00:00.000000Z",
  },
  // Terminated in 2011: six years past its floor whenever this suite runs.
  {
    key: "ancient",
    clinic: "Old Harbor Surgery",
    name: "Pat Moore",
    email: "pat@oldharbor.test",
    version: V_ANCIENT,
    hash: digest("ff11"),
    acceptedAt: "2010-01-01T09:00:00.000000Z",
    terminatedAt: "2011-01-01T23:59:59.999999Z",
    copySentAt: "2011-01-02T09:00:00.000000Z",
  },
];

const idByKey = new Map<string, string>();
const keyById = new Map<string, string>();

function idOf(key: string): string {
  const id = idByKey.get(key);
  if (!id) throw new Error(`No seeded agreement for "${key}".`);
  return id;
}

/** Assertions read as fixture names rather than as uuids. */
function keys(rows: AgreementRow[]): string[] {
  return rows.map((row) => keyById.get(row.id) ?? `unknown:${row.id}`);
}

async function seed(row: SeedRow): Promise<string> {
  const variables: Record<string, unknown> = {
    signatoryName: row.name,
    signatoryEmail: row.email,
    specialty: "Med spa",
  };
  if (row.clinic !== undefined) variables.clinicLegalName = row.clinic;

  // As the migrator: the corpus holds terminated agreements and delivered
  // copies, which the runtime role may not insert (its INSERT is
  // column-scoped since drizzle/0065; termination and the copy's record are
  // written by their own paths). Timestamps are bound as text and cast, so
  // microsecond precision survives; a JavaScript Date would truncate it.
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into baa_acceptances
       (organization_id, user_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_by_title, ip_address, user_agent,
        accepted_at, terminated_at, copy_sent_at, copy_document_sha256)
     values (null, null, $1, $2, $3, $4::jsonb, $5, $6, $7, $8, '203.0.113.42', 'Mozilla/5.0',
             $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)
     returning id`,
    [
      row.version,
      row.hash,
      `BUSINESS ASSOCIATE AGREEMENT\n\n${TEXT_MARKER}\n\nSigned by ${row.name}.`,
      JSON.stringify(variables),
      BAA_ASSENT_LABEL,
      row.name,
      row.email,
      row.title ?? null,
      row.acceptedAt,
      row.terminatedAt ?? null,
      row.copySentAt ?? null,
      // The table's CHECK refuses a send date with no digest, and rightly: a
      // date with no hash proves nothing.
      row.copySentAt ? digest(`f0${row.hash.slice(2, 8)}`) : null,
    ],
  );
  return rows[0]!.id;
}

async function seedCorpus(): Promise<void> {
  idByKey.clear();
  keyById.clear();
  for (const row of CORPUS) {
    const id = await seed(row);
    idByKey.set(row.key, id);
    keyById.set(id, row.key);
  }
}

describeDb("agreement register", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    await seedCorpus();
  });

  afterAll(async () => {
    await truncateAll();
    await closePools();
  });

  describe("free text", () => {
    test("matches the clinic legal name, case-insensitively and in part", async () => {
      const found = await searchAgreements({ query: "radiance med" });
      expect(keys(found.rows)).toEqual(["radiance"]);

      const shouted = await searchAgreements({ query: "RADIANCE MED" });
      expect(keys(shouted.rows)).toEqual(["radiance"]);
    });

    test("matches the signatory name and the signatory email", async () => {
      expect(keys((await searchAgreements({ query: "dana ruiz" })).rows)).toEqual([
        "lakeside",
      ]);
      expect(
        keys((await searchAgreements({ query: "YUKI@BACKSLASH.TEST" })).rows),
      ).toEqual(["backslash"]);
      // A fragment of the domain is how anyone actually searches.
      expect(keys((await searchAgreements({ query: "@halfprice" })).rows)).toEqual([
        "percent",
        "percentDecoy",
      ]);
    });

    test("matches a hash PREFIX, so nobody has to type 64 characters", async () => {
      // Four characters both digests share.
      const shared = await searchAgreements({ query: "0f3a" });
      expect(keys(shared.rows).sort()).toEqual(["lakeside", "radiance"]);

      // The fifth character separates them, which a substring match would not.
      expect(keys((await searchAgreements({ query: "0f3ab" })).rows)).toEqual([
        "radiance",
      ]);
      // Case-insensitive: a fingerprint pasted from a mail thread is shouted.
      expect(keys((await searchAgreements({ query: "0F3AB7C1" })).rows)).toEqual([
        "radiance",
      ]);
      // And the whole thing still works.
      expect(keys((await searchAgreements({ query: H_LAKESIDE })).rows)).toEqual([
        "lakeside",
      ]);
    });

    test("a hash is matched from the START, not anywhere inside", async () => {
      // "3ab7c1" is inside H_RADIANCE but is not a prefix of it. A LIKE
      // '%...%' over the hash column would return it and would make the
      // fingerprint search useless as an identifier.
      expect(keys((await searchAgreements({ query: "3ab7c1" })).rows)).toEqual([]);
    });

    test("a % in the query is a percent sign, not a wildcard", async () => {
      const found = await searchAgreements({ query: "50% Clinic" });

      // Read as a wildcard, "50% Clinic" also matches "Half Price 50 Dollars
      // Clinic" — an agreement that practice never signed.
      expect(keys(found.rows)).toEqual(["percent"]);
      expect(found.total).toBe(1);
    });

    test("an _ in the query is an underscore, not a single-character wildcard", async () => {
      const found = await searchAgreements({ query: "Bright_Smile" });

      // As a wildcard it would also match "BrightXSmile Dental".
      expect(keys(found.rows)).toEqual(["underscore"]);
    });

    test("a backslash is matched literally and does not error", async () => {
      // Backslash is LIKE's escape character. Unescaped, "Back\\Slash" means
      // "BackSlash" and matches nothing...
      expect(keys((await searchAgreements({ query: "Back\\Slash" })).rows)).toEqual([
        "backslash",
      ]);

      // ...and a query ENDING in one is not a wrong answer but a hard
      // Postgres error: "LIKE pattern must not end with escape character".
      // A search box that 500s on a keystroke.
      await expect(searchAgreements({ query: "\\" })).resolves.toMatchObject({
        rows: [expect.objectContaining({ id: idOf("backslash") })],
      });
    });

    test("a signed row with no clinic name in its variables is still findable", async () => {
      const found = await searchAgreements({ query: "wren abiola" });

      // `variables ->> 'clinicLegalName'` is NULL here, and NULL ILIKE is NULL
      // rather than false. If that collapsed the whole OR the row would be
      // unreachable, which for a legal record means lost.
      expect(keys(found.rows)).toEqual(["nameless"]);
      expect(found.rows[0]!.clinicLegalName).toBeNull();
    });

    test("a blank query is not a filter", async () => {
      expect((await searchAgreements({ query: "   " })).total).toBe(CORPUS.length);
      expect((await searchAgreements({})).total).toBe(CORPUS.length);
    });
  });

  describe("filters", () => {
    test("signedFrom is inclusive of the instant it names, in UTC", async () => {
      const found = await searchAgreements({ signedFrom: "2026-04-01" });

      // "percent" was signed at exactly 2026-04-01T00:00:00Z. An exclusive
      // bound, or one resolved in the server's local zone, drops it.
      expect(keys(found.rows)).toEqual([
        "radiance",
        "lakeside",
        "microA",
        "microB",
        "percent",
      ]);
    });

    test("signedTo includes the whole of the UTC day it names", async () => {
      const found = await searchAgreements({ signedTo: "2026-03-01" });

      // "percentDecoy" was signed at 23:59:59.999999 on that day. `<= date`
      // would exclude everything signed after midnight, which is all of it.
      expect(keys(found.rows)).toEqual([
        "percentDecoy",
        "underscore",
        "underscoreDecoy",
        "backslash",
        "nameless",
        "ancient",
      ]);
    });

    test("a date range is inclusive at both ends", async () => {
      const found = await searchAgreements({
        signedFrom: "2026-02-01",
        signedTo: "2026-04-01",
      });

      expect(keys(found.rows)).toEqual([
        "percent",
        "percentDecoy",
        "underscore",
        "underscoreDecoy",
      ]);
    });

    test("an instant with an explicit offset filters to the second", async () => {
      const found = await searchAgreements({
        signedFrom: "2026-05-01T12:30:00.200Z",
      });

      // Both microsecond rows sit before that instant; both must be excluded.
      expect(keys(found.rows)).toEqual(["radiance", "lakeside"]);
    });

    test("version is an exact match", async () => {
      const found = await searchAgreements({ version: V_ANCIENT });
      expect(keys(found.rows)).toEqual(["ancient"]);
      expect((await searchAgreements({ version: "0.9" })).rows).toEqual([]);
    });

    test("the three statuses partition the register", async () => {
      const inEffect = await searchAgreements({ status: "in_effect" });
      const terminated = await searchAgreements({ status: "terminated" });
      const review = await searchAgreements({ status: "retention_review" });

      expect(keys(terminated.rows)).toEqual(["underscore"]);
      expect(keys(review.rows)).toEqual(["ancient"]);
      expect(keys(inEffect.rows)).not.toContain("underscore");
      expect(keys(inEffect.rows)).not.toContain("ancient");

      // Exactly one status each, and every row accounted for.
      expect(inEffect.total + terminated.total + review.total).toBe(CORPUS.length);
    });

    test("a live agreement reports no eligibility date, however old", async () => {
      const live = await searchAgreements({ query: "radiance" });
      expect(live.rows[0]!.status).toBe("in_effect");
      expect(live.rows[0]!.eligibleAt).toBeNull();
      // The floor is still reported, under a name that says what it is.
      expect(live.rows[0]!.retentionFloorAt.toISOString()).toBe(
        "2032-06-01T09:00:00.000Z",
      );

      // A terminated one gets a real date, counted from termination.
      const past = await searchAgreements({ status: "retention_review" });
      expect(past.rows[0]!.eligibleAt?.toISOString()).toBe(
        "2017-01-01T23:59:59.999Z",
      );
    });

    test("copySent separates delivered from undelivered", async () => {
      const sent = await searchAgreements({ copySent: true });
      const unsent = await searchAgreements({ copySent: false });

      expect(keys(sent.rows).sort()).toEqual([
        "ancient",
        "percent",
        "radiance",
        "underscore",
      ]);
      expect(sent.rows.every((row) => row.copySent)).toBe(true);
      expect(unsent.rows.every((row) => !row.copySent && row.copySentAt === null)).toBe(
        true,
      );
      expect(sent.total + unsent.total).toBe(CORPUS.length);
    });

    test("filters combine, and every one of them narrows", async () => {
      const found = await searchAgreements({
        query: "smile",
        version: V_PRIOR,
        status: "in_effect",
        copySent: false,
        signedFrom: "2026-01-01",
        signedTo: "2026-02-14",
      });

      // "underscore" matches the text but is terminated, has a copy, and was
      // signed on the 15th; "underscoreDecoy" survives all six clauses.
      expect(keys(found.rows)).toEqual(["underscoreDecoy"]);
      expect(found.total).toBe(1);
    });
  });

  describe("input this module refuses", () => {
    test("a date that does not exist is refused, not rolled forward", async () => {
      await expect(searchAgreements({ signedFrom: "2026-02-31" })).rejects.toThrow(
        AgreementSearchError,
      );
      await expect(searchAgreements({ signedTo: "not-a-date" })).rejects.toThrow(
        AgreementSearchError,
      );
    });

    test("an instant with no offset is refused rather than read as local time", async () => {
      // Otherwise the same filter selects different agreements on a laptop and
      // in a container.
      await expect(
        searchAgreements({ signedFrom: "2026-04-01T10:00:00" }),
      ).rejects.toThrow(/explicit UTC offset/);
    });

    test("an unrecognised status is refused rather than answered with nothing", async () => {
      // The filters arrive as JSON across the app boundary, so the union in
      // the type is a compile-time promise about a runtime value. An empty
      // page here would read as "no agreement is in that state".
      await expect(
        searchAgreements({ status: "in_efect" as never }),
      ).rejects.toThrow(AgreementSearchError);
    });

    test("a nonsense limit is refused rather than defaulted", async () => {
      await expect(searchAgreements({ limit: 0 })).rejects.toThrow(
        AgreementSearchError,
      );
      await expect(searchAgreements({ limit: 2.5 })).rejects.toThrow(
        AgreementSearchError,
      );
      // A greedy one is clamped, not refused.
      expect((await searchAgreements({ limit: 5000 })).rows).toHaveLength(
        CORPUS.length,
      );
    });

    test("a blank cursor is the first page, not a broken request", async () => {
      // `?cursor=` in a query string is how a register renders its own first
      // page. Refusing it would 500 the landing view.
      const found = await searchAgreements({ cursor: "  ", limit: 2 });
      expect(keys(found.rows)).toEqual(["radiance", "lakeside"]);
    });

    test("a mangled cursor fails as a typed error", async () => {
      await expect(searchAgreements({ cursor: "not-a-cursor" })).rejects.toThrow(
        AgreementSearchError,
      );
      await expect(
        searchAgreements({
          cursor: Buffer.from("2026-06-01T09:00:00.000000Z|nope").toString(
            "base64url",
          ),
        }),
      ).rejects.toThrow(/Malformed cursor/);
    });
  });

  describe("pagination", () => {
    test("every row is returned exactly once, even with a signature landing mid-walk", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let inserted = false;

      for (let page = 0; page < 20; page += 1) {
        const result: Awaited<ReturnType<typeof searchAgreements>> =
          await searchAgreements({ limit: 3, cursor: cursor ?? undefined });

        seen.push(...keys(result.rows));
        // The count is of the whole answer, not of what is left: it never
        // shrinks as pages are walked. It does grow when the register does,
        // because it is a fresh statement per page reporting what is there
        // now. The WALK is what has to be stable, not the census.
        expect(result.total).toBe(CORPUS.length + (inserted ? 1 : 0));

        if (!inserted) {
          // A new agreement is signed while the operator is on page one. With
          // OFFSET this shifts every later row down by one and the row that
          // was at the page boundary is never shown.
          idByKey.set("latecomer", "");
          const id = await seed({
            key: "latecomer",
            clinic: "Latecomer Clinic",
            name: "Nia Fields",
            email: "nia@latecomer.test",
            version: V_CURRENT,
            hash: digest("9911"),
            acceptedAt: new Date().toISOString(),
          });
          idByKey.set("latecomer", id);
          keyById.set(id, "latecomer");
          inserted = true;
        }

        cursor = result.nextCursor;
        if (!cursor) break;
      }

      expect(cursor).toBeNull();
      expect(seen.sort()).toEqual(CORPUS.map((row) => row.key).sort());
      // Newer than every seeded row, so it belongs on a page already passed.
      // It must not appear, and nothing may be dropped to make room for it.
      expect(seen).not.toContain("latecomer");
    });

    test("rows microseconds apart survive the cursor round trip", async () => {
      const first = await searchAgreements({ query: "micro precision", limit: 1 });
      expect(keys(first.rows)).toEqual(["microA"]);
      expect(first.total).toBe(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await searchAgreements({
        query: "micro precision",
        limit: 1,
        cursor: first.nextCursor!,
      });

      // A cursor carrying a millisecond-resolution Date would emit
      // ...123000Z here and exclude a row signed at ...123456Z.
      expect(keys(second.rows)).toEqual(["microB"]);
      expect(second.nextCursor).toBeNull();
    });

    test("the cursor carries the filters' answer, not a new one", async () => {
      const first = await searchAgreements({ version: V_PRIOR, limit: 2 });
      expect(first.total).toBe(6);

      const second = await searchAgreements({
        version: V_PRIOR,
        limit: 2,
        cursor: first.nextCursor!,
      });

      // The total is of the filter, so it does not shrink as pages are walked.
      expect(second.total).toBe(6);
      expect(keys(second.rows)).toEqual(["underscore", "underscoreDecoy"]);
    });

    test("two signatures at the identical microsecond both survive the walk", async () => {
      // The corpus deliberately has no such pair, and this is the case a keyset
      // paginator gets wrong. Ordering by `accepted_at` alone, with a cursor
      // carrying only the instant, makes page two ask for rows STRICTLY BEFORE
      // it — which excludes every other row sharing that microsecond. The lost
      // row is invisible: the register answers "they never signed" about a
      // contract we hold. Simultaneous rows are not exotic, either. A bulk
      // import, a retry, or two tabs produce them.
      const at = "2026-07-04T11:22:33.456789Z";

      for (const twin of ["twinA", "twinB"] as const) {
        const suffix = twin.slice(-1);
        const id = await seed({
          key: twin,
          clinic: `Simultaneous Clinic ${suffix}`,
          name: `Sim ${suffix}`,
          email: `${twin}@simultaneous.test`,
          version: V_CURRENT,
          hash: digest(twin === "twinA" ? "7a11" : "7a22"),
          acceptedAt: at,
        });
        idByKey.set(twin, id);
        keyById.set(id, twin);
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 5; page += 1) {
        const result: Awaited<ReturnType<typeof searchAgreements>> =
          await searchAgreements({
            query: "simultaneous clinic",
            limit: 1,
            cursor: cursor ?? undefined,
          });

        expect(result.total).toBe(2);
        seen.push(...keys(result.rows));

        cursor = result.nextCursor;
        if (!cursor) break;
      }

      // Both of them, once each. The id in the sort key AND in the cursor is
      // what separates the twins; without it the second is not reordered, it
      // is skipped.
      expect(seen.sort()).toEqual(["twinA", "twinB"]);
      expect(idOf("twinA")).not.toBe(idOf("twinB"));
    });

    test("a full last page does not promise a next one", async () => {
      const found = await searchAgreements({ query: "micro precision", limit: 2 });
      expect(found.rows).toHaveLength(2);
      expect(found.nextCursor).toBeNull();
    });
  });

  describe("hostile text is data, not syntax", () => {
    test("quotes and semicolons in a filter cannot become SQL", async () => {
      // Every value reaches Postgres as a bound parameter through drizzle and
      // there is no string concatenation into SQL anywhere in the module. This
      // asserts that from the outside, on the two filters that carry free text
      // straight from an operator's keyboard across the signed API boundary.
      const injection = "'; drop table baa_acceptances; --";

      const byQuery = await searchAgreements({ query: injection });
      expect(byQuery.rows).toEqual([]);
      expect(byQuery.total).toBe(0);

      const byVersion = await searchAgreements({ version: injection });
      expect(byVersion.rows).toEqual([]);

      // The quieter half of the same bug: a pattern-shaped attempt must match
      // literally rather than widen the answer to the whole register.
      const widen = await searchAgreements({ query: "%' or '1'='1" });
      expect(widen.rows).toEqual([]);
      expect(widen.total).toBe(0);

      // And the register is still there, and still whole.
      expect((await searchAgreements({})).total).toBe(CORPUS.length);
    });
  });

  describe("the list is not an export", () => {
    test("no row carries the agreement text", async () => {
      // Guard the guard: the marker has to actually be in the table, or this
      // test passes because seeding failed.
      const { rows: stored } = await getMigratorPool().query<{ n: string }>(
        `select count(*)::text as n from baa_acceptances where rendered_text like $1`,
        [`%${TEXT_MARKER}%`],
      );
      expect(stored[0]!.n).toBe(String(CORPUS.length));

      const found = await searchAgreements({ limit: 200 });

      expect(found.rows).toHaveLength(CORPUS.length);
      expect(JSON.stringify(found.rows)).not.toContain(TEXT_MARKER);
      for (const row of found.rows) {
        expect(Object.keys(row).sort()).toEqual([
          "acceptedAt",
          "clinicLegalName",
          "copySent",
          "copySentAt",
          "documentHash",
          "eligibleAt",
          "id",
          "retentionFloorAt",
          "signatoryEmail",
          "signatoryName",
          "signatoryTitle",
          "status",
          "terminatedAt",
          "version",
        ]);
      }
    });

    test("a row carries what an auditor asks for", async () => {
      const found = await searchAgreements({ query: "radiance" });
      const row = found.rows[0]!;

      expect(row).toMatchObject({
        clinicLegalName: "Radiance Med Spa",
        signatoryName: "Alex Chen",
        signatoryEmail: "alex@radiance.test",
        signatoryTitle: "Owner",
        version: V_CURRENT,
        documentHash: H_RADIANCE,
        copySent: true,
        terminatedAt: null,
        status: "in_effect",
      });
      expect(row.acceptedAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
      expect(row.copySentAt?.toISOString()).toBe("2026-06-02T09:00:00.000Z");
    });
  });
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  bookingSyncFor,
  type BookingSystemId,
  type CalendarAccount,
  getCalendarElection,
  getDpaCalendarElection,
  prepareCalendarElection,
  prepareDpaCalendarElection,
} from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TENANT_SCOPED_TABLES } from "@/db/schema";

import {
  asApp,
  bindCalendarAgreement,
  type BoundAgreement,
  type Client,
  insertBookingRequest,
  insertGoogleConnection,
  markDemo,
  recordAgreementElection,
  seedWritableCalendar,
  sha256Hex,
} from "./setup/calendar-db";
import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedClinic,
  type SeededClinic,
  seedContact,
  seedPortalUser,
} from "./setup/factories";

/**
 * drizzle/0057 (Google Calendar, migration A), asserted.
 *
 * tests/slot-holds.test.ts covers the holds and the overlap guard,
 * tests/connect-links.test.ts the calendar link, and
 * tests/database-audit.test.ts the grant posture, the BAA-gate list, client
 * numbers, what a credential is sealed to and the catalogue's SQL copies.
 * This file pins the rest: the election guard that keeps a location's
 * calendar terms honest, the single-use OAuth state, named providers, one
 * live connection per Google account, the watch's tenant walk and the
 * re-issue of a desk token nobody received. Everything talks to the database
 * directly, mostly as the runtime role inside a tenant, because these are
 * the rules no application code can be trusted to remember.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Each test seeds clinics, agreements and rows over many round trips; a loaded runner needs room. */
const SLOW = 60_000;

const NEW_TENANT_TABLES = [
  "calendar_elections",
  "slot_holds",
  "clinic_providers",
  "clinic_provider_services",
];

type ElectionInput = {
  source: "calendar_link" | "portal";
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
  linkId?: string | null;
  userId?: string | null;
  ownerConfirmed?: boolean;
  /** Default: what the catalogue says of the version (calendar-election/1.0.0 is released since 12 October 2026). */
  released?: boolean;
  /** Overrides the hash the server would compute. */
  documentHash?: string;
  /** Overrides the version the server renders. */
  documentVersion?: string;
  /** Overrides the sync, kind and clause the catalogue derives. */
  forged?: { bookingSync: "live" | "manual"; termsKind: string; clauseId: string };
  /** Default: the address insertCalendarLink sends to. */
  linkSentTo?: string[] | null;
  sequence?: number;
  /**
   * Which form the server renders: the BAA's (default) or the DPA's own,
   * amending the agreement version given (drizzle/0104 holds the form to the
   * kind of the agreement in effect).
   */
  form?: { kind: "baa" } | { kind: "dpa"; agreementVersion: string };
};

/** A calendar election as the server renders it (prepareCalendarElection), inserted on the client given. */
async function insertElection(
  c: Client,
  clinicId: string,
  agreement: Pick<BoundAgreement, "agreementId">,
  input: ElectionInput,
): Promise<{ id: string; sequence: number }> {
  const bookingSystem = input.bookingSystem ?? "google_calendar";
  const calendarAccount = input.calendarAccount ?? "workspace_baa";
  const variables = {
    clinicLegalName: "Radiance Synthetic",
    locationName: "Main Street",
    agreementVersion: input.form?.kind === "dpa" ? input.form.agreementVersion : "1.3.0",
    agreementEffectiveDate: "2026-10-07",
    bookingSystem,
    calendarAccount,
    signatoryName: "Alex Chen",
    signatoryTitle: "Owner",
    electedOn: "2026-10-07",
  };
  const prepared =
    input.form?.kind === "dpa" ? prepareDpaCalendarElection(variables) : prepareCalendarElection(variables);
  const documentVersion = input.documentVersion ?? prepared.version;
  const { rows } = await c.query<{ id: string; sequence: number }>(
    `insert into calendar_elections
       (clinic_id, agreement_id, sequence, source, terms_kind, clause_id, calendar_account, booking_sync,
        booking_system, document_version, document_hash, document_released, owner_confirmed,
        rendered_text, elected_by_label, elected_by_user_id, link_id, link_sent_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Alex Chen, Owner', $15, $16, $17)
     returning id, sequence`,
    [
      clinicId,
      agreement.agreementId,
      input.sequence ?? 0,
      input.source,
      input.forged?.termsKind ?? prepared.kind,
      input.forged?.clauseId ?? prepared.clauseId,
      calendarAccount,
      input.forged?.bookingSync ?? bookingSyncFor(bookingSystem),
      bookingSystem,
      documentVersion,
      input.documentHash ?? prepared.hash,
      input.released ??
        (getCalendarElection(documentVersion) ?? getDpaCalendarElection(documentVersion))
          ?.approvedByCounsel ??
        false,
      input.ownerConfirmed ?? false,
      prepared.text,
      input.source === "portal" ? input.userId : null,
      input.source === "calendar_link" ? input.linkId : null,
      input.source === "calendar_link"
        ? input.linkSentTo === undefined
          ? ["front@clinic.test"]
          : input.linkSentTo
        : null,
    ],
  );
  return rows[0]!;
}

type LinkInput = {
  audience?: "recipients" | "owner";
  purpose?: string;
  /** What an owner confirm link asks the owner to confirm. */
  pendingElection?: Record<string, string>;
  /** Minted this many days ago and expired a day ago. */
  expired?: boolean;
};

/** A calendar link of the clinic, mailed to front@clinic.test, written as the migrator in its tenant. */
async function insertCalendarLink(clinicId: string, input: LinkInput = {}): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into connection_links
         (clinic_id, token_hash, created_at, expires_at, purpose, audience, sent_to, pending_election)
       values ($1, $2,
               case when $5::boolean then now() - interval '4 days' else now() end,
               case when $5::boolean then now() - interval '1 day' else now() + interval '3 days' end,
               $3, $4, '{front@clinic.test}', $6::jsonb)
       returning id`,
      [
        clinicId,
        randomBytes(32),
        input.purpose ?? "calendar",
        input.audience ?? "recipients",
        input.expired ?? false,
        input.pendingElection ? JSON.stringify(input.pendingElection) : null,
      ],
    );
    return rows[0]!.id;
  });
}

/** A location of `billing`'s practice: a clinic in its organisation naming it as the billing clinic. */
async function seedLocation(billing: SeededClinic): Promise<SeededClinic> {
  const slug = `loc-${randomUUID().slice(0, 6)}`;
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [billing.organizationId, slug, billing.clinicId],
  );
  return { ...billing, clinicId: rows[0]!.id, slug };
}

/** Migration A, found by its tag, not its number, which is assigned when the branch merges. */
function migrationA(): string {
  const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_google_calendar\.sql$/.test(name));
  expect(files).toHaveLength(1);
  return readFileSync(`${drizzleDir}${files[0]!}`, "utf8");
}

function permitted(clinicId: string, forAssistant = true): Promise<boolean> {
  return asApp(clinicId, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `select app_calendar_write_permitted($1, $2) as ok`,
      [clinicId, forAssistant],
    );
    return rows[0]!.ok;
  });
}

describeDb("drizzle/0057: the Google Calendar schema", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  /* -------------------------------------------------------------- catalogue */

  test(
    "each new tenant table forces RLS, has its isolation policy and is listed as tenant-scoped",
    async () => {
      const { rows } = await getMigratorPool().query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: string[];
      }>(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              coalesce(array_agg(p.polname::text) filter (where p.polname is not null), array[]::text[]) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         left join pg_policy p on p.polrelid = c.oid
        where c.relname = any($1::text[])
        group by c.relname, c.relrowsecurity, c.relforcerowsecurity`,
        [NEW_TENANT_TABLES],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...NEW_TENANT_TABLES].sort());
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.relforcerowsecurity, row.relname).toBe(true);
        expect(row.policies, row.relname).toEqual([`${row.relname}_tenant_isolation`]);
        expect((TENANT_SCOPED_TABLES as readonly string[]).includes(row.relname), row.relname).toBe(
          true,
        );
      }

      // The OAuth state is read by the callback before any tenant is known, so
      // it has no clinic_id for a tenant policy to hide it behind.
      const { rows: columns } = await getMigratorPool().query(
        `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'google_oauth_states' and column_name = 'clinic_id'`,
      );
      expect(columns).toEqual([]);
    },
    SLOW,
  );

  test("the migration itself seeds the calendar watch, and seeds it off", () => {
    // Read the migration, not the table: truncateAll() reseeds scheduled_jobs
    // from tests/setup/db.ts, so a query would check the harness's copy.
    const sql = migrationA();
    const insert = sql.match(
      /INSERT INTO scheduled_jobs[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/i,
    )?.[0];
    expect(insert, "0057 seeds scheduled_jobs").toBeDefined();
    const row = /\(\s*'([a-z-]+)'\s*,\s*'(?:[^']|'')*'\s*,\s*(true|false)\s*\)/gi;
    expect([...insert!.matchAll(row)].map((m) => [m[1]!, m[2]!.toLowerCase()])).toEqual([
      ["calendar-watch", "false"],
    ]);
    // And the harness reseeds the same row after every truncate.
    const harness = readFileSync(fileURLToPath(new URL("./setup/db.ts", import.meta.url)), "utf8");
    expect(harness).toContain("('calendar-watch', ");
  });

  /* ------------------------------------------------------ calendar elections */

  test(
    "an agreement row records exactly what the practice signed, as the location's first terms",
    async () => {
      const clinic = await seedClinic("elect-agreement");
      const agreement = await bindCalendarAgreement(clinic);
      const insertAgreementRow = (override: Partial<Record<string, unknown>>) =>
        asApp(clinic.clinicId, (c) =>
          c.query(
            `insert into calendar_elections
             (clinic_id, agreement_id, source, terms_kind, clause_id, calendar_account, booking_sync,
              booking_system, document_version, document_hash, document_released, elected_by_label)
           values ($1, $2, 'agreement', $3, $4, $5, $6, $7, $8, $9, true, 'Alex Chen')`,
            [
              clinic.clinicId,
              agreement.agreementId,
              override.termsKind ?? agreement.termsKind,
              override.clauseId ?? agreement.clauseId,
              override.calendarAccount ?? agreement.calendarAccount,
              override.bookingSync ?? agreement.bookingSync,
              override.bookingSystem ?? agreement.bookingSystem,
              override.documentVersion ?? agreement.documentVersion,
              override.documentHash ?? agreement.documentHash,
            ],
          ),
        );

      // Each way of recording something the practice did not sign.
      for (const [label, override] of [
        [
          "another kind",
          {
            termsKind: "uncovered",
            clauseId: "google-calendar-uncovered",
            calendarAccount: "workspace_no_baa",
          },
        ],
        ["another booking system", { bookingSystem: "calcom" }],
        ["another version", { documentVersion: "1.2.1" }],
        ["another hash", { documentHash: "b".repeat(64) }],
      ] as const) {
        await expect(insertAgreementRow(override), label).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(/exactly the calendar terms the practice signed/),
        });
      }

      const first = await recordAgreementElection(clinic.clinicId, agreement);
      expect(first.sequence).toBe(1);
      // Only the first under its agreement: the signature decides the
      // location's terms under it, and every later change is an election
      // (the guard since 0100; the CHECK held it to sequence 1 before).
      await expect(insertAgreementRow({})).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/first row recorded under its agreement/),
      });
      // The CHECK still holds the row's shape: a released document nobody had to confirm.
      for (const [label, released, confirmed] of [
        ["unreleased", false, false],
        ["owner-confirmed", true, true],
      ] as const) {
        const other = await seedClinic(`elect-shape-${label}`);
        const signed = await bindCalendarAgreement(other);
        await expect(
          asApp(other.clinicId, (c) =>
            c.query(
              `insert into calendar_elections
                 (clinic_id, agreement_id, source, terms_kind, clause_id, calendar_account,
                  booking_sync, booking_system, document_version, document_hash,
                  document_released, owner_confirmed, elected_by_label)
               values ($1, $2, 'agreement', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Alex Chen')`,
              [
                other.clinicId,
                signed.agreementId,
                signed.termsKind,
                signed.clauseId,
                signed.calendarAccount,
                signed.bookingSync,
                signed.bookingSystem,
                signed.documentVersion,
                signed.documentHash,
                released,
                confirmed,
              ],
            ),
          ),
          label,
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "calendar_elections_agreement_shape",
        });
      }

      // An acceptance with no calendar clause at all (1.2.1 and earlier) can
      // never be the source of a location's calendar terms.
      const legacy = await seedClinic("elect-legacy");
      const legacyId = randomUUID();
      await getMigratorPool().query(
        `insert into baa_acceptances
         (id, organization_id, document_version, document_hash, rendered_text, variables,
          assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, '1.2.1', repeat('c', 64), 'BAA (synthetic)',
               '{"appliedClauses":["google-calendar"],"clinicLegalName":"Old"}'::jsonb,
               'I agree', 'Alex Chen', 'alex@radiance.test', now(), now())`,
        [legacyId, legacy.organizationId],
      );
      await expect(
        asApp(legacy.clinicId, (c) =>
          c.query(
            `insert into calendar_elections
             (clinic_id, agreement_id, source, terms_kind, clause_id, calendar_account, booking_sync,
              booking_system, document_version, document_hash, document_released, elected_by_label)
           values ($1, $2, 'agreement', 'covered', 'google-calendar-covered', 'workspace_baa', 'live',
                   'google_calendar', '1.2.1', repeat('c', 64), true, 'Alex Chen')`,
            [legacy.clinicId, legacyId],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
    SLOW,
  );

  test(
    "the signed clause is only the first location's: a location added later records an election, which widens",
    async () => {
      // The clause governs "the calendar of the location Practice sets up when
      // it signs this agreement"; any other location's election takes its
      // place (CALENDAR_LOCATION_PARAGRAPH, plan §2.9).
      const first = await seedClinic("elect-location");
      const agreement = await bindCalendarAgreement(first);
      const location = await seedLocation(first);

      await expect(recordAgreementElection(location.clinicId, agreement)).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/only for the location set up at signing/),
      });
      // Nothing was written, so nothing lets the assistant write there, even
      // with a connection of the kind the signed clause names.
      await insertGoogleConnection(location.clinicId, { managed: true });
      expect(await permitted(location.clinicId)).toBe(false);
      // The location set up at signing takes the signed clause, as provisioning records it.
      expect((await recordAgreementElection(first.clinicId, agreement)).sequence).toBe(1);

      // The location's first covered election widens what reaches Google: not
      // through a recipients link, only the owner's. (A draft document, so
      // the location is a demo clinic here; after the release it need not be.)
      await markDemo(location.clinicId);
      const recipients = await insertCalendarLink(location.clinicId);
      const owner = await insertCalendarLink(location.clinicId, { audience: "owner" });
      await expect(
        asApp(location.clinicId, (c) =>
          insertElection(c, location.clinicId, agreement, {
            source: "calendar_link",
            linkId: recipients,
          }),
        ),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/needs the practice owner/),
      });
      const elected = await asApp(location.clinicId, (c) =>
        insertElection(c, location.clinicId, agreement, {
          source: "calendar_link",
          linkId: owner,
          ownerConfirmed: true,
        }),
      );
      expect(elected.sequence).toBe(1);
      expect(await permitted(location.clinicId)).toBe(true);
    },
    SLOW,
  );

  test(
    "an agreement row is the first under its agreement: a superseding agreement's is taken at a later sequence, a second under one agreement is not",
    async () => {
      // When a later signature supersedes the agreement, it is the location's
      // terms under the new one (recordSupersedingTerms, 0100). The sequence
      // counts every row the location has, so that row is not sequence 1;
      // the guard holds it to being the first row under its own agreement.
      const clinic = await seedClinic("elect-supersede");
      const location = await seedLocation(clinic);
      const agreementRow = (
        clinicId: string,
        agreement: BoundAgreement,
        override: Partial<Pick<BoundAgreement, "calendarAccount" | "termsKind" | "clauseId">> = {},
      ) =>
        asApp(clinicId, async (c) => {
          const { rows } = await c.query<{ sequence: number }>(
            `insert into calendar_elections
               (clinic_id, agreement_id, source, terms_kind, clause_id, calendar_account, booking_sync,
                booking_system, document_version, document_hash, document_released, elected_by_label)
             values ($1, $2, 'agreement', $3, $4, $5, $6, $7, $8, $9, true, 'Alex Chen')
             returning sequence`,
            [
              clinicId,
              agreement.agreementId,
              override.termsKind ?? agreement.termsKind,
              override.clauseId ?? agreement.clauseId,
              override.calendarAccount ?? agreement.calendarAccount,
              agreement.bookingSync,
              agreement.bookingSystem,
              agreement.documentVersion,
              agreement.documentHash,
            ],
          );
          return rows[0]!.sequence;
        });
      const supersede = async (
        old: BoundAgreement,
        input: Parameters<typeof bindCalendarAgreement>[1],
      ) => {
        // As app_supersede_agreement() leaves it: the old one ended, the new one bound and later.
        await getMigratorPool().query(
          `update baa_acceptances set accepted_at = now() - interval '1 day', terminated_at = now() where id = $1`,
          [old.agreementId],
        );
        return bindCalendarAgreement(clinic, input);
      };
      const firstUnder = {
        code: "23514",
        message: expect.stringMatching(/first row recorded under its agreement/),
      };

      // Under the first agreement: its row, then an election to a personal account.
      const before = await bindCalendarAgreement(clinic, { calendarAccount: "workspace_no_baa" });
      expect(await agreementRow(clinic.clinicId, before)).toBe(1);
      const recipients = await insertCalendarLink(clinic.clinicId);
      const elected = await asApp(clinic.clinicId, (c) =>
        insertElection(c, clinic.clinicId, before, {
          source: "calendar_link",
          linkId: recipients,
          calendarAccount: "personal",
        }),
      );
      expect(elected.sequence).toBe(2);

      const after = await supersede(before, { calendarAccount: "workspace_baa" });
      // Each refusal 0057 made of an agreement row still holds under the new
      // agreement: values the practice did not sign, a location with a
      // billing clinic, and an agreement no longer in effect.
      await expect(
        agreementRow(clinic.clinicId, after, {
          calendarAccount: "workspace_no_baa",
          termsKind: "uncovered",
          clauseId: "google-calendar-uncovered",
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/exactly the calendar terms the practice signed/),
      });
      await expect(agreementRow(location.clinicId, after)).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/only for the location set up at signing/),
      });
      await expect(agreementRow(clinic.clinicId, before)).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/against the agreement in effect/),
      });

      // The new signature's terms, at the location's third row: the election
      // under the old agreement is not carried forward.
      expect(await agreementRow(clinic.clinicId, after)).toBe(3);
      await insertGoogleConnection(clinic.clinicId, { managed: true });
      expect(await permitted(clinic.clinicId)).toBe(true);
      // A second agreement row under the same agreement is not the first under it.
      await expect(agreementRow(clinic.clinicId, after)).rejects.toMatchObject(firstUnder);

      // Nor is one recorded after an election under its agreement.
      const third = await supersede(after, { calendarAccount: "workspace_baa" });
      const owner = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      expect(
        (
          await asApp(clinic.clinicId, (c) =>
            insertElection(c, clinic.clinicId, third, {
              source: "calendar_link",
              linkId: owner,
              ownerConfirmed: true,
            }),
          )
        ).sequence,
      ).toBe(4);
      await expect(agreementRow(clinic.clinicId, third)).rejects.toMatchObject(firstUnder);
      const { rows } = await asApp(clinic.clinicId, (c) =>
        c.query<{ sequence: number; source: string; agreement_id: string }>(
          `select sequence, source, agreement_id from calendar_elections where clinic_id = $1 order by sequence`,
          [clinic.clinicId],
        ),
      );
      expect(rows).toEqual([
        { sequence: 1, source: "agreement", agreement_id: before.agreementId },
        { sequence: 2, source: "calendar_link", agreement_id: before.agreementId },
        { sequence: 3, source: "agreement", agreement_id: after.agreementId },
        { sequence: 4, source: "calendar_link", agreement_id: third.agreementId },
      ]);
    },
    SLOW,
  );

  test(
    "an election is anchored to the organisation's agreement in effect, and to no other",
    async () => {
      const clinic = await seedClinic("elect-anchor");
      await markDemo(clinic.clinicId);
      const link = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      const notMine = await bindCalendarAgreement(await seedClinic("elect-anchor-other"));
      const anchorRefusal = {
        code: "23514",
        message: expect.stringMatching(/against the agreement in effect/),
      };

      // No agreement in effect: nothing to anchor to.
      await expect(
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, notMine, {
            source: "calendar_link",
            linkId: link,
            ownerConfirmed: true,
          }),
        ),
      ).rejects.toMatchObject(anchorRefusal);

      const mine = await bindCalendarAgreement(clinic);
      // Another organisation's agreement is not this location's, though it exists.
      await expect(
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, notMine, {
            source: "calendar_link",
            linkId: link,
            ownerConfirmed: true,
          }),
        ),
      ).rejects.toMatchObject(anchorRefusal);
      await asApp(clinic.clinicId, (c) =>
        insertElection(c, clinic.clinicId, mine, {
          source: "calendar_link",
          linkId: link,
          ownerConfirmed: true,
        }),
      );

      // A terminated agreement voids every election under it.
      await getMigratorPool().query(
        `update baa_acceptances set terminated_at = now() where id = $1`,
        [mine.agreementId],
      );
      await expect(
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, mine, {
            source: "calendar_link",
            linkId: link,
            ownerConfirmed: true,
          }),
        ),
      ).rejects.toMatchObject(anchorRefusal);
    },
    SLOW,
  );

  test(
    "the database numbers the elections, and the list is append-only for every role",
    async () => {
      const clinic = await seedClinic("elect-append");
      await markDemo(clinic.clinicId);
      const agreement = await bindCalendarAgreement(clinic);
      await recordAgreementElection(clinic.clinicId, agreement);
      const link = await insertCalendarLink(clinic.clinicId);

      // Whatever sequence a writer passes is replaced by the next one.
      const second = await asApp(clinic.clinicId, (c) =>
        insertElection(c, clinic.clinicId, agreement, {
          source: "calendar_link",
          linkId: link,
          bookingSystem: "mindbody",
          sequence: 99,
        }),
      );
      expect(second.sequence).toBe(2);

      // The runtime role holds neither verb...
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(`update calendar_elections set terms_kind = 'covered' where id = $1`, [
            second.id,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(`delete from calendar_elections where id = $1`, [second.id]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // ...and the trigger refuses the owner both, inside the tenant.
      await expect(
        inTenant(clinic.clinicId, (client) =>
          client.query(
            `update calendar_elections set elected_by_label = 'Someone Else' where id = $1`,
            [second.id],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/append-only/) });
      await expect(
        inTenant(clinic.clinicId, (client) =>
          client.query(`delete from calendar_elections where id = $1`, [second.id]),
        ),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/append-only/) });
    },
    SLOW,
  );

  test(
    "the database, not the writer, says what is released and what is live; a draft counts only for a demo clinic",
    async () => {
      const clinic = await seedClinic("elect-draft");
      const agreement = await bindCalendarAgreement(clinic);
      const link = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      const elect = (input: Partial<ElectionInput>) =>
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, agreement, {
            source: "calendar_link",
            linkId: link,
            ownerConfirmed: true,
            ...input,
          }),
        );
      const releasedRefusal = {
        code: "23514",
        message: expect.stringMatching(/app_calendar_election_released/),
      };
      const syncRefusal = {
        code: "23514",
        message: expect.stringMatching(/app_booking_system_live/),
      };

      // calendar-election/1.0.0 is released (plan C19), in the catalogue and in
      // the database (the baa_release_1_3_0 migration); calling it a draft is as
      // wrong as the reverse.
      expect(getCalendarElection("calendar-election/1.0.0")?.approvedByCounsel).toBe(true);
      await expect(elect({ released: false })).rejects.toMatchObject(releasedRefusal);
      // A later BAA election version nobody released is the draft here: not
      // on the database's list of releases. (The DPA's own form was the
      // draft until its release with the DPA on 20 October 2026, 0104.)
      const DRAFT = "calendar-election/1.1.0-draft";
      expect(getCalendarElection(DRAFT)).toBeUndefined();
      // Told truthfully, a draft is refused for a clinic that is not a demo clinic...
      await expect(elect({ documentVersion: DRAFT })).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/only a demo clinic may record a draft/),
      });
      // ...and calling it released, or inventing a released version, changes nothing.
      await expect(elect({ documentVersion: DRAFT, released: true })).rejects.toMatchObject(
        releasedRefusal,
      );
      await expect(
        elect({ released: true, documentVersion: "calendar-election/9.9.9" }),
      ).rejects.toMatchObject(releasedRefusal);
      // A one-way system is manual whatever the writer says: never covered and live.
      await expect(
        elect({
          bookingSystem: "mindbody",
          forged: {
            bookingSync: "live",
            termsKind: "covered",
            clauseId: "google-calendar-covered",
          },
        }),
      ).rejects.toMatchObject(syncRefusal);
      // And one that reads Google is live: a writer cannot call it manual either.
      await expect(
        elect({
          bookingSystem: "google_calendar",
          forged: {
            bookingSync: "manual",
            termsKind: "not_used",
            clauseId: "google-calendar-not-used",
          },
        }),
      ).rejects.toMatchObject(syncRefusal);

      // The demo marker: status demo, no Stripe ids, still synthetic.
      await markDemo(clinic.clinicId);
      // A hash from anywhere but the stored text points at nothing.
      await expect(elect({ documentHash: "d".repeat(64) })).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/SHA-256 of rendered_text/),
      });
      // A demo clinic is not believed about the release either.
      await expect(elect({ documentVersion: DRAFT, released: true })).rejects.toMatchObject(
        releasedRefusal,
      );
      // Told truthfully, the draft counts here.
      await elect({ documentVersion: DRAFT });
    },
    SLOW,
  );

  test(
    "a released document counts for any clinic, by the database's own list of releases",
    async () => {
      // The release (plan C19) is the baa_release_1_3_0 migration, which added the version to
      // app_calendar_election_released(). Run inside one rolled-back
      // transaction, as the owner, whom the guard binds as it binds everyone,
      // on a clinic that is not a demo clinic.
      const clinic = await seedClinic("elect-released");
      const agreement = await bindCalendarAgreement(clinic, { bookingSystem: "mindbody" });
      const link = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      const client = await getMigratorPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [clinic.clinicId]);
        const elected = await insertElection(
          client as unknown as Client,
          clinic.clinicId,
          agreement,
          { source: "calendar_link", linkId: link, ownerConfirmed: true, released: true },
        );
        expect(elected.sequence).toBe(1);
        // Once released, a row that calls the version a draft is as wrong as the reverse.
        await client.query("savepoint draft");
        await expect(
          insertElection(client as unknown as Client, clinic.clinicId, agreement, {
            source: "calendar_link",
            linkId: link,
            ownerConfirmed: true,
            released: false,
          }),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(/app_calendar_election_released/),
        });
        await client.query("rollback to savepoint draft");
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }
      // The list is the migration's, not the test's: 1.0.0 stays released.
      const { rows } = await getMigratorPool().query<{ released: boolean }>(
        `select app_calendar_election_released('calendar-election/1.0.0') as released`,
      );
      expect(rows[0]!.released).toBe(true);
    },
    SLOW,
  );

  test(
    "an election is recorded on the form of its agreement's kind: the DPA's own under a DPA, never the BAA's, and never the reverse (0104)",
    async () => {
      const kindRefusal = {
        code: "23514",
        message: expect.stringMatching(/on the form of its agreement's kind/),
      };
      // A location under the released DPA, not a demo clinic: its own form,
      // released with the DPA, counts, and the BAA's is refused.
      const dpa = await seedClinic("elect-dpa");
      const dpaAgreement = await bindCalendarAgreement(dpa, {
        bookingSystem: "mindbody",
        documentVersion: "dpa/1.0.0",
      });
      const dpaLink = await insertCalendarLink(dpa.clinicId, { audience: "owner" });
      const electDpa = (input: Partial<ElectionInput>) =>
        asApp(dpa.clinicId, (c) =>
          insertElection(c, dpa.clinicId, dpaAgreement, {
            source: "calendar_link",
            linkId: dpaLink,
            ownerConfirmed: true,
            ...input,
          }),
        );
      expect(getDpaCalendarElection("calendar-election-dpa/1.0.0")?.approvedByCounsel).toBe(true);
      await expect(electDpa({})).rejects.toMatchObject(kindRefusal);
      const recorded = await electDpa({ form: { kind: "dpa", agreementVersion: "dpa/1.0.0" } });
      expect(recorded.sequence).toBe(1);
      const { rows } = await inTenant(dpa.clinicId, (c) =>
        c.query<{ document_version: string; document_released: boolean }>(
          `select document_version, document_released from calendar_elections where id = $1`,
          [recorded.id],
        ),
      );
      expect(rows).toEqual([{ document_version: "calendar-election-dpa/1.0.0", document_released: true }]);

      // A location under a BAA: the DPA's form is refused, whatever it says it is.
      const baa = await seedClinic("elect-baa-dpa-form");
      const baaAgreement = await bindCalendarAgreement(baa, { bookingSystem: "mindbody" });
      const baaLink = await insertCalendarLink(baa.clinicId, { audience: "owner" });
      await expect(
        asApp(baa.clinicId, (c) =>
          insertElection(c, baa.clinicId, baaAgreement, {
            source: "calendar_link",
            linkId: baaLink,
            ownerConfirmed: true,
            form: { kind: "dpa", agreementVersion: "dpa/1.0.0" },
          }),
        ),
      ).rejects.toMatchObject(kindRefusal);
    },
    SLOW,
  );

  test(
    "an election that lets more reach Google needs the owner; one that narrows does not",
    async () => {
      const clinic = await seedClinic("elect-widen");
      await markDemo(clinic.clinicId);
      const agreement = await bindCalendarAgreement(clinic, { bookingSystem: "mindbody" });
      const recipients = await insertCalendarLink(clinic.clinicId);
      const owner = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      const elect = (input: ElectionInput) =>
        asApp(clinic.clinicId, (c) => insertElection(c, clinic.clinicId, agreement, input));
      const ownerRefusal = { code: "42501", message: expect.stringMatching(/owner/) };

      // No row yet under this agreement: covered or uncovered widens.
      await expect(elect({ source: "calendar_link", linkId: recipients })).rejects.toMatchObject(
        ownerRefusal,
      );
      // Claiming the owner's confirmation through a recipients link is refused too.
      await expect(
        elect({ source: "calendar_link", linkId: recipients, ownerConfirmed: true }),
      ).rejects.toMatchObject(ownerRefusal);
      // Not used never widens.
      await elect({ source: "calendar_link", linkId: recipients, bookingSystem: "mindbody" });
      // From not used to writing widens: the owner, through an owner link.
      await expect(
        elect({ source: "calendar_link", linkId: recipients, calendarAccount: "workspace_no_baa" }),
      ).rejects.toMatchObject(ownerRefusal);
      await elect({
        source: "calendar_link",
        linkId: owner,
        ownerConfirmed: true,
        calendarAccount: "workspace_no_baa",
      });
      // Uncovered to covered narrows; covered to uncovered widens again.
      await elect({
        source: "calendar_link",
        linkId: recipients,
        calendarAccount: "workspace_baa",
      });
      await expect(
        elect({ source: "calendar_link", linkId: recipients, calendarAccount: "personal" }),
      ).rejects.toMatchObject(ownerRefusal);

      // Through the portal: the owner's own sign-in widens, nobody else's does,
      // and a stranger records nothing at all.
      await elect({
        source: "portal",
        userId: clinic.staffUserId,
        ownerConfirmed: true,
        calendarAccount: "personal",
      });
      const admin = await seedPortalUser(clinic.clinicId, "admin");
      await elect({ source: "portal", userId: admin.userId, calendarAccount: "workspace_baa" });
      await expect(
        elect({
          source: "portal",
          userId: admin.userId,
          ownerConfirmed: true,
          calendarAccount: "personal",
        }),
      ).rejects.toMatchObject(ownerRefusal);
      await expect(
        elect({
          source: "portal",
          userId: `usr_stranger_${randomUUID().slice(0, 8)}`,
          bookingSystem: "mindbody",
        }),
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/no active membership/),
      });

      // A link must be one of this location's calendar links.
      const connectLink = await insertCalendarLink(clinic.clinicId, { purpose: "connect" });
      await expect(
        elect({ source: "calendar_link", linkId: connectLink, bookingSystem: "mindbody" }),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/calendar links/) });
      // Another clinic's is invisible from this tenant, so the guard finds no
      // such link; and should a trigger ever be lost, the (clinic, link) key
      // still refuses it, whatever the writer's tenant could see.
      const elsewhere = await insertCalendarLink((await seedClinic("elect-widen-other")).clinicId, {
        audience: "owner",
      });
      await expect(
        elect({ source: "calendar_link", linkId: elsewhere, ownerConfirmed: true }),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/calendar links/) });
      const { rows: keys } = await getMigratorPool().query<{ conname: string; columns: string[] }>(
        `select c.conname,
                array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o)
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as columns
           from pg_constraint c
          where c.contype = 'f' and c.confrelid = 'connection_links'::regclass
            and c.conrelid in ('calendar_elections'::regclass, 'google_oauth_states'::regclass)
          order by c.conname`,
      );
      expect(keys).toEqual([
        { conname: "calendar_elections_link_fk", columns: ["clinic_id", "link_id"] },
        { conname: "google_oauth_states_link_fk", columns: ["target_clinic_id", "link_id"] },
      ]);
    },
    SLOW,
  );

  test(
    "a calendar link speaks only while it is live, as it was mailed, and a confirm link only for its own election",
    async () => {
      const clinic = await seedClinic("elect-link-state");
      await markDemo(clinic.clinicId);
      const agreement = await bindCalendarAgreement(clinic, { bookingSystem: "mindbody" });
      const elect = (input: Partial<ElectionInput>) =>
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, agreement, {
            source: "calendar_link",
            bookingSystem: "mindbody",
            ...input,
          }),
        );
      const lapsedRefusal = { code: "42501", message: expect.stringMatching(/spent or expired/) };

      // Expired weeks ago, or already spent: it authorises nothing.
      const expired = await insertCalendarLink(clinic.clinicId, {
        audience: "owner",
        expired: true,
      });
      await expect(
        elect({ linkId: expired, ownerConfirmed: true, bookingSystem: "google_calendar" }),
      ).rejects.toMatchObject(lapsedRefusal);
      const spent = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      await inTenant(clinic.clinicId, (client) =>
        client.query(`update connection_links set used_at = now() where id = $1`, [spent]),
      );
      await expect(
        elect({ linkId: spent, ownerConfirmed: true, bookingSystem: "google_calendar" }),
      ).rejects.toMatchObject(lapsedRefusal);

      // Who could have held it is the link's own record, not the writer's.
      const recipients = await insertCalendarLink(clinic.clinicId);
      for (const linkSentTo of [["attacker@example.test"], null]) {
        await expect(
          elect({ linkId: recipients, linkSentTo }),
          JSON.stringify(linkSentTo),
        ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/sent_to/) });
      }
      // Recorded first, then the link is spent in the same transaction (plan §2.6).
      await asApp(clinic.clinicId, async (c) => {
        await insertElection(c, clinic.clinicId, agreement, {
          source: "calendar_link",
          linkId: recipients,
          bookingSystem: "mindbody",
        });
        await c.query(`update connection_links set used_at = now() where id = $1`, [recipients]);
      });

      // A confirm link carries the widening the owner is asked to confirm, and records nothing else.
      const pending = {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_no_baa",
        documentVersion: "calendar-election/1.0.0",
        documentHash: "a".repeat(64),
      };
      const confirm = await insertCalendarLink(clinic.clinicId, {
        audience: "owner",
        pendingElection: pending,
      });
      const pendingRefusal = {
        code: "23514",
        message: expect.stringMatching(/only the election it asked the owner to confirm/),
      };
      // Another account kind, another booking system...
      await expect(
        elect({
          linkId: confirm,
          ownerConfirmed: true,
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
        }),
      ).rejects.toMatchObject(pendingRefusal);
      await expect(
        elect({
          linkId: confirm,
          ownerConfirmed: true,
          bookingSystem: "calcom",
          calendarAccount: "workspace_no_baa",
        }),
      ).rejects.toMatchObject(pendingRefusal);
      // ...or another document version.
      const olderVersion = await insertCalendarLink(clinic.clinicId, {
        audience: "owner",
        pendingElection: { ...pending, documentVersion: "calendar-election/0.9.0" },
      });
      await expect(
        elect({
          linkId: olderVersion,
          ownerConfirmed: true,
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_no_baa",
        }),
      ).rejects.toMatchObject(pendingRefusal);
      // The election it asked about goes through, whatever the hash it was
      // minted with: the stored text carries the owner's own typed name.
      await elect({
        linkId: confirm,
        ownerConfirmed: true,
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_no_baa",
      });
    },
    SLOW,
  );

  test(
    "the newest election decides the write permission, with no fallback, and a supersede fails closed",
    async () => {
      const clinic = await seedClinic("elect-newest");
      await markDemo(clinic.clinicId);
      const { agreement } = await seedWritableCalendar(clinic);
      expect(await permitted(clinic.clinicId)).toBe(true);

      // A newer not-used election stops the writes at once, whatever came before.
      const link = await insertCalendarLink(clinic.clinicId);
      await asApp(clinic.clinicId, (c) =>
        insertElection(c, clinic.clinicId, agreement, {
          source: "calendar_link",
          linkId: link,
          bookingSystem: "mindbody",
        }),
      );
      expect(await permitted(clinic.clinicId)).toBe(false);

      // Back to covered, by the owner: writing again.
      const owner = await insertCalendarLink(clinic.clinicId, { audience: "owner" });
      await asApp(clinic.clinicId, (c) =>
        insertElection(c, clinic.clinicId, agreement, {
          source: "calendar_link",
          linkId: owner,
          ownerConfirmed: true,
        }),
      );
      expect(await permitted(clinic.clinicId)).toBe(true);

      // A supersede (0051) binds a new agreement; no election is anchored to it,
      // so the location writes nothing until it records one. Under 1.5.1, the
      // go-live floor, which is all a supersede binds since 1.5.1 replaced
      // 1.5.0 (19 October 2026), as 1.5.0 had replaced 1.4.0, 1.4.0 1.3.0 and 1.3.0 1.2.2; its calendar
      // clause (1.3.0's) governs only the location set up at signing, so this
      // one still records an election.
      await getMigratorPool().query(
        `update clinics set regulatory_regime = 'hipaa-if-covered' where id = $1`,
        [clinic.clinicId],
      );
      const superseding = randomUUID();
      await getMigratorPool().query(
        `insert into baa_acceptances
         (id, organization_id, document_version, document_hash, rendered_text, variables,
          assent_label, accepted_by_name, accepted_by_email, accepted_at)
       values ($1, null, '1.5.1', repeat('e', 64), 'BAA (synthetic)',
               '{"clinicLegalName":"Radiance","bookingSystem":"google_calendar","calendarAccount":"workspace_baa","appliedClauses":["google-calendar-covered"]}'::jsonb,
               'I agree', 'Alex Chen', 'alex@radiance.test', now() + interval '1 second')`,
        [superseding],
      );
      await getAppPool().query(`select app_supersede_agreement($1, $2, 'test')`, [
        clinic.clinicId,
        superseding,
      ]);
      expect(await permitted(clinic.clinicId)).toBe(false);
      // And nothing may be recorded against the agreement it replaced.
      await expect(
        asApp(clinic.clinicId, (c) =>
          insertElection(c, clinic.clinicId, agreement, {
            source: "calendar_link",
            linkId: owner,
            ownerConfirmed: true,
          }),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/against the agreement in effect/),
      });
    },
    SLOW,
  );

  /* ------------------------------------------------------- OAuth state */

  test(
    "an OAuth state is shaped, short-lived and spent once",
    async () => {
      const clinic = await seedClinic("oauth-state");
      const other = await seedClinic("oauth-state-other");
      const link = await insertCalendarLink(clinic.clinicId);
      const insertState = (override: Record<string, unknown> = {}) =>
        getAppPool().query<{ state_hash: Buffer }>(
          `insert into google_oauth_states
           (state_hash, target_clinic_id, initiated_via, link_id, user_id, return_to,
            browser_binding_hash, disclosure_version, disclosure_sha256, disclosure_accepted_at,
            created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'google-calendar-disclosure/1', $8, now(),
                 now() + $10::interval, now() + $10::interval + $9::interval)
         returning state_hash`,
          [
            override.stateHash ?? randomBytes(32),
            override.targetClinicId ?? clinic.clinicId,
            override.initiatedVia ?? "calendar_link",
            override.linkId === undefined ? link : override.linkId,
            override.userId ?? null,
            override.returnTo ?? "calendar_link",
            override.binding ?? randomBytes(32),
            override.disclosure ?? randomBytes(32),
            override.ttl ?? "15 minutes",
            override.mintedIn ?? "0 seconds",
          ],
        );

      for (const [label, override, constraint] of [
        ["a raw state", { stateHash: Buffer.from("raw-state") }, "google_oauth_states_hash_length"],
        ["a raw binding", { binding: Buffer.from("cookie") }, "google_oauth_states_binding_length"],
        [
          "a disclosure that is not a digest",
          { disclosure: Buffer.alloc(16) },
          "google_oauth_states_disclosure_length",
        ],
        ["sixteen minutes", { ttl: "16 minutes" }, "google_oauth_states_expiry_check"],
        ["a link sign-in with no link", { linkId: null }, "google_oauth_states_link_shape"],
        [
          "a link sign-in returning to the portal",
          { returnTo: "portal" },
          "google_oauth_states_link_shape",
        ],
        [
          "a portal sign-in with nobody",
          { initiatedVia: "portal", linkId: null, returnTo: "portal" },
          "google_oauth_states_portal_shape",
        ],
        [
          "a URL to return to",
          {
            initiatedVia: "portal",
            linkId: null,
            userId: clinic.staffUserId,
            returnTo: "https://evil.test/",
          },
          "google_oauth_states_return_check",
        ],
      ] as const) {
        await expect(insertState(override), label).rejects.toMatchObject({
          code: "23514",
          constraint,
        });
      }
      // Its fifteen minutes run from the database's time, never a later one:
      // a state minted for next year would stay live until then.
      await expect(insertState({ mintedIn: "1 year" })).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/minted in the future/),
      });
      // A sign-in started from one clinic's link cannot target another clinic.
      await expect(insertState({ targetClinicId: other.clinicId })).rejects.toMatchObject({
        code: "23503",
        constraint: "google_oauth_states_link_fk",
      });

      // Both kinds that exist: a link's, and the portal's (Settings or the wizard).
      await insertState({
        initiatedVia: "portal",
        linkId: null,
        userId: clinic.staffUserId,
        returnTo: "wizard",
      });
      const { rows } = await insertState();
      const stateHash = rows[0]!.state_hash;

      // Consumed once, by the conditional update.
      const consume = () =>
        getAppPool().query(
          `update google_oauth_states set used_at = now(), consumed_ip = '203.0.113.7'
          where state_hash = $1 and used_at is null and expires_at > now()`,
          [stateHash],
        );
      expect((await consume()).rowCount).toBe(1);
      expect((await consume()).rowCount).toBe(0);
      // A spent state cannot be re-armed, by the runtime role or the owner.
      await expect(
        getAppPool().query(`update google_oauth_states set used_at = null where state_hash = $1`, [
          stateHash,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        getMigratorPool().query(
          `update google_oauth_states set used_at = null where state_hash = $1`,
          [stateHash],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // An unspent one cannot be stretched or re-pointed, even by the owner,
      // whom no grant stops: the trigger does. A portal sign-in, so no link
      // key could refuse the re-point first.
      const { rows: fresh } = await insertState({
        initiatedVia: "portal",
        linkId: null,
        userId: clinic.staffUserId,
        returnTo: "portal",
      });
      for (const assignment of [
        `expires_at = expires_at + interval '1 minute'`,
        `target_clinic_id = '${other.clinicId}'`,
        `disclosure_version = 'google-calendar-disclosure/0'`,
      ]) {
        await expect(
          getMigratorPool().query(
            `update google_oauth_states set ${assignment} where state_hash = $1`,
            [fresh[0]!.state_hash],
          ),
          assignment,
        ).rejects.toMatchObject({
          code: "42501",
          message: expect.stringMatching(/only used_at and consumed_ip may change/),
        });
      }

      // Housekeeping deletes old states.
      expect(
        (
          await getAppPool().query(`delete from google_oauth_states where state_hash = $1`, [
            stateHash,
          ])
        ).rowCount,
      ).toBe(1);
    },
    SLOW,
  );

  /* --------------------------------------------------- named providers */

  test(
    "named providers: one active provider per calendar, shaped names, and mappings kept inside the clinic",
    async () => {
      const clinic = await seedClinic("providers");
      const other = await seedClinic("providers-other");
      const addProvider = (clinicId: string, name: string, calendarId: string) =>
        asApp(clinicId, async (c) => {
          const { rows } = await c.query<{ id: string }>(
            `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, $2, $3) returning id`,
            [clinicId, name, calendarId],
          );
          return rows[0]!.id;
        });

      const jane = await addProvider(clinic.clinicId, "Dr. Jane Rivera", "jane@radiance.test");
      await expect(
        addProvider(clinic.clinicId, "Dr. Sam Okafor", "jane@radiance.test"),
      ).rejects.toMatchObject({
        code: "23505",
      });
      // Another clinic may use a calendar id that looks the same: it is its own account's.
      const theirs = await addProvider(other.clinicId, "Dr. Lee", "jane@radiance.test");
      // A deactivated provider frees the calendar.
      await asApp(clinic.clinicId, (c) =>
        c.query(`update clinic_providers set active = false, updated_at = now() where id = $1`, [
          jane,
        ]),
      );
      const sam = await addProvider(clinic.clinicId, "Dr. Sam Okafor", "jane@radiance.test");

      for (const [name, calendarId] of [
        ["", "a@radiance.test"],
        ["Dr.\nNewline", "b@radiance.test"],
        ["x".repeat(81), "c@radiance.test"],
        ["Dr. Space", "has space@radiance.test"],
        ["Dr. Empty", ""],
      ] as const) {
        await expect(
          addProvider(clinic.clinicId, name, calendarId),
          `${name} / ${calendarId}`,
        ).rejects.toMatchObject({
          code: "23514",
        });
      }

      const map = (clinicId: string, providerId: string, serviceKey: string) =>
        asApp(clinicId, (c) =>
          c.query(
            `insert into clinic_provider_services (clinic_id, provider_id, service_key) values ($1, $2, $3)`,
            [clinicId, providerId, serviceKey],
          ),
        );
      await map(clinic.clinicId, sam, "botox");
      await expect(map(clinic.clinicId, sam, "botox")).rejects.toMatchObject({ code: "23505" });
      // The key is the service's name trimmed and lower-cased, as the booking
      // path matches it.
      for (const key of ["Botox", " fillers", "", "x".repeat(121)]) {
        await expect(map(clinic.clinicId, sam, key), JSON.stringify(key)).rejects.toMatchObject({
          code: "23514",
        });
      }
      // Another clinic's provider is not this clinic's to map, though its id is real.
      await expect(map(clinic.clinicId, theirs, "botox")).rejects.toMatchObject({ code: "23503" });

      // Deactivated, never deleted; a mapping replaced, never edited.
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(`delete from clinic_providers where id = $1`, [jane]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(
            `update clinic_provider_services set service_key = 'fillers' where provider_id = $1`,
            [sam],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await asApp(clinic.clinicId, (c) =>
        c.query(`delete from clinic_provider_services where provider_id = $1`, [sam]),
      );

      // Each clinic sees only its own.
      await asApp(other.clinicId, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `select id from clinic_providers order by created_at`,
        );
        expect(rows.map((r) => r.id)).toEqual([theirs]);
      });
    },
    SLOW,
  );

  /* ------------------------------------------- Google connections, across tenants */

  test(
    "one Google account is live on one clinic at a time, and the count says so without revealing where",
    async () => {
      const a = await seedClinic("account-a");
      const b = await seedClinic("account-b");
      const accountRef = sha256Hex(`google:${randomUUID()}`);
      const count = async (ref: string, tenant: string | null = null) => {
        const client = await getAppPool().connect();
        try {
          await client.query("begin");
          if (tenant) await client.query(`select set_config('app.clinic_id', $1, true)`, [tenant]);
          const { rows } = await client.query<{ n: number; tenant: string | null }>(
            `select app_google_account_live_count($1) as n, current_setting('app.clinic_id', true) as tenant`,
            [ref],
          );
          return rows[0]!;
        } finally {
          await client.query("rollback").catch(() => {});
          client.release();
        }
      };

      expect((await count(accountRef)).n).toBe(0);
      await insertGoogleConnection(a.clinicId, { managed: true, accountRef });
      // Counted across tenants, from inside another one, which it gives back.
      expect(await count(accountRef, b.clinicId)).toEqual({ n: 1, tenant: b.clinicId });
      await expect(
        insertGoogleConnection(b.clinicId, { managed: true, accountRef }),
      ).rejects.toMatchObject({
        code: "23505",
      });

      // Revoked, the account is free for another location.
      await inTenant(a.clinicId, (client) =>
        client.query(`update provider_connections set status = 'revoked' where clinic_id = $1`, [
          a.clinicId,
        ]),
      );
      expect((await count(accountRef)).n).toBe(0);
      await insertGoogleConnection(b.clinicId, { managed: true, accountRef });
      expect((await count(accountRef)).n).toBe(1);

      // A malformed reference raises: a caller's bug must never read as "unused",
      // because "unused" is what lets a grant be revoked at Google.
      for (const bad of ["google:raw-sub", "", "A".repeat(64)]) {
        await expect(count(bad), bad).rejects.toMatchObject({ code: "22023" });
      }
      // And an account reference is a sha256, never the raw subject.
      await expect(
        insertGoogleConnection((await seedClinic("account-raw")).clinicId, {
          managed: true,
          accountRef: "google:12345",
        }),
      ).rejects.toMatchObject({ code: "23514" });
    },
    SLOW,
  );

  test(
    "the watch's list: unrevoked Google connections, revoked ones still owed an alert, no destroyed clinic",
    async () => {
      const live = await seedClinic("watch-live");
      const leaving = await seedClinic("watch-leaving");
      const gone = await seedClinic("watch-gone");
      const told = await seedClinic("watch-told");
      const untold = await seedClinic("watch-untold");
      const other = await seedClinic("watch-other");

      const liveRow = await insertGoogleConnection(live.clinicId, { managed: true });
      const leavingRow = await insertGoogleConnection(leaving.clinicId, {
        managed: true,
        status: "degraded",
      });
      await insertGoogleConnection(gone.clinicId, { managed: true });
      await insertGoogleConnection(told.clinicId, {
        managed: true,
        status: "revoked",
        brokenAt: new Date(),
        brokenAlertedAt: new Date(),
      });
      const untoldRow = await insertGoogleConnection(untold.clinicId, {
        managed: false,
        status: "revoked",
        brokenAt: new Date(),
      });
      // Another provider is never the watch's business.
      await asApp(other.clinicId, (c) =>
        c.query(
          `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'meta', 'active', 'x', 'x', 'x', 'x', 'v1', 1)`,
          [other.clinicId],
        ),
      );
      await getMigratorPool().query(
        `update clinics set offboarding_started_at = now() where id = $1`,
        [leaving.clinicId],
      );
      await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [
        gone.clinicId,
      ]);

      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [other.clinicId]);
        const { rows } = await client.query<{
          connection_id: string;
          status: string;
          offboarding: boolean;
        }>(
          `select connection_id, status::text as status, offboarding
           from app_calendar_connections()
          where clinic_id = any($1::uuid[])
          order by status`,
          [
            [
              live.clinicId,
              leaving.clinicId,
              gone.clinicId,
              told.clinicId,
              untold.clinicId,
              other.clinicId,
            ],
          ],
        );
        expect(rows).toEqual(
          expect.arrayContaining([
            { connection_id: liveRow.id, status: "active", offboarding: false },
            { connection_id: leavingRow.id, status: "degraded", offboarding: true },
            { connection_id: untoldRow.id, status: "revoked", offboarding: false },
          ]),
        );
        expect(rows).toHaveLength(3);
        // The caller's tenant is handed back.
        const { rows: after } = await client.query<{ tenant: string }>(
          `select current_setting('app.clinic_id', true) as tenant`,
        );
        expect(after[0]!.tenant).toBe(other.clinicId);
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
      }

      // Breakage stamps travel together: an alert with no breakage would hide the next one.
      await expect(
        inTenant(live.clinicId, (c) =>
          c.query(
            `update provider_connections set broken_alerted_at = now() where clinic_id = $1`,
            [live.clinicId],
          ),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "provider_connections_alert_needs_break",
      });
    },
    SLOW,
  );

  /* ------------------------------------------------ the desk token re-issue */

  test(
    "a desk token nobody received is re-issued only while the request is open and unnotified",
    async () => {
      const clinic = await seedClinic("reissue");
      const otherClinic = await seedClinic("reissue-other");
      const contactId = await seedContact(clinic.clinicId, "+15550100201");
      const freshHash = () => createHash("sha256").update(randomBytes(32)).digest();
      const reissue = (tenant: string, requestId: string, hash: Buffer) =>
        asApp(tenant, async (c) => {
          const { rows } = await c.query<{ ok: boolean }>(
            `select app_reissue_undelivered_booking_token($1, $2) as ok`,
            [requestId, hash],
          );
          return rows[0]!.ok;
        });
      const tokenOf = (requestId: string) =>
        inTenant(clinic.clinicId, async (client) => {
          const { rows } = await client.query<{ token_hash: Buffer }>(
            `select token_hash from booking_requests where id = $1`,
            [requestId],
          );
          return rows[0]!.token_hash;
        });

      const open = await asApp(clinic.clinicId, (c) =>
        insertBookingRequest(c, clinic.clinicId, contactId),
      );
      const replacement = freshHash();
      expect(await reissue(clinic.clinicId, open, replacement)).toBe(true);
      expect((await tokenOf(open)).equals(replacement)).toBe(true);
      // From another tenant the request is not there to re-issue.
      expect(await reissue(otherClinic.clinicId, open, freshHash())).toBe(false);
      // A raw token is refused, so the digest discipline holds here too.
      await expect(reissue(clinic.clinicId, open, Buffer.from("raw-token"))).rejects.toMatchObject({
        code: "22023",
      });

      // Once the desk has been told, the token it was told stays.
      await asApp(clinic.clinicId, (c) =>
        c.query(`update booking_requests set desk_notified_at = now() where id = $1`, [open]),
      );
      expect(await reissue(clinic.clinicId, open, freshHash())).toBe(false);
      // Decided or expired: nothing to re-issue.
      const declined = await asApp(clinic.clinicId, (c) =>
        insertBookingRequest(c, clinic.clinicId, contactId),
      );
      await asApp(clinic.clinicId, (c) =>
        c.query(
          `update booking_requests set status = 'declined', decided_at = now() where id = $1`,
          [declined],
        ),
      );
      expect(await reissue(clinic.clinicId, declined, freshHash())).toBe(false);
      const expired = await asApp(clinic.clinicId, (c) =>
        insertBookingRequest(c, clinic.clinicId, contactId, { expiresInDays: -1 }),
      );
      expect(await reissue(clinic.clinicId, expired, freshHash())).toBe(false);

      // The runtime role still cannot write the column itself, and the owner
      // can only through the function's switch, on an open, unnotified request.
      const another = await asApp(clinic.clinicId, (c) =>
        insertBookingRequest(c, clinic.clinicId, contactId),
      );
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(`update booking_requests set token_hash = $2 where id = $1`, [
            another,
            freshHash(),
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inTenant(clinic.clinicId, (client) =>
          client.query(`update booking_requests set token_hash = $2 where id = $1`, [
            another,
            freshHash(),
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // The switch opens the door only on an open, unnotified request...
      await expect(
        inTenant(clinic.clinicId, async (client) => {
          await client.query(`select set_config('app.booking_token_reissue', 'on', true)`);
          await client.query(`update booking_requests set token_hash = $2 where id = $1`, [
            open,
            freshHash(),
          ]);
        }),
      ).rejects.toMatchObject({ code: "42501" });
      // ...where it does open it: the switch, not a grant, is what the trigger reads.
      const switched = freshHash();
      await inTenant(clinic.clinicId, async (client) => {
        await client.query(`select set_config('app.booking_token_reissue', 'on', true)`);
        await client.query(`update booking_requests set token_hash = $2 where id = $1`, [
          another,
          switched,
        ]);
      });
      expect((await tokenOf(another)).equals(switched)).toBe(true);
    },
    SLOW,
  );

  /* ----------------------------------------- columns on existing tables */

  test(
    "Auto-confirm defaults on and records who changed it with when; event keys and durations are shaped",
    async () => {
      const clinic = await seedClinic("columns");
      const contactId = await seedContact(clinic.clinicId, "+15550100202");

      const settings = await asApp(clinic.clinicId, async (c) => {
        const { rows } = await c.query<{ auto_confirm_bookings: boolean }>(
          `insert into clinic_settings (clinic_id) values ($1) returning auto_confirm_bookings`,
          [clinic.clinicId],
        );
        return rows[0]!;
      });
      expect(settings.auto_confirm_bookings).toBe(true);
      await expect(
        asApp(clinic.clinicId, (c) =>
          c.query(
            `update clinic_settings set auto_confirm_bookings = false, auto_confirm_changed_at = now() where clinic_id = $1`,
            [clinic.clinicId],
          ),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "clinic_settings_auto_confirm_stamp_check",
      });
      await asApp(clinic.clinicId, (c) =>
        c.query(
          `update clinic_settings
            set auto_confirm_bookings = false, auto_confirm_changed_at = now(), auto_confirm_changed_by_label = 'ops'
          where clinic_id = $1`,
          [clinic.clinicId],
        ),
      );

      const insertAppointment = (columns: string, values: string) =>
        asApp(clinic.clinicId, (c) =>
          c.query(
            `insert into appointments (clinic_id, contact_id, scheduled_for${columns})
           values ($1, $2, now() + interval '30 days'${values})`,
            [clinic.clinicId, contactId],
          ),
        );
      await insertAppointment(", calendar_event_key", `, 'hold:${randomUUID()}'`);
      await insertAppointment(", calendar_event_key", `, '${randomUUID()}'`);
      for (const [columns, values, constraint] of [
        [", calendar_event_key", ", 'retell:CA123:1'", "appointments_calendar_event_key_check"],
        [", duration_minutes", ", 4", "appointments_duration_check"],
        [", duration_minutes", ", 481", "appointments_duration_check"],
        [", booking_origin", ", 'vendor'", "appointments_booking_origin_check"],
        [", calendar_write_attempts", ", -1", "appointments_calendar_write_attempts_check"],
      ] as const) {
        await expect(insertAppointment(columns, values), values).rejects.toMatchObject({
          code: "23514",
          constraint,
        });
      }
    },
    SLOW,
  );
});

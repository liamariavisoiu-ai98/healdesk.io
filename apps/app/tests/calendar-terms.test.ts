import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  getBaaTemplate,
  getCalendarElection,
  selectCalendarClause,
} from "@healdesk/catalog";
import { fakeGoogleCalendar, setGoogleFetch } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { PendingCalendarElection } from "@/db/schema";
import { signAgreement, type SignAgreementRequest } from "@/lib/agreements";
import {
  AgreementMismatchError,
  agreementInEffect,
  agreementInEffectFor,
  assertPlatformMatchesAgreement,
} from "@/lib/agreements/in-effect";
import {
  CalendarElectionError,
  planCalendarElection,
  recordAgreementTerms,
  recordCalendarElection,
  type ElectionChoice,
  type ElectionVia,
} from "@/lib/booking/elections";
import { calendarTermsFor, isDemoClinic } from "@/lib/booking/terms";
import { storeStripeIds } from "@/lib/billing/entitlements";
import { transition } from "@/lib/billing/state-machine";
import { withCredentials } from "@/lib/connections/store";
import { provisionClinic } from "@/lib/provisioning";
import { withTenant } from "@/lib/tenant";

import { asApp, futureBase, insertHold, markDemo } from "./setup/calendar-db";
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
  seedCalendarTerms,
  seedClinic,
  seedGoogleConnection,
  seedLegacyDemoClinic,
  seedPortalUser,
  type SeededClinic,
} from "./setup/factories";

/**
 * A location's calendar terms at runtime (plan C7: §2.6 to §2.9, §13.2):
 * the agreement in effect, the terms in effect, elections, and the demo
 * clinic they are tried on before the documents are released.
 *
 * drizzle/0057 holds the rules in the database and
 * tests/google-calendar-schema.test.ts attacks them there; this file proves
 * the libraries ask the same questions, answer them the same way, and do
 * what an election does after it, through the code paths production uses.
 * Every clinic, agreement and account here is synthetic.
 *
 * calendar-election/1.0.0 was released with BAA 1.3.0 (plan C19, 12 October
 * 2026), so no BAA election is a draft any more. To show what a draft does,
 * and that a release never upgrades a row recorded as one, the BAA's form
 * can be swapped here for an unreleased later version (`draft.election`),
 * which the database's list of releases (app_calendar_election_released)
 * leaves out, as it would a real one. Nothing else in the catalogue changes.
 */
const draft = vi.hoisted(() => ({ election: false }));
const DRAFT_ELECTION = "calendar-election/1.1.0-draft";
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  const asDraft = <T extends { version: string; approvedByCounsel: boolean } | undefined>(
    election: T,
  ): T =>
    election && draft.election && election.version === actual.CALENDAR_ELECTION_VERSION
      ? { ...election, version: DRAFT_ELECTION, approvedByCounsel: false }
      : election;
  return {
    ...actual,
    currentCalendarElection: () => asDraft(actual.currentCalendarElection()),
    calendarElectionFor: (version: string) => asDraft(actual.calendarElectionFor(version)),
    getCalendarElection: (version: string) =>
      version === DRAFT_ELECTION
        ? asDraft(actual.getCalendarElection(actual.CALENDAR_ELECTION_VERSION))
        : actual.getCalendarElection(version),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Each test seeds clinics, agreements and rows over many round trips; a loaded runner needs room. */
const SLOW = 90_000;

const actor = { type: "service" as const, serviceName: "calendar-terms-test" };

const COVERED: ElectionChoice = {
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
};
const NO_BAA: ElectionChoice = {
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_no_baa",
};
const PERSONAL: ElectionChoice = { bookingSystem: "google_calendar", calendarAccount: "personal" };
const MINDBODY: ElectionChoice = { bookingSystem: "mindbody", calendarAccount: "workspace_no_baa" };

const SIGNATORY = { name: "Alex Chen", title: "Office manager" };

function terms(clinicId: string) {
  return withTenant({ clinicId, actor }, (tx) => calendarTermsFor(tx));
}

function elect(
  clinicId: string,
  choice: ElectionChoice,
  via: ElectionVia,
  request?: { ipAddress?: string; userAgent?: string },
) {
  return withTenant({ clinicId, actor }, (tx) =>
    recordCalendarElection(tx, { choice, signatory: SIGNATORY, via, request }),
  );
}

/** app_calendar_write_permitted(), asked on the runtime role inside the tenant. */
function permitted(clinicId: string, forAssistant = false): Promise<boolean> {
  return asApp(clinicId, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `select app_calendar_write_permitted($1, $2) as ok`,
      [clinicId, forAssistant],
    );
    return rows[0]!.ok;
  });
}

/** A bound acceptance of a version before 1.3.0: it carries no calendar terms. */
async function bindLegacyAgreement(
  clinic: Pick<SeededClinic, "organizationId">,
  options: { version?: string; acceptedAgo?: string; boundAgo?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, $3, $4, 'BAA (synthetic)',
             '{"appliedClauses":["parties","google-calendar"],"clinicLegalName":"Radiance Synthetic LLC","effectiveDate":"2026-10-01"}'::jsonb,
             'I agree', 'Alex Chen', 'alex@radiance.test',
             now() - $5::interval, now() - $6::interval)`,
    [
      id,
      clinic.organizationId,
      options.version ?? "1.2.1",
      randomBytes(32).toString("hex"),
      options.acceptedAgo ?? "1 day",
      options.boundAgo ?? options.acceptedAgo ?? "1 day",
    ],
  );
  return id;
}

type LinkInput = {
  audience?: "recipients" | "owner";
  pendingElection?: PendingCalendarElection;
  sentTo?: string[];
};

/** One of the clinic's calendar links, as the connect flow will mint them (C8), written as the migrator in its tenant. */
async function insertCalendarLink(clinicId: string, input: LinkInput = {}): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into connection_links
         (clinic_id, token_hash, created_at, expires_at, purpose, audience, sent_to, pending_election)
       values ($1, $2, now(), now() + interval '3 days', 'calendar', $3, $4, $5::jsonb)
       returning id`,
      [
        clinicId,
        randomBytes(32),
        input.audience ?? "recipients",
        input.sentTo ?? ["front@radiance.test"],
        input.pendingElection ? JSON.stringify(input.pendingElection) : null,
      ],
    );
    return rows[0]!.id;
  });
}

/** A location of `billing`'s practice: a clinic in its organisation naming it as the billing clinic. */
async function seedLocation(billing: SeededClinic): Promise<SeededClinic> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
  );
  return { ...billing, clinicId: rows[0]!.id };
}

/** A demo clinic turned customer: the state machine's one edge out of `demo`, and Stripe ids. */
async function convertToCustomer(clinicId: string): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  await withTenant({ clinicId, actor }, async (tx) => {
    await transition(tx, "provisioning", { actor: "support", reason: "demo_converted" });
    await storeStripeIds(tx.db, clinicId, {
      customerId: `cus_demo${suffix}`,
      subscriptionId: `sub_demo${suffix}`,
    });
  });
}

async function electionRows(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      sequence: number;
      source: string;
      terms_kind: string;
      booking_system: string;
      document_released: boolean;
      owner_confirmed: boolean;
      rendered_text: string | null;
      document_hash: string;
      elected_by_label: string;
      link_sent_to: string[] | null;
      ip_address: string | null;
    }>(`select * from calendar_elections where clinic_id = $1 order by sequence`, [clinicId]);
    return rows;
  });
}

async function linkUsed(clinicId: string, linkId: string): Promise<boolean> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ used: boolean }>(
      `select used_at is not null as used from connection_links where id = $1`,
      [linkId],
    );
    return rows[0]!.used;
  });
}

async function connectionRow(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      last_error: string | null;
      account_ref: string | null;
      aad_version: number;
    }>(
      `select id, status, last_error, account_ref, aad_version
         from provider_connections where clinic_id = $1 and provider = 'google_calendar'`,
      [clinicId],
    );
    return rows[0];
  });
}

describeDb("calendar terms at runtime", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterEach(() => {
    draft.election = false;
    setGoogleFetch(undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  /* ---------------------------------------------------- the agreement in effect */

  test(
    "agreementInEffect is 0048's answer: the newest bound, unterminated acceptance by accepted_at",
    async () => {
      const clinic = await seedClinic("terms-effect");
      const other = await seedClinic("terms-effect-other");
      const inEffect = () =>
        withTenant({ clinicId: clinic.clinicId, actor }, (tx) => agreementInEffect(tx));
      const database = async () => {
        const { rows } = await getMigratorPool().query<{ agreement_id: string }>(
          `select agreement_id from app_agreement_in_effect($1)`,
          [clinic.organizationId],
        );
        return rows[0]?.agreement_id ?? null;
      };
      expect(await inEffect()).toBeNull();

      // Accepted 40 days ago and bound yesterday, against accepted 2 days ago
      // and bound 30 days ago: accepted_at decides, as it does for go-live.
      const older = await bindLegacyAgreement(clinic, {
        acceptedAgo: "40 days",
        boundAgo: "1 day",
      });
      const newer = await bindLegacyAgreement(clinic, {
        acceptedAgo: "2 days",
        boundAgo: "30 days",
      });
      const found = await inEffect();
      expect(found).toMatchObject({
        agreementId: newer,
        documentVersion: "1.2.1",
        agreementKind: "baa",
      });
      expect(found?.variables.appliedClauses).toEqual(["parties", "google-calendar"]);
      expect(found?.agreementId).toBe(await database());

      // A signature never paid for counts for nothing.
      await getMigratorPool().query(
        `insert into baa_acceptances (organization_id, document_version, document_hash, rendered_text, variables, assent_label, accepted_by_name, accepted_by_email, accepted_at)
         values (null, '1.2.1', repeat('f', 64), 'BAA', '{}'::jsonb, 'I agree', 'Alex', 'alex@radiance.test', now())`,
      );
      expect((await inEffect())?.agreementId).toBe(newer);

      // Terminated, the newer one is nobody's agreement; the older one is in effect again.
      await getMigratorPool().query(
        `update baa_acceptances set terminated_at = now() where id = $1`,
        [newer],
      );
      expect((await inEffect())?.agreementId).toBe(older);
      expect(await database()).toBe(older);

      // From a service context the organisation's agreement is found; from
      // another clinic's tenant it is not there at all.
      const { unsafeDb } = await import("@/db");
      expect((await agreementInEffectFor(unsafeDb, clinic.organizationId))?.agreementId).toBe(
        older,
      );
      expect(
        await withTenant({ clinicId: other.clinicId, actor }, (tx) =>
          agreementInEffectFor(tx.db, clinic.organizationId),
        ),
      ).toBeNull();
    },
    SLOW,
  );

  test(
    "assertPlatformMatchesAgreement asks the checkout's own comparison of the signed row",
    async () => {
      const signed = await signAgreement({
        clinicLegalName: "Radiance Synthetic LLC",
        specialty: "med-spa",
        signatoryName: "Alex Chen",
        signatoryTitle: "Owner",
        signatoryEmail: "alex@radiance-match.test",
        isCoveredEntity: false,
        attributionMode: "estimated",
        platform: "none",
        // BAA 1.3.0, the current version, reads both calendar answers.
        bookingSystem: "none",
        calendarAccount: "workspace_no_baa",
        assentLabel: BAA_ASSENT_LABEL,
        templateVersion: CURRENT_BAA_VERSION,
      });
      const purchase = {
        clinicName: "Radiance Synthetic LLC",
        specialty: "med-spa",
        platform: "none",
        isCoveredEntity: false,
        bookingSystem: "none",
        calendarAccount: "workspace_no_baa",
      } as const;
      await expect(
        assertPlatformMatchesAgreement(signed.agreementId, purchase),
      ).resolves.toBeUndefined();
      await expect(
        assertPlatformMatchesAgreement(signed.agreementId, {
          ...purchase,
          bookingSystem: "mindbody",
          platform: "mindbody",
        }),
      ).rejects.toMatchObject({
        name: "AgreementMismatchError",
        field: "agreementId",
        message: expect.stringMatching(/different booking system/),
      });
      await expect(assertPlatformMatchesAgreement(randomUUID(), purchase)).rejects.toBeInstanceOf(
        AgreementMismatchError,
      );
      await expect(assertPlatformMatchesAgreement("not-a-uuid", purchase)).rejects.toBeInstanceOf(
        AgreementMismatchError,
      );
    },
    SLOW,
  );

  /* ------------------------------------------------------- terms in effect */

  test(
    "no agreement is none; a signature before 1.3.0 needs an election; 1.3.0 gives the location set up at signing its signed terms",
    async () => {
      const bare = await seedClinic("terms-none");
      expect(await terms(bare.clinicId)).toMatchObject({
        kind: "none",
        reason: "no_agreement",
        allowsWrite: false,
      });

      const legacy = await seedClinic("terms-legacy");
      const legacyAgreement = await bindLegacyAgreement(legacy);
      expect(await terms(legacy.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "legacy_agreement",
        agreementId: legacyAgreement,
        agreementVersion: "1.2.1",
        allowsWrite: false,
        electionId: null,
      });
      // recordAgreementTerms writes nothing for it: there are no signed terms to record.
      expect(
        await withTenant({ clinicId: legacy.clinicId, actor }, (tx) =>
          recordAgreementTerms(tx, legacyAgreement),
        ),
      ).toBeNull();

      const covered = await seedClinic("terms-covered");
      const seeded = await seedCalendarTerms(covered);
      expect(await terms(covered.clinicId)).toMatchObject({
        kind: "covered",
        account: "workspace_baa",
        sync: "live",
        bookingSystem: "google_calendar",
        clauseId: "google-calendar-covered",
        source: "agreement",
        electionId: seeded.electionId,
        sequence: 1,
        documentVersion: "1.3.0",
        documentReleased: true,
        ownerConfirmed: false,
        agreementId: seeded.agreementId,
        agreementVersion: "1.3.0",
        allowsWrite: true,
        demo: false,
      });

      const oneWay = await seedClinic("terms-mindbody");
      await seedCalendarTerms(oneWay, { bookingSystem: "mindbody" });
      expect(await terms(oneWay.clinicId)).toMatchObject({
        kind: "not_used",
        sync: "manual",
        bookingSystem: "mindbody",
        clauseId: "google-calendar-not-used",
        allowsWrite: false,
      });

      const uncovered = await seedClinic("terms-personal");
      await seedCalendarTerms(uncovered, { calendarAccount: "personal" });
      expect(await terms(uncovered.clinicId)).toMatchObject({
        kind: "uncovered",
        account: "personal",
        allowsWrite: true,
      });
    },
    SLOW,
  );

  test(
    "the signed clause is the first location's: a location added later needs an election, and a terminated agreement voids both",
    async () => {
      const first = await seedClinic("terms-location");
      const agreement = await seedCalendarTerms(first);
      const location = await seedLocation(first);
      expect(await terms(location.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "location",
        agreementId: agreement.agreementId,
      });
      // Provisioning's call, made for the wrong location, is refused by the guard.
      await expect(
        withTenant({ clinicId: location.clinicId, actor }, (tx) =>
          recordAgreementTerms(tx, agreement.agreementId),
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "23514" }),
      });

      await getMigratorPool().query(
        `update baa_acceptances set terminated_at = now() where id = $1`,
        [agreement.agreementId],
      );
      expect(await terms(first.clinicId)).toMatchObject({ kind: "none", reason: "no_agreement" });
      expect(await terms(location.clinicId)).toMatchObject({
        kind: "none",
        reason: "no_agreement",
      });
    },
    SLOW,
  );

  test(
    "a location provisioned under a signature from 1.3.0 on is under its signed terms from the start, and the database reads them too (C15)",
    async () => {
      const sign = async (
        email: string,
        answers: Pick<SignAgreementRequest, "platform" | "bookingSystem" | "calendarAccount">,
        version?: string,
      ) => {
        const template = version ? getBaaTemplate(version)! : undefined;
        return signAgreement(
          {
            clinicLegalName: "Provisioned Terms LLC",
            specialty: "med-spa",
            signatoryName: "Alex Chen",
            signatoryTitle: "Owner",
            signatoryEmail: email,
            isCoveredEntity: false,
            attributionMode: "estimated",
            assentLabel: BAA_ASSENT_LABEL,
            templateVersion: template?.version ?? CURRENT_BAA_VERSION,
            ...answers,
          },
          {},
          template ? { current: template } : {},
        );
      };
      const provision = (email: string, agreementId: string) =>
        provisionClinic({
          clinicName: "Provisioned Terms LLC",
          specialty: "med-spa",
          platform: "none",
          plan: "voice-webchat-1000-1000",
          contactName: "Alex Chen",
          contactEmail: email,
          agreementId,
          idempotencyKey: `terms_${randomUUID()}`,
        });

      // Google Calendar alone, in a Workspace without Google's BAA: uncovered
      // terms. Signed as whatever is current: 1.5.0 since 14 October 2026,
      // which carries 1.3.0's calendar clauses under the same ids.
      const email = `owner-${randomUUID().slice(0, 8)}@provisioned.test`;
      const signed = await sign(email, {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_no_baa",
      });
      expect(signed.version).toBe(CURRENT_BAA_VERSION);
      const clinic = await provision(email, signed.agreementId);
      expect(await terms(clinic.clinicId)).toMatchObject({
        kind: "uncovered",
        account: "workspace_no_baa",
        sync: "live",
        bookingSystem: "google_calendar",
        clauseId: "google-calendar-uncovered",
        source: "agreement",
        sequence: 1,
        documentVersion: CURRENT_BAA_VERSION,
        documentReleased: true,
        ownerConfirmed: false,
        agreementId: signed.agreementId,
        agreementVersion: CURRENT_BAA_VERSION,
        allowsWrite: true,
        demo: false,
      });
      // The database reads the same terms: once a Workspace account is
      // connected healdesk may write there, the assistant too, with
      // Auto-confirm on by default.
      expect(await permitted(clinic.clinicId, true)).toBe(false);
      await seedGoogleConnection(clinic.clinicId, { managed: true });
      expect(await permitted(clinic.clinicId, true)).toBe(true);

      // 1.2.2 carries no calendar terms, and no location is provisioned under
      // it any more: 1.3.0 replaced it outright and is the go-live floor (12
      // October 2026), so every new location starts under signed terms. A
      // location already bound to an agreement before 1.3.0 still waits for
      // an election (`legacy_agreement`, above). Signed by its version rather
      // than as whatever is current.
      const legacyEmail = `owner-${randomUUID().slice(0, 8)}@legacy.test`;
      const legacy = await sign(legacyEmail, { platform: "none" }, "1.2.2");
      await expect(provision(legacyEmail, legacy.agreementId)).rejects.toMatchObject({
        name: "ProvisioningError",
        field: "agreementId",
        message: expect.stringContaining("Version 1.2.2 of the business associate agreement can't be used"),
      });
      // Nor under 1.3.0 or 1.4.0 since each was replaced outright (13 and 14
      // October 2026), though both carry the same calendar terms: the floor
      // is 1.5.0.
      for (const version of ["1.3.0", "1.4.0"]) {
        const replacedEmail = `owner-${randomUUID().slice(0, 8)}@replaced.test`;
        const replaced = await sign(
          replacedEmail,
          { bookingSystem: "google_calendar", calendarAccount: "workspace_no_baa" },
          version,
        );
        await expect(provision(replacedEmail, replaced.agreementId)).rejects.toMatchObject({
          name: "ProvisioningError",
          field: "agreementId",
          message: expect.stringContaining(`Version ${version} of the business associate agreement can't be used`),
        });
      }
    },
    SLOW,
  );

  test(
    "the newest row decides, and a newest row that does not count never falls back to an older one",
    async () => {
      const clinic = await seedClinic("terms-newest");
      await markDemo(clinic.clinicId);
      const signed = await seedCalendarTerms(clinic);
      expect(await terms(clinic.clinicId)).toMatchObject({ kind: "covered", sequence: 1 });

      // A draft election, which counts here because this is a demo clinic.
      draft.election = true;
      const narrowed = await elect(clinic.clinicId, MINDBODY, {
        source: "portal",
        userId: clinic.staffUserId,
      });
      expect(narrowed).toMatchObject({
        status: "recorded",
        election: { sequence: 2, kind: "not_used" },
      });
      expect(await terms(clinic.clinicId)).toMatchObject({
        kind: "not_used",
        sequence: 2,
        documentReleased: false,
        demo: true,
      });

      // No longer a demo clinic: its newest row is a draft that counts for
      // nobody else, and the signed covered terms under it do not come back.
      await convertToCustomer(clinic.clinicId);
      expect(await terms(clinic.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "draft_terms",
        agreementId: signed.agreementId,
        electionId: (narrowed as { election: { electionId: string } }).election.electionId,
        demo: false,
      });
      // And the database agrees, with a healthy Workspace connection in place.
      await seedGoogleConnection(clinic.clinicId, { managed: true });
      expect(await permitted(clinic.clinicId)).toBe(false);
    },
    SLOW,
  );

  test(
    "a demo clinic's draft terms count; once it is a customer neither the resolver nor the database counts them, and a release never upgrades them",
    async () => {
      const demo = await seedLegacyDemoClinic("terms-demo");
      expect(await withTenant({ clinicId: demo.clinicId, actor }, (tx) => isDemoClinic(tx))).toBe(
        true,
      );
      // Its agreement is 1.2.2, which carries no calendar terms.
      expect(await terms(demo.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "legacy_agreement",
        demo: true,
      });

      // Its owner, the operator's own sign-in, elects covered terms in the portal: a draft, counted.
      draft.election = true;
      const recorded = await elect(demo.clinicId, COVERED, {
        source: "portal",
        userId: demo.staffUserId,
      });
      expect(recorded).toMatchObject({
        status: "recorded",
        election: { kind: "covered", widened: true, ownerConfirmed: true, documentReleased: false },
      });
      const { connectionId } = await seedGoogleConnection(demo.clinicId, { managed: true });
      expect(await terms(demo.clinicId)).toMatchObject({
        kind: "covered",
        allowsWrite: true,
        demo: true,
      });
      expect(await permitted(demo.clinicId)).toBe(true);
      expect(connectionId).toBeTruthy();

      await convertToCustomer(demo.clinicId);
      expect(await withTenant({ clinicId: demo.clinicId, actor }, (tx) => isDemoClinic(tx))).toBe(
        false,
      );
      expect(await terms(demo.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "draft_terms",
      });
      expect(await permitted(demo.clinicId)).toBe(false);

      // The catalogue releasing the document changes nothing for a row
      // recorded as a draft: the row says what was true when it was accepted.
      draft.election = false;
      expect(getCalendarElection("calendar-election/1.0.0")?.approvedByCounsel).toBe(true);
      expect(await terms(demo.clinicId)).toMatchObject({
        kind: "needs_election",
        reason: "draft_terms",
      });
      expect(await permitted(demo.clinicId)).toBe(false);
    },
    SLOW,
  );

  /* -------------------------------------------------------------- elections */

  test(
    "an election waits for a released document, except on a demo clinic, and for an agreement",
    async () => {
      const bare = await seedClinic("elect-nothing");
      expect(
        await elect(bare.clinicId, MINDBODY, { source: "portal", userId: bare.staffUserId }),
      ).toEqual({
        status: "unavailable",
        reason: "no_agreement",
      });

      // Under a draft form, a location that is not the demo clinic records nothing.
      const legacy = await seedClinic("elect-unreleased");
      await bindLegacyAgreement(legacy);
      draft.election = true;
      expect(
        await withTenant({ clinicId: legacy.clinicId, actor }, (tx) =>
          planCalendarElection(tx, MINDBODY),
        ),
      ).toEqual({ status: "unavailable", reason: "draft_terms" });
      expect(
        await elect(legacy.clinicId, MINDBODY, { source: "portal", userId: legacy.staffUserId }),
      ).toEqual({
        status: "unavailable",
        reason: "draft_terms",
      });
      expect(await electionRows(legacy.clinicId)).toEqual([]);
      // Released (calendar-election/1.0.0, plan C19), the same election is ready.
      draft.election = false;
      expect(
        await withTenant({ clinicId: legacy.clinicId, actor }, (tx) =>
          planCalendarElection(tx, MINDBODY),
        ),
      ).toMatchObject({ status: "ready" });

      // Bad answers are refused before anything is read.
      await expect(
        elect(
          legacy.clinicId,
          { bookingSystem: "zenoti" as never, calendarAccount: "personal" },
          {
            source: "portal",
            userId: legacy.staffUserId,
          },
        ),
      ).rejects.toMatchObject({ name: "CalendarElectionError", field: "bookingSystem" });
      await expect(
        withTenant({ clinicId: legacy.clinicId, actor }, (tx) =>
          recordCalendarElection(tx, {
            choice: MINDBODY,
            signatory: { name: " " },
            via: { source: "portal", userId: legacy.staffUserId },
          }),
        ),
      ).rejects.toBeInstanceOf(CalendarElectionError);
    },
    SLOW,
  );

  test(
    "a narrowing election through a recipients link is recorded as the server rendered it, names the booking system and spends the link",
    async () => {
      const demo = await seedLegacyDemoClinic("elect-narrow");
      const link = await insertCalendarLink(demo.clinicId, { sentTo: ["front@radiance.test"] });

      const outcome = await elect(
        demo.clinicId,
        MINDBODY,
        { source: "calendar_link", linkId: link },
        { ipAddress: "203.0.113.7, 10.0.0.1", userAgent: "synthetic-browser" },
      );
      expect(outcome).toMatchObject({
        status: "recorded",
        election: {
          sequence: 1,
          source: "calendar_link",
          kind: "not_used",
          widened: false,
          ownerConfirmed: false,
          // calendar-election/1.0.0, released with BAA 1.3.0 (plan C19).
          documentReleased: true,
          erased: null,
          consumedLink: { linkId: link, audience: "recipients", sentTo: ["front@radiance.test"] },
        },
      });
      const [row] = await electionRows(demo.clinicId);
      expect(row).toMatchObject({
        source: "calendar_link",
        terms_kind: "not_used",
        booking_system: "mindbody",
        owner_confirmed: false,
        elected_by_label: "Alex Chen, Office manager",
        link_sent_to: ["front@radiance.test"],
        ip_address: "203.0.113.7",
      });
      // The stored text is the evidence, and its hash is its own.
      expect(row!.rendered_text).toContain("CALENDAR ELECTION");
      expect(row!.rendered_text).toContain("Alex Chen, Office manager");
      expect(row!.rendered_text).toContain("Mindbody");
      expect(row!.document_hash).toBe(
        createHash("sha256").update(row!.rendered_text!, "utf8").digest("hex"),
      );
      expect(await linkUsed(demo.clinicId, link)).toBe(true);

      const clinicRow = await getMigratorPool().query<{ booking_provider: string }>(
        `select booking_provider from clinics where id = $1`,
        [demo.clinicId],
      );
      expect(clinicRow.rows[0]!.booking_provider).toBe("mindbody");

      // Spent, it speaks for nobody.
      expect(
        await elect(demo.clinicId, MINDBODY, { source: "calendar_link", linkId: link }),
      ).toEqual({
        status: "link_not_usable",
      });
      // Nor does another clinic's link, or a link that is not a calendar link.
      const elsewhere = await insertCalendarLink(
        (await seedLegacyDemoClinic("elect-narrow-other")).clinicId,
      );
      expect(
        await elect(demo.clinicId, MINDBODY, { source: "calendar_link", linkId: elsewhere }),
      ).toEqual({
        status: "link_not_usable",
      });
      expect(
        await elect(demo.clinicId, MINDBODY, { source: "calendar_link", linkId: "not-a-link" }),
      ).toEqual({ status: "link_not_usable" });
      expect(await electionRows(demo.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a widening election through a recipients link records nothing and asks for the owner, whose confirm link records it unless it has changed",
    async () => {
      const demo = await seedLegacyDemoClinic("elect-widen");
      const recipients = await insertCalendarLink(demo.clinicId);

      const asked = await elect(demo.clinicId, COVERED, {
        source: "calendar_link",
        linkId: recipients,
      });
      expect(asked).toMatchObject({
        status: "owner_confirmation_required",
        kind: "covered",
        previousKind: "none",
        pending: {
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
          documentVersion: "calendar-election/1.0.0",
        },
      });
      const pending = (asked as { pending: PendingCalendarElection }).pending;
      expect(pending.documentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await electionRows(demo.clinicId)).toEqual([]);
      expect(await linkUsed(demo.clinicId, recipients)).toBe(false);
      // The plan answers the same before anyone accepts anything.
      expect(
        await withTenant({ clinicId: demo.clinicId, actor }, (tx) =>
          planCalendarElection(tx, COVERED),
        ),
      ).toMatchObject({ status: "ready", widens: true, previousKind: "none", pending });

      // A confirm link carrying something else is refused, recording nothing:
      // a tampered hash, or a choice other than the one asked about.
      const tampered = await insertCalendarLink(demo.clinicId, {
        audience: "owner",
        pendingElection: { ...pending, documentHash: "a".repeat(64) },
      });
      expect(
        await elect(demo.clinicId, COVERED, { source: "calendar_link", linkId: tampered }),
      ).toEqual({
        status: "changed",
      });
      const confirm = await insertCalendarLink(demo.clinicId, {
        audience: "owner",
        pendingElection: pending,
      });
      expect(
        await elect(demo.clinicId, NO_BAA, { source: "calendar_link", linkId: confirm }),
      ).toEqual({
        status: "changed",
      });
      expect(await electionRows(demo.clinicId)).toEqual([]);

      const confirmed = await elect(demo.clinicId, COVERED, {
        source: "calendar_link",
        linkId: confirm,
      });
      expect(confirmed).toMatchObject({
        status: "recorded",
        election: {
          kind: "covered",
          widened: true,
          ownerConfirmed: true,
          consumedLink: { audience: "owner" },
        },
      });
      expect(await terms(demo.clinicId)).toMatchObject({
        kind: "covered",
        source: "calendar_link",
      });
    },
    SLOW,
  );

  test(
    "in the portal the setting is the owner's: the owner's own sign-in widens and narrows, another member records nothing, nor does a stranger",
    async () => {
      const demo = await seedLegacyDemoClinic("elect-portal");
      const owner = { source: "portal", userId: demo.staffUserId } as const;
      expect(await elect(demo.clinicId, NO_BAA, owner)).toMatchObject({
        status: "recorded",
        election: { kind: "uncovered", widened: true, ownerConfirmed: true },
      });
      // Uncovered to covered narrows; the owner's confirmation is recorded all the same.
      expect(await elect(demo.clinicId, COVERED, owner)).toMatchObject({
        status: "recorded",
        election: { kind: "covered", widened: false, ownerConfirmed: true },
      });

      // Plan §4.1: elections in the portal are owner-only, narrowing included.
      const admin = await seedPortalUser(demo.clinicId, "admin");
      for (const choice of [MINDBODY, PERSONAL]) {
        expect(
          await elect(demo.clinicId, choice, { source: "portal", userId: admin.userId }),
        ).toEqual({
          status: "owner_only",
        });
      }
      expect(
        await elect(demo.clinicId, MINDBODY, {
          source: "portal",
          userId: `usr_stranger_${randomUUID().slice(0, 8)}`,
        }),
      ).toEqual({ status: "not_member" });

      const rows = await electionRows(demo.clinicId);
      expect(rows.map((r) => [r.sequence, r.source, r.terms_kind, r.owner_confirmed])).toEqual([
        [1, "portal", "uncovered", true],
        [2, "portal", "covered", true],
      ]);
    },
    SLOW,
  );

  test(
    "an election that ends the terms erases the Google connection and releases the holds, and nothing reaches Google",
    async () => {
      const google = fakeGoogleCalendar();
      setGoogleFetch(google.fetch);
      const demo = await seedLegacyDemoClinic("elect-erase");
      const owner = { source: "portal", userId: demo.staffUserId } as const;
      await elect(demo.clinicId, COVERED, owner);
      const { connectionId, accountRef } = await seedGoogleConnection(demo.clinicId, {
        managed: true,
        refreshToken: "synthetic-refresh-erase",
      });
      await asApp(demo.clinicId, (c) =>
        insertHold(c, demo.clinicId, { holder: "voice:call-erase", startsAt: futureBase(5) }),
      );
      expect(await permitted(demo.clinicId)).toBe(true);

      const outcome = await elect(demo.clinicId, MINDBODY, owner);
      expect(outcome).toMatchObject({
        status: "recorded",
        election: { kind: "not_used", erased: { connectionId, accountRef }, releasedHolds: 1 },
      });
      // The grant to revoke at Google after commit (plan §2.6): the token as
      // it was before the erasure sealed over it, read through an audited
      // decrypt, and in memory only.
      const grant = outcome.status === "recorded" ? outcome.election.erased?.grant : null;
      expect(grant?.refreshToken).toBe("synthetic-refresh-erase");
      expect(grant?.accountRef).toBe(accountRef);
      expect(JSON.stringify(outcome)).not.toContain("synthetic-refresh-erase");
      const decrypts = await inTenant(demo.clinicId, async (client) => {
        const { rows } = await client.query<{ purpose: string }>(
          `select metadata ->> 'purpose' as purpose from audit_log
            where clinic_id = $1 and action = 'decrypt' and resource_id = $2`,
          [demo.clinicId, connectionId],
        );
        return rows.map((row) => row.purpose);
      });
      expect(decrypts).toEqual(["election_changed"]);

      // The bag is empty, the row revoked and says why, and the account
      // reference stays for revocation by account.
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        id: connectionId,
        status: "revoked",
        last_error: "election_changed",
        account_ref: accountRef,
        aad_version: 2,
      });
      const bag = await withTenant({ clinicId: demo.clinicId, actor }, (tx) =>
        withCredentials(
          tx.db,
          { clinicId: demo.clinicId, connectionId },
          async (credentials) => credentials,
        ),
      );
      expect(bag).toEqual({});
      const holds = await inTenant(demo.clinicId, async (client) => {
        const { rows } = await client.query<{ status: string; outcome_reason: string }>(
          `select status, outcome_reason from slot_holds where clinic_id = $1`,
          [demo.clinicId],
        );
        return rows;
      });
      expect(holds).toEqual([{ status: "released", outcome_reason: "election_changed" }]);
      expect(await terms(demo.clinicId)).toMatchObject({ kind: "not_used", allowsWrite: false });
      expect(await permitted(demo.clinicId)).toBe(false);
      expect(google.requests).toEqual([]);
    },
    SLOW,
  );

  test(
    "an election keeps a connection of the account kind it names and erases one of another kind",
    async () => {
      const demo = await seedLegacyDemoClinic("elect-kind");
      const owner = { source: "portal", userId: demo.staffUserId } as const;
      await elect(demo.clinicId, COVERED, owner);
      const { connectionId } = await seedGoogleConnection(demo.clinicId, { managed: true });

      // Workspace with Google's BAA to Workspace without it: still a Workspace account.
      expect(await elect(demo.clinicId, NO_BAA, owner)).toMatchObject({
        status: "recorded",
        election: { kind: "uncovered", erased: null },
      });
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        id: connectionId,
        status: "active",
      });
      expect(await permitted(demo.clinicId)).toBe(true);

      // A personal account is not the Workspace account connected.
      expect(await elect(demo.clinicId, PERSONAL, owner)).toMatchObject({
        status: "recorded",
        election: { kind: "uncovered", erased: { connectionId } },
      });
      expect(await connectionRow(demo.clinicId)).toMatchObject({
        status: "revoked",
        last_error: "election_changed",
      });
    },
    SLOW,
  );

  test(
    "two elections racing for one number are numbered one after the other",
    async () => {
      const demo = await seedLegacyDemoClinic("elect-race");
      const owner = { source: "portal", userId: demo.staffUserId } as const;

      // A records and holds its transaction open; B's insert then waits on
      // the unique index, A commits, and B takes the next number.
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => (releaseA = resolve));
      let aInserted!: () => void;
      const aReady = new Promise<void>((resolve) => (aInserted = resolve));
      const a = withTenant({ clinicId: demo.clinicId, actor }, async (tx) => {
        const out = await recordCalendarElection(tx, {
          choice: MINDBODY,
          signatory: SIGNATORY,
          via: owner,
        });
        aInserted();
        await gate;
        return out;
      });
      await aReady;
      const b = elect(
        demo.clinicId,
        { bookingSystem: "boulevard", calendarAccount: "personal" },
        owner,
      );
      // B's insert takes number 1 too, and waits on A's uncommitted row.
      let bWaited = false;
      for (let i = 0; i < 200 && !bWaited; i += 1) {
        const { rows } = await getAppPool().query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike '%insert into "calendar_elections"%'`,
        );
        bWaited = rows[0]!.n > 0;
        if (!bWaited) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      releaseA();
      const [first, second] = await Promise.all([a, b]);
      expect(bWaited).toBe(true);
      expect(first).toMatchObject({ status: "recorded", election: { sequence: 1 } });
      expect(second).toMatchObject({ status: "recorded", election: { sequence: 2 } });
      expect(
        (await electionRows(demo.clinicId)).map((r) => [r.sequence, r.booking_system]),
      ).toEqual([
        [1, "mindbody"],
        [2, "boulevard"],
      ]);
    },
    SLOW,
  );

  test(
    "recordAgreementTerms records exactly what was signed, and refuses a record whose clause contradicts the account signed with it",
    async () => {
      const clinic = await seedClinic("terms-agreement");
      const agreementId = randomUUID();
      await getMigratorPool().query(
        `insert into baa_acceptances
           (id, organization_id, document_version, document_hash, rendered_text, variables,
            assent_label, accepted_by_name, accepted_by_email, accepted_by_title, accepted_at, bound_at)
         values ($1, $2, '1.3.0', $3, 'BAA (synthetic)',
                 '{"appliedClauses":["google-calendar-covered"],"bookingSystem":"google_calendar","calendarAccount":"personal"}'::jsonb,
                 'I agree', 'Alex Chen', 'alex@radiance.test', 'Owner', now(), now())`,
        [agreementId, clinic.organizationId, randomBytes(32).toString("hex")],
      );
      // Signed "covered" with a personal account: the record contradicts itself.
      await expect(
        withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          recordAgreementTerms(tx, agreementId),
        ),
      ).rejects.toMatchObject({ name: "CalendarElectionError", field: "agreementId" });
      expect(await electionRows(clinic.clinicId)).toEqual([]);

      const good = await seedClinic("terms-agreement-good");
      const seeded = await seedCalendarTerms(good, { calendarAccount: "workspace_no_baa" });
      const [row] = await electionRows(good.clinicId);
      expect(row).toMatchObject({
        id: seeded.electionId,
        sequence: 1,
        source: "agreement",
        terms_kind: "uncovered",
        document_released: true,
        owner_confirmed: false,
        rendered_text: null,
        elected_by_label: "Alex Chen",
      });
    },
    SLOW,
  );

  test(
    "recordAgreementTerms never refuses a signature signing accepted: one too long for the label is recorded by its name",
    async () => {
      // Signing caps the name at 120 characters and the title not at all, so
      // "name, title" can pass the label's 200. Provisioning records the terms
      // inside its own transaction (C15), where a refusal would leave a paid
      // purchase unprovisioned. 1.3.0 is not signable before its release, so
      // the acceptance is written as the migrator, as signing would store it.
      const { clauseId } = selectCalendarClause(NO_BAA);
      const signedBy = async (label: string, name: string, title: string) => {
        const clinic = await seedClinic(label);
        const agreementId = randomUUID();
        await getMigratorPool().query(
          `insert into baa_acceptances
             (id, organization_id, document_version, document_hash, rendered_text, variables,
              assent_label, accepted_by_name, accepted_by_email, accepted_by_title, accepted_at,
              bound_at)
           values ($1, $2, '1.3.0', $3, 'BAA (synthetic)', $4::jsonb,
                   'I agree', $5, 'owner@radiance.test', $6, now(), now())`,
          [
            agreementId,
            clinic.organizationId,
            randomBytes(32).toString("hex"),
            JSON.stringify({ appliedClauses: [clauseId], ...NO_BAA }),
            name,
            title,
          ],
        );
        const recorded = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          recordAgreementTerms(tx, agreementId),
        );
        expect(recorded).toMatchObject({ sequence: 1, kind: "uncovered" });
        return (await electionRows(clinic.clinicId))[0]!.elected_by_label;
      };

      const longName = `Alexandra ${"Synthetic-".repeat(11)}Chen`.slice(0, 120);
      const longTitle = `Director of ${"Synthetic Operations ".repeat(5)}`.slice(0, 100);
      expect(longName).toHaveLength(120);
      expect(longTitle).toHaveLength(100);
      expect(await signedBy("terms-long-signature", longName, longTitle)).toBe(longName);
      // One that fits keeps the signature as signed.
      expect(await signedBy("terms-fitting-signature", "Alex Chen", "Owner")).toBe(
        "Alex Chen, Owner",
      );
    },
    SLOW,
  );
});

import { createHash, randomBytes } from "node:crypto";

import { BOOKING_FIELDS, EXCLUDED_FIELDS, prepareDirectBookingAddendum } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import type { ActorContext } from "@/lib/audit";
import { consumeConnectionLink, issueConnectionLink, resolveConnectionLink } from "@/lib/connections/links";
import { readOnboarding } from "@/lib/onboarding/steps";
import {
  confirmBookingRequirementsWithin,
  directBookingOffered,
  SetupLinkSpentError,
  SetupSubmissionError,
} from "@/lib/onboarding/requirements";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The setup link (design of 23 September 2026, §A.9, §H, §J).
 *
 * The same table, token and bootstrap policy as the connect link, with a
 * purpose column between the two pages. What is attacked here is the seam:
 * a setup token presented to the credential wizard, a connect token
 * presented to the setup page, two submissions of one setup link at the same
 * instant, and a submission made as the runtime role against the 0040
 * column grants — the one a forgotten GRANT would fail.
 *
 * The addendum's approval flag is mocked per test rather than flipped in the
 * catalogue, because the catalogue's `approvedByCounsel: false` is itself the
 * thing under test in "the section is absent".
 */

const approved = vi.hoisted(() => ({ value: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: approved.value }),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor: ActorContext = { type: "service", serviceName: "test" };

async function issueSetup(clinicId: string) {
  return issueConnectionLink(clinicId, { purpose: "setup" }, { actor, request: {} });
}


/** The submission from app/setup/[token]/actions.ts, as the test can drive it. */
async function submit(clinicId: string, token: string, fields: string[], platformId = "acuity", election: { signatoryName: string; signatoryTitle: string | null } | null = null): Promise<boolean> {
  try {
    await withTenant({ clinicId, actor }, (tx) =>
      confirmBookingRequirementsWithin(tx, { token, ip: null, fields, election, clinicName: "Setup Clinic", platformId }),
    );
    return true;
  } catch (error) {
    if (error instanceof SetupLinkSpentError) return false;
    throw error;
  }
}

async function clinicRow(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    booking_requirements: string[] | null;
    booking_requirements_source: string | null;
    booking_requirements_confirmed_at: Date | null;
    booking_mode: string;
    direct_booking_elected_at: Date | null;
    direct_booking_elected_by_label: string | null;
    direct_booking_clause_version: string | null;
    direct_booking_clause_hash: Buffer | null;
  }>(
    `select booking_requirements, booking_requirements_source, booking_requirements_confirmed_at, booking_mode,
            direct_booking_elected_at, direct_booking_elected_by_label, direct_booking_clause_version, direct_booking_clause_hash
       from clinics where id = $1`,
    [clinicId],
  );
  return rows[0]!;
}

describe("the catalogue", () => {
  test("contains no EXCLUDED_FIELDS term", () => {
    // Each excluded item reduced to the word that would betray it in an id,
    // a label or an ask. A field that mentions any of these is a field that
    // exceeds the BAA's minimum-necessary clause, whatever it is called.
    const tells = ["birth", "insurance", "member", "medical", "condition", "medication", "pregnan", "breastfeed", "reason", "photo", "card", "payment", "address", "email", "heard"];
    for (const field of BOOKING_FIELDS) {
      const haystack = `${field.id} ${field.label} ${field.ask}`.toLowerCase();
      for (const tell of tells) expect(haystack, `${field.id} mentions "${tell}"`).not.toContain(tell);
    }
    expect(EXCLUDED_FIELDS.length).toBeGreaterThanOrEqual(10);
  });

  test("the Direct booking section is absent while the addendum is unapproved", () => {
    approved.value = false;
    expect(directBookingOffered("calcom")).toBe(false);
    expect(directBookingOffered("none")).toBe(false);
    approved.value = true;
    expect(directBookingOffered("calcom")).toBe(true);
    expect(directBookingOffered("none")).toBe(true);
    // Never for a platform healdesk cannot write into, approved or not.
    expect(directBookingOffered("acuity")).toBe(false);
    approved.value = false;
  });
});

describeDb("setup links", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("a setup token cannot be spent on /connect, and a connect token cannot be spent on /setup", async () => {
    const { clinicId } = await seedClinic("setup-purpose");
    const setup = await issueSetup(clinicId);
    const connect = await issueConnectionLink(clinicId, {}, { actor, request: {} });

    // Resolution: each token answers only for its own page, and the wrong
    // page gets the same null an unknown token gets.
    expect(await resolveConnectionLink(setup.token)).toBeNull();
    expect(await resolveConnectionLink(setup.token, undefined, "setup")).toMatchObject({ clinicId, specialty: "med-spa", purpose: "setup" });
    expect(await resolveConnectionLink(connect.token, undefined, "setup")).toBeNull();
    expect(await resolveConnectionLink(connect.token)).toMatchObject({ clinicId, purpose: "connect" });

    // Consumption filters on purpose too, so a route that forgot to resolve
    // still could not burn the other page's token.
    expect(await consumeConnectionLink(setup.token, null)).toBe(false);
    expect(await consumeConnectionLink(connect.token, null, "setup")).toBe(false);
    expect(await submit(clinicId, connect.token, [])).toBe(false);

    // And each is still live for its own page afterwards.
    expect(await consumeConnectionLink(setup.token, null, "setup")).toBe(true);
    expect(await consumeConnectionLink(connect.token, null)).toBe(true);

    const rows = await inTenant(clinicId, async (client) => {
      const r = await client.query<{ purpose: string; used: boolean }>(`select purpose, used_at is not null as used from connection_links where clinic_id = $1 order by purpose`, [clinicId]);
      return r.rows;
    });
    expect(rows).toEqual([{ purpose: "connect", used: true }, { purpose: "setup", used: true }]);
  });

  test("a submission as the runtime role stamps the set and the step", async () => {
    const { clinicId } = await seedClinic("setup-submit");
    const { token } = await issueSetup(clinicId);

    // withTenant runs as healdesk_app: the UPDATE below is the 0040 column
    // grant being exercised, not the migrator's table ownership.
    expect(await submit(clinicId, token, ["last_name", "service", "not_a_field"])).toBe(true);

    const row = await clinicRow(clinicId);
    // Locked four always present, catalogue order, the unknown id dropped.
    expect(row.booking_requirements).toEqual(["first_name", "phone", "preferred_window", "alternative_windows", "last_name", "service"]);
    expect(row.booking_requirements_source).toBe("practice");
    expect(row.booking_requirements_confirmed_at).not.toBeNull();
    expect(row.booking_mode).toBe("desk_confirms");
    expect(row.direct_booking_elected_at).toBeNull();

    const state = await withTenant({ clinicId, actor }, readOnboarding);
    expect(state.booking_requirements_confirmed).not.toBeNull();

    // Spent: the page would redirect, and a second submission loses the burn.
    expect(await resolveConnectionLink(token, undefined, "setup")).toBeNull();
    expect(await submit(clinicId, token, [])).toBe(false);
  });

  test("single-use under concurrent submits", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { clinicId } = await seedClinic(`setup-race-${round}`);
      const { token } = await issueSetup(clinicId);

      const results = await Promise.allSettled([
        submit(clinicId, token, ["last_name"]),
        submit(clinicId, token, ["service"]),
      ]);
      const summary = results.map((r) => (r.status === "fulfilled" ? `returned ${String(r.value)}` : `threw ${String(r.reason)}`)).join(" / ");

      expect(results.every((r) => r.status === "fulfilled"), `round ${round}: a losing submission threw — ${summary}`).toBe(true);
      const winners = results.map((r, i) => (r.status === "fulfilled" && r.value === true ? i : -1)).filter((i) => i >= 0);
      expect(winners.length, `round ${round}: expected exactly one winner, got ${summary}`).toBe(1);

      // The stored set is the winner's, and only one burn happened.
      const row = await clinicRow(clinicId);
      expect(row.booking_requirements).toContain(winners[0] === 0 ? "last_name" : "service");
      expect(row.booking_requirements).not.toContain(winners[0] === 0 ? "service" : "last_name");
      const used = await inTenant(clinicId, async (client) => {
        const r = await client.query<{ n: number }>(`select count(*)::int as n from connection_links where clinic_id = $1 and used_at is not null`, [clinicId]);
        return r.rows[0]!.n;
      });
      expect(used).toBe(1);
    }
  });

  test("the election writes the addendum hash and version", async () => {
    const { clinicId } = await seedClinic("setup-elect");
    const { token } = await issueSetup(clinicId);

    // Unapproved: the section is absent, so an election in the form is a
    // stale tab or a forged POST, and it is refused before anything burns.
    approved.value = false;
    await expect(submit(clinicId, token, [], "calcom", { signatoryName: "Dr Chen", signatoryTitle: "Owner" })).rejects.toThrow(SetupSubmissionError);
    expect(await resolveConnectionLink(token, undefined, "setup")).not.toBeNull();

    approved.value = true;
    try {
      expect(await submit(clinicId, token, ["service"], "calcom", { signatoryName: "Dr Chen", signatoryTitle: "Owner" })).toBe(true);
      const row = await clinicRow(clinicId);
      expect(row.direct_booking_elected_at).not.toBeNull();
      expect(row.direct_booking_elected_by_label).toBe("Dr Chen, Owner");
      expect(row.direct_booking_clause_version).toBe("direct-booking-addendum/1.0.0");
      // Reproducible from the catalogue text and the stored facts alone.
      const expected = prepareDirectBookingAddendum({
        clinicLegalName: "Setup Clinic",
        signatoryName: "Dr Chen",
        signatoryTitle: "Owner",
        acceptedOn: new Date(row.direct_booking_elected_at!).toISOString().slice(0, 10),
      });
      expect(row.direct_booking_clause_hash!.toString("hex")).toBe(expected.hash);
      // Electing is not switching: the mode is still the desk's until the
      // console flips it through every gate.
      expect(row.booking_mode).toBe("desk_confirms");
    } finally {
      approved.value = false;
    }
  });

  test("the CHECK refuses booking_mode='direct' without an election", async () => {
    const { clinicId } = await seedClinic("setup-check");
    await expect(
      getMigratorPool().query(`update clinics set booking_mode = 'direct' where id = $1`, [clinicId]),
    ).rejects.toMatchObject({ code: "23514" });
    // A withdrawn election is no election.
    await getMigratorPool().query(
      `update clinics set direct_booking_elected_at = now(), direct_booking_clause_hash = $2, direct_booking_clause_version = 'x', direct_booking_withdrawn_at = now() where id = $1`,
      [clinicId, createHash("sha256").update(randomBytes(8)).digest()],
    );
    await expect(
      getMigratorPool().query(`update clinics set booking_mode = 'direct' where id = $1`, [clinicId]),
    ).rejects.toMatchObject({ code: "23514" });
    await getMigratorPool().query(`update clinics set direct_booking_withdrawn_at = null where id = $1`, [clinicId]);
    await expect(getMigratorPool().query(`update clinics set booking_mode = 'direct' where id = $1`, [clinicId])).resolves.toBeTruthy();
  });
});

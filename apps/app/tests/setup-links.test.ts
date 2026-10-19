import { createHash, randomBytes } from "node:crypto";

import { BOOKING_FIELDS, EXCLUDED_FIELDS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ActorContext } from "@/lib/audit";
import { consumeConnectionLink, issueConnectionLink, resolveConnectionLink } from "@/lib/connections/links";
import { isOpName } from "@/lib/ops/api";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The setup link (design of 23 September 2026, §A.9, §H, §J), retired with
 * the setup wizard (plan C2, 14 October 2026): the wizard asks what its page
 * asked, and provisioning stamps the specialty's booking fields, so the
 * page, its email and the console's "Resend setup link" are gone and nothing
 * issues a setup link any more.
 *
 * What stays is the seam the links table keeps for the setup links issued
 * before then: a setup token presented to the credential wizard, a connect
 * token presented as a setup token. And the catalogue's own promise about
 * what a booking request may ask, and the CHECK that keeps direct booking
 * behind an election.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor: ActorContext = { type: "service", serviceName: "test" };

async function issueSetup(clinicId: string) {
  return issueConnectionLink(clinicId, { purpose: "setup" }, { actor, request: {} });
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
});

describe("the retired setup link", () => {
  test("nothing issues one any more: the console's op is gone", () => {
    expect(isOpName("issueSetupLink")).toBe(false);
    expect(isOpName("issueConnectLink")).toBe(true);
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

  test("a setup token cannot be spent on /connect, and a connect token cannot be spent as a setup token", async () => {
    const { clinicId } = await seedClinic("setup-purpose");
    const setup = await issueSetup(clinicId);
    const connect = await issueConnectionLink(clinicId, {}, { actor, request: {} });

    // Resolution: each token answers only for its own purpose, and the wrong
    // one gets the same null an unknown token gets.
    expect(await resolveConnectionLink(setup.token)).toBeNull();
    expect(await resolveConnectionLink(setup.token, undefined, "setup")).toMatchObject({ clinicId, specialty: "med-spa", purpose: "setup" });
    expect(await resolveConnectionLink(connect.token, undefined, "setup")).toBeNull();
    expect(await resolveConnectionLink(connect.token)).toMatchObject({ clinicId, purpose: "connect" });

    // Consumption filters on purpose too, so a route that forgot to resolve
    // still could not burn the other page's token.
    expect(await consumeConnectionLink(setup.token, null)).toBe(false);
    expect(await consumeConnectionLink(connect.token, null, "setup")).toBe(false);

    // And each is still live for its own purpose afterwards.
    expect(await consumeConnectionLink(setup.token, null, "setup")).toBe(true);
    expect(await consumeConnectionLink(connect.token, null)).toBe(true);

    const rows = await inTenant(clinicId, async (client) => {
      const r = await client.query<{ purpose: string; used: boolean }>(`select purpose, used_at is not null as used from connection_links where clinic_id = $1 order by purpose`, [clinicId]);
      return r.rows;
    });
    expect(rows).toEqual([{ purpose: "connect", used: true }, { purpose: "setup", used: true }]);
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

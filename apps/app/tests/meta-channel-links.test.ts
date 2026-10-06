import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ActorContext } from "@/lib/audit";
import {
  consumeConnectionLinkWithin,
  issueConnectionLink,
  resolveConnectionLink,
  type LinkPurpose,
} from "@/lib/connections/links";
import { listConnections, withCredentials } from "@/lib/connections/store";
import { attachMetaChannel, resolveMetaChannel } from "@/lib/meta/channels";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The two Meta link purposes against the real two-role database (migration
 * 0049, launch plan 1.6 and 2.5).
 *
 * What the routes rely on, and what is proved here rather than assumed:
 *
 *   - a `meta` link opens the Facebook page and nothing else, and a
 *     `whatsapp` link the WhatsApp page and nothing else;
 *   - storing the channels and burning the link in one transaction means a
 *     link buys exactly one connection: the second attempt rolls back whole;
 *   - the WhatsApp PIN is sealed with the token, and the account id sits in
 *     plain metadata where the PIN must not.
 *
 * Skips as a whole when TEST_APP_URL is unset, like every DB-backed suite.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor: ActorContext = { type: "service", serviceName: "test" };

class Spent extends Error {}

async function issue(clinicId: string, purpose: LinkPurpose) {
  return issueConnectionLink(clinicId, { purpose }, { actor, request: {} });
}

/** What the callback route does once Meta has answered: store, then burn, in one transaction. */
async function storeAndBurn(clinicId: string, token: string, purpose: LinkPurpose, pageId: string) {
  await withTenant({ clinicId, actor }, async (tx) => {
    await attachMetaChannel(tx, { platform: "messenger", externalId: pageId, accessToken: `page-token-${pageId}`, label: "Page", via: "facebook_login" });
    const burned = await consumeConnectionLinkWithin(tx, token, null, purpose);
    if (!burned) throw new Spent();
  });
}

describeDb("Meta channel links", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("a meta link opens only the Facebook page; a whatsapp link only the WhatsApp page", async () => {
    const clinic = await seedClinic("Purpose");
    const meta = await issue(clinic.clinicId, "meta");
    const whatsapp = await issue(clinic.clinicId, "whatsapp");

    expect((await resolveConnectionLink(meta.token, {}, "meta"))?.clinicId).toBe(clinic.clinicId);
    for (const other of ["whatsapp", "setup", "connect"] as const) {
      expect(await resolveConnectionLink(meta.token, {}, other)).toBeNull();
    }
    expect((await resolveConnectionLink(whatsapp.token, {}, "whatsapp"))?.clinicId).toBe(clinic.clinicId);
    expect(await resolveConnectionLink(whatsapp.token, {}, "meta")).toBeNull();
  });

  test("the database refuses a purpose nobody declared", async () => {
    const clinic = await seedClinic("Undeclared");
    // Inside the clinic's tenant, so row-level security lets the row through
    // and the only thing left to refuse it is the constraint under test.
    const insert = (purpose: string, fill: number) =>
      inTenant(clinic.clinicId, (client) =>
        client.query(
          `insert into connection_links (clinic_id, token_hash, expires_at, purpose) values ($1, $2, now() + interval '1 day', $3)`,
          [clinic.clinicId, Buffer.alloc(32, fill), purpose],
        ),
      );
    await expect(insert("channels", 7)).rejects.toThrow(/connection_links_purpose_known/);
    // And the two it now declares are accepted, so the refusal above is the CHECK, not something else.
    await expect(insert("meta", 8)).resolves.toBeDefined();
    await expect(insert("whatsapp", 9)).resolves.toBeDefined();
  });

  test("a link buys one connection: stored and burned together, and the second attempt rolls back whole", async () => {
    const clinic = await seedClinic("OneBuy");
    const { token } = await issue(clinic.clinicId, "meta");

    await storeAndBurn(clinic.clinicId, token, "meta", "700000000000001");
    expect(await resolveConnectionLink(token, {}, "meta")).toBeNull();
    expect((await resolveMetaChannel("700000000000001"))?.clinicId).toBe(clinic.clinicId);

    // A replay — the same link, a different Page — must not replace the first.
    await expect(storeAndBurn(clinic.clinicId, token, "meta", "700000000000002")).rejects.toBeInstanceOf(Spent);
    expect(await resolveMetaChannel("700000000000002")).toBeNull();
    expect((await resolveMetaChannel("700000000000001"))?.clinicId).toBe(clinic.clinicId);
  });

  test("a whatsapp link cannot be spent by the Facebook callback", async () => {
    const clinic = await seedClinic("CrossSpend");
    const { token } = await issue(clinic.clinicId, "whatsapp");
    await expect(storeAndBurn(clinic.clinicId, token, "meta", "700000000000003")).rejects.toBeInstanceOf(Spent);
    expect(await resolveMetaChannel("700000000000003")).toBeNull();
    expect((await resolveConnectionLink(token, {}, "whatsapp"))?.clinicId).toBe(clinic.clinicId);
  });

  test("the WhatsApp PIN is sealed with the token; the account id is plain metadata", async () => {
    const clinic = await seedClinic("Sealed");
    const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      attachMetaChannel(tx, {
        platform: "whatsapp",
        externalId: "109876543210987",
        accessToken: "wa-token",
        label: "+1 555 010 0199",
        secrets: { registrationPin: "135790" },
        details: { wabaId: "102030405060708" },
        via: "embedded_signup",
      }),
    );

    const [row] = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) => listConnections(tx.db, clinic.clinicId));
    expect(row?.metadata).toEqual({ wabaId: "102030405060708", externalId: "109876543210987", label: "+1 555 010 0199" });
    expect(JSON.stringify(row?.metadata)).not.toContain("135790");

    const creds = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(tx.db, { clinicId: clinic.clinicId, connectionId }, async (c) => c),
    );
    expect(creds).toEqual({ registrationPin: "135790", accessToken: "wa-token" });
  });

  test("a secret can never overwrite the token it is sealed with", async () => {
    const clinic = await seedClinic("NoOverwrite");
    const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      attachMetaChannel(tx, {
        platform: "whatsapp",
        externalId: "109876543210988",
        accessToken: "the-real-token",
        secrets: { accessToken: "an-impostor" },
      }),
    );
    const creds = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(tx.db, { clinicId: clinic.clinicId, connectionId }, async (c) => c),
    );
    expect(creds.accessToken).toBe("the-real-token");
  });
});

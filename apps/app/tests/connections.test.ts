import { randomUUID } from "node:crypto";

import { getConnectionGuide, personaliseGuide } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  listConnections,
  saveConnection,
  withCredentials,
} from "@/lib/connections/store";
import {
  CredentialValidationError,
  validateCredentials,
  verifyConnection,
} from "@/lib/connections/verify";
import { AwsKmsKeyWrapper, __setKeyWrapperForTests } from "@/lib/crypto/kms";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";
import { fakeKms, sealAsVersionOne, TEST_KEY_ARN } from "./setup/kms";

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service" as const, serviceName: "test" };

describe("credential validation", () => {
  test("requires every field the platform needs", () => {
    expect(() => validateCredentials("acuity", { userId: "123" })).toThrow(
      CredentialValidationError,
    );
  });

  test("rejects the example value pasted verbatim", () => {
    // People paste the placeholder. Catching it here saves a confused support
    // thread three weeks later when no data has arrived.
    expect(() =>
      validateCredentials("acuity", { userId: "12345678", apiKey: "abc123…" }),
    ).toThrow(/example value/i);
  });

  test("trims whitespace, which is how most pasted keys arrive", () => {
    const cleaned = validateCredentials("acuity", {
      userId: "  987654  ",
      apiKey: " realkey \n",
    });
    expect(cleaned).toEqual({ userId: "987654", apiKey: "realkey" });
  });

  test("names the offending field so the form can highlight it", () => {
    try {
      validateCredentials("acuity", { userId: "987654", apiKey: "" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CredentialValidationError).field).toBe("apiKey");
    }
  });
});

describe("connection guides", () => {
  test("never ask for the clinic owner's own login", () => {
    // Violates essentially every platform's terms, destroys the audit trail,
    // and is the request that makes a careful clinic walk away.
    for (const id of ["acuity", "mindbody", "zenoti", "vagaro", "patientnow"]) {
      const guide = getConnectionGuide(id)!;
      const text = JSON.stringify(guide).toLowerCase();
      expect(text, id).not.toMatch(/your (own )?(password|login)/);
    }
  });

  test("every guide states what the connection cannot see", () => {
    for (const id of ["acuity", "mindbody", "zenoti", "vagaro", "patientnow"]) {
      const guide = getConnectionGuide(id)!;
      expect(guide.doesNotGrant.length, id).toBeGreaterThan(0);
      // Clinical notes are the thing a clinic actually worries about.
      expect(guide.doesNotGrant.join(" ").toLowerCase(), id).toContain(
        "clinical notes",
      );
    }
  });

  test("personalising substitutes the clinic's own connect address", () => {
    const guide = personaliseGuide(getConnectionGuide("acuity")!, "radiance-spa");
    const copyables = guide.steps.map((s) => s.copyable).filter(Boolean);

    expect(copyables).toContain("connect+radiance-spa@healdesk.io");
    expect(JSON.stringify(guide)).not.toContain("{connectEmail}");
  });

  test("platforms with known gaps say so in the guide, not in a footnote", () => {
    // Acuity has no arrival concept; Vagaro cannot supply sales history. Both
    // must reach the clinic before they connect, not after the first report.
    expect(
      getConnectionGuide("acuity")!.doesNotGrant.join(" "),
    ).toMatch(/arriv/i);
    expect(getConnectionGuide("vagaro")!.doesNotGrant.join(" ")).toMatch(
      /before you connect/i,
    );
  });

  test("Mindbody's guide routes around the API deliberately", () => {
    const guide = getConnectionGuide("mindbody")!;
    expect(guide.doesNotGrant.join(" ")).toMatch(/developer API/i);
    expect(guide.doesNotGrant.join(" ")).toMatch(/terms prohibit/i);
  });
});

describe("verification read-back", () => {
  test("reports capabilities honestly per platform", async () => {
    const acuity = await verifyConnection({
      platformId: "acuity",
      credentials: { userId: "1", apiKey: "k" },
    });
    // Acuity genuinely cannot tell us whether someone arrived.
    expect(acuity.capabilities.arrival).toBe(false);

    const zenoti = await verifyConnection({
      platformId: "zenoti",
      credentials: { apiKey: "k", centerId: "c" },
    });
    expect(zenoti.capabilities.arrival).toBe(true);
    expect(zenoti.capabilities.revenue).toBe(true);
  });

  test("never claims write-back, which is deferred", async () => {
    for (const id of ["acuity", "zenoti", "vagaro"]) {
      const result = await verifyConnection({
        platformId: id,
        credentials: {},
      });
      expect(result.capabilities.writeback, id).toBe(false);
    }
  });

  test("admits it has not actually called the platform yet", async () => {
    // A wizard that says "verified" without verifying is worse than one that
    // says "saved, not yet checked" — the first is discovered at month end.
    const result = await verifyConnection({
      platformId: "acuity",
      credentials: { userId: "1", apiKey: "k" },
    });
    expect(result.unverifiedReason).toMatch(/haven't called/i);
  });
});

describeDb("connection storage", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterEach(() => {
    __setKeyWrapperForTests(undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  /** The clinic's client number, as the database issued it. */
  async function clientNumberOf(clinicId: string): Promise<number> {
    const result = await getMigratorPool().query<{ client_number: number }>(
      "select client_number from clinics where id = $1",
      [clinicId],
    );
    return result.rows[0]!.client_number;
  }

  /** Copy a sealed row's envelope into a new row: the clinic and provider are the copy's own. */
  async function copyEnvelope(
    from: { clinicId: string; connectionId: string },
    to: { clinicId: string; provider: string },
  ): Promise<string> {
    const row = await inTenant(from.clinicId, async (client) => {
      const result = await client.query<Record<string, string>>(
        `select ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version
           from provider_connections where id = $1`,
        [from.connectionId],
      );
      return result.rows[0]!;
    });
    return inTenant(to.clinicId, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, $2, 'active', $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          to.clinicId,
          to.provider,
          row.ciphertext,
          row.iv,
          row.auth_tag,
          row.wrapped_dek,
          row.key_version,
          row.aad_version,
        ],
      );
      return result.rows[0]!.id;
    });
  }

  test("stores credentials encrypted and returns them only to a callback", async () => {
    const clinic = await seedClinic("conn-a");

    const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: clinic.clinicId,
        provider: "acuity",
        credentials: { userId: "987654", apiKey: "super-secret-key" },
      }),
    );

    // Nothing readable in the row itself. Read inside the tenant: this table
    // is FORCE ROW LEVEL SECURITY, so even the owner sees nothing without one.
    const stored = await inTenant(clinic.clinicId, async (client) => {
      const result = await client.query<{ ciphertext: string }>(
        `select ciphertext from provider_connections where id = $1`,
        [connectionId],
      );
      return result.rows[0]!;
    });
    expect(stored.ciphertext).not.toContain("super-secret-key");

    // And the summary never carries them either.
    const summaries = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      listConnections(tx.db, clinic.clinicId),
    );
    expect(JSON.stringify(summaries)).not.toContain("super-secret-key");

    const recovered = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(
        tx.db,
        { clinicId: clinic.clinicId, connectionId },
        async (creds) => creds.apiKey,
      ),
    );
    expect(recovered).toBe("super-secret-key");
  });

  test("another clinic cannot open the ciphertext, even holding the row", async () => {
    // Every field needed to decrypt travels with the row, so without a binding
    // copying it across tenants would just work. Two refuse it. The data key
    // is locked to the owner's client number, which the attacker's clinic does
    // not have, so the key is not released: that is what answers first, and on
    // AWS it is KMS answering. Behind it, the AAD is bound to {clinicId,
    // credentialId} (tests/envelope.test.ts).
    const owner = await seedClinic("conn-owner");
    const attacker = await seedClinic("conn-attacker");

    const connectionId = await withTenant({ clinicId: owner.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: owner.clinicId,
        provider: "zenoti",
        credentials: { apiKey: "owner-key", centerId: "c1" },
      }),
    );

    // Physically copy the row into the attacker's clinic, as a compromised
    // process with SQL write access could. Two steps, because a single
    // INSERT..SELECT cannot span two tenants — RLS would filter the SELECT half
    // to nothing, which is itself the isolation working.
    const row = await inTenant(owner.clinicId, async (client) => {
      const result = await client.query<Record<string, string>>(
        `select provider, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version
           from provider_connections where id = $1`,
        [connectionId],
      );
      return result.rows[0]!;
    });

    const stolenId = await inTenant(attacker.clinicId, async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, $2, 'active', $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          attacker.clinicId,
          row.provider,
          row.ciphertext,
          row.iv,
          row.auth_tag,
          row.wrapped_dek,
          row.key_version,
          row.aad_version,
        ],
      );
      return result.rows[0]!.id;
    });

    await expect(
      withTenant({ clinicId: attacker.clinicId, actor }, (tx) =>
        withCredentials(
          tx.db,
          { clinicId: attacker.clinicId, connectionId: stolenId },
          async (creds) => creds.apiKey,
        ),
      ),
    ).rejects.toThrow(/not wrapped under this key and lock label/);
  });

  test("re-saving replaces rather than duplicating", async () => {
    const clinic = await seedClinic("conn-b");

    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: clinic.clinicId,
        provider: "acuity",
        credentials: { userId: "1", apiKey: "first" },
      }),
    );
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: clinic.clinicId,
        provider: "acuity",
        credentials: { userId: "1", apiKey: "second" },
      }),
    );

    const summaries = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      listConnections(tx.db, clinic.clinicId),
    );
    expect(summaries).toHaveLength(1);

    const value = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(
        tx.db,
        { clinicId: clinic.clinicId, connectionId: summaries[0]!.id },
        async (creds) => creds.apiKey,
      ),
    );
    expect(value).toBe("second");
  });

  test("each credential is locked to its clinic's client number and its own provider, read from the database", async () => {
    const clinic = await seedClinic("conn-label");
    const context = {
      "healdesk:clinic": String(await clientNumberOf(clinic.clinicId)),
      "healdesk:login": "google_calendar",
    };
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

    const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: clinic.clinicId,
        provider: "google_calendar",
        credentials: { refresh_token: "a-synthetic-refresh-token" },
      }),
    );
    const opened = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(
        tx.db,
        { clinicId: clinic.clinicId, connectionId },
        async (creds) => creds.refresh_token,
      ),
    );

    expect(opened).toBe("a-synthetic-refresh-token");
    expect(kms.calls).toEqual([
      {
        command: "GenerateDataKey",
        keyId: TEST_KEY_ARN,
        keySpec: "AES_256",
        encryptionContext: context,
      },
      { command: "Decrypt", keyId: TEST_KEY_ARN, encryptionContext: context },
    ]);

    const stored = await inTenant(clinic.clinicId, async (client) => {
      const result = await client.query<{ aad_version: number }>(
        "select aad_version from provider_connections where id = $1",
        [connectionId],
      );
      return result.rows[0]!;
    });
    expect(stored.aad_version).toBe(2);
  });

  test("moved within one clinic to another provider's row, a credential is refused by the label the row derives", async () => {
    const clinic = await seedClinic("conn-move");
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

    const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      saveConnection(tx.db, {
        clinicId: clinic.clinicId,
        provider: "google_calendar",
        credentials: { refresh_token: "a-synthetic-refresh-token" },
      }),
    );
    const movedId = await copyEnvelope(
      { clinicId: clinic.clinicId, connectionId },
      { clinicId: clinic.clinicId, provider: "meta-whatsapp" },
    );

    await expect(
      withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        withCredentials(
          tx.db,
          { clinicId: clinic.clinicId, connectionId: movedId },
          async (creds) => creds.refresh_token,
        ),
      ),
    ).rejects.toMatchObject({ name: "InvalidCiphertextException" });

    // The label was the moved row's own, not the one the envelope was sealed under.
    expect(kms.calls.at(-1)).toEqual({
      command: "Decrypt",
      keyId: TEST_KEY_ARN,
      encryptionContext: {
        "healdesk:clinic": String(await clientNumberOf(clinic.clinicId)),
        "healdesk:login": "meta-whatsapp",
      },
    });
  });

  test("a credential sealed before lock labels still opens", async () => {
    const clinic = await seedClinic("conn-v1");
    const id = randomUUID();
    const sealed = await sealAsVersionOne(
      JSON.stringify({ apiKey: "sealed-before-labels" }),
      { clinicId: clinic.clinicId, credentialId: id },
      { kekBase64: process.env.HEALDESK_LOCAL_KEK! },
    );

    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into provider_connections
           (id, clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, $2, 'acuity', 'active', $3, $4, $5, $6, $7, $8)`,
        [
          id,
          clinic.clinicId,
          sealed.ciphertext,
          sealed.iv,
          sealed.authTag,
          sealed.wrappedDek,
          sealed.keyVersion,
          sealed.aadVersion,
        ],
      ),
    );

    const value = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      withCredentials(
        tx.db,
        { clinicId: clinic.clinicId, connectionId: id },
        async (creds) => creds.apiKey,
      ),
    );
    expect(value).toBe("sealed-before-labels");
  });

  test("a clinic other than the transaction's own seals nothing", async () => {
    const mine = await seedClinic("conn-mine");
    const theirs = await seedClinic("conn-theirs");

    await expect(
      withTenant({ clinicId: mine.clinicId, actor }, (tx) =>
        saveConnection(tx.db, {
          clinicId: theirs.clinicId,
          provider: "acuity",
          credentials: { userId: "1", apiKey: "k" },
        }),
      ),
    ).rejects.toThrow(/Clinic not found/);
  });
});

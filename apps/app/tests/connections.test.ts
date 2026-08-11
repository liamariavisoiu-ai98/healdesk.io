import { getConnectionGuide, personaliseGuide } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

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

  afterAll(async () => {
    await closePools();
  });

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
    // The AAD is bound to {clinicId, credentialId}. Without it, every field
    // needed to decrypt travels with the row, so copying it across tenants
    // would just work.
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
    ).rejects.toThrow(/authentication tag mismatch/);
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
});

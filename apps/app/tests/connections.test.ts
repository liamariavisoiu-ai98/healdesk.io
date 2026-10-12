import { createHash, randomUUID } from "node:crypto";

import { getConnectionGuide, personaliseGuide } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  calendarBreakOf,
  googleCalendarConnection,
  markCalendarBroken,
  markCalendarBrokenWithin,
} from "@/lib/connections/google-calendar";
import { calendarRecipients, ownerRecipients } from "@/lib/connections/recipients";
import {
  eraseCredentials,
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

import { asApp, futureBase, insertHold } from "./setup/calendar-db";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedGoogleConnection, seedPortalUser } from "./setup/factories";
import { fakeKms, sealAsVersionOne, TEST_KEY_ARN } from "./setup/kms";

/**
 * What the connection's breakage tells the clinic and ops, captured. The
 * clinic's email is the funnel's notifyCalendarState (a seam until its M3),
 * asked here whether the alert it is sent for is already claimed in the
 * transaction it was given, and not yet outside it: the addendum's "in the
 * SAME transaction that claims broken_alerted_at".
 */
const notices = vi.hoisted(() => ({
  calendar: [] as {
    clinicId: string;
    state: string;
    dedupeKey: string;
    claimedInside: boolean;
    claimedOutside: boolean;
  }[],
  ops: [] as { event: string; fields: Record<string, unknown> }[],
}));
vi.mock("@/lib/notices/calendar-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notices/calendar-state")>();
  return {
    ...actual,
    notifyCalendarState: async (
      tx: import("@/db").Transaction,
      clinicId: string,
      state: "stopped" | "reconnected",
      opts: { dedupeKey: string },
    ) => {
      const { sql } = await import("drizzle-orm");
      const { inTenant: outside } = await import("./setup/factories");
      const inside = await tx.execute<{ claimed: boolean }>(
        sql`select broken_alerted_at is not null as claimed
              from provider_connections
             where clinic_id = ${clinicId}::uuid and provider = 'google_calendar'`,
      );
      const committed = await outside(clinicId, async (client) => {
        const result = await client.query<{ claimed: boolean }>(
          `select broken_alerted_at is not null as claimed
             from provider_connections
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinicId],
        );
        return result.rows;
      });
      notices.calendar.push({
        clinicId,
        state,
        dedupeKey: opts.dedupeKey,
        claimedInside: inside.rows[0]?.claimed === true,
        claimedOutside: committed[0]?.claimed === true,
      });
    },
  };
});
vi.mock("@/lib/ops/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/notify")>();
  return {
    ...actual,
    notifyOps: async (event: string, fields: Record<string, unknown>) => {
      notices.ops.push({ event, fields });
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service" as const, serviceName: "test" };

/** The calendar suites below seed and seal over many round trips; a loaded runner needs room. */
const SLOW = 60_000;

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

describeDb("re-saving and erasing a credential", () => {
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

  const accountRefOf = (label: string) =>
    createHash("sha256").update(`google:${label}`).digest("hex");

  async function rowOf(clinicId: string, connectionId: string) {
    return inTenant(clinicId, async (client) => {
      const result = await client.query<{
        status: string;
        phi_basis: string | null;
        account_ref: string | null;
        last_error: string | null;
        ciphertext: string;
        aad_version: number;
      }>(
        `select status, phi_basis, account_ref, last_error, ciphertext, aad_version
           from provider_connections where id = $1`,
        [connectionId],
      );
      return result.rows[0]!;
    });
  }

  test(
    "every save clears the PHI basis, and records the account reference it is given and no other",
    async () => {
      // A basis is recorded for one vendor account. A re-save may be another
      // account's credential, which nobody has looked at (plan §4.8).
      const clinic = await seedClinic("resave-basis");
      const save = (accountRef?: string) =>
        withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          saveConnection(tx.db, {
            clinicId: clinic.clinicId,
            provider: "fixture",
            credentials: { apiKey: "fx-key" },
            ...(accountRef ? { accountRef } : {}),
          }),
        );
      const connectionId = await save(accountRefOf("first"));
      expect(await rowOf(clinic.clinicId, connectionId)).toMatchObject({
        phi_basis: null,
        account_ref: accountRefOf("first"),
      });

      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `update provider_connections set phi_basis = 'practice_account' where id = $1`,
          [connectionId],
        ),
      );
      expect(await save()).toBe(connectionId);
      expect(await rowOf(clinic.clinicId, connectionId)).toMatchObject({
        phi_basis: null,
        account_ref: null,
      });
    },
    SLOW,
  );

  test(
    "eraseCredentials seals an empty bag under the row's own label, revokes the row and keeps its account",
    async () => {
      const clinic = await seedClinic("erase");
      const accountRef = accountRefOf("erase");
      const connectionId = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        saveConnection(tx.db, {
          clinicId: clinic.clinicId,
          provider: "google_calendar",
          credentials: { refresh_token: "synthetic-refresh-erase" },
          accountRef,
        }),
      );
      const before = await rowOf(clinic.clinicId, connectionId);

      const kms = fakeKms();
      __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          eraseCredentials(tx.db, { clinicId: clinic.clinicId, connectionId, reason: "clinic" }),
        ),
      ).toBe(true);
      // Sealed afresh, under the clinic's client number and the row's provider.
      const { rows } = await getMigratorPool().query<{ client_number: number }>(
        "select client_number from clinics where id = $1",
        [clinic.clinicId],
      );
      expect(kms.calls).toEqual([
        {
          command: "GenerateDataKey",
          keyId: TEST_KEY_ARN,
          keySpec: "AES_256",
          encryptionContext: {
            "healdesk:clinic": String(rows[0]!.client_number),
            "healdesk:login": "google_calendar",
          },
        },
      ]);

      const after = await rowOf(clinic.clinicId, connectionId);
      expect(after).toMatchObject({
        status: "revoked",
        last_error: "clinic",
        account_ref: accountRef,
        phi_basis: null,
        aad_version: 2,
      });
      expect(after.ciphertext).not.toBe(before.ciphertext);
      const bag = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        withCredentials(
          tx.db,
          { clinicId: clinic.clinicId, connectionId },
          async (credentials) => credentials,
        ),
      );
      expect(bag).toEqual({});

      // Nothing to erase on a row that is not there, or not this clinic's;
      // and the reason is a code, never free text.
      const other = await seedClinic("erase-other");
      for (const [clinicId, id] of [
        [clinic.clinicId, "00000000-0000-4000-8000-000000000000"],
        [other.clinicId, connectionId],
      ] as const) {
        expect(
          await withTenant({ clinicId, actor }, (tx) =>
            eraseCredentials(tx.db, { clinicId, connectionId: id, reason: "clinic" }),
          ),
        ).toBe(false);
      }
      await expect(
        withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          eraseCredentials(tx.db, {
            clinicId: clinic.clinicId,
            connectionId,
            reason: "The clinic asked us on the phone",
          }),
        ),
      ).rejects.toThrow(/short code/);
    },
    SLOW,
  );
});

describe("which failures break a calendar connection", () => {
  test("only Google's definitive answers, each named as the adapter names it", () => {
    for (const reason of [
      "invalid_grant",
      "admin_policy_enforced",
      "scope_lost",
      "access_denied",
      "insufficient_permissions",
    ]) {
      expect(calendarBreakOf({ code: "unauthorised", reason }), reason).toBe(reason);
    }
    expect(calendarBreakOf({ code: "misconfigured", reason: "calendar_not_found" })).toBe(
      "calendar_not_found",
    );
    // Ours, the same for every clinic: never a reason to take one clinic's token.
    expect(calendarBreakOf({ code: "misconfigured", reason: "oauth_client" })).toBeNull();
    expect(calendarBreakOf({ code: "misconfigured", reason: "api_disabled" })).toBeNull();
    // Transient: never a flip on one miss.
    for (const error of [
      { code: "unavailable", reason: "timeout" },
      { code: "unavailable", reason: "unconfirmed" },
      { code: "rate_limited", reason: "rateLimitExceeded" },
      { code: "unauthorised" },
      { code: "unauthorised", reason: "calendar_not_found" },
    ]) {
      expect(calendarBreakOf(error), JSON.stringify(error)).toBeNull();
    }
    expect(calendarBreakOf(null)).toBeNull();
  });
});

describeDb("a broken calendar connection", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    notices.calendar.length = 0;
    notices.ops.length = 0;
  });

  afterAll(async () => {
    await closePools();
  });

  async function connection(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const result = await client.query<{
        id: string;
        status: string;
        last_error: string | null;
        account_ref: string | null;
        broken_at: Date | null;
        broken_alerted_at: Date | null;
      }>(
        `select id, status, last_error, account_ref, broken_at, broken_alerted_at
           from provider_connections where clinic_id = $1 and provider = 'google_calendar'`,
        [clinicId],
      );
      return result.rows[0]!;
    });
  }

  async function holdsOf(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const result = await client.query<{ status: string; outcome_reason: string | null }>(
        `select status, outcome_reason from slot_holds where clinic_id = $1`,
        [clinicId],
      );
      return result.rows;
    });
  }

  async function securityEvents(connectionId: string): Promise<number> {
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from security_events
        where event = 'calendar_broken' and metadata ->> 'connectionId' = $1`,
      [connectionId],
    );
    return rows[0]!.n;
  }

  /** The stored token, opened as a caller would open it. */
  function bagOf(clinicId: string, connectionId: string) {
    return withTenant({ clinicId, actor }, (tx) =>
      withCredentials(tx.db, { clinicId, connectionId }, async (bag) => bag),
    );
  }

  /** The credential version of the row as it is now, as googleCalendarConnection reads it. */
  async function versionNow(clinicId: string): Promise<string> {
    const row = await withTenant({ clinicId, actor }, (tx) => googleCalendarConnection(tx));
    return row!.credentialVersion;
  }

  /** The purposes of the audited decrypts of one credential. */
  async function decryptPurposes(clinicId: string, connectionId: string): Promise<unknown[]> {
    return inTenant(clinicId, async (client) => {
      const result = await client.query<{ purpose: unknown }>(
        `select metadata ->> 'purpose' as purpose from audit_log
          where clinic_id = $1 and action = 'decrypt' and resource_type = 'credential'
            and resource_id = $2
          order by occurred_at`,
        [clinicId, connectionId],
      );
      return result.rows.map((row) => row.purpose);
    });
  }

  test(
    "access removed at Google erases the token, revokes the row and releases the holds, and tells the clinic and ops once",
    async () => {
      const clinic = await seedClinic("broken-token");
      const { connectionId, accountRef, credentialVersion } = await seedGoogleConnection(
        clinic.clinicId,
        { refreshToken: "synthetic-refresh-broken" },
      );
      await asApp(clinic.clinicId, (c) =>
        insertHold(c, clinic.clinicId, { holder: "voice:call-broken", startsAt: futureBase(4) }),
      );

      const first = await markCalendarBroken(clinic.clinicId, {
        code: "invalid_grant",
        connectionId,
        credentialVersion,
      });
      // An invalid_grant token is dead at Google already: nothing to revoke, so
      // nothing read before it was erased.
      expect(first).toEqual({
        status: "broken",
        connectionId,
        code: "invalid_grant",
        erased: true,
        firstBreak: true,
        releasedHolds: 1,
        grant: null,
      });
      expect(await decryptPurposes(clinic.clinicId, connectionId)).toEqual([]);
      const row = await connection(clinic.clinicId);
      expect(row).toMatchObject({
        status: "revoked",
        last_error: "invalid_grant",
        account_ref: accountRef,
      });
      expect(row.broken_at).toBeInstanceOf(Date);
      expect(row.broken_alerted_at).toBeInstanceOf(Date);
      expect(await bagOf(clinic.clinicId, connectionId)).toEqual({});
      expect(await holdsOf(clinic.clinicId)).toEqual([
        { status: "released", outcome_reason: "calendar_broken" },
      ]);

      // The clinic, in the transaction that claimed the alert, keyed by the episode.
      expect(notices.calendar).toEqual([
        {
          clinicId: clinic.clinicId,
          state: "stopped",
          dedupeKey: `calendar-stopped:${connectionId}:${row.broken_at!.getTime()}`,
          claimedInside: true,
          claimedOutside: false,
        },
      ]);
      // Ops, after commit; and the security event.
      expect(notices.ops).toEqual([
        {
          event: "calendar_broken",
          fields: { clinicId: clinic.clinicId, connectionId, code: "invalid_grant" },
        },
      ]);
      expect(await securityEvents(connectionId)).toBe(1);

      // The watch, which read the token before the booking path erased it,
      // reports the same a moment later: about a token no longer held, so
      // nothing changes and nobody is told twice.
      expect(
        await markCalendarBroken(clinic.clinicId, {
          code: "invalid_grant",
          connectionId,
          credentialVersion,
        }),
      ).toEqual({ status: "stale" });
      // Asked of the row as it is now, it is broken already: nothing more to do.
      const again = await markCalendarBroken(clinic.clinicId, {
        code: "invalid_grant",
        connectionId,
        credentialVersion: await versionNow(clinic.clinicId),
      });
      expect(again).toMatchObject({
        status: "broken",
        erased: false,
        firstBreak: false,
        releasedHolds: 0,
        grant: null,
      });
      expect((await connection(clinic.clinicId)).broken_at!.getTime()).toBe(
        row.broken_at!.getTime(),
      );
      expect(notices.calendar).toHaveLength(1);
      expect(notices.ops).toHaveLength(1);
      expect(await securityEvents(connectionId)).toBe(1);
    },
    SLOW,
  );

  test(
    "a calendar that refuses healdesk keeps the token, puts the row in error, and a later loss of the grant erases it within the same episode, keeping the token for revoking at Google",
    async () => {
      const clinic = await seedClinic("broken-calendar");
      const { connectionId, accountRef, credentialVersion } = await seedGoogleConnection(
        clinic.clinicId,
        { refreshToken: "synthetic-refresh-calendar" },
      );

      const first = await markCalendarBroken(clinic.clinicId, {
        code: "insufficient_permissions",
        connectionId,
        credentialVersion,
      });
      expect(first).toMatchObject({
        status: "broken",
        erased: false,
        firstBreak: true,
        grant: null,
      });
      const broken = await connection(clinic.clinicId);
      expect(broken).toMatchObject({ status: "error", last_error: "insufficient_permissions" });
      expect(await bagOf(clinic.clinicId, connectionId)).toEqual({
        refresh_token: "synthetic-refresh-calendar",
      });
      expect(notices.calendar).toHaveLength(1);

      // The token is kept, so its version is too.
      const later = await markCalendarBroken(clinic.clinicId, {
        code: "scope_lost",
        connectionId,
        credentialVersion,
      });
      expect(later).toMatchObject({ status: "broken", erased: true, firstBreak: false });
      const erased = await connection(clinic.clinicId);
      expect(erased).toMatchObject({ status: "revoked", last_error: "scope_lost" });
      expect(erased.broken_at!.getTime()).toBe(broken.broken_at!.getTime());
      expect(notices.calendar).toHaveLength(1);
      expect(notices.ops).toHaveLength(1);

      // The grant Google still holds: its token as it was before the erasure,
      // read through an audited decrypt, while the row now opens to nothing.
      // In memory only: the result serialises without it.
      const grant = later.status === "broken" ? later.grant : null;
      expect(grant?.refreshToken).toBe("synthetic-refresh-calendar");
      expect(grant?.accountRef).toBe(accountRef);
      expect(await bagOf(clinic.clinicId, connectionId)).toEqual({});
      expect(await decryptPurposes(clinic.clinicId, connectionId)).toEqual(["calendar_broken"]);
      expect(JSON.stringify(later)).not.toContain("synthetic-refresh-calendar");
      expect(JSON.parse(JSON.stringify(later)).grant).toEqual({ accountRef });
    },
    SLOW,
  );

  test(
    "Google's answer about a token the location has since replaced changes nothing, whether it reconnected another account or the same one",
    async () => {
      const clinic = await seedClinic("broken-stale");
      const old = await seedGoogleConnection(clinic.clinicId, {
        refreshToken: "synthetic-refresh-old",
      });
      await asApp(clinic.clinicId, (c) =>
        insertHold(c, clinic.clinicId, { holder: "voice:call-stale", startsAt: futureBase(6) }),
      );

      // While Google was being asked about the old token, the owner switched
      // to another account: the same row, a new token, a new account.
      const other = await seedGoogleConnection(clinic.clinicId, {
        refreshToken: "synthetic-refresh-other",
      });
      expect(other.connectionId).toBe(old.connectionId);
      expect(other.accountRef).not.toBe(old.accountRef);
      expect(
        await markCalendarBroken(clinic.clinicId, {
          code: "invalid_grant",
          connectionId: old.connectionId,
          credentialVersion: old.credentialVersion,
        }),
      ).toEqual({ status: "stale" });
      const kept = {
        id: old.connectionId,
        status: "active",
        last_error: null,
        account_ref: other.accountRef,
        broken_at: null,
        broken_alerted_at: null,
      };
      expect(await connection(clinic.clinicId)).toEqual(kept);
      expect(await bagOf(clinic.clinicId, old.connectionId)).toEqual({
        refresh_token: "synthetic-refresh-other",
      });

      // Removing access and connecting the same account again is a new token
      // all the same: an answer about the token before it is stale too.
      const again = await seedGoogleConnection(clinic.clinicId, {
        accountRef: other.accountRef,
        refreshToken: "synthetic-refresh-again",
      });
      expect(
        await markCalendarBroken(clinic.clinicId, {
          code: "scope_lost",
          connectionId: old.connectionId,
          credentialVersion: other.credentialVersion,
        }),
      ).toEqual({ status: "stale" });
      expect(await connection(clinic.clinicId)).toEqual(kept);
      expect(await bagOf(clinic.clinicId, old.connectionId)).toEqual({
        refresh_token: "synthetic-refresh-again",
      });
      expect(again.credentialVersion).not.toBe(other.credentialVersion);

      expect(await holdsOf(clinic.clinicId)).toEqual([{ status: "held", outcome_reason: null }]);
      expect(await decryptPurposes(clinic.clinicId, old.connectionId)).toEqual([]);
      expect(notices.calendar).toEqual([]);
      expect(notices.ops).toEqual([]);
      expect(await securityEvents(old.connectionId)).toBe(0);
    },
    SLOW,
  );

  test(
    "nothing is broken where there is no connection, another connection is named, or the clinic took the access away itself",
    async () => {
      const bare = await seedClinic("broken-none");
      expect(
        await markCalendarBroken(bare.clinicId, {
          code: "invalid_grant",
          connectionId: "00000000-0000-4000-8000-000000000000",
          credentialVersion: "none",
        }),
      ).toEqual({ status: "not_connected" });

      const named = await seedClinic("broken-named");
      const live = await seedGoogleConnection(named.clinicId);
      expect(
        await markCalendarBroken(named.clinicId, {
          code: "invalid_grant",
          connectionId: "00000000-0000-4000-8000-000000000000",
          credentialVersion: live.credentialVersion,
        }),
      ).toEqual({ status: "not_connected" });
      expect((await connection(named.clinicId)).status).toBe("active");

      const disconnected = await seedClinic("broken-disconnected");
      const { connectionId, credentialVersion } = await seedGoogleConnection(disconnected.clinicId);
      await withTenant({ clinicId: disconnected.clinicId, actor }, (tx) =>
        eraseCredentials(tx.db, {
          clinicId: disconnected.clinicId,
          connectionId,
          reason: "clinic",
        }),
      );
      for (const version of [credentialVersion, await versionNow(disconnected.clinicId)]) {
        expect(
          await markCalendarBroken(disconnected.clinicId, {
            code: "invalid_grant",
            connectionId,
            credentialVersion: version,
          }),
        ).toEqual({ status: "not_connected" });
      }
      expect(await connection(disconnected.clinicId)).toMatchObject({
        status: "revoked",
        last_error: "clinic",
        broken_at: null,
      });

      // Only a definitive break is one.
      await expect(
        withTenant({ clinicId: named.clinicId, actor }, (tx) =>
          markCalendarBrokenWithin(tx, {
            code: "timeout" as never,
            connectionId: live.connectionId,
            credentialVersion: live.credentialVersion,
          }),
        ),
      ).rejects.toThrow(/Not a definitive calendar break/);
      expect(notices.calendar).toEqual([]);
      expect(notices.ops).toEqual([]);
    },
    SLOW,
  );
});

describeDb("who receives a location's calendar mail", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  const recipients = (clinicId: string) =>
    withTenant({ clinicId, actor }, async (tx) => ({
      calendar: await calendarRecipients(tx),
      owner: await ownerRecipients(tx),
    }));

  test(
    "the clinic's one address, its owner's sign-in, and failing that the address that bought it; never another",
    async () => {
      const clinic = await seedClinic("recipients");
      await seedPortalUser(clinic.clinicId, "admin");
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `insert into report_recipients (clinic_id, email, added_by) values
             ($1, 'Buyer@Radiance-Recipients.test', 'provisioning'),
             ($1, 'front-desk@radiance-recipients.test', 'operator')`,
          [clinic.clinicId],
        ),
      );
      // One address, and both lists are it (one sign-in per clinic).
      expect(await recipients(clinic.clinicId)).toEqual({
        calendar: [clinic.staffEmail],
        owner: [clinic.staffEmail],
      });

      // With no owner sign-in, the buyer's own address, lower-cased; never the
      // front-desk list.
      await inTenant(clinic.clinicId, (client) =>
        client.query(
          `update clinic_memberships set revoked_at = now() where clinic_id = $1 and role = 'owner'`,
          [clinic.clinicId],
        ),
      );
      expect(await recipients(clinic.clinicId)).toEqual({
        calendar: ["buyer@radiance-recipients.test"],
        owner: ["buyer@radiance-recipients.test"],
      });

      // Another clinic has its own address and never this one's.
      const other = await seedClinic("recipients-other");
      expect(await recipients(other.clinicId)).toEqual({
        calendar: [other.staffEmail],
        owner: [other.staffEmail],
      });

      // And a location with neither gets nobody.
      const bare = await seedClinic("recipients-bare");
      await inTenant(bare.clinicId, (client) =>
        client.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [
          bare.clinicId,
        ]),
      );
      expect(await recipients(bare.clinicId)).toEqual({ calendar: [], owner: [] });
    },
    SLOW,
  );
});

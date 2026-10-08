import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ActorContext } from "@/lib/audit";
import {
  CONNECTION_LINK_TTL_DAYS,
  MAX_CONNECTION_LINK_TTL_DAYS,
  calendarLinkClinicForReissue,
  consumeCalendarLinkWithin,
  consumeConnectionLink,
  consumeConnectionLinkWithin,
  issueConnectionLink,
  resolveConnectionLink,
} from "@/lib/connections/links";
import {
  listConnections,
  saveConnection,
  withCredentials,
} from "@/lib/connections/store";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedContact } from "./setup/factories";

/**
 * Single-use connection links.
 *
 * This is the only surface healdesk exposes to somebody holding no session, no
 * account and no password: a clinic manager who clicked a link in an email. The
 * URL *is* the credential, the way a webhook signature is. So these tests walk
 * the happy path only far enough to have something to attack, and then attack
 * it — a stolen link, a replayed one, a guessed one, a tampered one, two
 * submissions at the same instant, and a caller inside the wrong tenant.
 *
 * Six failures are hunted specifically. Each one is invisible to a test that
 * merely checks the wizard works:
 *
 *   1. **Read-then-write consumption.** "Is this link used? No? Use it." passes
 *      every sequential assertion ever written and loses a race in production,
 *      spending one link on two credentials. Both race tests below fire
 *      simultaneous calls over several independent links, because a race
 *      declared fixed on one lucky interleaving is not fixed.
 *
 *   2. **A token stored verbatim.** A dump of connection_links would then be a
 *      dump of live links. The row is read back and the token hunted through
 *      every reversible encoding of itself.
 *
 *   3. **A resolver that distinguishes its failures.** Expired, already used,
 *      never issued and malformed must be one indistinguishable `null`. Every
 *      distinction is an oracle for whoever holds a URL they should not have:
 *      "expired" says the link was real, a clinic name says whose it was.
 *
 *   4. **A link that can be un-spent.** Withholding DELETE is pointless if the
 *      app can write `used_at = NULL` back over a consumed row, or widen
 *      `expires_at` on a link that has sat in a forwarded inbox for a month.
 *      0003_grants.sql ends with ALTER DEFAULT PRIVILEGES granting
 *      SELECT/INSERT/UPDATE/DELETE on every future table, so every one of these
 *      privileges arrived automatically and had to be taken away on purpose.
 *
 *   5. **A bootstrap policy that is wider than one row.** 0024 lets an
 *      anonymous holder read connection_links with no tenant, authorised by the
 *      digest they presented. That is a deliberate hole in RLS, and its exact
 *      dimensions — one row, read-only, and only outside a tenant — are
 *      asserted here rather than assumed.
 *
 *   6. **A tenant boundary that exists only in the application.** The clinic
 *      comes from the token, never from the request. These tests try to spend
 *      clinic A's link from inside clinic B anyway, and require the database to
 *      be the thing that refuses.
 *
 * Everything runs against the real two-role database, like the rest of the
 * DB-backed suites, and skips as a whole when TEST_APP_URL is unset.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor: ActorContext = { type: "service", serviceName: "test" };
const DAY_MS = 24 * 3_600_000;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A clinic wired the way one arrives here: a booking platform to connect. */
async function seedConnectableClinic(label: string, provider = "acuity") {
  const clinic = await seedClinic(label);
  await getMigratorPool().query(
    `update clinics set booking_provider = $2 where id = $1`,
    [clinic.clinicId, provider],
  );
  return { ...clinic, name: `${label} Clinic`, provider };
}

async function issueFor(
  clinicId: string,
): Promise<{ token: string; expiresAt: Date }> {
  return issueConnectionLink(clinicId, {}, { actor, request: {} });
}

function digestOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Insert a link row directly, so its clock can be chosen.
 *
 * An expired link has to be born expired: the no-rewrite trigger refuses any
 * change to `expires_at`, deliberately, and the CHECK constraint requires
 * expires_at > created_at — hence both ends of the window.
 *
 * This hard-codes the hashing convention (SHA-256 over the token string exactly
 * as it appears in the URL). `a hand-built link is a real link` asserts that
 * convention against the live resolver before any expiry test relies on it: a
 * mismatch would otherwise make every one of them pass because the row was
 * never findable, which is precisely the shape of a test that guards nothing.
 */
async function insertLink(
  clinicId: string,
  window: { createdAgo: string; expiresIn: string },
): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest();

  const id = await inTenant(clinicId, async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into connection_links (clinic_id, token_hash, created_at, expires_at)
       values ($1, $2, now() - $3::interval, now() + $4::interval)
       returning id`,
      [clinicId, tokenHash, window.createdAgo, window.expiresIn],
    );
    return result.rows[0]!.id;
  });

  return { token, id };
}

/** Burn a link inside a tenant transaction the caller chooses. */
async function consumeWithinTenant(
  tenantClinicId: string,
  token: string,
  ip: string | null = null,
): Promise<boolean> {
  return withTenant({ clinicId: tenantClinicId, actor }, (tx) =>
    consumeConnectionLinkWithin(tx, token, ip),
  );
}

/**
 * Postgres unique_violation, found wherever drizzle has put it.
 *
 * The chain walk is not defensive. drizzle-orm 0.45 wraps driver errors in a
 * `DrizzleQueryError` whose own `code` is undefined; the pg `DatabaseError`
 * carrying `23505` sits on `.cause`. A check that reads `error.code` directly
 * never matches, and silently — the harness would then classify a lost race as
 * an unrecognised failure and report a database that behaved correctly as
 * broken.
 *
 * ⚠️ Deliberately WIDER than the route action's `isConcurrentConnectionInsert()`,
 * which walks the same chain but also requires the constraint to be
 * `provider_connections_clinic_provider_idx`. That narrowing belongs there and
 * not here: the action turns this classification into "stored" for the clinic,
 * so a stray 23505 read as the expected one would report a credential that was
 * never written. The harness only has to recognise that the loser lost, and a
 * check that hard-codes an index name would go quiet — passing, testing
 * nothing — the day that index is renamed.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

class LostTheRace extends Error {}

/**
 * The submission transaction from app/connect/[token]/actions.ts, reproduced.
 *
 * Store the credential, burn the link, and roll the whole thing back if the
 * burn found nothing left to spend. Reproduced rather than imported because the
 * action is a "use server" function that reads `headers()`, which vitest cannot
 * provide — and the property under test, one link buying exactly one stored
 * credential under simultaneous submission, lives entirely in these two calls
 * and the transaction boundary around them.
 */
async function submitCredential(
  clinicId: string,
  provider: string,
  token: string,
  apiKey: string,
): Promise<boolean> {
  try {
    return await withTenant({ clinicId, actor }, async (tx) => {
      await saveConnection(tx.db, {
        clinicId,
        provider,
        credentials: { userId: "987654", apiKey },
      });

      const consumed = await consumeConnectionLinkWithin(tx, token, null);
      if (!consumed) throw new LostTheRace();

      return true;
    });
  } catch (error) {
    if (error instanceof LostTheRace || isUniqueViolation(error)) return false;
    throw error;
  }
}

async function connectionsFor(clinicId: string) {
  return withTenant({ clinicId, actor }, (tx) => listConnections(tx.db, clinicId));
}

async function apiKeyFor(clinicId: string, connectionId: string): Promise<string> {
  return withTenant({ clinicId, actor }, (tx) =>
    withCredentials(tx.db, { clinicId, connectionId }, async (creds) => {
      const key = creds.apiKey;
      if (key === undefined) throw new Error("stored credential has no apiKey");
      return key;
    }),
  );
}

/** Every column of every link row for a clinic, as text. */
async function linkRowsFor(clinicId: string): Promise<string[]> {
  return inTenant(clinicId, async (client) => {
    const result = await client.query<{ row: string }>(
      `select to_jsonb(l)::text as row from connection_links l where clinic_id = $1`,
      [clinicId],
    );
    return result.rows.map((r) => r.row);
  });
}

type AppClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/**
 * Run as the runtime role with chosen transaction-local settings, always
 * rolling back.
 *
 * The always-rollback matters more than it looks, for the reason
 * tests/tenant-isolation.test.ts gives: a failed expectation inside an open
 * transaction poisons the pooled connection, and every later test then fails
 * with "current transaction is aborted", hiding the one that actually broke.
 */
async function asApp<T>(
  settings: Record<string, string>,
  fn: (client: AppClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    for (const [name, value] of Object.entries(settings)) {
      await client.query(`select set_config($1, $2, true)`, [name, value]);
    }
    return await fn(client as never);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

function asTenant<T>(
  clinicId: string,
  fn: (client: AppClient) => Promise<T>,
): Promise<T> {
  return asApp({ "app.clinic_id": clinicId }, fn);
}

function describeOutcome(result: PromiseSettledResult<boolean>): string {
  return result.status === "fulfilled"
    ? `returned ${String(result.value)}`
    : `threw ${String(result.reason)}`;
}

/* -------------------------------------------------------------------------- */

describeDb("connection links", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  /* ------------------------------------------------------------- resolution */

  test("a token resolves once, and not after it is spent", async () => {
    const clinic = await seedConnectableClinic("link-live");
    const { token } = await issueFor(clinic.clinicId);

    const link = await resolveConnectionLink(token);
    expect(link).not.toBeNull();

    // Asserted through serialisation rather than field names: the page has to
    // name the clinic and pick the right wizard, and those are the facts that
    // matter whatever the resolver calls them.
    const payload = JSON.stringify(link);
    expect(payload).toContain(clinic.name);
    expect(payload).toContain(clinic.slug);
    expect(payload).toContain("acuity");

    expect(await consumeConnectionLink(token, null)).toBe(true);

    // The URL is still sitting in an inbox, a mail gateway's scan log and a
    // browser history. From here on it is inert.
    expect(await resolveConnectionLink(token)).toBeNull();
  });

  test("opening a link does not spend it", async () => {
    // Mail gateways and link-safety scanners fetch every URL in an email before
    // the recipient sees it. A link consumed on GET would be dead on arrival for
    // exactly the security-conscious clinics we most want, and it would present
    // as "your wizard is broken" rather than as a design error. Consumption
    // belongs on the submission, not on the render.
    const clinic = await seedConnectableClinic("link-prefetch");
    const { token } = await issueFor(clinic.clinicId);

    expect(await resolveConnectionLink(token)).not.toBeNull();
    expect(await resolveConnectionLink(token)).not.toBeNull();
    expect(await resolveConnectionLink(token)).not.toBeNull();

    expect(await consumeConnectionLink(token, null)).toBe(true);
  });

  test("a hand-built link is a real link", async () => {
    // The control for every expiry assertion below. If SHA-256 over the token
    // string were not the convention links.ts uses, a hand-built row would
    // simply never be found — and each expiry test would pass for the wrong
    // reason, proving nothing about expiry at all.
    const clinic = await seedConnectableClinic("link-handbuilt");
    const live = await insertLink(clinic.clinicId, {
      createdAgo: "1 minute",
      expiresIn: "1 hour",
    });

    const resolved = await resolveConnectionLink(live.token);
    expect(resolved, "the token hashing convention has changed").not.toBeNull();
    expect(JSON.stringify(resolved)).toContain(clinic.name);
  });

  test("an expired token resolves to null and cannot be spent", async () => {
    const clinic = await seedConnectableClinic("link-expired");
    const expired = await insertLink(clinic.clinicId, {
      createdAgo: "2 days",
      expiresIn: "-1 day",
    });

    expect(await resolveConnectionLink(expired.token)).toBeNull();

    // Not redundant with the resolve. Expiry has to live in the statement that
    // does the spending too, or any caller that skips the resolve — a retry, a
    // repair script, an ops tool — can spend a link whose window has closed.
    expect(await consumeConnectionLink(expired.token, null)).toBe(false);
    expect(await consumeWithinTenant(clinic.clinicId, expired.token)).toBe(false);

    expect(await connectionsFor(clinic.clinicId)).toHaveLength(0);
  });

  test("a token that was never issued resolves to null", async () => {
    // Correctly shaped, so this exercises the lookup rather than the guard in
    // front of it.
    const forged = randomBytes(32).toString("base64url");
    expect(await resolveConnectionLink(forged)).toBeNull();
    expect(await consumeConnectionLink(forged, null)).toBe(false);
  });

  test("malformed tokens fail closed instead of throwing", async () => {
    // A throw here is not a harmless 500. The page redirects to /connect/invalid
    // only when the resolve returns null; an exception produces a different
    // response, and any difference is a signal to whoever is probing. It would
    // also be a way to make us do work — a hash, a query — on junk.
    const malformed = [
      "",
      "   ",
      "../../etc/passwd",
      "' or 1=1 --",
      "not a token at all",
      "0000000-0000-0000-0000-000000000000",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 42: one short
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 44: one long
      "x".repeat(4096),
    ];

    for (const token of malformed) {
      const label = JSON.stringify(token.slice(0, 24));
      await expect(
        resolveConnectionLink(token),
        `resolving ${label} threw`,
      ).resolves.toBeNull();
      await expect(
        consumeConnectionLink(token, null),
        `consuming ${label} threw`,
      ).resolves.toBe(false);
    }
  });

  test("a tampered token resolves to nothing, not to someone else", async () => {
    const alpha = await seedConnectableClinic("link-tamper-a");
    const beta = await seedConnectableClinic("link-tamper-b");
    await issueFor(beta.clinicId);

    const { token } = await issueFor(alpha.clinicId);

    // One character. A prefix or truncating comparison — LIKE, a substring
    // index, a check against the first N bytes — would hand the holder of a
    // near miss somebody else's clinic.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(flipped).not.toBe(token);

    expect(await resolveConnectionLink(flipped)).toBeNull();
    expect(await resolveConnectionLink(token.slice(0, -1))).toBeNull();
    expect(await resolveConnectionLink(`${token}A`)).toBeNull();

    // And none of that spent the real one.
    expect(await resolveConnectionLink(token)).not.toBeNull();
  });

  test("expired, used and unknown are indistinguishable from outside", async () => {
    const expiredClinic = await seedConnectableClinic("link-blind-exp");
    const usedClinic = await seedConnectableClinic("link-blind-used");

    const expired = await insertLink(expiredClinic.clinicId, {
      createdAgo: "2 days",
      expiresIn: "-1 day",
    });

    const { token: used } = await issueFor(usedClinic.clinicId);
    expect(await consumeConnectionLink(used, null)).toBe(true);

    const unknown = randomBytes(32).toString("base64url");
    const malformed = "not-a-token";

    const resolutions = await Promise.all(
      [expired.token, used, unknown, malformed].map((t) =>
        resolveConnectionLink(t),
      ),
    );

    // Four different reasons, one answer. Anything else is an oracle for
    // whoever is holding a URL they should not have.
    expect(resolutions).toEqual([null, null, null, null]);
    expect(
      new Set(resolutions.map((r: unknown) => JSON.stringify(r))).size,
    ).toBe(1);

    const consumptions = await Promise.all(
      [expired.token, used, unknown, malformed].map((t) =>
        consumeConnectionLink(t, null),
      ),
    );
    expect(consumptions).toEqual([false, false, false, false]);
  });

  /* ------------------------------------------------------------- single use */

  test("a spent link cannot be spent again", async () => {
    const clinic = await seedConnectableClinic("link-replay");
    const { token } = await issueFor(clinic.clinicId);

    expect(
      await submitCredential(clinic.clinicId, "acuity", token, "genuine"),
    ).toBe(true);
    expect(
      await submitCredential(clinic.clinicId, "acuity", token, "attacker"),
    ).toBe(false);

    // A refusal that still writes is not a refusal. Whoever replays a link out
    // of a forwarded email must not be able to swap a live clinic's credential
    // for one they control and be told it worked.
    const connections = await connectionsFor(clinic.clinicId);
    expect(connections).toHaveLength(1);
    expect(await apiKeyFor(clinic.clinicId, connections[0]!.id)).toBe("genuine");
  });

  test("two simultaneous consumptions produce exactly one winner", async () => {
    // The property the atomic UPDATE ... WHERE used_at IS NULL RETURNING exists
    // for, in its barest form. A read-then-write implementation passes every
    // other test in this file and fails this one — but only sometimes, which is
    // why it runs over several independent links rather than declaring victory
    // on one interleaving.
    for (let round = 0; round < 6; round += 1) {
      const clinic = await seedConnectableClinic(`link-burn-${round}`);
      const { token } = await issueFor(clinic.clinicId);

      // Both in flight before either is awaited.
      const results = await Promise.allSettled([
        consumeConnectionLink(token, null),
        consumeConnectionLink(token, null),
      ]);

      const summary = results.map(describeOutcome).join(" / ");

      // Both calls must ANSWER — one true, one false. This is the assertion a
      // read-then-write implementation actually fails, and it is worth stating
      // separately from the winner count: the no-rewrite trigger in 0024 means
      // a naive "select, then update" does not double-spend, it raises 42501 at
      // whichever caller lost. That still leaves exactly one winner, so a test
      // counting only winners would pass on it — while the clinic gets a 500
      // instead of "your colleague already did this".
      expect(
        results.every((r) => r.status === "fulfilled"),
        `round ${round}: a losing consumption threw instead of returning false — ${summary}`,
      ).toBe(true);

      const winners = results.filter(
        (r) => r.status === "fulfilled" && r.value === true,
      );

      expect(
        winners.length,
        `round ${round}: expected exactly one winner, got ${summary}`,
      ).toBe(1);

      // Exactly one row carries a used_at, and it was set exactly once.
      const used = await inTenant(clinic.clinicId, async (client) => {
        const result = await client.query<{ n: number }>(
          `select count(*)::int as n from connection_links
            where clinic_id = $1 and used_at is not null`,
          [clinic.clinicId],
        );
        return result.rows[0]!.n;
      });
      expect(used).toBe(1);
    }
  });

  test("two simultaneous submissions store exactly one credential", async () => {
    // The same race through the route's own transaction: store the credential,
    // burn the link, roll everything back if the burn lost. What must never
    // happen is one link buying two credentials, or the loser's credential
    // surviving because it was written before the burn was attempted.
    for (let round = 0; round < 4; round += 1) {
      const clinic = await seedConnectableClinic(`link-race-${round}`);
      const { token } = await issueFor(clinic.clinicId);

      const results = await Promise.allSettled([
        submitCredential(clinic.clinicId, "acuity", token, "race-0"),
        submitCredential(clinic.clinicId, "acuity", token, "race-1"),
      ]);

      const summary = results.map(describeOutcome).join(" / ");

      // The loser must lose in one of the two documented ways — the unique
      // index on (clinic_id, provider), or the burn — and nothing else. Anything
      // this harness cannot classify is a third failure mode nobody reasoned
      // about, and it surfaces here rather than as a mystery 500 in production.
      // (This asserts the classification in isUniqueViolation() above, which
      // deliberately differs from the route action's; see the note there.)
      expect(
        results.every((r) => r.status === "fulfilled"),
        `round ${round}: a losing submission failed in an unrecognised way — ${summary}`,
      ).toBe(true);

      const winners = results
        .map((r, i) => (r.status === "fulfilled" && r.value === true ? i : -1))
        .filter((i) => i >= 0);

      expect(
        winners.length,
        `round ${round}: expected exactly one submission to win, got ${summary}`,
      ).toBe(1);

      // One winner is not enough on its own — the loser could have written its
      // credential and merely reported false.
      const connections = await connectionsFor(clinic.clinicId);
      expect(
        connections.length,
        `round ${round}: expected one stored credential, got ${connections.length}`,
      ).toBe(1);

      expect(
        await apiKeyFor(clinic.clinicId, connections[0]!.id),
        `round ${round}: the stored credential is not the winner's`,
      ).toBe(`race-${winners[0]!}`);

      expect(await resolveConnectionLink(token)).toBeNull();
    }
  });

  test("a consumed link cannot be reset, even by the schema owner", async () => {
    // Grants can stop the application deleting a row. They cannot stop it
    // writing used_at = NULL back over one, which is the same evasion with an
    // extra step — so a trigger refuses it, and a trigger binds every role,
    // including the migrator this assertion runs as.
    const clinic = await seedConnectableClinic("link-noreset");
    const { token } = await issueFor(clinic.clinicId);
    expect(await consumeConnectionLink(token, null)).toBe(true);

    await expect(
      inTenant(clinic.clinicId, (client) =>
        client.query(
          `update connection_links set used_at = null where clinic_id = $1`,
          [clinic.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // Still spent.
    expect(await consumeConnectionLink(token, null)).toBe(false);
  });

  test("an unspent link cannot have its window widened", async () => {
    // Extending a link that has been sitting in a forwarded inbox for a month
    // is not an operation anyone should have. Reissuing is, and that writes a
    // new row with a new token.
    const clinic = await seedConnectableClinic("link-nowiden");
    await issueFor(clinic.clinicId);

    await expect(
      inTenant(clinic.clinicId, (client) =>
        client.query(
          `update connection_links
              set expires_at = now() + interval '1 year'
            where clinic_id = $1`,
          [clinic.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  /* ------------------------------------------------------- calendar links */

  test("a calendar token opens and burns only as a calendar link, and no other token opens a calendar page", async () => {
    // 0056's fifth purpose. The column is in both the resolver's comparison
    // and the burn's predicate, so isolation must hold in both directions:
    // a calendar link spent on the credential wizard, or a connect link on
    // the calendar page, would each hand one page's capability to the other.
    const clinic = await seedConnectableClinic("link-calendar");
    const others = ["connect", "setup", "meta", "whatsapp"] as const;

    const calendar = await issueConnectionLink(
      clinic.clinicId,
      { purpose: "calendar" },
      { actor, request: {} },
    );
    for (const purpose of others) {
      expect(await resolveConnectionLink(calendar.token, {}, purpose), purpose).toBeNull();
      expect(await consumeConnectionLink(calendar.token, null, purpose), purpose).toBe(false);
    }
    expect((await resolveConnectionLink(calendar.token, {}, "calendar"))?.purpose).toBe("calendar");
    expect(await consumeConnectionLink(calendar.token, null, "calendar")).toBe(true);
    expect(await consumeConnectionLink(calendar.token, null, "calendar")).toBe(false);

    for (const purpose of others) {
      const { token } = await issueConnectionLink(
        clinic.clinicId,
        { purpose },
        { actor, request: {} },
      );
      expect(await resolveConnectionLink(token, {}, "calendar"), purpose).toBeNull();
      expect(await consumeConnectionLink(token, null, "calendar"), purpose).toBe(false);
      // The refused calendar burn did not spend it for its own page.
      expect((await resolveConnectionLink(token, {}, purpose))?.purpose, purpose).toBe(purpose);
    }
  });

  test("only a calendar link carries an owner audience, an account change or a pending election", async () => {
    const clinic = await seedConnectableClinic("link-calendar-shape");
    const insert = (columns: string, values: string) =>
      asTenant(clinic.clinicId, (c) =>
        c.query(
          `insert into connection_links (clinic_id, token_hash, expires_at${columns})
           values ($1, $2, now() + interval '3 days'${values})`,
          [clinic.clinicId, randomBytes(32)],
        ),
      );
    const pending = `'{"bookingSystem":"google_calendar","calendarAccount":"personal","documentVersion":"calendar-election/1.0.0","documentHash":"${"a".repeat(64)}"}'::jsonb`;

    // Every other purpose keeps 0024's plain shape.
    await expect(insert(", purpose, audience", ", 'connect', 'owner'")).rejects.toMatchObject({
      code: "23514",
      constraint: "connection_links_calendar_only_flags",
    });
    await expect(
      insert(", purpose, allows_account_change", ", 'setup', true"),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insert(", purpose, pending_election", `, 'meta', ${pending}`),
    ).rejects.toMatchObject({
      code: "23514",
    });
    // A calendar link's change and confirm powers belong to the owner alone.
    await expect(
      insert(", purpose, audience, allows_account_change", ", 'calendar', 'recipients', true"),
    ).rejects.toMatchObject({ code: "23514", constraint: "connection_links_account_change_owner" });
    await expect(
      insert(", purpose, audience, pending_election", `, 'calendar', 'recipients', ${pending}`),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "connection_links_pending_election_owner",
    });
    await expect(
      insert(", purpose, audience, pending_election", ", 'calendar', 'owner', '[]'::jsonb"),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "connection_links_pending_election_owner",
    });
    await expect(insert(", purpose, audience", ", 'calendar', 'everyone'")).rejects.toMatchObject({
      code: "23514",
      constraint: "connection_links_audience_check",
    });
    await expect(insert(", purpose", ", 'calendar-ish'")).rejects.toMatchObject({
      code: "23514",
      constraint: "connection_links_purpose_known",
    });

    // The shapes the plan uses all fit: a recipients link, an owner change
    // link and an owner confirm link, each with the addresses it went to.
    await insert(", purpose, sent_to", ", 'calendar', '{front@clinic.test}'");
    await insert(
      ", purpose, audience, allows_account_change, sent_to",
      ", 'calendar', 'owner', true, '{owner@clinic.test}'",
    );
    await insert(
      ", purpose, audience, pending_election, sent_to",
      `, 'calendar', 'owner', ${pending}, '{owner@clinic.test}'`,
    );
  });

  test("a calendar link's purpose, audience, recipients and flags are fixed when it is minted", async () => {
    const clinic = await seedConnectableClinic("link-calendar-frozen");
    const linkId = await inTenant(clinic.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into connection_links (clinic_id, token_hash, expires_at, purpose, audience, allows_account_change, sent_to)
         values ($1, $2, now() + interval '3 days', 'calendar', 'owner', true, '{owner@clinic.test}')
         returning id`,
        [clinic.clinicId, randomBytes(32)],
      );
      return rows[0]!.id;
    });

    // The runtime role holds no UPDATE on any of them...
    const { rows: grants } = await getAppPool().query<{ column: string; updatable: boolean }>(
      `select c as column, has_column_privilege(current_user, 'connection_links', c, 'UPDATE') as updatable
         from unnest(array['purpose', 'audience', 'sent_to', 'allows_account_change', 'pending_election']) as c`,
    );
    expect(grants.filter((g) => g.updatable)).toEqual([]);

    // ...and the trigger refuses the schema owner too, on an unspent link.
    for (const assignment of [
      `audience = 'recipients', allows_account_change = false`,
      `allows_account_change = false`,
      `sent_to = '{someone@else.test}'`,
      `pending_election = '{}'::jsonb`,
      `purpose = 'connect', audience = 'recipients', allows_account_change = false`,
    ]) {
      await expect(
        inTenant(clinic.clinicId, (client) =>
          client.query(`update connection_links set ${assignment} where id = $1`, [linkId]),
        ),
        assignment,
      ).rejects.toMatchObject({ code: "42501" });
    }

    // Consumption is untouched by the freeze.
    await inTenant(clinic.clinicId, (client) =>
      client.query(`update connection_links set used_at = now() where id = $1`, [linkId]),
    );
  });

  test("the library mints a calendar link with its audience, recipients and flags, and reads them back", async () => {
    const clinic = await seedConnectableClinic("link-calendar-library");
    const pending = {
      bookingSystem: "google_calendar" as const,
      calendarAccount: "personal" as const,
      documentVersion: "calendar-election/1.0.0",
      documentHash: "c".repeat(64),
    };
    const confirm = await issueConnectionLink(
      clinic.clinicId,
      {
        purpose: "calendar",
        expiresInDays: 3,
        audience: "owner",
        sentTo: [" Owner@Clinic.TEST ", "owner@clinic.test"],
        pendingElection: pending,
      },
      { actor, request: {} },
    );
    expect(await resolveConnectionLink(confirm.token, {}, "calendar")).toMatchObject({
      linkId: confirm.linkId,
      audience: "owner",
      allowsAccountChange: false,
      pendingElection: pending,
      sentTo: ["owner@clinic.test"],
    });
    // Every other purpose stays plain, and its recipients unrecorded.
    const connect = await issueConnectionLink(clinic.clinicId, {}, { actor, request: {} });
    expect(await resolveConnectionLink(connect.token)).toMatchObject({
      audience: "recipients",
      allowsAccountChange: false,
      pendingElection: null,
      sentTo: null,
    });
    // The database refuses a change link that is not the owner's.
    const refused: unknown = await issueConnectionLink(
      clinic.clinicId,
      { purpose: "calendar", audience: "recipients", allowsAccountChange: true },
      { actor, request: {} },
    ).catch((error: unknown) => error);
    let constraint: unknown = null;
    for (
      let e = refused as { constraint?: unknown; cause?: unknown } | undefined;
      e;
      e = e.cause as typeof e
    ) {
      constraint ??= e.constraint ?? null;
    }
    expect(constraint).toBe("connection_links_account_change_owner");
  });

  test("the calendar burn names the link it spent, and only a calendar link; a re-issue finds only a recent calendar link", async () => {
    const clinic = await seedConnectableClinic("link-calendar-burn");
    const calendar = await issueConnectionLink(
      clinic.clinicId,
      { purpose: "calendar" },
      { actor, request: {} },
    );
    const connect = await issueConnectionLink(clinic.clinicId, {}, { actor, request: {} });
    const burn = (token: string) =>
      withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        consumeCalendarLinkWithin(tx, token, "203.0.113.9"),
      );
    expect(await burn(connect.token)).toBeNull();
    expect(await resolveConnectionLink(connect.token)).not.toBeNull();
    expect(await burn(calendar.token)).toBe(calendar.linkId);
    expect(await burn(calendar.token)).toBeNull();
    expect(await burn("not a token")).toBeNull();

    // A spent calendar link may still ask for a new one; nothing else may.
    expect(await calendarLinkClinicForReissue(calendar.token)).toBe(clinic.clinicId);
    expect(await calendarLinkClinicForReissue(connect.token)).toBeNull();
    expect(await calendarLinkClinicForReissue("Q".repeat(43))).toBeNull();
    // Older than thirty days: no.
    const old = await issueConnectionLink(
      clinic.clinicId,
      { purpose: "calendar" },
      { actor, request: {} },
    );
    // Issued 31 days ago and spent: the issuance facts are frozen, so the
    // schema owner moves them with the table's triggers off, as the days would.
    await inTenant(clinic.clinicId, async (client) => {
      await client.query(`alter table connection_links disable trigger user`);
      try {
        await client.query(
          `update connection_links
              set created_at = now() - interval '31 days', expires_at = now() - interval '24 days',
                  used_at = now() - interval '30 days'
            where id = $1`,
          [old.linkId],
        );
      } finally {
        await client.query(`alter table connection_links enable trigger user`);
      }
    });
    expect(await calendarLinkClinicForReissue(old.token)).toBeNull();
  });

  /* ---------------------------------------------------------------- the token */

  test("stores a digest, never the token", async () => {
    const clinic = await seedConnectableClinic("link-digest");
    const { token } = await issueFor(clinic.clinicId);

    const rows = await linkRowsFor(clinic.clinicId);
    // Guards everything below against passing because the query matched
    // nothing at all.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Every reversible representation, not merely the token itself: a column
    // holding base64(token) leaks working links exactly as badly as one holding
    // the token, and reads as "hashed" at a glance.
    const reversible = {
      raw: token,
      base64: Buffer.from(token).toString("base64"),
      base64url: Buffer.from(token).toString("base64url"),
      hex: Buffer.from(token).toString("hex"),
      uriEncoded: encodeURIComponent(token),
    };
    for (const [encoding, value] of Object.entries(reversible)) {
      expect(
        row.includes(value),
        `the connection_links row carries the token (${encoding})`,
      ).toBe(false);
    }

    // And what IS stored is the digest of this token, rather than an unrelated
    // random value that would satisfy the check above without being a lookup
    // key at all.
    const stored = await inTenant(clinic.clinicId, async (client) => {
      const result = await client.query<{ hash: string; bytes: number }>(
        `select encode(token_hash, 'hex') as hash,
                octet_length(token_hash) as bytes
           from connection_links where clinic_id = $1`,
        [clinic.clinicId],
      );
      return result.rows[0]!;
    });

    expect(stored.hash).toBe(digestOf(token));
    expect(stored.bytes).toBe(32);

    // Consumption records that the link was spent. It must not record what was
    // spent: the row is evidence, not a copy of the secret.
    expect(await consumeConnectionLink(token, null)).toBe(true);
    const after = await linkRowsFor(clinic.clinicId);
    expect(after).toHaveLength(1);
    expect(after[0]!.includes(token)).toBe(false);
  });

  test("tokens are unguessable, URL-safe and short-lived", async () => {
    const clinic = await seedConnectableClinic("link-entropy");
    const issued = [
      await issueFor(clinic.clinicId),
      await issueFor(clinic.clinicId),
      await issueFor(clinic.clinicId),
      await issueFor(clinic.clinicId),
      await issueFor(clinic.clinicId),
    ];

    expect(new Set(issued.map((i) => i.token)).size).toBe(issued.length);

    for (const { token, expiresAt } of issued) {
      // Below roughly 128 bits of alphabet, "single use" stops mattering: the
      // link becomes reachable without ever having been sent.
      expect(
        token.length,
        `token is only ${token.length} characters`,
      ).toBeGreaterThanOrEqual(32);

      // It travels in a URL path. '+' and '/' from plain base64 are mangled or
      // re-encoded in transit, and a token that survives one mail client but not
      // another fails as "the link doesn't work", never as a bug.
      expect(
        /^[A-Za-z0-9._~-]+$/.test(token),
        `token is not URL-safe: ${token}`,
      ).toBe(true);

      // Nothing a stranger might already know may appear in it.
      expect(token).not.toContain(clinic.clinicId);
      expect(token).not.toContain(clinic.slug);

      const ttlDays = (expiresAt.getTime() - Date.now()) / DAY_MS;
      expect(ttlDays).toBeGreaterThan(0);
      expect(Math.round(ttlDays)).toBe(CONNECTION_LINK_TTL_DAYS);
    }
  });

  test("a caller cannot ask for a link that outlives the ceiling", async () => {
    // The override exists so ops can shorten a link for a clinic on the phone.
    // Unclamped, it is a number a human types — and a link good for a year is
    // not a link, it is a password with extra steps sitting in an inbox that
    // gets forwarded to a bookkeeper, an agency, a departing office manager.
    const clinic = await seedConnectableClinic("link-ttl");

    const long = await issueConnectionLink(
      clinic.clinicId,
      { expiresInDays: 3650 },
      { actor, request: {} },
    );
    expect(
      (long.expiresAt.getTime() - Date.now()) / DAY_MS,
    ).toBeLessThanOrEqual(MAX_CONNECTION_LINK_TTL_DAYS + 0.01);

    // And it cannot be talked into issuing something already dead, which would
    // be an unusable link reported as issued.
    const zero = await issueConnectionLink(
      clinic.clinicId,
      { expiresInDays: 0 },
      { actor, request: {} },
    );
    expect(zero.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await resolveConnectionLink(zero.token)).not.toBeNull();
  });

  /* ------------------------------------------------------- tenant isolation */

  test("a link for one clinic cannot be spent from inside another", async () => {
    const alpha = await seedConnectableClinic("link-alpha");
    const beta = await seedConnectableClinic("link-beta", "zenoti");

    const { token: alphaToken } = await issueFor(alpha.clinicId);

    // The attack written out: a transaction inside beta's tenant storing beta's
    // credential and paying for it with alpha's link. The burn must find
    // nothing — alpha's row is invisible under beta's tenant — and the
    // credential rolls back with it.
    expect(
      await submitCredential(beta.clinicId, "zenoti", alphaToken, "stolen"),
    ).toBe(false);
    expect(await connectionsFor(beta.clinicId)).toHaveLength(0);

    // The bare burn fares no better.
    expect(await consumeWithinTenant(beta.clinicId, alphaToken)).toBe(false);

    // Alpha's link is untouched by all of that, and still worth exactly one
    // credential — to alpha.
    expect(await resolveConnectionLink(alphaToken)).not.toBeNull();
    expect(
      await submitCredential(alpha.clinicId, "acuity", alphaToken, "alpha-key"),
    ).toBe(true);

    const alphaConnections = await connectionsFor(alpha.clinicId);
    expect(alphaConnections).toHaveLength(1);
    expect(alphaConnections[0]!.provider).toBe("acuity");
    expect(await apiKeyFor(alpha.clinicId, alphaConnections[0]!.id)).toBe(
      "alpha-key",
    );
  });

  test("the runtime role cannot write a credential into another clinic", async () => {
    // The database backstop under the check above: even if consumption were
    // tricked into carrying the wrong clinic, WITH CHECK refuses the write.
    // 42501 specifically — an RLS refusal, not the BAA trigger firing for a
    // different reason.
    const alpha = await seedConnectableClinic("link-rls-a");
    const beta = await seedConnectableClinic("link-rls-b");
    await issueFor(alpha.clinicId);

    await expect(
      asTenant(beta.clinicId, (c) =>
        c.query(
          `insert into provider_connections
             (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
           values ($1, 'acuity', 'pending', 'x', 'x', 'x', 'x', 'v1', 1)`,
          [alpha.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // And beta cannot see alpha's links at all — not to read them, and not to
    // burn one it was never sent.
    const visible = await asTenant(beta.clinicId, async (c) => {
      const result = await c.query(
        `select id from connection_links where clinic_id = $1`,
        [alpha.clinicId],
      );
      return result.rows.length;
    });
    expect(visible).toBe(0);
  });

  /* ------------------------------------------------------ the bootstrap hole */

  test("with no tenant and no token, connection_links reads empty", async () => {
    // What a bypassed withTenant() gets. The whole bootstrap design in 0024
    // rests on this being true; if a plain SELECT worked here, the table would
    // be readable by any code path that merely forgot to open a tenant.
    const clinic = await seedConnectableClinic("link-notenant");
    await issueFor(clinic.clinicId);

    const { rows } = await getAppPool().query<{ count: number }>(
      `select count(*)::int as count from connection_links`,
    );
    expect(rows[0]!.count).toBe(0);
  });

  test("presenting a digest reveals exactly one row, and only outside a tenant", async () => {
    // 0024 opens a deliberate hole in RLS so an anonymous holder can find their
    // own tenant. These are its dimensions. A policy that let through more than
    // the matching row would turn "I hold one link" into "I can enumerate every
    // clinic's links", and nothing above this layer would notice.
    const mine = await seedConnectableClinic("link-boot-mine");
    const other = await seedConnectableClinic("link-boot-other");

    const { token } = await issueFor(mine.clinicId);
    await issueFor(other.clinicId);
    const hash = digestOf(token);

    const visible = await asApp(
      { "app.connection_link_hash": hash },
      async (c) => {
        const result = await c.query(
          `select clinic_id from connection_links`,
        );
        return result.rows as { clinic_id: string }[];
      },
    );
    // Exactly one, and it is the one whose digest was presented — with another
    // clinic's link sitting in the table, so this is filtering and not an empty
    // database.
    expect(visible).toHaveLength(1);
    expect(visible[0]!.clinic_id).toBe(mine.clinicId);

    // A digest that is well-formed but wrong reveals nothing — the interesting
    // half of this loop, since it is the one that reaches `decode()` and an
    // actual index probe. The malformed entries assert the other half: the
    // policy must yield no rows rather than RAISE, because an error inside a
    // policy is both an oracle and a way to break the page for everyone.
    const wrongDigest = createHash("sha256")
      .update(randomBytes(32).toString("base64url"), "utf8")
      .digest("hex");
    for (const junk of [
      wrongDigest,
      "",
      "not-hex",
      "zz",
      "0".repeat(63),
      "0".repeat(65),
      "0".repeat(64).toUpperCase(),
    ]) {
      const rows = await asApp(
        { "app.connection_link_hash": junk },
        async (c) => (await c.query(`select id from connection_links`)).rows,
      );
      expect(rows, `a junk digest (${JSON.stringify(junk)}) matched rows`)
        .toHaveLength(0);
    }

    // Read-only. The bootstrap policy is FOR SELECT, so a holder cannot burn
    // their own link outside a tenant transaction — writes stay bound to the
    // tenant policy's WITH CHECK.
    const written = await asApp(
      { "app.connection_link_hash": hash },
      async (c) => {
        const result = await c.query(
          `update connection_links set used_at = now() where token_hash = decode($1, 'hex')`,
          [hash],
        );
        return result.rowCount ?? 0;
      },
    );
    expect(written, "the bootstrap policy permitted a write").toBe(0);

    // And a stale digest is inert inside a tenant: the policy applies only when
    // no clinic is set, so a setting left over from an earlier statement cannot
    // be used to reach across tenants.
    const crossed = await asApp(
      {
        "app.clinic_id": other.clinicId,
        "app.connection_link_hash": hash,
      },
      async (c) =>
        (
          await c.query(`select id from connection_links where clinic_id = $1`, [
            mine.clinicId,
          ])
        ).rows,
    );
    expect(crossed, "a stale digest crossed a tenant boundary").toHaveLength(0);
  });

  test("the anonymous lookup holds no elevated rights", async () => {
    // app_connection_link_clinic() is the one thing that reads this table
    // before a tenant exists. It must do so as the ordinary runtime role: what
    // admits the read is the digest the caller presented, not a privilege. A
    // definer function here would run as the table owner, which is one dropped
    // FORCE away from reading every row.
    const { rows: definition } = await getMigratorPool().query<{
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `select prosecdef, proconfig
         from pg_proc where proname = 'app_connection_link_clinic'`,
    );
    expect(definition).toHaveLength(1);
    expect(
      definition[0]!.prosecdef,
      "the anonymous lookup runs with elevated rights",
    ).toBe(false);
    expect(
      (definition[0]!.proconfig ?? []).some((c) => c.startsWith("search_path=")),
      "the lookup has an unpinned search_path",
    ).toBe(true);

    const { rows: aces } = await getMigratorPool().query<{ ace: string }>(
      `select unnest(proacl)::text as ace
         from pg_proc where proname = 'app_connection_link_clinic'`,
    );
    // A NULL proacl means default privileges, and the default for a function is
    // EXECUTE to PUBLIC — so no rows here is the failure, not the pass.
    expect(
      aces.length,
      "proacl is empty, so the default EXECUTE to PUBLIC still stands",
    ).toBeGreaterThan(0);
    for (const { ace } of aces) {
      // A grantee-less entry ("=X/owner") is PUBLIC.
      expect(ace.startsWith("="), `PUBLIC holds privileges: ${ace}`).toBe(false);
    }
  });

  /* ------------------------------------------------------------- privileges */

  test("the runtime role cannot delete or rewrite a connection link", async () => {
    // 0003_grants.sql ends with ALTER DEFAULT PRIVILEGES granting the runtime
    // role SELECT, INSERT, UPDATE and DELETE on every table the migrator creates
    // afterwards, so all four arrived here automatically and had to be removed
    // on purpose. A consumed link is the record that a credential was granted;
    // the argument that makes audit_log append-only in tenant-isolation.test.ts
    // applies to it exactly.
    const { rows } = await getAppPool().query<{
      links_delete: boolean;
      links_select: boolean;
      links_insert: boolean;
      update_used_at: boolean;
      update_consumed_ip: boolean;
      update_token_hash: boolean;
      update_expires_at: boolean;
      update_clinic_id: boolean;
      contacts_delete: boolean;
    }>(
      `select has_table_privilege(current_user, 'connection_links', 'DELETE') as links_delete,
              has_table_privilege(current_user, 'connection_links', 'SELECT') as links_select,
              has_table_privilege(current_user, 'connection_links', 'INSERT') as links_insert,
              has_column_privilege(current_user, 'connection_links', 'used_at',     'UPDATE') as update_used_at,
              has_column_privilege(current_user, 'connection_links', 'consumed_ip', 'UPDATE') as update_consumed_ip,
              has_column_privilege(current_user, 'connection_links', 'token_hash',  'UPDATE') as update_token_hash,
              has_column_privilege(current_user, 'connection_links', 'expires_at',  'UPDATE') as update_expires_at,
              has_column_privilege(current_user, 'connection_links', 'clinic_id',   'UPDATE') as update_clinic_id,
              has_table_privilege(current_user, 'contacts', 'DELETE') as contacts_delete`,
    );
    const grants = rows[0]!;

    // Control: the same probe reports DELETE where DELETE really is held, so a
    // false below means "revoked" rather than "the query is broken".
    expect(grants.contacts_delete, "the probe cannot see DELETE grants").toBe(
      true,
    );

    expect(
      grants.links_delete,
      "healdesk_app holds DELETE on connection_links — a spent link could be erased",
    ).toBe(false);

    // The app writes exactly the two columns consumption sets. Column grants
    // refuse the rest before the trigger has to.
    expect(grants.update_used_at).toBe(true);
    expect(grants.update_consumed_ip).toBe(true);
    expect(
      grants.update_token_hash,
      "healdesk_app can rewrite token_hash — it could point a live link at any row",
    ).toBe(false);
    expect(
      grants.update_expires_at,
      "healdesk_app can rewrite expires_at — a stale link could be revived",
    ).toBe(false);
    expect(
      grants.update_clinic_id,
      "healdesk_app can rewrite clinic_id — a link could be moved between tenants",
    ).toBe(false);

    // The other half of the control: the app reaches this table normally, so
    // the falses above are withheld verbs and not an unreachable table.
    expect(grants.links_select).toBe(true);
    expect(grants.links_insert).toBe(true);

    // Privileges are checked ahead of RLS, so this is a refusal rather than
    // "matched no rows".
    const clinic = await seedConnectableClinic("link-nodelete");
    await issueFor(clinic.clinicId);
    await expect(
      asTenant(clinic.clinicId, (c) =>
        c.query(`delete from connection_links where clinic_id = $1`, [
          clinic.clinicId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  /* ---------------------------------------------------------- audit and PHI */

  test("the whole lifecycle is audited, and never with the token", async () => {
    const clinic = await seedConnectableClinic("link-audit");
    const { token } = await issueFor(clinic.clinicId);

    await resolveConnectionLink(token); // opened
    expect(await consumeConnectionLink(token, null)).toBe(true); // consumed
    await resolveConnectionLink(token); // rejected: already used
    expect(await consumeConnectionLink(token, null)).toBe(false); // rejected

    const trail = await inTenant(clinic.clinicId, async (client) => {
      const result = await client.query<{ action: string; row: string }>(
        `select action, to_jsonb(a)::text as row
           from audit_log a
          where clinic_id = $1 and resource_type = 'connection_link'`,
        [clinic.clinicId],
      );
      return result.rows;
    });

    // Issued, opened, consumed, and both refusals. A link still circulating
    // after it was redeemed is exactly the thing we would want to see
    // afterwards, so the rejections have to be recorded too.
    expect(
      trail.length,
      "the link lifecycle left fewer than five audit rows",
    ).toBeGreaterThanOrEqual(5);
    expect(new Set(trail.map((r) => r.action))).toEqual(
      new Set(["create", "read", "update"]),
    );

    // An audit row carrying the token would put live links back into a table
    // ops staff read routinely, undoing the hashing entirely.
    for (const { row } of trail) {
      expect(row.includes(token), "an audit_log row carries the token").toBe(
        false,
      );
      expect(row.includes(digestOf(token)), "an audit_log row carries the digest")
        .toBe(false);
    }

    const { rows: events } = await getAppPool().query<{ blob: string }>(
      `select coalesce(string_agg(to_jsonb(s)::text, ' '), '') as blob
         from security_events s`,
    );
    expect(events[0]!.blob.includes(token)).toBe(false);
  });

  test("a junk client IP cannot refuse the grant or reach the inet column", async () => {
    // The IP comes from a proxy header, which is attacker-influenced text on
    // its way into an `inet` column. A value that column refuses raises 22P02
    // and aborts the transaction — turning a strange header into a refused
    // credential grant, with a 500 as the clinic's only explanation.
    const junk = await seedConnectableClinic("link-ip-junk");
    const real = await seedConnectableClinic("link-ip-real");

    const { token: junkToken } = await issueFor(junk.clinicId);
    expect(
      await consumeConnectionLink(junkToken, "'; drop table connection_links --"),
    ).toBe(true);

    const { token: realToken } = await issueFor(real.clinicId);
    expect(
      await consumeConnectionLink(realToken, "203.0.113.9, 10.0.0.1"),
    ).toBe(true);

    const ipFor = async (clinicId: string) =>
      inTenant(clinicId, async (client) => {
        const result = await client.query<{ ip: string | null }>(
          `select host(consumed_ip) as ip from connection_links where clinic_id = $1`,
          [clinicId],
        );
        return result.rows[0]!.ip;
      });

    // Dropped rather than stored, and the grant went through regardless.
    expect(await ipFor(junk.clinicId)).toBeNull();
    // The first hop of a forwarded chain, which is the only part worth keeping.
    expect(await ipFor(real.clinicId)).toBe("203.0.113.9");
  });

  test("nothing patient-level reaches the anonymous surface", async () => {
    // docs/hipaa-compliance.md. This page renders to whoever holds the URL. It
    // may name the clinic and describe its booking platform; it may not confirm
    // an identity or show a patient.
    const clinic = await seedConnectableClinic("link-phi");
    const phone = "+15550188881";
    await seedContact(clinic.clinicId, phone);

    const { token } = await issueFor(clinic.clinicId);
    const link = await resolveConnectionLink(token);
    expect(link).not.toBeNull();

    const payload = JSON.stringify(link);
    expect(payload).not.toContain(phone);
    expect(payload).not.toContain("Synthetic Patient");
    // The address we mailed the link to is itself an identifier: echoing it
    // back confirms to a stranger holding the URL who was contacted.
    expect(payload).not.toContain(clinic.staffEmail);
  });
});

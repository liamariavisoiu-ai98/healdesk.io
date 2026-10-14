import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { unsafeDb } from "@/db";
import { conversations } from "@/db/schema";
import { auth } from "@/lib/auth";
import {
  finishPasskeyAuthentication,
  removePasskey,
  startPasskeyAuthentication,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import {
  findLiveStepUp,
  hashSessionToken,
  recordStepUp,
  STEP_UP_IDLE_MS,
} from "@/lib/factors/step-ups";
import { checkSecondFactorCode, enrolTotp, proposeTotp, totpStep } from "@/lib/factors/totp";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * The patient-page guard (plan Part D2-D4; spec, "Account access and
 * credentials"): a passkey step-up before any conversation or booking opens,
 * 15 minutes idle and 8 hours at most, and an access-log row per open naming
 * the device's passkey.
 *
 * Driven through the real Better Auth: every session here is one a sign-in
 * link started (startLinkSession), presented by its cookie, and signing out
 * is Better Auth's own. Only the WebAuthn library's verdict is stubbed, as in
 * tests/passkeys.test.ts; the ceremony around it is ours and real.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    headers: new Headers(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...actual, verifyAuthenticationResponse: mocks.verifyAuthenticationResponse };
});

const {
  logPatientAccess,
  MAX_PATIENT_IDS_PER_ROW,
  PatientAccessNotLoggedError,
  patientGuardProps,
  requirePatientPage,
  withPatientPage,
} = await import("@/lib/portal/patient-page");
const { keepPatientPageOpen, patientPageStatus } = await import("@/app/c/[slug]/keep-open");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

type Signed = { cookie: string; token: string; binding: SessionBinding };

/** A session the way a sign-in link starts one, and its cookie. */
async function signIn(userId: string): Promise<Signed> {
  const started = await auth.api.startLinkSession({
    body: { userId },
    headers: new Headers(),
    asResponse: true,
  });
  const cookie = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("hd.session_token="))!
    .split(";")[0]!;
  const token = decodeURIComponent(cookie.slice("hd.session_token=".length)).split(".")[0]!;
  return { cookie, token, binding: { userId, sessionTokenHash: hashSessionToken(token) } };
}

/** This request comes from `who`'s browser, asking for `path`. */
function browse(who: Signed | null, path: string): void {
  mocks.headers = new Headers({
    ...(who ? { cookie: who.cookie } : {}),
    "x-healdesk-path": path,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "x-forwarded-for": "203.0.113.7",
  });
}

async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; redirect: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false, redirect: error.url };
    throw error;
  }
}

async function addPasskey(userId: string, label: string) {
  const credentialId = b64(randomBytes(16));
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, label, credentialId],
  );
  return { factorId: rows[0]!.id, credentialId };
}

/** A passkey step-up through our ceremony, the library's verdict stubbed to "verified". */
async function stepUp(session: SessionBinding, credentialId: string, counter = 0) {
  const started = await startPasskeyAuthentication({ session });
  if (!started.ok) throw new Error(started.reason);
  mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter: counter,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  });
  const finished = await finishPasskeyAuthentication({
    session,
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64(
          JSON.stringify({
            type: "webauthn.get",
            challenge: started.options.challenge,
            origin: ORIGIN,
          }),
        ),
        authenticatorData: b64(randomBytes(37)),
        signature: b64(randomBytes(64)),
      },
      clientExtensionResults: {},
    },
  });
  if (!finished.ok) throw new Error(finished.reason);
  return finished.stepUp;
}

/** A step-up row with chosen ages, as the migrator, for the clock tests. */
async function agedStepUp(
  who: Signed,
  factorId: string,
  ages: { createdMinutesAgo: number; activeMinutesAgo: number },
): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, 'Front desk Mac', now() - $4 * interval '1 minute', now() - $5 * interval '1 minute')
     returning id`,
    [
      who.binding.sessionTokenHash,
      who.binding.userId,
      factorId,
      ages.createdMinutesAgo,
      ages.activeMinutesAgo,
    ],
  );
  return rows[0]!.id;
}

/** An independent RFC 6238 code for a base32 secret. */
function codeFor(secretBase32: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const character of secretBase32) {
    acc = (acc << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.readUInt8(19) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}

/** The session row as Better Auth wrote it, to put back after a sign-out for the replay check. */
async function sessionRow(token: string): Promise<Record<string, unknown>> {
  const { rows } = await getMigratorPool().query(`select * from session where token = $1`, [token]);
  return rows[0]!;
}

async function restoreSession(row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await getMigratorPool().query(
    `insert into session (${columns.map((c) => `"${c}"`).join(", ")})
     values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((c) => row[c]),
  );
}

/** The clinic's access log, read as the migrator with the tenant set (audit_log forces RLS). */
async function auditRows(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      actor_type: string;
      actor_user_id: string | null;
      actor_label: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      resource_ids: string[] | null;
      result_count: number | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown> | null;
      request_id: string | null;
    }>(
      `select actor_type, actor_user_id, actor_label, action, resource_type, resource_id,
              resource_ids, result_count, ip_address, user_agent, metadata, request_id
         from audit_log where clinic_id = $1 order by occurred_at, id`,
      [clinicId],
    );
    return rows;
  });
}

/** How long a step-up has left by its two absolute times, as the browser counts it. */
const left = (stepUp: { expiresAt: Date; checkedAt: Date }) =>
  stepUp.expiresAt.getTime() - stepUp.checkedAt.getTime();
const answerLeft = (answer: Awaited<ReturnType<typeof patientPageStatus>>) =>
  answer.ok ? Date.parse(answer.expiresAt) - Date.parse(answer.now) : null;

describeDb("patient pages", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.verifyAuthenticationResponse.mockReset();
    mocks.headers = new Headers();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a session from a sign-in link alone never opens one", async () => {
    const clinic = await seedClinic("linkonly");
    const page = `/c/${clinic.slug}/conversations`;
    const toStepUp = `/c/${clinic.slug}/step-up?next=${encodeURIComponent(page)}`;

    browse(null, page);
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });

    const link = await signIn(clinic.staffUserId);
    browse(link, page);
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: toStepUp,
    });

    // A passkey on the sign-in is not a step-up on this session.
    await addPasskey(clinic.staffUserId, "Front desk Mac");
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: toStepUp,
    });
    // The page may say where to come back to; it must still be this clinic's.
    expect(
      await outcome(() =>
        requirePatientPage(clinic.slug, { returnTo: `/c/${clinic.slug}/bookings` }),
      ),
    ).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/bookings`)}`,
    });
    expect(
      await outcome(() => requirePatientPage(clinic.slug, { returnTo: "https://evil.test/" })),
    ).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });
    expect(await auditRows(clinic.clinicId)).toEqual([]);
  });

  test("the authenticator backup never opens one, by a right code or a step-up row made with it", async () => {
    const clinic = await seedClinic("totponly");
    const link = await signIn(clinic.staffUserId);
    browse(link, `/c/${clinic.slug}/bookings`);

    // Enrolled while the sign-in has no factor and nothing is live, as the
    // backup may be; then a right, unspent code.
    const proposal = proposeTotp({ userId: clinic.staffUserId, email: clinic.staffEmail });
    const now = new Date();
    const step = totpStep(now);
    expect(
      (
        await enrolTotp({
          userId: clinic.staffUserId,
          sessionTokenHash: link.binding.sessionTokenHash,
          proposal: proposal.proposal,
          code: codeFor(proposal.secret, step - 1),
          at: now,
        })
      ).ok,
    ).toBe(true);
    expect(
      await checkSecondFactorCode(clinic.staffUserId, codeFor(proposal.secret, step)),
    ).toMatchObject({
      ok: true,
    });
    expect((await outcome(() => requirePatientPage(clinic.slug))).ok).toBe(false);

    // A step-up row naming the authenticator is refused at the store, and one
    // that reaches the table some other way counts for nothing.
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `select id from user_factors where user_id = $1 and kind = 'totp'`,
      [clinic.staffUserId],
    );
    const totpId = rows[0]!.id;
    await expect(
      recordStepUp(unsafeDb, { ...link.binding, factorId: totpId, deviceLabel: "Authenticator" }),
    ).rejects.toThrow(/passkeys/);
    const planted = await agedStepUp(link, totpId, { createdMinutesAgo: 1, activeMinutesAgo: 1 });
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/bookings`)}`,
    });
    expect(await patientPageStatus(clinic.slug, planted)).toEqual({ ok: false });
    expect(await keepPatientPageOpen(clinic.slug, planted)).toEqual({ ok: false });
    expect(await auditRows(clinic.clinicId)).toEqual([]);
  });

  test("activity keeps it open, fifteen minutes idle closes it, and eight hours is the most", async () => {
    const clinic = await seedClinic("clock");
    const { factorId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const pool = getMigratorPool();

    // Fourteen minutes idle: open, and the check itself is activity.
    const busy = await signIn(clinic.staffUserId);
    browse(busy, `/c/${clinic.slug}/conversations`);
    const busyId = await agedStepUp(busy, factorId, {
      createdMinutesAgo: 60,
      activeMinutesAgo: 14,
    });
    const opened = await outcome(() => requirePatientPage(clinic.slug));
    if (!opened.ok) throw new Error(opened.redirect);
    expect(opened.value.stepUp).toMatchObject({
      passkeyId: factorId,
      stepUpId: busyId,
      capped: false,
    });
    expect(left(opened.value.stepUp)).toBe(STEP_UP_IDLE_MS);
    const idle = await pool.query<{ s: string }>(
      `select extract(epoch from (now() - last_activity_at)) as s from step_ups where id = $1`,
      [busyId],
    );
    expect(Number(idle.rows[0]!.s)).toBeLessThan(5);
    // The guard's status asks without counting as activity; "Keep open" counts.
    const activity = async () =>
      (
        await pool.query<{ at: Date }>(
          `select last_activity_at as at from step_ups where id = $1`,
          [busyId],
        )
      ).rows[0]!.at.getTime();
    const before = await activity();
    const status = await patientPageStatus(clinic.slug, busyId);
    expect(status).toMatchObject({ ok: true, stepUpId: busyId, capped: false });
    expect(answerLeft(status)).toBeLessThanOrEqual(STEP_UP_IDLE_MS);
    expect(await activity()).toBe(before);
    const kept = await keepPatientPageOpen(clinic.slug, busyId);
    expect(answerLeft(kept)).toBe(STEP_UP_IDLE_MS);
    expect(await activity()).toBeGreaterThan(before);
    // About a page rendered under another step-up, the answer is no.
    expect(await patientPageStatus(clinic.slug, randomUUID())).toEqual({ ok: false });
    expect(await keepPatientPageOpen(clinic.slug, randomUUID())).toEqual({ ok: false });

    // Sixteen minutes idle: closed, and neither question brings it back.
    const away = await signIn(clinic.staffUserId);
    browse(away, `/c/${clinic.slug}/conversations`);
    const awayId = await agedStepUp(away, factorId, {
      createdMinutesAgo: 30,
      activeMinutesAgo: 16,
    });
    expect((await outcome(() => requirePatientPage(clinic.slug))).ok).toBe(false);
    expect(await patientPageStatus(clinic.slug, awayId)).toEqual({ ok: false });
    expect(await keepPatientPageOpen(clinic.slug, awayId)).toEqual({ ok: false });
    const stale = await pool.query<{ s: string }>(
      `select extract(epoch from (now() - last_activity_at)) as s from step_ups where id = $1`,
      [awayId],
    );
    expect(Number(stale.rows[0]!.s)).toBeGreaterThan(15 * 60);

    // Five minutes short of eight hours: open, but only until the eight hours,
    // whatever "Keep open" asks, and the page is told so.
    const late = await signIn(clinic.staffUserId);
    browse(late, `/c/${clinic.slug}/conversations`);
    const lateId = await agedStepUp(late, factorId, {
      createdMinutesAgo: 8 * 60 - 5,
      activeMinutesAgo: 1,
    });
    const capped = await outcome(() => requirePatientPage(clinic.slug));
    if (!capped.ok) throw new Error(capped.redirect);
    expect(capped.value.stepUp.capped).toBe(true);
    expect(left(capped.value.stepUp)).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(left(capped.value.stepUp)).toBeGreaterThan(4 * 60 * 1000);
    const keptLate = await keepPatientPageOpen(clinic.slug, lateId);
    expect(keptLate).toMatchObject({ ok: true, capped: true });
    expect(answerLeft(keptLate)).toBeLessThanOrEqual(5 * 60 * 1000);

    // Past eight hours: closed, however recently it was used.
    const done = await signIn(clinic.staffUserId);
    browse(done, `/c/${clinic.slug}/conversations`);
    const doneId = await agedStepUp(done, factorId, {
      createdMinutesAgo: 8 * 60 + 2,
      activeMinutesAgo: 3,
    });
    expect((await outcome(() => requirePatientPage(clinic.slug))).ok).toBe(false);
    expect(await keepPatientPageOpen(clinic.slug, doneId)).toEqual({ ok: false });
  });

  test("two requests touching at once both succeed, and activity never moves back", async () => {
    const clinic = await seedClinic("race");
    const { factorId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const link = await signIn(clinic.staffUserId);
    const id = await agedStepUp(link, factorId, { createdMinutesAgo: 5, activeMinutesAgo: 5 });

    // The first request's transaction begins first, so its now() is the
    // earlier; the second touches and commits before the first gets to it.
    const latest = await unsafeDb.transaction(async (first) => {
      await first.execute(sql`select now()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await findLiveStepUp(unsafeDb, link.binding, { touch: true });
      expect(second?.id).toBe(id);
      const touched = await findLiveStepUp(first, link.binding, { touch: true });
      expect(touched?.id).toBe(id);
      return second!.lastActivityAt.getTime();
    });
    const { rows } = await getMigratorPool().query<{ at: Date }>(
      `select last_activity_at as at from step_ups where id = $1`,
      [id],
    );
    expect(rows[0]!.at.getTime()).toBe(latest);
  });

  test("each open writes one access row naming the passkey and the device, and ids only", async () => {
    const clinic = await seedClinic("access");
    const other = await seedClinic("access-other");
    const mine = await seedConversation(clinic.clinicId, { startedAt: new Date(), booked: true });
    const theirs = await seedConversation(other.clinicId, { startedAt: new Date() });
    const { factorId, credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const link = await signIn(clinic.staffUserId);
    const granted = await stepUp(link.binding, credentialId);
    browse(link, `/c/${clinic.slug}/conversations/${mine.conversationId}`);

    const page = await requirePatientPage(clinic.slug);
    expect(page.portal).toEqual({
      userId: clinic.staffUserId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.slug,
    });
    expect(page.stepUp).toMatchObject({
      passkeyId: factorId,
      deviceLabel: "Front desk Mac",
      stepUpId: granted.id,
    });
    // What the guard gets: identifiers, and no clock of its own.
    expect(patientGuardProps(page)).toEqual({
      slug: clinic.slug,
      stepUpId: granted.id,
      renderId: page.request.requestId,
    });

    // One record: the row is written in the transaction that reads it.
    const shown = await withPatientPage(page, async (tx) => {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "conversation",
        resourceId: mine.conversationId,
      });
      // Not committed yet: it lands with the read, or not at all.
      expect(await auditRows(clinic.clinicId)).toEqual([]);
      const read = (id: string) =>
        tx.db
          .select({ id: conversations.id, outcome: conversations.outcome })
          .from(conversations)
          .where(eq(conversations.id, id));
      // Scoped to the page's clinic: another clinic's record is not there to read.
      expect(await read(theirs.conversationId)).toEqual([]);
      return read(mine.conversationId);
    });
    expect(shown).toEqual([{ id: mine.conversationId, outcome: "booked" }]);

    // A list as shown: one row for the list. An export: its own row.
    await withPatientPage(page, async (tx) => {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "appointment",
        resourceIds: [mine.appointmentId!],
      });
    });
    await withPatientPage(page, async (tx) => {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "booking_request",
        resourceIds: [],
      });
    });
    // A long list keeps every id it showed: no sample, no truncation.
    const many = Array.from({ length: 60 }, () => randomUUID());
    await withPatientPage(page, async (tx) => {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "booking_request",
        resourceIds: many,
      });
    });
    await withPatientPage(page, async (tx) => {
      await logPatientAccess(tx, {
        action: "export",
        resourceType: "clinic_bundle",
        resourceId: clinic.clinicId,
      });
    });

    const rows = await auditRows(clinic.clinicId);
    const common = {
      actor_type: "user",
      actor_user_id: clinic.staffUserId,
      actor_label: "Front desk Mac",
      ip_address: "203.0.113.7",
      user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      metadata: { passkeyId: factorId, stepUpId: granted.id },
      // Every row the page wrote carries its request id.
      request_id: page.request.requestId,
    };
    expect(rows).toEqual([
      {
        ...common,
        action: "read",
        resource_type: "conversation",
        resource_id: mine.conversationId,
        resource_ids: null,
        result_count: null,
      },
      {
        ...common,
        action: "read",
        resource_type: "appointment",
        resource_id: null,
        resource_ids: [mine.appointmentId],
        result_count: 1,
      },
      {
        ...common,
        action: "read",
        resource_type: "booking_request",
        resource_id: null,
        resource_ids: [],
        result_count: 0,
      },
      {
        ...common,
        action: "read",
        resource_type: "booking_request",
        resource_id: null,
        resource_ids: many,
        result_count: 60,
      },
      {
        ...common,
        action: "export",
        resource_type: "clinic_bundle",
        resource_id: clinic.clinicId,
        resource_ids: null,
        result_count: null,
      },
    ]);
    expect(await auditRows(other.clinicId)).toEqual([]);
  });

  test("no record leaves without its row, and nothing but an id goes in one", async () => {
    const clinic = await seedClinic("norow");
    const other = await seedClinic("norow-other");
    const { credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const link = await signIn(clinic.staffUserId);
    await stepUp(link.binding, credentialId);
    browse(link, `/c/${clinic.slug}/bookings`);
    const page = await requirePatientPage(clinic.slug);

    // A read that forgets the row returns nothing.
    await expect(withPatientPage(page, async () => "a booking request")).rejects.toBeInstanceOf(
      PatientAccessNotLoggedError,
    );

    // Only a known record type, a read or an export, and UUIDs.
    const id = "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f";
    for (const bad of [
      { action: "read", resourceType: "booking_request", resourceId: "+1 415 555 0100" },
      { action: "read", resourceType: "booking_request", resourceIds: [id, "Jane Doe"] },
      { action: "read", resourceType: "contact", resourceId: id },
      { action: "update", resourceType: "booking_request", resourceId: id },
      { action: "read", resourceType: "booking_request" },
      { action: "read", resourceType: "booking_request", resourceId: id, resourceIds: [id] },
      {
        action: "read",
        resourceType: "booking_request",
        resourceIds: Array.from({ length: MAX_PATIENT_IDS_PER_ROW + 1 }, () => id),
      },
    ]) {
      await expect(
        withPatientPage(page, (tx) => logPatientAccess(tx, bad as never)),
        JSON.stringify(bad),
      ).rejects.toThrow();
    }

    // A read that fails after its row takes the row with it: nothing was shown.
    await expect(
      withPatientPage(page, async (tx) => {
        await logPatientAccess(tx, {
          action: "read",
          resourceType: "booking_request",
          resourceId: id,
        });
        throw new Error("the read failed");
      }),
    ).rejects.toThrow("the read failed");

    // A row goes only in a transaction withPatientPage opened: not in a plain
    // tenant transaction dressed up with the page, its clinic's or another's.
    for (const clinicId of [clinic.clinicId, other.clinicId]) {
      await expect(
        withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
          logPatientAccess(
            { ...tx, page },
            { action: "read", resourceType: "booking_request", resourceId: id },
          ),
        ),
      ).rejects.toThrow(/withPatientPage opened/);
    }

    expect(await auditRows(clinic.clinicId)).toEqual([]);
    expect(await auditRows(other.clinicId)).toEqual([]);
  });

  test("only a page requirePatientPage issued opens anything, and it cannot be changed", async () => {
    const victim = await seedClinic("victim");
    const attacker = await seedClinic("attacker");
    await seedConversation(victim.clinicId, { startedAt: new Date() });
    const { credentialId } = await addPasskey(attacker.staffUserId, "Front desk Mac");
    const link = await signIn(attacker.staffUserId);
    await stepUp(link.binding, credentialId);
    browse(link, `/c/${attacker.slug}/conversations`);
    const page = await requirePatientPage(attacker.slug);

    // The reviewer's forgery: the victim's clinic and a passkey that does not exist.
    const forged = {
      portal: { ...page.portal, clinicId: victim.clinicId },
      stepUp: { ...page.stepUp, passkeyId: randomUUID() },
      request: page.request,
    };
    let reads = 0;
    const read = async (tx: Parameters<Parameters<typeof withPatientPage>[1]>[0]) => {
      reads += 1;
      const rows = await tx.db.select({ id: conversations.id }).from(conversations);
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "conversation",
        resourceIds: rows.map((r) => r.id),
      });
      return rows;
    };
    await expect(withPatientPage(forged, read)).rejects.toThrow(/requirePatientPage issued/);
    // A copy of an issued page is not that page.
    await expect(withPatientPage({ ...page }, read)).rejects.toThrow(/requirePatientPage issued/);
    expect(() => patientGuardProps(forged)).toThrow(/requirePatientPage issued/);
    expect(reads).toBe(0);
    // And an issued page cannot be pointed somewhere else.
    expect(() => {
      (page.portal as { clinicId: string }).clinicId = victim.clinicId;
    }).toThrow(TypeError);
    expect(() => {
      (page.stepUp as { passkeyId: string }).passkeyId = randomUUID();
    }).toThrow(TypeError);
    expect(() => {
      (page as { portal: unknown }).portal = forged.portal;
    }).toThrow(TypeError);
    expect(page.portal.clinicId).toBe(attacker.clinicId);

    expect(await auditRows(victim.clinicId)).toEqual([]);
    expect(await auditRows(attacker.clinicId)).toEqual([]);
  });

  test("another clinic's sign-in gets not found, stepped up or not", async () => {
    const mine = await seedClinic("mine");
    const theirs = await seedClinic("theirs");
    const { credentialId } = await addPasskey(mine.staffUserId, "Front desk Mac");
    const link = await signIn(mine.staffUserId);
    browse(link, `/c/${theirs.slug}/conversations`);
    await expect(requirePatientPage(theirs.slug)).rejects.toThrow("NEXT_NOT_FOUND");
    await stepUp(link.binding, credentialId);
    await expect(requirePatientPage(theirs.slug)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(requirePatientPage("no-such-clinic")).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await requirePatientPage(mine.slug)).portal.clinicId).toBe(mine.clinicId);
  });

  test("signing out ends the step-up: even the same token, put back, opens nothing", async () => {
    const clinic = await seedClinic("signout");
    const { credentialId } = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const link = await signIn(clinic.staffUserId);
    await stepUp(link.binding, credentialId);
    browse(link, `/c/${clinic.slug}/conversations`);
    expect((await outcome(() => requirePatientPage(clinic.slug))).ok).toBe(true);
    const row = await sessionRow(link.token);

    await auth.api.signOut({ headers: new Headers({ cookie: link.cookie }) });
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });

    // Were the session to come back, its step-up would not.
    await restoreSession(row);
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/conversations`)}`,
    });
  });

  test("removing a device's passkey ends the pages it opened, and only those", async () => {
    const clinic = await seedClinic("removal");
    const phoneKey = await addPasskey(clinic.staffUserId, "Maria's iPhone");
    const macKey = await addPasskey(clinic.staffUserId, "Front desk Mac");
    const phone = await signIn(clinic.staffUserId);
    const mac = await signIn(clinic.staffUserId);
    const phoneStep = await stepUp(phone.binding, phoneKey.credentialId);
    await stepUp(mac.binding, macKey.credentialId);

    browse(phone, `/c/${clinic.slug}/bookings`);
    expect((await requirePatientPage(clinic.slug)).stepUp.deviceLabel).toBe("Maria's iPhone");
    const phoneRow = await sessionRow(phone.token);

    // The phone is lost; the Mac removes its passkey.
    expect(await removePasskey({ session: mac.binding, factorId: phoneKey.factorId })).toEqual({
      ok: true,
      sessionsEnded: 1,
      endedThisSession: false,
    });

    browse(phone, `/c/${clinic.slug}/bookings`);
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${clinic.slug}`)}`,
    });
    await restoreSession(phoneRow);
    expect(await outcome(() => requirePatientPage(clinic.slug))).toEqual({
      ok: false,
      redirect: `/c/${clinic.slug}/step-up?next=${encodeURIComponent(`/c/${clinic.slug}/bookings`)}`,
    });
    expect(await patientPageStatus(clinic.slug, phoneStep.id)).toEqual({ ok: false });
    expect(await keepPatientPageOpen(clinic.slug, phoneStep.id)).toEqual({ ok: false });

    // The Mac's own step-up, made with its own passkey, stands.
    browse(mac, `/c/${clinic.slug}/bookings`);
    expect((await requirePatientPage(clinic.slug)).stepUp.deviceLabel).toBe("Front desk Mac");
  });
});

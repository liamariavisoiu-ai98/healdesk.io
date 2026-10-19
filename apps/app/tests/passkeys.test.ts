import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  removePasskey,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { enrolTotp, proposeTotp, totpStep } from "@/lib/factors/totp";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * Passkeys around @simplewebauthn/server (plan Part D3): OUR rules, with the
 * library's two verify functions replaced at the module boundary so each test
 * can say what the library concluded. The options are generated for real.
 * tests/passkeys-ceremony.test.ts runs the real verifiers end to end.
 *
 * What must hold: a challenge is spent once, by the session that asked, inside
 * five minutes; the first passkey needs only the session before go-live, and
 * every other needs a step-up on this session or a code; a revoked passkey and
 * a counter going backwards are refused; the device's name is stored and
 * snapshotted into the step-up; removing a device needs a step-up and takes
 * the sessions it vouched for with it.
 */

const mocks = vi.hoisted(() => ({
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: mocks.verifyRegistrationResponse,
    verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A browser's registration response for `challenge`, as far as our code reads it. */
function registrationResponse(challenge: string, credentialId = b64(randomBytes(16))) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN })),
      attestationObject: b64(randomBytes(64)),
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: {},
  };
}

function authenticationResponse(challenge: string, credentialId: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: b64(JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN })),
      authenticatorData: b64(randomBytes(37)),
      signature: b64(randomBytes(64)),
    },
    clientExtensionResults: {},
  };
}

/** What the library concludes about a registration: verified, user verified, this credential. */
function registers(
  credentialId: string,
  overrides: { verified?: boolean; userVerified?: boolean } = {},
) {
  mocks.verifyRegistrationResponse.mockResolvedValueOnce(
    overrides.verified === false
      ? { verified: false }
      : {
          verified: true,
          registrationInfo: {
            fmt: "none",
            aaguid: "00000000-0000-0000-0000-000000000000",
            credential: {
              id: credentialId,
              publicKey: new Uint8Array(randomBytes(77)),
              counter: 0,
              transports: ["internal", "hybrid"],
            },
            credentialType: "public-key",
            attestationObject: new Uint8Array(1),
            userVerified: overrides.userVerified ?? true,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: true,
            origin: ORIGIN,
            rpID: "localhost",
          },
        },
  );
}

function asserts(credentialId: string, newCounter: number, userVerified = true) {
  mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter,
      userVerified,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  });
}

function binding(userId: string): SessionBinding {
  return { userId, sessionTokenHash: hashSessionToken(randomBytes(24).toString("base64url")) };
}

/** Add a passkey the way a browser would: options, then a (mock-verified) response. */
async function addPasskey(session: SessionBinding, label = "Front desk Mac", code?: string) {
  const started = await startPasskeyRegistration({ session, code });
  if (!started.ok) return { started, finished: null, credentialId: null };
  const credentialId = b64(randomBytes(16));
  registers(credentialId);
  const finished = await finishPasskeyRegistration({
    session,
    response: registrationResponse(started.options.challenge, credentialId),
    deviceLabel: label,
  });
  return { started, finished, credentialId };
}

async function stepUpWith(session: SessionBinding, credentialId: string, newCounter: number) {
  const started = await startPasskeyAuthentication({ session });
  if (!started.ok) throw new Error(started.reason);
  asserts(credentialId, newCounter);
  return finishPasskeyAuthentication({
    session,
    response: authenticationResponse(started.options.challenge, credentialId),
  });
}

/** An independent RFC 4226 code for a base32 secret. */
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

describeDb("passkeys", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.verifyRegistrationResponse.mockReset();
    mocks.verifyAuthenticationResponse.mockReset();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the sign-in's first passkey needs only the session, and is stored under the name given", async () => {
    const clinic = await seedClinic("first");
    const session = binding(clinic.staffUserId);

    const started = await startPasskeyRegistration({ session });
    expect(started).toMatchObject({ ok: true, basis: "first_passkey" });
    if (!started.ok) return;
    expect(started.options.rp).toEqual({ name: "healdesk", id: "localhost" });
    expect(started.options.authenticatorSelection).toMatchObject({ userVerification: "required" });
    // Left open, so the browser offers the phone's QR flow beside this device.
    expect(started.options.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
    expect(started.options.excludeCredentials).toEqual([]);
    expect(started.options.user.name).toBe(clinic.staffEmail);
    expect(started.options.user.id).not.toContain(clinic.staffUserId);

    const credentialId = b64(randomBytes(16));
    registers(credentialId);
    const finished = await finishPasskeyRegistration({
      session,
      response: registrationResponse(started.options.challenge, credentialId),
      deviceLabel: "  Front   desk Mac ",
    });
    expect(finished).toMatchObject({ ok: true, deviceLabel: "Front desk Mac" });
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: started.options.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: "localhost",
        requireUserVerification: true,
        requireUserPresence: true,
      }),
    );

    const pool = getMigratorPool();
    const { rows } = await pool.query<{
      id: string;
      device_label: string;
      credential_id: string;
      counter: string;
      transports: string[];
      backed_up: boolean;
    }>(
      `select id, device_label, credential_id, counter, transports, backed_up from user_factors where user_id = $1`,
      [clinic.staffUserId],
    );
    expect(rows).toEqual([
      {
        id: expect.any(String),
        device_label: "Front desk Mac",
        credential_id: credentialId,
        counter: "0",
        transports: ["internal", "hybrid"],
        backed_up: true,
      },
    ]);
    // Making it took the same unlock as a step-up: this session is stepped up at once, named.
    const stepUps = await pool.query<{
      factor_id: string;
      device_label: string;
      session_token_hash: Buffer;
    }>(`select factor_id, device_label, session_token_hash from step_ups where user_id = $1`, [
      clinic.staffUserId,
    ]);
    expect(stepUps.rows).toEqual([
      {
        factor_id: rows[0]!.id,
        device_label: "Front desk Mac",
        session_token_hash: session.sessionTokenHash,
      },
    ]);
    const events = await pool.query<{ event: string; metadata: Record<string, unknown> }>(
      `select event, metadata from security_events where user_id = $1 order by occurred_at, event`,
      [clinic.staffUserId],
    );
    expect(events.rows.map((r) => r.event).sort()).toEqual(["passkey_added", "step_up_granted"]);
    expect(events.rows.find((r) => r.event === "passkey_added")?.metadata).toMatchObject({
      basis: "first_passkey",
    });
  });

  test("a challenge is spent once, only by the session that asked, for its own purpose, within five minutes", async () => {
    const clinic = await seedClinic("challenge");
    const session = binding(clinic.staffUserId);
    const other = binding(clinic.staffUserId);
    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);
    const credentialId = b64(randomBytes(16));
    const response = registrationResponse(started.options.challenge, credentialId);

    // Another session of the same sign-in can't use it, and doesn't use it up.
    expect(
      await finishPasskeyRegistration({ session: other, response, deviceLabel: "Mac" }),
    ).toEqual({
      ok: false,
      reason: "challenge",
    });
    registers(credentialId);
    expect((await finishPasskeyRegistration({ session, response, deviceLabel: "Mac" })).ok).toBe(
      true,
    );
    // Spent.
    registers(credentialId);
    expect(await finishPasskeyRegistration({ session, response, deviceLabel: "Mac" })).toEqual({
      ok: false,
      reason: "challenge",
    });

    // A step-up's challenge can't register a device.
    const auth = await startPasskeyAuthentication({ session });
    if (!auth.ok) throw new Error(auth.reason);
    expect(
      await finishPasskeyRegistration({
        session,
        response: registrationResponse(auth.options.challenge),
        deviceLabel: "Mac",
      }),
    ).toEqual({ ok: false, reason: "challenge" });

    // Five minutes old: dead. Written already expired, since nobody may move an expiry.
    const stale = randomBytes(32).toString("base64url");
    await getMigratorPool().query(
      `insert into webauthn_challenges (user_id, session_token_hash, purpose, challenge, enrol_basis, created_at, expires_at)
       values ($1, $2, 'register', $3, 'step_up', now() - interval '6 minutes', now() - interval '1 minute')`,
      [clinic.staffUserId, session.sessionTokenHash, stale],
    );
    expect(
      await finishPasskeyRegistration({
        session,
        response: registrationResponse(stale),
        deviceLabel: "Mac",
      }),
    ).toEqual({
      ok: false,
      reason: "challenge",
    });
    // Nothing reached the library for any of the refusals.
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  test("a second device needs a step-up on this session or a code; the first device did not", async () => {
    const clinic = await seedClinic("second");
    const front = binding(clinic.staffUserId);
    const first = await addPasskey(front, "Front desk Mac");
    expect(first.finished?.ok).toBe(true);

    const phone = binding(clinic.staffUserId);
    expect(await startPasskeyRegistration({ session: phone })).toEqual({
      ok: false,
      reason: "needs_step_up",
    });
    expect(await startPasskeyRegistration({ session: phone, code: "000000" })).toEqual({
      ok: false,
      reason: "code_incorrect",
    });

    // A step-up on the phone's session (the Mac's passkey, over the QR flow) lets it add itself.
    expect((await stepUpWith(phone, first.credentialId!, 0)).ok).toBe(true);
    const viaStepUp = await addPasskey(phone, "Maria's iPhone");
    expect(viaStepUp.started).toMatchObject({ ok: true, basis: "step_up" });
    expect(viaStepUp.finished?.ok).toBe(true);
    // The devices it already has are excluded, so one device isn't added twice.
    const again = await startPasskeyRegistration({ session: phone });
    if (!again.ok) throw new Error(again.reason);
    expect(again.options.excludeCredentials?.map((c) => c.id).sort()).toEqual(
      [first.credentialId!, viaStepUp.credentialId!].sort(),
    );

    // The authenticator-app route, enrolled under the Mac's step-up.
    const proposal = proposeTotp({ userId: clinic.staffUserId, email: clinic.staffEmail });
    // Enrolled one step back, so the current step's code is unspent whichever
    // side of a thirty-second boundary the check below lands.
    const now = new Date();
    const step = totpStep(now);
    const enrolled = await enrolTotp({
      userId: clinic.staffUserId,
      sessionTokenHash: front.sessionTokenHash,
      proposal: proposal.proposal,
      code: codeFor(proposal.secret, step - 1),
      at: now,
    });
    expect(enrolled.ok).toBe(true);
    const tablet = binding(clinic.staffUserId);
    const viaCode = await addPasskey(tablet, "Back office iPad", codeFor(proposal.secret, step));
    expect(viaCode.started).toMatchObject({ ok: true, basis: "code" });
    expect(viaCode.finished?.ok).toBe(true);

    const { rows } = await getMigratorPool().query<{ device_label: string }>(
      `select device_label from user_factors where user_id = $1 and kind = 'passkey' order by created_at`,
      [clinic.staffUserId],
    );
    expect(rows.map((r) => r.device_label)).toEqual([
      "Front desk Mac",
      "Maria's iPhone",
      "Back office iPad",
    ]);
  });

  test("once a clinic is live, even a first passkey needs more than a sign-in link", async () => {
    const clinic = await seedClinic("live");
    await getMigratorPool().query(`update clinics set went_live_at = now() where id = $1`, [
      clinic.clinicId,
    ]);
    // With no passkey to step up with, the refusal says so (`no_device`), so
    // the Protect page offers the backup code and the human route rather
    // than a step-up that could only send it back (wave 2, R4).
    expect(await startPasskeyRegistration({ session: binding(clinic.staffUserId) })).toEqual({
      ok: false,
      reason: "no_device",
    });

    // And a "first passkey" challenge issued before go-live is refused after it.
    const before = await seedClinic("golive");
    const session = binding(before.staffUserId);
    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production' where id = $1`,
      [before.clinicId],
    );
    const credentialId = b64(randomBytes(16));
    registers(credentialId);
    expect(
      await finishPasskeyRegistration({
        session,
        response: registrationResponse(started.options.challenge, credentialId),
        deviceLabel: "Mac",
      }),
    ).toEqual({ ok: false, reason: "needs_step_up" });
  });

  test("two browsers racing to add the 'first' passkey: one is first, the other must step up", async () => {
    const clinic = await seedClinic("race");
    const a = binding(clinic.staffUserId);
    const b = binding(clinic.staffUserId);
    const [startA, startB] = await Promise.all([
      startPasskeyRegistration({ session: a }),
      startPasskeyRegistration({ session: b }),
    ]);
    if (!startA.ok || !startB.ok) throw new Error("both should start as first");
    const idA = b64(randomBytes(16));
    const idB = b64(randomBytes(16));
    mocks.verifyRegistrationResponse.mockImplementation(
      async ({ response }: { response: { id: string } }) => ({
        verified: true,
        registrationInfo: {
          credential: {
            id: response.id,
            publicKey: new Uint8Array(randomBytes(77)),
            counter: 0,
            transports: [],
          },
          userVerified: true,
          credentialBackedUp: false,
        },
      }),
    );
    const results = await Promise.all([
      finishPasskeyRegistration({
        session: a,
        response: registrationResponse(startA.options.challenge, idA),
        deviceLabel: "A",
      }),
      finishPasskeyRegistration({
        session: b,
        response: registrationResponse(startB.options.challenge, idB),
        deviceLabel: "B",
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "needs_step_up" }]);
  });

  test("no passkey is stored without verification, user verification, a valid name, or a new credential", async () => {
    const clinic = await seedClinic("refused");
    const session = binding(clinic.staffUserId);
    const attempt = async (setup: () => void, label: unknown = "Mac") => {
      const started = await startPasskeyRegistration({ session });
      if (!started.ok) throw new Error(started.reason);
      setup();
      return finishPasskeyRegistration({
        session,
        response: registrationResponse(started.options.challenge),
        deviceLabel: label,
      });
    };
    expect(await attempt(() => registers("x", { verified: false }))).toEqual({
      ok: false,
      reason: "not_verified",
    });
    expect(await attempt(() => registers("y", { userVerified: false }))).toEqual({
      ok: false,
      reason: "not_verified",
    });
    expect(
      await attempt(() =>
        mocks.verifyRegistrationResponse.mockRejectedValueOnce(new Error("Unexpected origin")),
      ),
    ).toEqual({
      ok: false,
      reason: "not_verified",
    });
    for (const label of ["", "x".repeat(61), "Front\u202edesk", 42]) {
      expect(await attempt(() => undefined, label), JSON.stringify(label)).toEqual({
        ok: false,
        reason: "label_invalid",
      });
    }
    expect(
      await finishPasskeyRegistration({ session, response: { id: "x" }, deviceLabel: "Mac" }),
    ).toEqual({
      ok: false,
      reason: "not_verified",
    });
    const { rows } = await getMigratorPool().query(
      `select 1 from user_factors where user_id = $1`,
      [clinic.staffUserId],
    );
    expect(rows).toHaveLength(0);

    // A credential already on file is refused, not stored twice.
    const added = await addPasskey(session);
    expect(added.finished?.ok).toBe(true);
    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);
    registers(added.credentialId!);
    expect(
      await finishPasskeyRegistration({
        session,
        response: registrationResponse(started.options.challenge, added.credentialId!),
        deviceLabel: "Mac again",
      }),
    ).toEqual({ ok: false, reason: "already_registered" });
  });

  test("a step-up asks for user verification on this sign-in's passkeys, and records the device", async () => {
    const clinic = await seedClinic("stepup");
    const added = await addPasskey(binding(clinic.staffUserId), "Front desk Mac");
    const session = binding(clinic.staffUserId);

    const started = await startPasskeyAuthentication({ session });
    if (!started.ok) throw new Error(started.reason);
    expect(started.options.userVerification).toBe("required");
    expect(started.options.allowCredentials).toEqual([
      { id: added.credentialId, type: "public-key", transports: ["internal", "hybrid"] },
    ]);
    asserts(added.credentialId!, 5);
    const finished = await finishPasskeyAuthentication({
      session,
      response: authenticationResponse(started.options.challenge, added.credentialId!),
    });
    expect(finished).toMatchObject({ ok: true, stepUp: { deviceLabel: "Front desk Mac" } });
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requireUserVerification: true,
        expectedOrigin: ORIGIN,
        expectedRPID: "localhost",
      }),
    );
    const { rows } = await getMigratorPool().query<{ counter: string; last_used_at: Date | null }>(
      `select counter, last_used_at from user_factors where credential_id = $1`,
      [added.credentialId],
    );
    expect(rows[0]!.counter).toBe("5");
    expect(rows[0]!.last_used_at).not.toBeNull();

    // No user verification: refused.
    const again = await startPasskeyAuthentication({ session });
    if (!again.ok) throw new Error(again.reason);
    asserts(added.credentialId!, 6, false);
    expect(
      await finishPasskeyAuthentication({
        session,
        response: authenticationResponse(again.options.challenge, added.credentialId!),
      }),
    ).toEqual({ ok: false, reason: "not_verified" });
  });

  test("a counter that does not move forward is a copy, and refused; two zeros are a synced passkey", async () => {
    const clinic = await seedClinic("counter");
    const added = await addPasskey(binding(clinic.staffUserId));
    const session = binding(clinic.staffUserId);

    expect((await stepUpWith(session, added.credentialId!, 0)).ok).toBe(true);
    expect((await stepUpWith(session, added.credentialId!, 0)).ok).toBe(true);
    expect((await stepUpWith(session, added.credentialId!, 9)).ok).toBe(true);
    expect(await stepUpWith(session, added.credentialId!, 9)).toEqual({
      ok: false,
      reason: "counter",
    });
    expect(await stepUpWith(session, added.credentialId!, 4)).toEqual({
      ok: false,
      reason: "counter",
    });
    expect(await stepUpWith(session, added.credentialId!, 0)).toEqual({
      ok: false,
      reason: "counter",
    });

    const { rows } = await getMigratorPool().query<{ counter: string }>(
      `select counter from user_factors where credential_id = $1`,
      [added.credentialId],
    );
    expect(rows[0]!.counter).toBe("9");
    const stepUps = await getMigratorPool().query(
      `select 1 from step_ups where session_token_hash = $1`,
      [session.sessionTokenHash],
    );
    expect(stepUps.rows).toHaveLength(3);
  });

  test("a revoked passkey, or another sign-in's, steps nobody up", async () => {
    const clinic = await seedClinic("revoked");
    const added = await addPasskey(binding(clinic.staffUserId));
    const stranger = await seedClinic("stranger");
    const theirs = await addPasskey(binding(stranger.staffUserId));
    const session = binding(clinic.staffUserId);

    const started = await startPasskeyAuthentication({ session });
    if (!started.ok) throw new Error(started.reason);
    expect(
      await finishPasskeyAuthentication({
        session,
        response: authenticationResponse(started.options.challenge, theirs.credentialId!),
      }),
    ).toEqual({ ok: false, reason: "unknown_credential" });

    await getMigratorPool().query(
      `update user_factors set revoked_at = now() where credential_id = $1`,
      [added.credentialId],
    );
    // Revoked: not offered, and refused if presented anyway.
    expect(await startPasskeyAuthentication({ session })).toEqual({
      ok: false,
      reason: "no_passkey",
    });
    const stale = randomBytes(32).toString("base64url");
    await getMigratorPool().query(
      `insert into webauthn_challenges (user_id, session_token_hash, purpose, challenge, expires_at)
       values ($1, $2, 'authenticate', $3, now() + interval '5 minutes')`,
      [clinic.staffUserId, session.sessionTokenHash, stale],
    );
    asserts(added.credentialId!, 50);
    expect(
      await finishPasskeyAuthentication({
        session,
        response: authenticationResponse(stale, added.credentialId!),
      }),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test("removing a device needs a step-up, and ends its step-ups and the sessions that stepped up with it", async () => {
    const clinic = await seedClinic("remove");
    const pool = getMigratorPool();
    const token = (label: string) => `${label}-${randomUUID()}`;
    const tokens = { mac: token("mac"), phone: token("phone"), bystander: token("bystander") };
    for (const value of Object.values(tokens)) {
      await pool.query(
        `insert into session (id, expires_at, token, created_at, updated_at, user_id)
         values ($1, now() + interval '14 days', $2, now(), now(), $3)`,
        [randomUUID(), value, clinic.staffUserId],
      );
    }
    const mac: SessionBinding = {
      userId: clinic.staffUserId,
      sessionTokenHash: hashSessionToken(tokens.mac),
    };
    const phone: SessionBinding = {
      userId: clinic.staffUserId,
      sessionTokenHash: hashSessionToken(tokens.phone),
    };
    const bystander: SessionBinding = {
      userId: clinic.staffUserId,
      sessionTokenHash: hashSessionToken(tokens.bystander),
    };

    const macKey = await addPasskey(mac, "Front desk Mac");
    expect((await stepUpWith(phone, macKey.credentialId!, 0)).ok).toBe(true);
    const phoneKey = await addPasskey(phone, "Maria's iPhone");
    const phoneFactor = phoneKey.finished?.ok ? phoneKey.finished.factorId : "";

    // Without a step-up on this session: no.
    expect(await removePasskey({ session: bystander, factorId: phoneFactor })).toEqual({
      ok: false,
      reason: "needs_step_up",
    });

    // The Mac removes the phone's passkey: the phone's session stepped up with it, and ends.
    const removed = await removePasskey({ session: mac, factorId: phoneFactor });
    expect(removed).toEqual({ ok: true, sessionsEnded: 1, endedThisSession: false });
    const sessions = await pool.query<{ token: string }>(
      `select token from session where user_id = $1 order by token`,
      [clinic.staffUserId],
    );
    expect(sessions.rows.map((r) => r.token).sort()).toEqual([tokens.bystander, tokens.mac].sort());
    const live = await pool.query<{ device_label: string }>(
      `select device_label from step_ups where user_id = $1 and revoked_at is null`,
      [clinic.staffUserId],
    );
    expect(live.rows.map((r) => r.device_label)).toEqual(["Front desk Mac"]);
    const event = await pool.query<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = 'passkey_removed' and user_id = $1`,
      [clinic.staffUserId],
    );
    expect(event.rows[0]!.metadata).toMatchObject({ factorId: phoneFactor, sessionsEnded: 1 });

    // Gone means gone: a second removal finds nothing, and the passkey steps nobody up.
    expect(await removePasskey({ session: mac, factorId: phoneFactor })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await removePasskey({ session: mac, factorId: "not-a-uuid" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("the user handle", () => {
  test("is not our user id", () => {
    // Recomputed here so a change of derivation is a decision, not an accident.
    const handle = createHash("sha256")
      .update("healdesk.webauthn.user.v1|usr_123")
      .digest("base64url");
    expect(handle).not.toContain("usr_123");
  });
});

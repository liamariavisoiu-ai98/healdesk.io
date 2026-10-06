import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * The passkey ceremonies end to end, through the REAL @simplewebauthn/server
 * verifiers: no mocks. A software authenticator is built here from the
 * WebAuthn spec (a P-256 key, a "none" attestation, ES256 assertions over
 * authenticatorData and the hash of clientDataJSON), CBOR-encoded with the
 * library's own isoCBOR helper; the library ships no test authenticator.
 *
 * tests/passkeys.test.ts covers our rules with the verifiers stubbed; this
 * file proves that what we pass the library, and what we store from it, make
 * a real passkey register and step up, and that the library's own refusals
 * (no user verification, the wrong origin, a signature from another key, a
 * counter going backwards) reach the caller as refusals.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "http://localhost:3001";
const RP_ID = "localhost";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** A software authenticator holding one P-256 credential. */
class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #key: KeyObject;
  readonly #public: KeyObject;
  counter: number;

  constructor(counter = 0) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#key = pair.privateKey;
    this.#public = pair.publicKey;
    this.counter = counter;
  }

  /** The credential's public key as COSE_Key (RFC 9053): EC2, ES256, P-256. */
  #coseKey(): Uint8Array {
    const jwk = this.#public.export({ format: "jwk" });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ]),
    );
  }

  #authData(flags: number, attested: boolean): Buffer {
    const parts = [
      createHash("sha256").update(RP_ID).digest(),
      Buffer.from([flags]),
      Buffer.alloc(4),
    ];
    parts[2]!.writeUInt32BE(this.counter);
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.#coseKey()));
    }
    return Buffer.concat(parts);
  }

  create(challenge: string, options: { flags?: number } = {}) {
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    });
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        [
          "authData",
          new Uint8Array(this.#authData(options.flags ?? FLAG_UP | FLAG_UV | FLAG_AT, true)),
        ],
      ]) as Parameters<typeof isoCBOR.encode>[0],
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64(clientDataJSON),
        attestationObject: b64(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(challenge: string, options: { flags?: number; origin?: string; signWith?: KeyObject } = {}) {
    this.counter += 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: options.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const authenticatorData = this.#authData(options.flags ?? FLAG_UP | FLAG_UV, false);
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientDataJSON).digest(),
    ]);
    const signature = sign("sha256", signed, options.signWith ?? this.#key);
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
      },
      clientExtensionResults: {},
    };
  }
}

function binding(userId: string): SessionBinding {
  return { userId, sessionTokenHash: hashSessionToken(randomBytes(24).toString("base64url")) };
}

async function challengeFor(session: SessionBinding): Promise<string> {
  const started = await startPasskeyAuthentication({ session });
  if (!started.ok) throw new Error(started.reason);
  return started.options.challenge;
}

describeDb("passkey ceremonies, through the real verifiers", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a real passkey registers under its name, then steps a session up as its counter moves", async () => {
    const clinic = await seedClinic("ceremony");
    const device = new SoftAuthenticator();
    const session = binding(clinic.staffUserId);

    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);
    const registered = await finishPasskeyRegistration({
      session,
      response: device.create(started.options.challenge),
      deviceLabel: "Front desk Mac",
    });
    expect(registered).toMatchObject({ ok: true, deviceLabel: "Front desk Mac" });

    const { rows } = await getMigratorPool().query<{
      credential_id: string;
      counter: string;
      transports: string[];
    }>(`select credential_id, counter, transports from user_factors where user_id = $1`, [
      clinic.staffUserId,
    ]);
    expect(rows).toEqual([
      { credential_id: b64(device.credentialId), counter: "0", transports: ["internal"] },
    ]);

    const later = binding(clinic.staffUserId);
    const first = await finishPasskeyAuthentication({
      session: later,
      response: device.get(await challengeFor(later)),
    });
    expect(first).toMatchObject({ ok: true, stepUp: { deviceLabel: "Front desk Mac" } });
    const second = await finishPasskeyAuthentication({
      session: later,
      response: device.get(await challengeFor(later)),
    });
    expect(second.ok).toBe(true);
    const counter = await getMigratorPool().query<{ counter: string }>(
      `select counter from user_factors where user_id = $1`,
      [clinic.staffUserId],
    );
    expect(counter.rows[0]!.counter).toBe("2");

    // The same signed assertion again: its challenge is spent.
    const challenge = await challengeFor(later);
    const assertion = device.get(challenge);
    expect((await finishPasskeyAuthentication({ session: later, response: assertion })).ok).toBe(
      true,
    );
    expect(await finishPasskeyAuthentication({ session: later, response: assertion })).toEqual({
      ok: false,
      reason: "challenge",
    });
  });

  test("the library's refusals stay refusals: no user verification, another origin, another key, a counter wound back", async () => {
    const clinic = await seedClinic("refusals");
    const device = new SoftAuthenticator();
    const session = binding(clinic.staffUserId);

    // Registration without user verification (a tap, not Face ID).
    const noUv = await startPasskeyRegistration({ session });
    if (!noUv.ok) throw new Error(noUv.reason);
    expect(
      await finishPasskeyRegistration({
        session,
        response: device.create(noUv.options.challenge, { flags: FLAG_UP | FLAG_AT }),
        deviceLabel: "Mac",
      }),
    ).toEqual({ ok: false, reason: "not_verified" });

    const started = await startPasskeyRegistration({ session });
    if (!started.ok) throw new Error(started.reason);
    expect(
      (
        await finishPasskeyRegistration({
          session,
          response: device.create(started.options.challenge),
          deviceLabel: "Mac",
        })
      ).ok,
    ).toBe(true);

    const refuse = async (response: unknown) => finishPasskeyAuthentication({ session, response });
    expect(await refuse(device.get(await challengeFor(session), { flags: FLAG_UP }))).toEqual({
      ok: false,
      reason: "not_verified",
    });
    expect(
      await refuse(device.get(await challengeFor(session), { origin: "https://evil.example" })),
    ).toEqual({
      ok: false,
      reason: "not_verified",
    });
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(await refuse(device.get(await challengeFor(session), { signWith: stranger }))).toEqual({
      ok: false,
      reason: "not_verified",
    });

    // A genuine assertion moves the counter on; a clone still at an older count is refused.
    device.counter = 10;
    expect((await refuse(device.get(await challengeFor(session)))).ok).toBe(true);
    device.counter = 3;
    expect((await refuse(device.get(await challengeFor(session)))).ok).toBe(false);
    const { rows } = await getMigratorPool().query<{ counter: string }>(
      `select counter from user_factors where user_id = $1`,
      [clinic.staffUserId],
    );
    expect(rows[0]!.counter).toBe("11");
  });
});

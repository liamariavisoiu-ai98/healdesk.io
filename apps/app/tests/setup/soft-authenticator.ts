import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software WebAuthn authenticator for the journey test
 * (tests/e2e-journey.test.ts): one P-256 credential, a "none" attestation and
 * ES256 assertions, built from the WebAuthn spec exactly as
 * tests/passkeys-ceremony.test.ts builds its own, so the REAL
 * @simplewebauthn/server verifiers check what it answers. It replaces the
 * browser and the device's secure enclave only; nothing on the server side is
 * stubbed. The origin and relying party are BETTER_AUTH_URL's localhost.
 */

export const SOFT_ORIGIN = "http://localhost:3001";
const RP_ID = "localhost";
const ORIGIN = SOFT_ORIGIN;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** A software authenticator holding one P-256 credential. */
export class SoftAuthenticator {
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

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getKeyWrapper } from "./kms";

/**
 * Envelope encryption for per-clinic third-party credentials.
 *
 * The payload is sealed with AES-256-GCM under a per-credential data key; that
 * key is wrapped by a KMS key (see kms.ts). We unseal in the application, never
 * in the database — pgcrypto would put the key into SQL, where it lands in
 * pg_stat_activity and query logs, and HIPAA mode on some hosts *requires*
 * query logging stay on.
 *
 * ## The AAD is the part that matters
 *
 * GCM's additional authenticated data is bound to {clinicId, credentialId}. It
 * isn't encrypted — it's authenticated, so decryption fails if it doesn't match.
 *
 * Without it, anyone who can write to provider_connections could copy clinic
 * A's ciphertext row into clinic B's and the app would decrypt it happily:
 * every field needed to unseal travels with the row. With it, the ciphertext is
 * useless anywhere but the row it was created for.
 *
 * This is the single easiest thing to leave out and the most expensive to omit.
 */

export const CURRENT_AAD_VERSION = 1;

export type SealedPayload = {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  keyVersion: string;
  aadVersion: number;
};

export type CredentialIdentity = {
  clinicId: string;
  credentialId: string;
};

export function buildAad(
  identity: CredentialIdentity,
  version: number = CURRENT_AAD_VERSION,
): Buffer {
  // Field-separated and version-prefixed so the encoding can evolve without
  // silently changing what a given AAD means.
  return Buffer.from(
    `v${version}|clinic:${identity.clinicId}|credential:${identity.credentialId}`,
    "utf8",
  );
}

export async function seal(
  plaintext: string,
  identity: CredentialIdentity,
): Promise<SealedPayload> {
  const wrapper = getKeyWrapper();
  const { dek, wrapped } = await wrapper.generateDek();

  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(buildAad(identity));

    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    return {
      ciphertext: body.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      wrappedDek: wrapped.wrapped,
      keyVersion: wrapped.keyVersion,
      aadVersion: CURRENT_AAD_VERSION,
    };
  } finally {
    // Best-effort: don't leave the key sitting in a reachable buffer.
    dek.fill(0);
  }
}

export async function open(
  sealed: SealedPayload,
  identity: CredentialIdentity,
): Promise<string> {
  const wrapper = getKeyWrapper();
  const dek = await wrapper.unwrapDek({
    wrapped: sealed.wrappedDek,
    keyVersion: sealed.keyVersion,
  });

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(sealed.iv, "base64url"),
    );
    decipher.setAAD(buildAad(identity, sealed.aadVersion));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    // A GCM tag failure here usually means one of three things, and the
    // difference matters when debugging: wrong clinic, wrong credential row, or
    // genuine tampering. Never echo the ciphertext or the identity into logs.
    throw new Error(
      "Failed to decrypt credential: authentication tag mismatch. " +
        "The ciphertext does not belong to this clinic and credential, or has been altered.",
      { cause: error },
    );
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap a data key under the current KEK, leaving the ciphertext untouched.
 * This is the whole point of the DEK indirection: rotating keys rewrites a
 * 32-byte blob per row rather than re-encrypting every payload.
 *
 * It necessarily holds the DEK in memory briefly, so run it in a background
 * job, not a request handler. Returns the input unchanged if already current.
 */
export async function rewrap(sealed: SealedPayload): Promise<SealedPayload> {
  const wrapper = getKeyWrapper();
  if (sealed.keyVersion === wrapper.keyVersion) return sealed;

  const dek = await wrapper.unwrapDek({
    wrapped: sealed.wrappedDek,
    keyVersion: sealed.keyVersion,
  });

  try {
    const rewrapped = await wrapper.wrapExisting(dek);
    return {
      ...sealed,
      wrappedDek: rewrapped.wrapped,
      keyVersion: rewrapped.keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

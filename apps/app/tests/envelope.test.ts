import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { open, rewrap, seal } from "@/lib/crypto/envelope";
import { LocalKeyWrapper, __setKeyWrapperForTests } from "@/lib/crypto/kms";

const clinicA = randomUUID();
const clinicB = randomUUID();
const credential = randomUUID();

describe("envelope encryption", () => {
  test("round-trips a credential", async () => {
    const sealed = await seal("sk_live_secret", {
      clinicId: clinicA,
      credentialId: credential,
    });

    expect(sealed.ciphertext).not.toContain("sk_live_secret");

    const opened = await open(sealed, {
      clinicId: clinicA,
      credentialId: credential,
    });
    expect(opened).toBe("sk_live_secret");
  });

  test("REFUSES a ciphertext moved to another clinic", async () => {
    // The attack the AAD exists to stop: copy clinic A's encrypted row into
    // clinic B's. Every field needed to decrypt travels with the row, so
    // without AAD binding this would succeed.
    const sealed = await seal("sk_live_secret", {
      clinicId: clinicA,
      credentialId: credential,
    });

    await expect(
      open(sealed, { clinicId: clinicB, credentialId: credential }),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("REFUSES a ciphertext moved to another credential row", async () => {
    const sealed = await seal("sk_live_secret", {
      clinicId: clinicA,
      credentialId: credential,
    });

    await expect(
      open(sealed, { clinicId: clinicA, credentialId: randomUUID() }),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("REFUSES tampered ciphertext", async () => {
    const sealed = await seal("sk_live_secret", {
      clinicId: clinicA,
      credentialId: credential,
    });

    const raw = Buffer.from(sealed.ciphertext, "base64url");
    raw[0] = raw[0]! ^ 0xff;

    await expect(
      open(
        { ...sealed, ciphertext: raw.toString("base64url") },
        { clinicId: clinicA, credentialId: credential },
      ),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("each seal uses a distinct data key and IV", async () => {
    const identity = { clinicId: clinicA, credentialId: credential };
    const one = await seal("same-plaintext", identity);
    const two = await seal("same-plaintext", identity);

    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.iv).not.toBe(two.iv);
    expect(one.wrappedDek).not.toBe(two.wrappedDek);
  });

  test("rewrap changes the key version but preserves the plaintext", async () => {
    const identity = { clinicId: clinicA, credentialId: credential };
    const sealed = await seal("sk_live_secret", identity);

    // Swap in a wrapper with a different KEK, as a rotation would.
    const rotated = new LocalKeyWrapper(Buffer.alloc(32, 7).toString("base64"));
    const original = new LocalKeyWrapper(Buffer.alloc(32).toString("base64"));

    // Unwrap under the old key, re-wrap under the new one.
    const dek = await original.unwrapDek({
      wrapped: sealed.wrappedDek,
      keyVersion: sealed.keyVersion,
    });
    const rewrapped = await rotated.wrapExisting(dek);

    __setKeyWrapperForTests(rotated);
    try {
      const opened = await open(
        { ...sealed, wrappedDek: rewrapped.wrapped, keyVersion: rewrapped.keyVersion },
        identity,
      );
      expect(opened).toBe("sk_live_secret");

      // And rewrap() is a no-op once already on the current key.
      const current = { ...sealed, wrappedDek: rewrapped.wrapped, keyVersion: rewrapped.keyVersion };
      expect(await rewrap(current)).toBe(current);
    } finally {
      __setKeyWrapperForTests(undefined);
    }
  });
});

import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { open, rewrap, seal } from "@/lib/crypto/envelope";
import {
  LocalKeyWrapper,
  getKeyWrapper,
  __setKeyWrapperForTests,
  type KeyWrapper,
  type LockLabel,
} from "@/lib/crypto/kms";

const clinicA = randomUUID();
const clinicB = randomUUID();
const credential = randomUUID();

/**
 * One lock label for every test here, so each one varies only the AAD it is
 * about. What a different label does is tests/lock-labels.test.ts's subject.
 */
const label: LockLabel = { clinic: "7", login: "google_calendar" };

describe("envelope encryption", () => {
  test("round-trips a credential", async () => {
    const sealed = await seal(
      "sk_live_secret",
      { clinicId: clinicA, credentialId: credential },
      label,
    );

    expect(sealed.ciphertext).not.toContain("sk_live_secret");

    const opened = await open(sealed, { clinicId: clinicA, credentialId: credential }, label);
    expect(opened).toBe("sk_live_secret");
  });

  test("REFUSES a ciphertext moved to another clinic", async () => {
    // The attack the AAD exists to stop: copy clinic A's encrypted row into
    // clinic B's. Every field needed to decrypt travels with the row, so
    // without AAD binding this would succeed.
    const sealed = await seal(
      "sk_live_secret",
      { clinicId: clinicA, credentialId: credential },
      label,
    );

    await expect(
      open(sealed, { clinicId: clinicB, credentialId: credential }, label),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("REFUSES a ciphertext moved to another credential row", async () => {
    const sealed = await seal(
      "sk_live_secret",
      { clinicId: clinicA, credentialId: credential },
      label,
    );

    await expect(
      open(sealed, { clinicId: clinicA, credentialId: randomUUID() }, label),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("REFUSES tampered ciphertext", async () => {
    const sealed = await seal(
      "sk_live_secret",
      { clinicId: clinicA, credentialId: credential },
      label,
    );

    const raw = Buffer.from(sealed.ciphertext, "base64url");
    raw[0] = raw[0]! ^ 0xff;

    await expect(
      open(
        { ...sealed, ciphertext: raw.toString("base64url") },
        { clinicId: clinicA, credentialId: credential },
        label,
      ),
    ).rejects.toThrow(/authentication tag mismatch/);
  });

  test("each seal uses a distinct data key and IV", async () => {
    const identity = { clinicId: clinicA, credentialId: credential };
    const one = await seal("same-plaintext", identity, label);
    const two = await seal("same-plaintext", identity, label);

    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.iv).not.toBe(two.iv);
    expect(one.wrappedDek).not.toBe(two.wrappedDek);
  });

  test("rewrap moves a payload to the new key and preserves the plaintext", async () => {
    const identity = { clinicId: clinicA, credentialId: credential };
    const sealed = await seal("sk_live_secret", identity, label);

    /**
     * A wrapper that unwraps under the OLD key and wraps under the new one.
     *
     * This models what AWS KMS actually does — a ciphertext blob names the key
     * that produced it, so KMS decrypts across versions while always encrypting
     * with the current one. LocalKeyWrapper cannot: it holds exactly one KEK, so
     * it is structurally incapable of driving a rotation. A test built on two of
     * them was exercising hand-rolled steps rather than rewrap() itself.
     */
    class RotatingWrapper implements KeyWrapper {
      readonly keyVersion = "test-rotated";

      constructor(
        private readonly next: LocalKeyWrapper,
        private readonly previous: KeyWrapper,
      ) {}

      generateDek(lockLabel: LockLabel) {
        return this.next.generateDek(lockLabel);
      }

      async wrapExisting(dek: Buffer, lockLabel: LockLabel) {
        const wrapped = await this.next.wrapExisting(dek, lockLabel);
        return { ...wrapped, keyVersion: this.keyVersion };
      }

      async unwrapDek(
        wrapped: { wrapped: string; keyVersion: string },
        lockLabel: LockLabel | null,
      ) {
        // New key first, then the old one — the order a partially migrated
        // estate needs, where both generations exist at once.
        try {
          return await this.next.unwrapDek(wrapped, lockLabel);
        } catch {
          return this.previous.unwrapDek(wrapped, lockLabel);
        }
      }
    }

    const rotating = new RotatingWrapper(
      new LocalKeyWrapper(Buffer.alloc(32, 7).toString("base64")),
      getKeyWrapper(),
    );

    __setKeyWrapperForTests(rotating);
    try {
      // Sanity: the versions genuinely differ, or the rotation below is a no-op
      // that proves nothing. This is exactly what broke when LocalKeyWrapper
      // reported a constant "local-v1" for every key — rewrap() returned early
      // and the ciphertext stayed on the old key while reporting success.
      expect(rotating.keyVersion).not.toBe(sealed.keyVersion);

      const migrated = await rewrap(sealed, label);

      expect(migrated.keyVersion).toBe(rotating.keyVersion);
      expect(migrated.wrappedDek).not.toBe(sealed.wrappedDek);
      // Only the wrapped DEK changes. Re-encrypting the payload would be the
      // expensive, risky way to rotate, and avoiding it is why envelope
      // encryption exists at all.
      expect(migrated.ciphertext).toBe(sealed.ciphertext);

      expect(await open(migrated, identity, label)).toBe("sk_live_secret");

      // And it is a no-op once already on the current key.
      expect(await rewrap(migrated, label)).toBe(migrated);
    } finally {
      __setKeyWrapperForTests(undefined);
    }
  });
});

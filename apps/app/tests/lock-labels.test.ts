import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import {
  CURRENT_AAD_VERSION,
  LABELLED_AAD_VERSION,
  open,
  rewrap,
  seal,
  type CredentialIdentity,
  type SealedPayload,
} from "@/lib/crypto/envelope";
import {
  AwsKmsKeyWrapper,
  FIXED_LOCK_LABELS,
  LocalKeyWrapper,
  __setKeyWrapperForTests,
  clinicLockLabel,
  encryptionContext,
  getKeyWrapper,
  lockLabelProblem,
  type KeyWrapper,
  type LockLabel,
  type WrappedKey,
} from "@/lib/crypto/kms";

import { fakeKms, sealAsVersionOne, TEST_KEY_ARN } from "./setup/kms";

/**
 * The KMS lock labels (owner, 5 October 2026; C6b).
 *
 * Every data key is wrapped under a label, `{ "healdesk:clinic": <client
 * number>, "healdesk:login": <provider> }` for a clinic's credential and a
 * fixed pair for what belongs to no clinic, sent to KMS as the encryption
 * context and bound by LocalKeyWrapper into its own AAD. What is proved here:
 *
 *   1. a sealed value opens under the label it was sealed under, and under no
 *      other: a different clinic or a different login is refused, by KMS
 *      itself on AWS, before the payload's own AAD is reached;
 *   2. the AWS wrapper sends the label as the EncryptionContext on
 *      GenerateDataKey, Decrypt and Encrypt, and refuses to send any of them
 *      with a label that is not whole, which is how a sealer added later
 *      without one fails a test rather than production;
 *   3. a re-wrap keeps the label;
 *   4. an envelope sealed before labels (aad_version 1) still opens, without
 *      one, and the version cannot be edited to skip the label;
 *   5. the version is read once, and must be one this code writes: missing,
 *      or anything else, it is refused before the key is asked anything, so
 *      whether the label is used and which AAD the payload carries can never
 *      be decided from two different answers.
 *
 * That each real sealer passes its own label, read from data that cannot
 * change, is proved beside each one: tests/connections.test.ts,
 * admin-totp.test.ts, totp.test.ts and kms.test.ts (the self-check).
 */

afterEach(() => {
  __setKeyWrapperForTests(undefined);
});

/** A clinic's Google Calendar credential, and the context KMS receives for it. */
const LABEL: LockLabel = { clinic: "12", login: "google_calendar" };
const CONTEXT = { "healdesk:clinic": "12", "healdesk:login": "google_calendar" };
/** The same login at another clinic, and another login at the same clinic. */
const OTHER_CLINIC: LockLabel = { clinic: "13", login: "google_calendar" };
const OTHER_LOGIN: LockLabel = { clinic: "12", login: "meta-whatsapp" };

const identity = (): CredentialIdentity => ({
  clinicId: randomUUID(),
  credentialId: randomUUID(),
});

/** A local wrapper's refusal to unwrap: what KMS calls InvalidCiphertextException. */
const NOT_UNDER_THIS_LABEL = /not wrapped under this key and lock label/;

/**
 * A key rotation in progress: wraps under `next`, unwraps each data key with
 * whichever key made it. Chosen by key version, so no call is made to a key
 * that cannot answer and every call the stand-in records is one that matters.
 */
class Rotation implements KeyWrapper {
  constructor(
    private readonly next: KeyWrapper,
    private readonly previous: KeyWrapper,
  ) {}

  get keyVersion(): string {
    return this.next.keyVersion;
  }

  generateDek(label: LockLabel) {
    return this.next.generateDek(label);
  }

  wrapExisting(dek: Buffer, label: LockLabel) {
    return this.next.wrapExisting(dek, label);
  }

  unwrapDek(wrapped: WrappedKey, label: LockLabel | null) {
    const holder = wrapped.keyVersion === this.next.keyVersion ? this.next : this.previous;
    return holder.unwrapDek(wrapped, label);
  }
}

/** A wrapper that records whether it was asked anything, and answers nothing. */
function untouchable(): { wrapper: KeyWrapper; asked: string[] } {
  const asked: string[] = [];
  const refuse = (name: string) => {
    asked.push(name);
    return Promise.reject(new Error("the wrapper should not have been asked"));
  };
  return {
    asked,
    wrapper: {
      keyVersion: "untouchable",
      generateDek: () => refuse("generateDek"),
      unwrapDek: () => refuse("unwrapDek"),
      wrapExisting: () => refuse("wrapExisting"),
    },
  };
}

// -----------------------------------------------------------------------------

describe("what a lock label may be", () => {
  test("a clinic's label is its client number and what the credential logs in to, as KMS will receive them", () => {
    const label = clinicLockLabel(42, "google_calendar");
    expect(label).toEqual({ clinic: "42", login: "google_calendar" });
    expect(encryptionContext(label)).toEqual({
      "healdesk:clinic": "42",
      "healdesk:login": "google_calendar",
    });
    // Provider ids as provider_connections holds them, hyphens included.
    expect(clinicLockLabel(7, "meta-whatsapp")).toEqual({ clinic: "7", login: "meta-whatsapp" });
  });

  test("the labels that belong to no clinic are these three, and each is whole", () => {
    expect(FIXED_LOCK_LABELS).toEqual({
      adminCode: { clinic: "ops", login: "admin-code" },
      selfCheck: { clinic: "ops", login: "self-check" },
      userTotp: { clinic: "users", login: "user-totp" },
    });
    for (const label of Object.values(FIXED_LOCK_LABELS))
      expect(lockLabelProblem(label)).toBeNull();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "a client number of %s is refused",
    (clientNumber) => {
      expect(() => clinicLockLabel(clientNumber, "google_calendar")).toThrow(
        /client number, a positive integer/,
      );
    },
  );

  const REFUSED: [string, unknown][] = [
    ["no label at all", undefined],
    ["null", null],
    ["a bare string", "12"],
    ["an empty object", {}],
    ["a client number that is a number, not text", { clinic: 12, login: "google_calendar" }],
    ["a client number with a leading zero", { clinic: "012", login: "google_calendar" }],
    ["an empty clinic", { clinic: "", login: "google_calendar" }],
    ["the word a missing value prints as", { clinic: "undefined", login: "google_calendar" }],
    ["a plane that does not exist", { clinic: "admin", login: "admin-code" }],
    ["no login", { clinic: "12" }],
    ["an empty login", { clinic: "12", login: "" }],
    ["a login in capitals", { clinic: "12", login: "Google_Calendar" }],
    ["a login with a space", { clinic: "12", login: "google calendar" }],
  ];

  test.each(REFUSED)("%s is refused", (_case, label) => {
    expect(lockLabelProblem(label)).toMatch(/lock label/);
    expect(() => encryptionContext(label as LockLabel)).toThrow(/lock label/);
  });

  test("a refusal never repeats the value, which could be anything a caller passed by mistake", () => {
    const token = "Bearer EAAB-not-a-real-token-0123456789";
    for (const label of [
      { clinic: token, login: "meta-messenger" },
      { clinic: "12", login: token },
    ]) {
      const problem = lockLabelProblem(label);
      expect(problem).not.toBeNull();
      expect(problem).not.toContain("EAAB");
    }
  });
});

// -----------------------------------------------------------------------------

describe("the envelope under LocalKeyWrapper, as development and every other test runs it", () => {
  test("round trip: sealed as version 2, opened under the label it was sealed under", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);

    expect(LABELLED_AAD_VERSION).toBe(2);
    expect(CURRENT_AAD_VERSION).toBe(LABELLED_AAD_VERSION);
    expect(sealed.aadVersion).toBe(2);
    expect(await open(sealed, who, LABEL)).toBe("a-synthetic-refresh-token");
    // A label built the way the store builds it is the same label.
    expect(await open(sealed, who, clinicLockLabel(12, "google_calendar"))).toBe(
      "a-synthetic-refresh-token",
    );
  });

  test("another clinic's label does not open it, nor another login's", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);

    await expect(open(sealed, who, OTHER_CLINIC)).rejects.toThrow(NOT_UNDER_THIS_LABEL);
    await expect(open(sealed, who, OTHER_LOGIN)).rejects.toThrow(NOT_UNDER_THIS_LABEL);
    await expect(open(sealed, who, FIXED_LOCK_LABELS.adminCode)).rejects.toThrow(
      NOT_UNDER_THIS_LABEL,
    );
  });

  test("seal, open and rewrap refuse a label that is not whole before the wrapper is asked anything", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    const { wrapper, asked } = untouchable();
    __setKeyWrapperForTests(wrapper);

    const broken = [undefined, { clinic: "12", login: "" }, { clinic: "", login: "meta" }];
    for (const label of broken) {
      await expect(seal("value", who, label as LockLabel)).rejects.toThrow(/lock label/);
      await expect(open(sealed, who, label as LockLabel)).rejects.toThrow(/lock label/);
      await expect(rewrap(sealed, label as LockLabel)).rejects.toThrow(/lock label/);
    }
    expect(asked).toEqual([]);
  });

  test("the wrapper itself refuses a label that is not whole, and an omitted one is not taken for a version-1 open", async () => {
    const local = new LocalKeyWrapper(randomBytes(32).toString("base64"));
    const { wrapped } = await local.generateDek(LABEL);

    await expect(local.generateDek({ clinic: "12", login: "" })).rejects.toThrow(/lock label/);
    await expect(local.wrapExisting(randomBytes(32), { clinic: "", login: "x" })).rejects.toThrow(
      /lock label/,
    );
    // Only an explicit null opens without a label; a forgotten argument is refused.
    await expect(local.unwrapDek(wrapped, undefined as unknown as null)).rejects.toThrow(
      /lock label is required/,
    );
    // And a key wrapped under a label does not open as if it had none.
    await expect(local.unwrapDek(wrapped, null)).rejects.toThrow(NOT_UNDER_THIS_LABEL);
    expect((await local.unwrapDek(wrapped, LABEL)).length).toBe(32);
  });
});

// -----------------------------------------------------------------------------

describe("AwsKmsKeyWrapper sends the label as the encryption context", () => {
  test("GenerateDataKey on the seal and Decrypt on the open both carry it", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
    const who = identity();

    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    expect(sealed.aadVersion).toBe(2);
    expect(await open(sealed, who, LABEL)).toBe("a-synthetic-refresh-token");

    expect(kms.calls).toEqual([
      {
        command: "GenerateDataKey",
        keyId: TEST_KEY_ARN,
        keySpec: "AES_256",
        encryptionContext: CONTEXT,
      },
      { command: "Decrypt", keyId: TEST_KEY_ARN, encryptionContext: CONTEXT },
    ]);
  });

  test.each([
    [
      "another clinic",
      OTHER_CLINIC,
      { "healdesk:clinic": "13", "healdesk:login": "google_calendar" },
    ],
    ["another login", OTHER_LOGIN, { "healdesk:clinic": "12", "healdesk:login": "meta-whatsapp" }],
  ] as const)(
    "a mismatched label (%s) is refused by KMS, which never releases the data key",
    async (_case, wrong, wrongContext) => {
      const kms = fakeKms();
      __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
      const who = identity();
      const sealed = await seal("a-synthetic-refresh-token", who, LABEL);

      await expect(open(sealed, who, wrong)).rejects.toMatchObject({
        name: "InvalidCiphertextException",
      });
      expect(kms.calls.at(-1)).toEqual({
        command: "Decrypt",
        keyId: TEST_KEY_ARN,
        encryptionContext: wrongContext,
      });
    },
  );

  test("Encrypt carries it too", async () => {
    const kms = fakeKms();
    const wrapper = new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client });
    const dek = randomBytes(32);

    const wrapped = await wrapper.wrapExisting(dek, LABEL);
    expect(await wrapper.unwrapDek(wrapped, LABEL)).toEqual(dek);
    await expect(wrapper.unwrapDek(wrapped, OTHER_LOGIN)).rejects.toMatchObject({
      name: "InvalidCiphertextException",
    });

    expect(kms.calls.map((call) => [call.command, call.encryptionContext])).toEqual([
      ["Encrypt", CONTEXT],
      ["Decrypt", CONTEXT],
      ["Decrypt", { "healdesk:clinic": "12", "healdesk:login": "meta-whatsapp" }],
    ]);
  });

  test("it refuses to seal or open without both keys, and sends KMS nothing", async () => {
    const kms = fakeKms();
    const wrapper = new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client });
    const { wrapped } = await wrapper.generateDek(LABEL);
    kms.calls.length = 0;

    const halves = [
      { clinic: "12" },
      { login: "google_calendar" },
      { clinic: "12", login: "" },
      { clinic: "", login: "google_calendar" },
    ] as unknown as LockLabel[];
    for (const label of halves) {
      await expect(wrapper.generateDek(label)).rejects.toThrow(/lock label/);
      await expect(wrapper.wrapExisting(randomBytes(32), label)).rejects.toThrow(/lock label/);
      await expect(wrapper.unwrapDek(wrapped, label)).rejects.toThrow(/lock label/);
    }
    await expect(wrapper.generateDek(undefined as unknown as LockLabel)).rejects.toThrow(
      /lock label is required/,
    );
    await expect(wrapper.unwrapDek(wrapped, undefined as unknown as null)).rejects.toThrow(
      /lock label is required/,
    );

    expect(kms.calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------

describe("rewrap keeps the label", () => {
  test("on the local wrapper: the re-wrapped key opens under the same label and no other", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    const rotation = new Rotation(
      new LocalKeyWrapper(Buffer.alloc(32, 7).toString("base64")),
      getKeyWrapper(),
    );
    __setKeyWrapperForTests(rotation);

    const migrated = await rewrap(sealed, LABEL);
    expect(migrated.keyVersion).toBe(rotation.keyVersion);
    expect(migrated.keyVersion).not.toBe(sealed.keyVersion);
    expect(migrated.ciphertext).toBe(sealed.ciphertext);
    expect(migrated.aadVersion).toBe(2);

    expect(await open(migrated, who, LABEL)).toBe("a-synthetic-refresh-token");
    await expect(open(migrated, who, OTHER_CLINIC)).rejects.toThrow(NOT_UNDER_THIS_LABEL);
    await expect(open(migrated, who, OTHER_LOGIN)).rejects.toThrow(NOT_UNDER_THIS_LABEL);
  });

  test("onto KMS: the Encrypt that re-wraps carries the context, and the key opens only under it", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    const kms = fakeKms();
    __setKeyWrapperForTests(
      new Rotation(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }), getKeyWrapper()),
    );

    const migrated = await rewrap(sealed, LABEL);
    expect(migrated.keyVersion).toBe(`kms:${TEST_KEY_ARN}`);
    expect(kms.calls).toEqual([
      { command: "Encrypt", keyId: TEST_KEY_ARN, encryptionContext: CONTEXT },
    ]);

    expect(await open(migrated, who, LABEL)).toBe("a-synthetic-refresh-token");
    await expect(open(migrated, who, OTHER_CLINIC)).rejects.toMatchObject({
      name: "InvalidCiphertextException",
    });
    expect(kms.calls.slice(1).map((call) => call.encryptionContext)).toEqual([
      CONTEXT,
      { "healdesk:clinic": "13", "healdesk:login": "google_calendar" },
    ]);
  });

  test("an envelope from before labels is refused rather than re-wrapped without one", async () => {
    const who = identity();
    const before = await sealAsVersionOne("a-synthetic-refresh-token", who, {
      kekBase64: process.env.HEALDESK_LOCAL_KEK!,
    });

    // Already on the current key: nothing to do, and nothing done.
    expect(await rewrap(before, LABEL)).toBe(before);

    const kms = fakeKms();
    __setKeyWrapperForTests(
      new Rotation(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }), getKeyWrapper()),
    );
    await expect(rewrap(before, LABEL)).rejects.toThrow(/sealed before lock labels/);
    expect(kms.calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------

/**
 * An envelope sealed by the code as it stood before lock labels: 3cca422's
 * lib/crypto/envelope.ts and kms.ts, run unchanged, under a throwaway KEK of
 * 32 bytes of 0x5a. Synthetic throughout; the "token" is a made-up string.
 */
const BEFORE_LABELS = {
  kekBase64: Buffer.alloc(32, 0x5a).toString("base64"),
  identity: {
    clinicId: "0b6f3c52-1d7e-4a8f-9c21-5e4d3b2a1f00",
    credentialId: "7c1e9a44-2b3d-4f5e-8a6b-9d0c1e2f3a4b",
  },
  plaintext: '{"refresh_token":"synthetic-version-one-token"}',
  sealed: {
    ciphertext: "JYukahfbC9du7oCc5Dv4NAoCjlxPEQ2VPYsu3ETnthbV0439gSRsxb0dCXGTAMI",
    iv: "NyVqCtOxwRrF4VJg",
    authTag: "hzaAatYS9SZYbjfk1b83yw",
    wrappedDek: "Eu_BPhbj7AvIsf9clNuVnGdoLs1Av5zpOPjgXUjwPSm9MlWzy8ej1HZOJ5sGvacdyZ-r7j_htl2TkgeN",
    keyVersion: "local-60bf07c4",
    aadVersion: 1,
  } satisfies SealedPayload,
};

describe("an envelope sealed before lock labels still opens", () => {
  test("one the pre-label code sealed opens without its label being used: any whole label does", async () => {
    __setKeyWrapperForTests(new LocalKeyWrapper(BEFORE_LABELS.kekBase64));
    const { sealed, identity: who, plaintext } = BEFORE_LABELS;

    expect(await open(sealed, who, LABEL)).toBe(plaintext);
    expect(await open(sealed, who, FIXED_LOCK_LABELS.adminCode)).toBe(plaintext);
    // But the label is still checked for shape: a sealer that passes a malformed
    // one fails here too. A whole label of the wrong clinic is not caught on a
    // version-1 envelope, as the line above shows; its AAD is what binds it.
    await expect(open(sealed, who, { clinic: "", login: "x" })).rejects.toThrow(/lock label/);
    // And the AAD still binds it to its row.
    await expect(open(sealed, identity(), LABEL)).rejects.toThrow(/authentication tag mismatch/);
  });

  test("the test helper writes that same format", async () => {
    __setKeyWrapperForTests(new LocalKeyWrapper(BEFORE_LABELS.kekBase64));
    const who = identity();
    const made = await sealAsVersionOne("synthetic", who, { kekBase64: BEFORE_LABELS.kekBase64 });

    expect(made.keyVersion).toBe(BEFORE_LABELS.sealed.keyVersion);
    expect(made.aadVersion).toBe(1);
    expect(await open(made, who, LABEL)).toBe("synthetic");
  });

  test("on KMS, a version-1 envelope is asked for with no encryption context: the one call that goes without", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
    const who = identity();
    const before = await sealAsVersionOne("a-synthetic-refresh-token", who, { kms: kms.client });
    kms.calls.length = 0;

    expect(await open(before, who, LABEL)).toBe("a-synthetic-refresh-token");
    expect(kms.calls).toEqual([{ command: "Decrypt", keyId: TEST_KEY_ARN }]);
  });

  test("the version cannot be edited to skip the label, nor to add one", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
    const who = identity();

    // A labelled envelope marked as from before labels: KMS is asked without
    // the context, and refuses.
    const labelled = await seal("a-synthetic-refresh-token", who, LABEL);
    await expect(open({ ...labelled, aadVersion: 1 }, who, LABEL)).rejects.toMatchObject({
      name: "InvalidCiphertextException",
    });
    expect(kms.calls.at(-1)).toEqual({ command: "Decrypt", keyId: TEST_KEY_ARN });

    // One from before labels marked as labelled: KMS is asked with a context
    // the key was never wrapped under, and refuses that too.
    const before = await sealAsVersionOne("a-synthetic-refresh-token", who, { kms: kms.client });
    await expect(open({ ...before, aadVersion: 2 }, who, LABEL)).rejects.toMatchObject({
      name: "InvalidCiphertextException",
    });

    // The same on the local wrapper.
    __setKeyWrapperForTests(undefined);
    const local = await seal("a-synthetic-refresh-token", who, LABEL);
    await expect(open({ ...local, aadVersion: 1 }, who, LABEL)).rejects.toThrow(
      NOT_UNDER_THIS_LABEL,
    );
    const localBefore = await sealAsVersionOne("a-synthetic-refresh-token", who, {
      kekBase64: process.env.HEALDESK_LOCAL_KEK!,
    });
    await expect(open({ ...localBefore, aadVersion: 2 }, who, LABEL)).rejects.toThrow(
      NOT_UNDER_THIS_LABEL,
    );
  });
});

// -----------------------------------------------------------------------------

describe("the envelope's version is read once, and only a version this code writes", () => {
  /** The refusal, which names the field and the versions this code writes. */
  const VERSION_REFUSED = /aadVersion must be a whole number from 1 to 2/;

  /** The envelope as it would read from a jsonb column that lost the field. */
  function withoutVersion(sealed: SealedPayload): SealedPayload {
    const copy: Partial<SealedPayload> = { ...sealed };
    delete copy.aadVersion;
    return copy as SealedPayload;
  }

  test("an envelope without its version is refused before the key is asked anything, whichever version it was", async () => {
    const who = identity();
    // Neither shape check stops one: admin_totp's CHECK does not require the
    // field, and user_factors.secret_sealed has none. Guessing would answer the
    // version twice, once for the key and once for the payload's AAD, with
    // nothing to keep the two answers the same.
    const labelled = await seal("a-synthetic-refresh-token", who, LABEL);
    const before = await sealAsVersionOne("a-synthetic-refresh-token", who, {
      kekBase64: process.env.HEALDESK_LOCAL_KEK!,
    });
    const { wrapper, asked } = untouchable();
    __setKeyWrapperForTests(wrapper);

    for (const sealed of [labelled, before]) {
      await expect(open(withoutVersion(sealed), who, LABEL)).rejects.toThrow(VERSION_REFUSED);
      await expect(rewrap(withoutVersion(sealed), LABEL)).rejects.toThrow(VERSION_REFUSED);
    }
    expect(asked).toEqual([]);
  });

  test.each([
    ["0", 0],
    ["-1", -1],
    ["3, a version not written yet", CURRENT_AAD_VERSION + 1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ['"2", the number as text, as a hand-written jsonb value would hold it', "2"],
    ["null", null],
    ["true", true],
  ] as const)("aadVersion %s: refused before the key is asked anything", async (_case, value) => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    const altered = { ...sealed, aadVersion: value as unknown as number };
    const { wrapper, asked } = untouchable();
    __setKeyWrapperForTests(wrapper);

    await expect(open(altered, who, LABEL)).rejects.toThrow(VERSION_REFUSED);
    await expect(rewrap(altered, LABEL)).rejects.toThrow(VERSION_REFUSED);
    expect(asked).toEqual([]);
  });

  test("the refusal names the field and never repeats the value, which could be anything", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);
    const altered = {
      ...sealed,
      aadVersion: "Bearer EAAB-not-a-real-token-0123456789" as unknown as number,
    };

    const refusal = await open(altered, who, LABEL).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("aadVersion");
    expect((refusal as Error).message).not.toContain("EAAB");
  });

  test("rewrap refuses one even on the current key, where it would otherwise hand the envelope back as done", async () => {
    const who = identity();
    const sealed = await seal("a-synthetic-refresh-token", who, LABEL);

    // Whole, and already on the current key: nothing to do.
    expect(await rewrap(sealed, LABEL)).toBe(sealed);
    // The same envelope with a version nothing wrote is reported, not passed over.
    await expect(rewrap({ ...sealed, aadVersion: CURRENT_AAD_VERSION + 1 }, LABEL)).rejects.toThrow(
      VERSION_REFUSED,
    );
    await expect(rewrap(withoutVersion(sealed), LABEL)).rejects.toThrow(VERSION_REFUSED);
  });
});

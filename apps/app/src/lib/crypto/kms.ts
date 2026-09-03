import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { env } from "@/lib/env";

/**
 * Key wrapping — the outer half of envelope encryption.
 *
 * Each credential gets its own random data-encryption key (DEK). The DEK
 * encrypts the payload; a key-encryption key (KEK) encrypts the DEK. Only the
 * wrapped DEK is stored, so rotating the KEK means re-wrapping a short blob
 * rather than re-encrypting every credential.
 *
 * Two implementations behind one interface:
 *
 *   LocalKeyWrapper  — a KEK from the environment. Development only.
 *   AwsKmsKeyWrapper — KMS holds the KEK and never releases it. Every unwrap is
 *                      a CloudTrail event, which is what an auditor wants to see.
 *
 * getKeyWrapper() refuses the local wrapper in production. That is deliberate:
 * a silent downgrade to a key sitting in an env var is exactly the failure this
 * interface exists to prevent.
 */

export type WrappedKey = {
  /** base64url of the wrapped DEK. */
  wrapped: string;
  /** Which KEK wrapped it, so rotation can find rows to re-wrap. */
  keyVersion: string;
};

export interface KeyWrapper {
  readonly keyVersion: string;
  /** Generate a fresh 32-byte DEK and return it alongside its wrapped form. */
  generateDek(): Promise<{ dek: Buffer; wrapped: WrappedKey }>;
  unwrapDek(wrapped: WrappedKey): Promise<Buffer>;
  /**
   * Wrap a DEK we already hold, under the current KEK. This is what makes key
   * rotation cheap: re-wrap a 32-byte key rather than re-encrypt the payload.
   */
  wrapExisting(dek: Buffer): Promise<WrappedKey>;
}

const DEK_BYTES = 32;

// -----------------------------------------------------------------------------
// Local — development only
// -----------------------------------------------------------------------------

export class LocalKeyWrapper implements KeyWrapper {
  /**
   * Derived from the key material, not a constant.
   *
   * It used to be the literal string "local-v1" for every instance, which made
   * key rotation a silent no-op: `rewrap()` returns early when
   * `sealed.keyVersion === wrapper.keyVersion`, so rotating the KEK produced two
   * wrappers that reported the SAME version and every re-wrap was skipped. The
   * ciphertext stayed on the old key while the system reported it rotated —
   * which is the worst kind of security bug, because the dashboard says done.
   *
   * A short hash of the key identifies WHICH key without revealing it. Eight
   * hex characters is ample: this only ever distinguishes a handful of keys, and
   * a collision would cause a failed rotation rather than a wrong decrypt,
   * because unwrapping still authenticates.
   */
  readonly keyVersion: string;
  readonly #kek: Buffer;

  constructor(kekBase64: string) {
    const kek = Buffer.from(kekBase64, "base64");
    if (kek.length !== 32) {
      throw new Error(
        "HEALDESK_LOCAL_KEK must be 32 bytes, base64-encoded. Generate with: openssl rand -base64 32",
      );
    }
    this.#kek = kek;
    this.keyVersion = `local-${createHash("sha256").update(kek).digest("hex").slice(0, 8)}`;
  }

  async generateDek(): Promise<{ dek: Buffer; wrapped: WrappedKey }> {
    const dek = randomBytes(DEK_BYTES);
    return { dek, wrapped: await this.wrapExisting(dek) };
  }

  async wrapExisting(dek: Buffer): Promise<WrappedKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
    const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      wrapped: Buffer.concat([iv, tag, sealed]).toString("base64url"),
      keyVersion: this.keyVersion,
    };
  }

  async unwrapDek(wrapped: WrappedKey): Promise<Buffer> {
    const raw = Buffer.from(wrapped.wrapped, "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);

    const decipher = createDecipheriv("aes-256-gcm", this.#kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

// -----------------------------------------------------------------------------
// AWS KMS
// -----------------------------------------------------------------------------

/**
 * AWS KMS — the production wrapper.
 *
 * The SDK is an OPTIONAL dependency, loaded lazily. Until there's a paying
 * clinic there's no KMS key to talk to, and pulling ~20MB of AWS SDK into every
 * install to support a code path nobody runs yet is a poor trade.
 *
 * The specifier goes through a variable so TypeScript can't resolve it
 * statically and demand the package be installed. That is deliberate, not an
 * oversight — the runtime error below is what a developer should see, rather
 * than a compile failure in a file they didn't touch.
 *
 * When you do install it:
 *   npm install --workspace @healdesk/app @aws-sdk/client-kms
 */
const KMS_MODULE = "@aws-sdk/client-kms";

type KmsModule = {
  KMSClient: new (config: Record<string, unknown>) => {
    send: (command: unknown) => Promise<{
      Plaintext?: Uint8Array;
      CiphertextBlob?: Uint8Array;
    }>;
  };
  GenerateDataKeyCommand: new (input: Record<string, unknown>) => unknown;
  DecryptCommand: new (input: Record<string, unknown>) => unknown;
  EncryptCommand: new (input: Record<string, unknown>) => unknown;
};

export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly keyVersion: string;
  readonly #keyId: string;
  #mod?: KmsModule;
  #client?: InstanceType<KmsModule["KMSClient"]>;

  constructor(keyId: string) {
    this.#keyId = keyId;
    this.keyVersion = `kms:${keyId}`;
  }

  async #kms(): Promise<{
    mod: KmsModule;
    client: InstanceType<KmsModule["KMSClient"]>;
  }> {
    if (!this.#mod) {
      try {
        this.#mod = (await import(/* @vite-ignore */ KMS_MODULE)) as KmsModule;
      } catch {
        throw new Error(
          "HEALDESK_KMS_PROVIDER is 'aws-kms' but @aws-sdk/client-kms is not installed. " +
            "Run: npm install --workspace @healdesk/app @aws-sdk/client-kms",
        );
      }
    }
    this.#client ??= new this.#mod.KMSClient({});
    return { mod: this.#mod, client: this.#client };
  }

  async generateDek(): Promise<{ dek: Buffer; wrapped: WrappedKey }> {
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.GenerateDataKeyCommand({
        KeyId: this.#keyId,
        KeySpec: "AES_256",
      }),
    );
    if (!result.Plaintext || !result.CiphertextBlob) {
      throw new Error("KMS returned no data key.");
    }
    return {
      dek: Buffer.from(result.Plaintext),
      wrapped: {
        wrapped: Buffer.from(result.CiphertextBlob).toString("base64url"),
        keyVersion: this.keyVersion,
      },
    };
  }

  async unwrapDek(wrapped: WrappedKey): Promise<Buffer> {
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.DecryptCommand({
        CiphertextBlob: Buffer.from(wrapped.wrapped, "base64url"),
        KeyId: this.#keyId,
      }),
    );
    if (!result.Plaintext) throw new Error("KMS returned no plaintext key.");
    return Buffer.from(result.Plaintext);
  }

  async wrapExisting(dek: Buffer): Promise<WrappedKey> {
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.EncryptCommand({ KeyId: this.#keyId, Plaintext: dek }),
    );
    if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext.");
    return {
      wrapped: Buffer.from(result.CiphertextBlob).toString("base64url"),
      keyVersion: this.keyVersion,
    };
  }
}

// -----------------------------------------------------------------------------

let cached: KeyWrapper | undefined;

export function getKeyWrapper(): KeyWrapper {
  if (cached) return cached;

  if (env.kmsProvider() === "aws-kms") {
    const keyId = env.kmsKeyId();
    if (!keyId) throw new Error("HEALDESK_KMS_KEY_ID is required for aws-kms.");
    cached = new AwsKmsKeyWrapper(keyId);
    return cached;
  }

  if (env.isProduction()) {
    throw new Error(
      "Refusing to use the local key wrapper in production. " +
        "Set HEALDESK_KMS_PROVIDER=aws-kms and HEALDESK_KMS_KEY_ID.",
    );
  }

  const kek = env.localKek();
  if (!kek) {
    throw new Error(
      "HEALDESK_LOCAL_KEK is not set. Generate with: openssl rand -base64 32",
    );
  }
  cached = new LocalKeyWrapper(kek);
  return cached;
}

/** Tests swap the wrapper; nothing else should call this. */
export function __setKeyWrapperForTests(wrapper: KeyWrapper | undefined): void {
  cached = wrapper;
}

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
 * The SDK is a dependency of this app, imported lazily by a literal specifier
 * and listed in next.config.ts's serverExternalPackages. Each of the three is
 * there on purpose, and the arrangement they replaced is the reason.
 *
 * It used to be an optional dependency, installed nowhere, with the specifier
 * routed through a `const` so that TypeScript could not resolve it statically.
 * That hid it from TypeScript and not from Turbopack, which folds the constant,
 * found no package, and compiled the import into an unconditional
 * `throw MODULE_NOT_FOUND` in the server chunk. Every production build produced
 * a server that could never load KMS — and since getKeyWrapper() refuses the
 * local wrapper in production, a server that could seal and open no secret at
 * all. Installing the SDK into the image afterwards could not help: the throw
 * was already compiled in.
 *
 *   - A dependency, so the build can resolve it.
 *   - A literal specifier, so what the bundler resolves is what the code says,
 *     not what constant folding happens to recover.
 *   - External, so the chunk `require`s it from node_modules at run time
 *     instead of carrying a copy of the SDK, and the standalone output traces
 *     it in beside the server.
 *
 * Still lazy: nothing loads it until a KMS wrapper is first used, so
 * development and tests on the local wrapper never do.
 */
type KmsModule = typeof import("@aws-sdk/client-kms");

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
        this.#mod = await import("@aws-sdk/client-kms");
      } catch (error) {
        // Not a missing feature any more: the package is a dependency, so a
        // failure here is an install or an image without its node_modules.
        throw new Error(
          "HEALDESK_KMS_PROVIDER is 'aws-kms' but @aws-sdk/client-kms could not be loaded. " +
            "It is a dependency of @healdesk/app and external to the Next build, so the " +
            "server requires it from node_modules at run time: the install is incomplete.",
          { cause: error },
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

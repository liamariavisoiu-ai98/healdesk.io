import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { KMSClient, KMSClientConfig } from "@aws-sdk/client-kms";

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
 *
 * Every DEK is wrapped under a lock label as well as the KEK (below), and both
 * implementations refuse to wrap one without it.
 */

export type WrappedKey = {
  /** base64url of the wrapped DEK. */
  wrapped: string;
  /** Which KEK wrapped it, so rotation can find rows to re-wrap. */
  keyVersion: string;
};

export interface KeyWrapper {
  readonly keyVersion: string;
  /** Generate a fresh 32-byte DEK and return it alongside its form wrapped under `label`. */
  generateDek(label: LockLabel): Promise<{ dek: Buffer; wrapped: WrappedKey }>;
  /**
   * `label` is the one the DEK was wrapped under. `null`, and only an explicit
   * `null`, opens a DEK wrapped before lock labels: envelope.ts passes it for
   * an envelope of aad_version 1 and for nothing else.
   */
  unwrapDek(wrapped: WrappedKey, label: LockLabel | null): Promise<Buffer>;
  /**
   * Wrap a DEK we already hold, under the current KEK and `label`. This is what
   * makes key rotation cheap: re-wrap a 32-byte key rather than re-encrypt the
   * payload.
   */
  wrapExisting(dek: Buffer, label: LockLabel): Promise<WrappedKey>;
}

const DEK_BYTES = 32;

// -----------------------------------------------------------------------------
// Lock labels
// -----------------------------------------------------------------------------

/**
 * What a data key is locked to besides the KEK: the owner's "lock label" (5
 * October 2026), which KMS receives as the encryption context
 * `{ "healdesk:clinic": clinic, "healdesk:login": login }`.
 *
 * KMS binds the context into the wrapped key as authenticated data and hands
 * the DEK back only to a Decrypt that names the same context, exactly. Two
 * things follow that the envelope's own AAD cannot give:
 *
 *   - the refusal happens inside KMS, before a data key reaches this process:
 *     a sealed row copied into another clinic's row, or another login's, never
 *     gets as far as its payload;
 *   - every GenerateDataKey, Decrypt and Encrypt lands in CloudTrail with the
 *     label in the clear, so the trail says whose credential each unseal
 *     opened, and the task role's policy can refuse any call of its own made
 *     without one (docs/design/google-calendar-2026-10-05.md §5).
 *
 * Because it is written in the clear, a label holds a client number or the
 * name of a plane that is no clinic, and a word: never a clinic's name, a
 * person, an address or a row id.
 *
 * A label is derived, when sealing and again at every open, from values that
 * cannot change: the clinic's client number and the connection row's provider
 * (the google_calendar migration refuses any change to either, for every
 * role), or a constant. Never from anything editable, and never stored beside
 * the ciphertext: a label that travelled with its row would travel with a
 * copied row too, and open it wherever it landed.
 */
export type LockLabel = {
  /** `healdesk:clinic`: the clinic's client number in decimal, or a plane that is not a clinic. */
  readonly clinic: string;
  /** `healdesk:login`: what is sealed. A provider id such as `google_calendar`, or a fixed word. */
  readonly login: string;
};

export const LOCK_LABEL_CLINIC_KEY = "healdesk:clinic";
export const LOCK_LABEL_LOGIN_KEY = "healdesk:login";

/**
 * The labels that belong to no clinic: all of them, so that what the infra
 * policy may name is this list and a typo cannot invent another. A clinic's
 * credentials take `clinicLockLabel()` instead.
 */
export const FIXED_LOCK_LABELS = {
  /** The operator's TOTP secret (lib/ops/admin-totp.ts). */
  adminCode: { clinic: "ops", login: "admin-code" },
  /** The throwaway value the key self-check seals and opens (envelope.ts). */
  selfCheck: { clinic: "ops", login: "self-check" },
  /**
   * A portal sign-in's authenticator-app secret (lib/factors/totp.ts). A
   * sign-in is not a clinic and has no client number, so its label is fixed;
   * the envelope's AAD binds the sealed secret to its user and its row.
   */
  userTotp: { clinic: "users", login: "user-totp" },
} as const satisfies Record<string, LockLabel>;

/** The planes that are not clinics: `ops` and `users`. */
const PLANES: ReadonlySet<string> = new Set(
  Object.values(FIXED_LOCK_LABELS).map((label) => label.clinic),
);

/** A client number as the context carries it: in decimal, with no sign and no leading zero. */
const CLIENT_NUMBER = /^[1-9][0-9]{0,9}$/;

/** As provider ids are written (`google_calendar`, `meta-whatsapp`), and the fixed words. */
const LOGIN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Null when `label` is a whole lock label; otherwise what is wrong with it.
 *
 * Checked by type before shape, so a missing value is refused rather than
 * written down as the word "undefined". The reasons never repeat the value: a
 * value passed by mistake can be anything, a token included, and these
 * messages reach logs.
 */
export function lockLabelProblem(label: unknown): string | null {
  if (typeof label !== "object" || label === null) {
    return "A lock label is required: both healdesk:clinic and healdesk:login.";
  }
  const { clinic, login } = label as { clinic?: unknown; login?: unknown };
  if (typeof clinic !== "string" || !(CLIENT_NUMBER.test(clinic) || PLANES.has(clinic))) {
    return (
      "A lock label's healdesk:clinic must be the clinic's client number, or one of " +
      `${[...PLANES].join(", ")} for what belongs to no clinic.`
    );
  }
  if (typeof login !== "string" || !LOGIN.test(login)) {
    return (
      "A lock label's healdesk:login must be a provider id or a fixed word: lower-case " +
      "letters, digits, '_' and '-', starting with a letter."
    );
  }
  return null;
}

export function assertLockLabel(label: unknown): asserts label is LockLabel {
  const problem = lockLabelProblem(label);
  if (problem) throw new Error(problem);
}

/**
 * The label of a clinic's credential: its client number, and what the
 * credential logs in to (for a provider_connections row, the row's provider).
 */
export function clinicLockLabel(clientNumber: number, login: string): LockLabel {
  if (!Number.isSafeInteger(clientNumber) || clientNumber < 1) {
    throw new Error("A clinic's lock label needs its client number, a positive integer.");
  }
  const label = { clinic: String(clientNumber), login };
  assertLockLabel(label);
  return label;
}

/** The label as KMS takes it, checked first. Also what LocalKeyWrapper authenticates. */
export function encryptionContext(label: LockLabel): Record<string, string> {
  assertLockLabel(label);
  return { [LOCK_LABEL_CLINIC_KEY]: label.clinic, [LOCK_LABEL_LOGIN_KEY]: label.login };
}

/**
 * A refusal that is about this deployment, not about one credential.
 *
 * `unconfigured`: getKeyWrapper() will not build a wrapper from this
 * environment. `sdk_missing`: KMS is configured but its SDK cannot be loaded.
 * Typed so that the callers which must ask before acting —
 * credentialSealingProblem(), the self-check in envelope.ts — can tell "this
 * deployment cannot seal" from a bug, which should still surface as one.
 *
 * The messages name the variable and the expected shape, never the configured
 * value: a mistyped variable can hold anything, a pasted secret included, and
 * these messages reach logs and the operator.
 */
export class CredentialKeyError extends Error {
  readonly code: "unconfigured" | "sdk_missing";

  constructor(code: "unconfigured" | "sdk_missing", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialKeyError";
    this.code = code;
  }
}

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
      throw new CredentialKeyError(
        "unconfigured",
        "HEALDESK_LOCAL_KEK must be 32 bytes, base64-encoded. Generate with: openssl rand -base64 32",
      );
    }
    this.#kek = kek;
    this.keyVersion = `local-${createHash("sha256").update(kek).digest("hex").slice(0, 8)}`;
  }

  async generateDek(label: LockLabel): Promise<{ dek: Buffer; wrapped: WrappedKey }> {
    const dek = randomBytes(DEK_BYTES);
    return { dek, wrapped: await this.wrapExisting(dek, label) };
  }

  async wrapExisting(dek: Buffer, label: LockLabel): Promise<WrappedKey> {
    const aad = localAad(label);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      wrapped: Buffer.concat([iv, tag, sealed]).toString("base64url"),
      keyVersion: this.keyVersion,
    };
  }

  async unwrapDek(wrapped: WrappedKey, label: LockLabel | null): Promise<Buffer> {
    // A DEK wrapped before lock labels was wrapped with no AAD at all.
    const aad = label === null ? null : localAad(label);
    const raw = Buffer.from(wrapped.wrapped, "base64url");

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#kek, raw.subarray(0, 12));
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } catch (error) {
      // What KMS answers here is InvalidCiphertextException, and it cannot say
      // which either: the wrong label, the wrong key and a damaged blob all
      // fail the same tag.
      throw new Error(
        "Failed to unwrap the data key: it was not wrapped under this key and lock label, " +
          "or has been altered.",
        { cause: error },
      );
    }
  }
}

/**
 * The label as LocalKeyWrapper authenticates it: the encryption context KMS
 * would be sent, as JSON. KMS authenticates the context with its ciphertext
 * too, so a test on this wrapper fails where production would, on a label that
 * differs by a single character.
 */
function localAad(label: LockLabel): Buffer {
  return Buffer.from(JSON.stringify(encryptionContext(label)), "utf8");
}

// -----------------------------------------------------------------------------
// AWS KMS
// -----------------------------------------------------------------------------

/**
 * Where the one KMS key lives: the region designated under the AWS business
 * associate agreement (docs/policies/aws-hipaa-account.md).
 */
export const KMS_KEY_REGION = "us-east-1";

const KEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ARN = /^arn:aws:kms:([^:]+):(\d{12}):key\/([^/]+)$/;

/**
 * Null when `value` is the full ARN of a single-region key in us-east-1;
 * otherwise the reason, worded for whoever set HEALDESK_KMS_KEY_ID.
 *
 * KMS itself would accept less. It would accept an alias, and an alias can be
 * pointed at a different key without anything here noticing: every credential
 * sealed after that would be under a key nobody chose for it, and every one
 * sealed before would stop opening. It would accept a bare key id and resolve
 * it in whatever account and region the client happened to be in. And it would
 * accept a key in another region, outside the one the AWS agreement designates,
 * or a multi-Region key, whose replicas can live in any region at all. The full
 * key ARN names the account, the region and the key, and it is also what
 * `keyVersion` records against every sealed row, so it has to mean one key for
 * as long as those rows exist.
 */
export function kmsKeyArnProblem(value: string | undefined): string | null {
  const keyId = value?.trim();
  const expected = `arn:aws:kms:${KMS_KEY_REGION}:<12-digit account>:key/<key id>`;

  if (!keyId) {
    return (
      "HEALDESK_KMS_KEY_ID is not set. HEALDESK_KMS_PROVIDER is 'aws-kms', which needs the full " +
      `ARN of the key: ${expected}.`
    );
  }
  if (keyId.startsWith("alias/") || /^arn:[^:]*:kms:[^:]*:[^:]*:alias\//.test(keyId)) {
    return (
      "HEALDESK_KMS_KEY_ID is a KMS alias, not a key. An alias can be repointed at another key " +
      `without this app noticing; set the key's full ARN instead: ${expected}.`
    );
  }
  if (KEY_UUID.test(keyId) || keyId.startsWith("mrk-")) {
    return (
      "HEALDESK_KMS_KEY_ID is a bare key id. Set the key's full ARN, which also names the " +
      `account and the region: ${expected}.`
    );
  }

  const arn = KEY_ARN.exec(keyId);
  if (arn && arn[1] !== KMS_KEY_REGION) {
    return (
      `HEALDESK_KMS_KEY_ID names a key outside ${KMS_KEY_REGION}. healdesk's key must be in ` +
      `${KMS_KEY_REGION}, the region designated under the AWS business associate agreement: ` +
      `${expected}.`
    );
  }
  if (!arn || !KEY_UUID.test(arn[3]!)) {
    return (
      "HEALDESK_KMS_KEY_ID is not the ARN of a single-region KMS key. Expected " +
      `${expected}, exactly as \`aws kms describe-key\` prints it.`
    );
  }
  return null;
}

/**
 * A client in another region cannot use the key at all: KMS keys are regional,
 * and a call for a us-east-1 key sent to another region's endpoint fails on
 * every seal. Refusing here says why, once, instead. Empty counts as unset, as
 * it does in kmsClientConfig(): .env.example ships the variable empty.
 */
function kmsRegionProblem(): string | null {
  const region = process.env.AWS_REGION;
  if (!region || region === KMS_KEY_REGION) return null;
  return (
    `AWS_REGION names a region other than ${KMS_KEY_REGION}, where healdesk's KMS key is. ` +
    `Unset it or set it to ${KMS_KEY_REGION}.`
  );
}

/**
 * Bounds on every KMS call, because each one sits inside work somebody is
 * waiting for: opening a clinic's credential to send a message or read a
 * calendar, and sealing one at the end of a connect flow.
 *
 * Constructed with no configuration, as it was until 6 October 2026, the client
 * sets no request timeout at all. And on the SDK this app installs (@aws-sdk
 * 3.1146, @smithy/node-http-handler 4.12), `requestTimeout` alone still bounds
 * nothing: when it passes, the handler only logs a warning — through
 * console.warn, around lib/log.ts — and keeps waiting, unless
 * `throwOnRequestTimeout` is set too. So it is set, here and in
 * reporting/deliver.ts, and tests/kms.test.ts pins both halves of that
 * behaviour against the installed SDK, so an upgrade that changes it fails a
 * test rather than a request.
 *
 * Every call this wrapper makes is safe to repeat, which is what lets these
 * numbers be short where SES's cannot be (see deliver.ts): Decrypt and Encrypt
 * change nothing, and a data key from a GenerateDataKey whose answer never
 * arrived is a key nobody stored. The SDK retries a timed-out call as a
 * transient error, so the worst case is KMS_MAX_ATTEMPTS request timeouts plus
 * one backoff: about ten seconds. Two attempts rather than the SDK's default
 * three because a retry helps with one dropped connection, while a third mostly
 * lengthens the wait when KMS is not answering at all.
 */
const KMS_CONNECT_TIMEOUT_MS = 2_000;
const KMS_REQUEST_TIMEOUT_MS = 5_000;
const KMS_MAX_ATTEMPTS = 2;

/**
 * The KMS client's configuration. Exported for tests/kms.test.ts.
 *
 * The region falls back on an empty AWS_REGION as well as an unset one: the
 * SDK's constructor refuses an empty region ("Region is missing"), and `??`
 * would hand it one. Any other region never gets this far, because
 * getKeyWrapper() refuses it.
 */
export function kmsClientConfig() {
  return {
    region: process.env.AWS_REGION || KMS_KEY_REGION,
    maxAttempts: KMS_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: KMS_CONNECT_TIMEOUT_MS,
      requestTimeout: KMS_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  } satisfies KMSClientConfig;
}

type KmsModule = typeof import("@aws-sdk/client-kms");

let kmsModule: KmsModule | undefined;

/**
 * The SDK, imported once per process, and only once a KMS wrapper is used.
 *
 * The import sits outside any `try`, and that is a fourth fact beside the three
 * in the comment on AwsKmsKeyWrapper below, not a matter of style. Inside a
 * `try`, Turbopack treats an import it cannot resolve as optional: it compiles
 * it into the `throw MODULE_NOT_FOUND` that comment describes and passes the
 * build with a warning.
 * Outside one, the build fails. Probe builds on Next 16.3 (6 October 2026)
 * showed both, for a literal specifier and a constant alike. So if the package
 * ever goes missing again, the build says so instead of shipping a server that
 * cannot seal. The `.catch()` below is not a `try`, which is the point.
 * tests/aws-sdk-externals.test.ts holds every import under src to this, and
 * the CI step after `npm run build` reads the chunks the build produced.
 */
async function loadKms(): Promise<KmsModule> {
  kmsModule ??= await import("@aws-sdk/client-kms").catch((error: unknown) => {
    // Not a missing feature any more: the package is a dependency, so a
    // failure here is an install or an image without its node_modules.
    throw new CredentialKeyError(
      "sdk_missing",
      "HEALDESK_KMS_PROVIDER is 'aws-kms' but @aws-sdk/client-kms could not be loaded. " +
        "It is a dependency of @healdesk/app and external to the Next build, so the " +
        "server requires it from node_modules at run time: the install is incomplete.",
      { cause: error },
    );
  });
  return kmsModule;
}

/**
 * The one method of KMSClient the wrapper uses. Tests pass a stand-in, so the
 * commands KMS would receive can be read without an AWS account.
 */
export type KmsClientLike = Pick<KMSClient, "send">;

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
 *
 * The key is named by its full ARN on every call, Decrypt included, and the
 * constructor refuses anything else (kmsKeyArnProblem). Decrypt would work
 * without a KeyId for a symmetric key, because the ciphertext names the key
 * that made it; passing it anyway means a blob made under any other key is
 * refused instead of opened.
 *
 * The lock label goes on every call as the EncryptionContext, and is checked
 * before the SDK is even loaded: GenerateDataKey and Encrypt are never sent
 * without both keys, and Decrypt goes without a context only for an envelope
 * sealed before labels (aad_version 1). Once the task role's policy requires
 * both keys (docs/design/google-calendar-2026-10-05.md §5), KMS refuses that
 * Decrypt as well, so such an envelope opens on AWS only until then.
 */
export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly keyVersion: string;
  readonly #keyArn: string;
  #client?: KmsClientLike;

  constructor(keyArn: string, options: { client?: KmsClientLike } = {}) {
    const problem = kmsKeyArnProblem(keyArn);
    if (problem) throw new CredentialKeyError("unconfigured", problem);
    this.#keyArn = keyArn.trim();
    this.keyVersion = `kms:${this.#keyArn}`;
    this.#client = options.client;
  }

  async #kms(): Promise<{ mod: KmsModule; client: KmsClientLike }> {
    const mod = await loadKms();
    this.#client ??= new mod.KMSClient(kmsClientConfig());
    return { mod, client: this.#client };
  }

  async generateDek(label: LockLabel): Promise<{ dek: Buffer; wrapped: WrappedKey }> {
    const context = encryptionContext(label);
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.GenerateDataKeyCommand({
        KeyId: this.#keyArn,
        KeySpec: "AES_256",
        EncryptionContext: context,
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

  async unwrapDek(wrapped: WrappedKey, label: LockLabel | null): Promise<Buffer> {
    const context = label === null ? null : encryptionContext(label);
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.DecryptCommand({
        CiphertextBlob: Buffer.from(wrapped.wrapped, "base64url"),
        KeyId: this.#keyArn,
        ...(context ? { EncryptionContext: context } : {}),
      }),
    );
    if (!result.Plaintext) throw new Error("KMS returned no plaintext key.");
    return Buffer.from(result.Plaintext);
  }

  async wrapExisting(dek: Buffer, label: LockLabel): Promise<WrappedKey> {
    const context = encryptionContext(label);
    const { mod, client } = await this.#kms();
    const result = await client.send(
      new mod.EncryptCommand({ KeyId: this.#keyArn, Plaintext: dek, EncryptionContext: context }),
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
    const problem = kmsKeyArnProblem(env.kmsKeyId()) ?? kmsRegionProblem();
    if (problem) throw new CredentialKeyError("unconfigured", problem);
    cached = new AwsKmsKeyWrapper(env.kmsKeyId()!);
    return cached;
  }

  if (env.isProduction()) {
    throw new CredentialKeyError(
      "unconfigured",
      "Refusing to use the local key wrapper in production. " +
        "Set HEALDESK_KMS_PROVIDER=aws-kms and HEALDESK_KMS_KEY_ID.",
    );
  }

  const kek = env.localKek();
  if (!kek) {
    throw new CredentialKeyError(
      "unconfigured",
      "HEALDESK_LOCAL_KEK is not set. Generate with: openssl rand -base64 32",
    );
  }
  cached = new LocalKeyWrapper(kek);
  return cached;
}

/**
 * Null when this deployment can seal a credential; otherwise the reason,
 * worded for an operator. For callers that must check before they start
 * something only a sealed credential can finish — sending a clinic to Google
 * to connect a calendar, above all, where the grant would come back to a
 * server that cannot store it.
 *
 * It asks what can be known without calling KMS: that the wrapper builds and,
 * for KMS, that the SDK loads. Whether the key answers is the self-check's
 * question (selfCheckCredentialKey in envelope.ts).
 */
export async function credentialSealingProblem(): Promise<string | null> {
  try {
    if (getKeyWrapper() instanceof AwsKmsKeyWrapper) await loadKms();
    return null;
  } catch (error) {
    if (error instanceof CredentialKeyError) return error.message;
    throw error;
  }
}

export type CredentialKeyConfiguration = {
  provider: "aws-kms" | "local";
  /** Whether getKeyWrapper() builds a wrapper from this environment. */
  keyConfigured: boolean;
  /**
   * The last six characters of the KMS key's ARN — enough to tell which key
   * against the AWS console, without the account id the rest of it carries.
   * Null for the local wrapper, and for a value that is not a key ARN, which
   * might be anything at all.
   */
  keyArnSuffix: string | null;
};

/**
 * What getCredentialKeyStatus reports about the credential key beside the
 * self-check: only what can be read without calling KMS.
 */
export function credentialKeyConfiguration(): CredentialKeyConfiguration {
  const provider = env.kmsProvider();
  const keyId = env.kmsKeyId()?.trim();

  let keyConfigured = true;
  try {
    getKeyWrapper();
  } catch (error) {
    if (!(error instanceof CredentialKeyError)) throw error;
    keyConfigured = false;
  }

  return {
    provider,
    keyConfigured,
    keyArnSuffix:
      provider === "aws-kms" && keyId && kmsKeyArnProblem(keyId) === null ? keyId.slice(-6) : null,
  };
}

/** Tests swap the wrapper; nothing else should call this. */
export function __setKeyWrapperForTests(wrapper: KeyWrapper | undefined): void {
  cached = wrapper;
}

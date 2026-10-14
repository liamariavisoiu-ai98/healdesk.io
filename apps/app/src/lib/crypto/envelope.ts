import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { describeError, log } from "@/lib/log";

import {
  assertLockLabel,
  CredentialKeyError,
  FIXED_LOCK_LABELS,
  getKeyWrapper,
  type LockLabel,
} from "./kms";

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
 *
 * ## And the data key has a lock label
 *
 * Every seal, open and re-wrap takes the sealer's lock label (kms.ts), and the
 * data key is wrapped under it: on AWS, as KMS's encryption context. So a moved
 * row is refused one step earlier, on AWS by KMS itself, before the AAD is ever
 * checked, and CloudTrail records whose credential each unseal opened. The
 * caller derives the label from what cannot change and passes it every time;
 * the envelope does not carry it.
 */

/**
 * The envelope's version, part of the AAD it is sealed under.
 *
 *   1  Before lock labels: the data key wrapped with no label. Still opened,
 *      without one, so whatever was sealed then keeps opening.
 *   2  The data key wrapped under the sealer's lock label. What every seal
 *      writes since lock labels.
 *
 * Because the version is inside the AAD, editing it cannot skip the label: a
 * version-2 envelope marked 1 asks for its data key without the label, which
 * KMS (or LocalKeyWrapper) refuses, and its payload would not authenticate
 * under `v1` either. Any other value, or none, is refused before the key is
 * asked anything (envelopeVersion below).
 */
export const CURRENT_AAD_VERSION = 2;

/** The first version whose data key is locked to a label. */
export const LABELLED_AAD_VERSION = 2;

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

/**
 * The version has no default. A default would be a second answer to which
 * version an envelope is, so an envelope without the field could ask for its
 * data key as one version and authenticate its payload as another. open() reads
 * the version once (envelopeVersion) and passes that.
 */
export function buildAad(identity: CredentialIdentity, version: number): Buffer {
  // Field-separated and version-prefixed so the encoding can evolve without
  // silently changing what a given AAD means.
  return Buffer.from(
    `v${version}|clinic:${identity.clinicId}|credential:${identity.credentialId}`,
    "utf8",
  );
}

/**
 * The envelope's version, checked once and then used for both decisions it
 * makes: whether the data key is unwrapped under the label, and which AAD the
 * payload must authenticate under.
 *
 * Anything but a version this code has written is refused, a missing one
 * included. Every seal has written the field since the first, so an envelope
 * without it was made or altered by something else, and the stored shapes do
 * not stop one: user_factors.secret_sealed has no shape check at all. The
 * message names the field and never its value, which could be anything and
 * reaches logs.
 */
function envelopeVersion(sealed: SealedPayload): number {
  const version: unknown = sealed.aadVersion;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= CURRENT_AAD_VERSION
  ) {
    return version;
  }
  throw new Error(
    `The sealed envelope's aadVersion must be a whole number from 1 to ${CURRENT_AAD_VERSION}.`,
  );
}

export async function seal(
  plaintext: string,
  identity: CredentialIdentity,
  label: LockLabel,
): Promise<SealedPayload> {
  assertLockLabel(label);
  const wrapper = getKeyWrapper();
  const { dek, wrapped } = await wrapper.generateDek(label);

  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(buildAad(identity, CURRENT_AAD_VERSION));

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

/**
 * `label` is the one the caller derives for this row, as it did when sealing.
 * It is passed to the wrapper only for an envelope of version 2 or later; a
 * version-1 envelope was sealed before labels and opens without one. It is
 * checked for shape either way, so a sealer that passes no label, or a
 * malformed one, fails on today's rows too. A whole but wrong label is caught
 * only on version-2 envelopes; a version-1 envelope relies on its AAD alone.
 */
export async function open(
  sealed: SealedPayload,
  identity: CredentialIdentity,
  label: LockLabel,
): Promise<string> {
  assertLockLabel(label);
  const version = envelopeVersion(sealed);
  const wrapper = getKeyWrapper();
  const dek = await wrapper.unwrapDek(
    { wrapped: sealed.wrappedDek, keyVersion: sealed.keyVersion },
    version >= LABELLED_AAD_VERSION ? label : null,
  );

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dek,
      Buffer.from(sealed.iv, "base64url"),
    );
    decipher.setAAD(buildAad(identity, version));
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
 *
 * The label is kept: the DEK is unwrapped under `label` and wrapped again under
 * the same one, so the re-wrapped row opens for the same clinic and login and
 * no other. An envelope from before labels is refused rather than re-wrapped:
 * its AAD says version 1, so its data key could only be wrapped again without a
 * label, which neither wrapper does. Seal its credential again instead. An
 * envelope whose version open() would refuse is refused here too, even one
 * already on the current key, so a rotation reports it rather than passing it
 * over as done.
 */
export async function rewrap(sealed: SealedPayload, label: LockLabel): Promise<SealedPayload> {
  assertLockLabel(label);
  const version = envelopeVersion(sealed);
  const wrapper = getKeyWrapper();
  if (sealed.keyVersion === wrapper.keyVersion) return sealed;

  if (version < LABELLED_AAD_VERSION) {
    throw new Error(
      "Refusing to re-wrap an envelope sealed before lock labels (aad_version 1): its data " +
        "key can only be wrapped again without a label. Seal the credential again instead.",
    );
  }

  const dek = await wrapper.unwrapDek(
    { wrapped: sealed.wrappedDek, keyVersion: sealed.keyVersion },
    label,
  );

  try {
    const rewrapped = await wrapper.wrapExisting(dek, label);
    return {
      ...sealed,
      wrappedDek: rewrapped.wrapped,
      keyVersion: rewrapped.keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

// -----------------------------------------------------------------------------
// The self-check
// -----------------------------------------------------------------------------

/**
 * Why a self-check failed: a category, never a message. An AWS error message
 * can carry the key's ARN, the account id and the role's name, and this word
 * is what crosses /api/ops (getCredentialKeyStatus); the scrubbed detail goes
 * to the log instead.
 */
export type CredentialKeyCheckError =
  /**
   * getKeyWrapper() refused this environment: no key, a key id that is not a
   * us-east-1 key ARN, or the local wrapper in production.
   */
  | "unconfigured"
  /** KMS is the provider and its SDK cannot be loaded in this build. */
  | "sdk_missing"
  /** The SDK found no AWS credentials to sign with: no task role, or none it can reach. */
  | "no_credentials"
  /** KMS refused the caller: credentials it does not accept, or the role's policy, or the key's. */
  | "denied"
  /** The key is disabled, pending deletion, missing, or not an encryption key. */
  | "key_unusable"
  /** No answer inside the self-check's budget, or the SDK's own request timeout. */
  | "timeout"
  /** The value came back different. It cannot, which is why it is checked. */
  | "mismatch"
  /** Anything else; the log line written beside it has the detail. */
  | "failed";

export type CredentialKeySelfCheck = {
  ok: boolean;
  /** ISO 8601: when the check finished. */
  at: string;
  /** Present only when `ok` is false. */
  error?: CredentialKeyCheckError;
};

/**
 * Well inside the twelve seconds apps/web's ops client waits for any /api/ops
 * answer (UPSTREAM_TIMEOUT_MS in its ops-client.ts), so a KMS that does not
 * answer is reported as `timeout` rather than as a caller that gave up. A
 * healthy round trip is two KMS calls; this is room for a slow one and its
 * retry.
 */
const SELF_CHECK_BUDGET_MS = 8_000;

/**
 * Not a clinic. The AAD binds this identity like any other, so nothing sealed
 * here could be opened as a real clinic's credential, and nothing is stored.
 * Its lock label, ops / self-check, is what CloudTrail shows for the check's
 * two calls, and it carries both keys like every real seal: a check sent
 * without them would be refused by a task role that requires them, and would
 * report `denied` for a key every real seal can reach.
 */
const SELF_CHECK_CLINIC = "credential-key-self-check";
const SELF_CHECK_LABEL = FIXED_LOCK_LABELS.selfCheck;

/**
 * Error names as the SDK raises them: the service's error code, for the codes
 * KMS models and for the ones every AWS JSON service shares. The last three
 * mean credentials were found and KMS would not accept them, which is the
 * operator's problem in the same place as a policy that says no.
 */
const DENIED: ReadonlySet<string> = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
]);

const KEY_UNUSABLE: ReadonlySet<string> = new Set([
  "DisabledException",
  "KMSInvalidStateException",
  "NotFoundException",
  "KeyUnavailableException",
  "InvalidKeyUsageException",
]);

function classifyKeyFailure(error: unknown): CredentialKeyCheckError {
  if (error instanceof CredentialKeyError) return error.code;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "timeout";
  if (name === "CredentialsProviderError") return "no_credentials";
  if (DENIED.has(name)) return "denied";
  if (KEY_UNUSABLE.has(name)) return "key_unusable";
  return "failed";
}

/**
 * Seal a throwaway value and open it again, through the same wrapper every
 * real credential goes through.
 *
 * The question it answers is the one nothing else asks before it matters: can
 * this process reach its key? Without it, the first sign of a missing task role
 * or a key policy that names the wrong principal is a clinic's connect flow
 * failing at its last step, or a calendar write or a reply that cannot open the
 * clinic's credential. The worker runs it once at start and logs the answer,
 * which is the check an operator can read today. The read-only ops operation
 * getCredentialKeyStatus runs it on demand on the web tier, but only for a
 * signed /api/ops request: nothing in apps/web calls that operation yet, so
 * no console card shows it.
 *
 * The value is random and belongs to nobody, so there is nothing in it to
 * protect and nothing kept: the sealed copy lives only in memory. On KMS this
 * is two calls, GenerateDataKey and Decrypt, each a CloudTrail event like any
 * real unseal.
 *
 * Never throws. A failure is the answer, and a caller that has to catch it is
 * a caller that can forget to.
 */
export async function selfCheckCredentialKey(
  options: { budgetMs?: number } = {},
): Promise<CredentialKeySelfCheck> {
  const identity = { clinicId: SELF_CHECK_CLINIC, credentialId: randomUUID() };
  const probe = randomBytes(16).toString("hex");

  const roundTrip = (async (): Promise<CredentialKeyCheckError | null> => {
    const sealed = await seal(probe, identity, SELF_CHECK_LABEL);
    return (await open(sealed, identity, SELF_CHECK_LABEL)) === probe ? null : "mismatch";
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.budgetMs ?? SELF_CHECK_BUDGET_MS);
  });

  let failure: CredentialKeyCheckError | null;
  try {
    // A round trip still running when the budget wins is abandoned, not
    // cancelled; race() has already subscribed to it, so its eventual
    // rejection is handled rather than reported as unhandled.
    failure = await Promise.race([roundTrip, budget]);
  } catch (error) {
    failure = classifyKeyFailure(error);
    log.error("credential key self-check failed", {
      code: failure,
      error: describeError(error),
    });
  } finally {
    clearTimeout(timer);
  }

  const at = new Date().toISOString();
  return failure ? { ok: false, at, error: failure } : { ok: true, at };
}

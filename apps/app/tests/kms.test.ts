import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { DecryptCommand, KMSClient, type KMSClientConfig } from "@aws-sdk/client-kms";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { open, rewrap, seal, selfCheckCredentialKey } from "@/lib/crypto/envelope";
import {
  AwsKmsKeyWrapper,
  CredentialKeyError,
  credentialSealingProblem,
  getKeyWrapper,
  kmsClientConfig,
  kmsKeyArnProblem,
  __setKeyWrapperForTests,
} from "@/lib/crypto/kms";

import { fakeKms, restoreKeyEnvironment, setKeyEnvironment, TEST_KEY_ARN } from "./setup/kms";

/**
 * The KMS half of credential sealing: what HEALDESK_KMS_KEY_ID may be, how the
 * client is bounded, what the wrapper sends, and how the self-check reports.
 *
 * Nothing here reaches AWS. The wrapper is driven three ways: with a stand-in
 * for KMSClient injected (the commands the SDK would send, read directly), with
 * the real SDK pointed at KMS's wire protocol served from this process, and
 * with the real SDK pointed at an endpoint that never answers, which is how the
 * time limits are checked against the installed version rather than its notes.
 */

afterEach(() => {
  restoreKeyEnvironment();
  vi.restoreAllMocks();
});

const OTHER_KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/0987dcba-09ba-87dc-65fe-0987654321ba";

/** A KMS configuration that passes every check, for tests that vary one thing. */
const KMS_CONFIGURED = {
  HEALDESK_KMS_PROVIDER: "aws-kms",
  HEALDESK_KMS_KEY_ID: TEST_KEY_ARN,
  AWS_REGION: undefined,
} as const;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

// -----------------------------------------------------------------------------

describe("HEALDESK_KMS_KEY_ID: the full ARN of a key in us-east-1, and nothing else", () => {
  test("a key ARN in us-east-1 is accepted, with or without stray whitespace", () => {
    expect(kmsKeyArnProblem(TEST_KEY_ARN)).toBeNull();
    expect(kmsKeyArnProblem(`  ${TEST_KEY_ARN}\n`)).toBeNull();
  });

  // Each value KMS itself would take, or that someone might paste, and why it
  // is refused: an alias can be repointed, a bare id resolves in whatever
  // account and region the client is in, and another region is outside the
  // one the AWS agreement designates.
  const REFUSED: [string, string | undefined, RegExp][] = [
    ["unset", undefined, /is not set/],
    ["empty", "   ", /is not set/],
    ["an alias name", "alias/healdesk-credentials", /alias, not a key/],
    [
      "an alias ARN",
      "arn:aws:kms:us-east-1:111122223333:alias/healdesk-credentials",
      /alias, not a key/,
    ],
    ["a bare key id", "1234abcd-12ab-34cd-56ef-1234567890ab", /bare key id/],
    ["a bare multi-Region key id", "mrk-1234abcd12ab34cd56ef1234567890ab", /bare key id/],
    [
      "a key ARN in another region",
      "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      /outside us-east-1/,
    ],
    [
      "a key ARN in a neighbouring region",
      "arn:aws:kms:us-east-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      /outside us-east-1/,
    ],
    [
      "a multi-Region key ARN",
      "arn:aws:kms:us-east-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab",
      /not the ARN of a single-region KMS key/,
    ],
    [
      "an account id that is not twelve digits",
      "arn:aws:kms:us-east-1:11112222333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      /not the ARN of a single-region KMS key/,
    ],
    [
      "another partition",
      "arn:aws-us-gov:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab",
      /not the ARN of a single-region KMS key/,
    ],
    ["something else entirely", "healdesk-credentials-key", /not the ARN/],
  ];

  test.each(REFUSED)("%s is refused, with a reason", (_label, value, reason) => {
    const problem = kmsKeyArnProblem(value);
    expect(problem).toMatch(reason);
    expect(problem).toContain("arn:aws:kms:us-east-1:<12-digit account>:key/<key id>");
  });

  test.each(REFUSED)(
    "%s makes getKeyWrapper() refuse, naming the variable but not its value",
    (_label, value, reason) => {
      setKeyEnvironment({ ...KMS_CONFIGURED, HEALDESK_KMS_KEY_ID: value });

      const error = thrown(() => getKeyWrapper());
      expect(error).toBeInstanceOf(CredentialKeyError);
      expect((error as CredentialKeyError).code).toBe("unconfigured");
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).toMatch(/HEALDESK_KMS_KEY_ID/);
      // The message reaches logs and the operator; whatever was pasted into the
      // variable stays where it was pasted.
      if (value?.trim()) expect((error as Error).message).not.toContain(value.trim());
    },
  );

  test("a key ARN builds the KMS wrapper, which records the ARN as the key version", () => {
    setKeyEnvironment(KMS_CONFIGURED);
    const wrapper = getKeyWrapper();
    expect(wrapper).toBeInstanceOf(AwsKmsKeyWrapper);
    expect(wrapper.keyVersion).toBe(`kms:${TEST_KEY_ARN}`);

    setKeyEnvironment({ ...KMS_CONFIGURED, AWS_REGION: "us-east-1" });
    expect(getKeyWrapper()).toBeInstanceOf(AwsKmsKeyWrapper);

    // Empty, as .env.example ships it, is unset rather than another region.
    setKeyEnvironment({ ...KMS_CONFIGURED, AWS_REGION: "" });
    expect(getKeyWrapper()).toBeInstanceOf(AwsKmsKeyWrapper);
  });

  test("an AWS_REGION other than us-east-1 is refused: the client could never reach the key", () => {
    setKeyEnvironment({ ...KMS_CONFIGURED, AWS_REGION: "eu-west-1" });
    const error = thrown(() => getKeyWrapper());
    expect(error).toBeInstanceOf(CredentialKeyError);
    expect((error as Error).message).toMatch(/AWS_REGION names a region other than us-east-1/);
  });

  test("production still refuses the local wrapper", () => {
    setKeyEnvironment({ HEALDESK_KMS_PROVIDER: "local", NODE_ENV: "production" });
    const error = thrown(() => getKeyWrapper());
    expect(error).toBeInstanceOf(CredentialKeyError);
    expect((error as Error).message).toMatch(/Refusing to use the local key wrapper in production/);
  });

  test("the wrapper's own constructor refuses a bad key id, even with a client in hand", () => {
    const error = thrown(
      () => new AwsKmsKeyWrapper("alias/healdesk-credentials", { client: fakeKms().client }),
    );
    expect(error).toBeInstanceOf(CredentialKeyError);
  });
});

// -----------------------------------------------------------------------------

describe("the KMS client: a named region, bounded calls, one retry", () => {
  test("its configuration", () => {
    setKeyEnvironment({ AWS_REGION: undefined });
    expect(kmsClientConfig()).toEqual({
      region: "us-east-1",
      maxAttempts: 2,
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 5_000,
        throwOnRequestTimeout: true,
      },
    });

    setKeyEnvironment({ AWS_REGION: "us-east-1" });
    expect(kmsClientConfig().region).toBe("us-east-1");

    // The SDK's constructor refuses an empty region, so empty means the fallback.
    setKeyEnvironment({ AWS_REGION: "" });
    expect(kmsClientConfig().region).toBe("us-east-1");
  });

  /**
   * The installed SDK's behaviour, pinned. On @aws-sdk 3.1146 with
   * @smithy/node-http-handler 4.12, the Node handler's `requestTimeout` only
   * warns when it passes unless `throwOnRequestTimeout` is set; kms.ts and
   * deliver.ts both rely on the flag to make their limits limits. If an upgrade
   * changes either half, these fail here rather than as a request that hangs in
   * production.
   */
  describe("against an endpoint that takes every request and never answers", () => {
    let server: Server;
    let endpoint: string;
    let received = 0;

    beforeAll(async () => {
      server = createServer(() => {
        received += 1;
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      server.close();
    });

    const client = (requestHandler: Record<string, unknown>) =>
      new KMSClient({
        ...kmsClientConfig(),
        endpoint,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-only-not-a-secret" },
        requestHandler,
      });

    const decrypt = () =>
      new DecryptCommand({ CiphertextBlob: new Uint8Array(16), KeyId: TEST_KEY_ARN });

    test("with throwOnRequestTimeout, as configured, the call fails with TimeoutError after its two attempts", async () => {
      received = 0;
      // Shortened from 5 s so the test is quick; nothing else differs from kmsClientConfig().
      const kms = client({ ...kmsClientConfig().requestHandler, requestTimeout: 150 });

      const error = await kms.send(decrypt()).then(
        () => null,
        (failure: unknown) => failure,
      );
      kms.destroy();

      expect(error).toMatchObject({ name: "TimeoutError" });
      // Retried as a transient error, and only once: maxAttempts is 2.
      expect(received).toBe(2);
    });

    test("without it, the same limit only logs a warning and the call keeps waiting", async () => {
      const warnings: string[] = [];
      const logger = {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: () => {},
      };
      const kms = client({ connectionTimeout: 2_000, requestTimeout: 100, logger });
      const abort = new AbortController();

      let settled = false;
      const call = kms.send(decrypt(), { abortSignal: abort.signal }).then(
        () => (settled = true),
        () => (settled = true),
      );

      await vi.waitFor(() => expect(warnings.join("\n")).toMatch(/requestTimeout/), {
        timeout: 5_000,
      });
      // Several timeouts' worth past the warning, and still nothing.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      abort.abort();
      await call;
      kms.destroy();
    });
  });
});

// -----------------------------------------------------------------------------

describe("AwsKmsKeyWrapper against a stand-in for KMSClient", () => {
  test("seal and open: one GenerateDataKey and one Decrypt, each naming the key by its full ARN", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
    const identity = { clinicId: randomUUID(), credentialId: randomUUID() };

    const sealed = await seal("a-throwaway-value", identity);
    expect(sealed.keyVersion).toBe(`kms:${TEST_KEY_ARN}`);
    expect(await open(sealed, identity)).toBe("a-throwaway-value");

    expect(kms.calls).toEqual([
      { command: "GenerateDataKey", keyId: TEST_KEY_ARN, keySpec: "AES_256" },
      { command: "Decrypt", keyId: TEST_KEY_ARN },
    ]);
  });

  test("Encrypt: a data key already in hand is wrapped under the same key and comes back intact", async () => {
    const kms = fakeKms();
    const wrapper = new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client });
    const dek = randomBytes(32);

    const wrapped = await wrapper.wrapExisting(dek);
    expect(wrapped.keyVersion).toBe(`kms:${TEST_KEY_ARN}`);
    expect(await wrapper.unwrapDek(wrapped)).toEqual(dek);

    expect(kms.calls).toEqual([
      { command: "Encrypt", keyId: TEST_KEY_ARN },
      { command: "Decrypt", keyId: TEST_KEY_ARN },
    ]);
  });

  test("rewrap leaves a payload already under the key alone, and asks KMS nothing", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));
    const sealed = await seal("a-throwaway-value", {
      clinicId: randomUUID(),
      credentialId: randomUUID(),
    });
    const before = kms.calls.length;

    expect(await rewrap(sealed)).toBe(sealed);
    expect(kms.calls).toHaveLength(before);
  });

  test("Decrypt carries the key's ARN, so a data key made under it is refused under any other", async () => {
    const kms = fakeKms(TEST_KEY_ARN);
    const ours = new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client });
    const other = new AwsKmsKeyWrapper(OTHER_KEY_ARN, { client: kms.client });

    const { wrapped } = await ours.generateDek();
    await expect(other.unwrapDek(wrapped)).rejects.toMatchObject({
      name: "IncorrectKeyException",
    });
    expect(kms.calls.at(-1)).toEqual({ command: "Decrypt", keyId: OTHER_KEY_ARN });
  });
});

// -----------------------------------------------------------------------------

/**
 * KMS's wire protocol (AWS JSON 1.1), answered from this process: enough of
 * GenerateDataKey and Decrypt for the real SDK to complete a round trip, or one
 * error code for every call. The "ciphertext" is the data key behind a prefix,
 * not encryption: what is under test is the SDK and the wrapper's use of it.
 */
async function localKms() {
  const prefix = Buffer.from("test-endpoint-wrap:");
  const requests: { target: string; keyId: unknown; keySpec?: unknown }[] = [];
  let refusal: string | undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        string | undefined
      >;
      const target = String(req.headers["x-amz-target"] ?? "");
      requests.push({
        target,
        keyId: body.KeyId,
        ...(body.KeySpec ? { keySpec: body.KeySpec } : {}),
      });

      const answer = (status: number, payload: object) => {
        res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
        res.end(JSON.stringify(payload));
      };

      if (refusal) {
        answer(400, { __type: refusal, message: "refused by the test endpoint" });
      } else if (target === "TrentService.GenerateDataKey") {
        const dek = randomBytes(32);
        answer(200, {
          KeyId: body.KeyId,
          Plaintext: dek.toString("base64"),
          CiphertextBlob: Buffer.concat([prefix, dek]).toString("base64"),
        });
      } else if (target === "TrentService.Decrypt") {
        const blob = Buffer.from(body.CiphertextBlob ?? "", "base64");
        answer(200, {
          KeyId: body.KeyId,
          Plaintext: blob.subarray(prefix.length).toString("base64"),
        });
      } else {
        answer(400, { __type: "UnsupportedOperationException", message: "not served here" });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    refuseWith(code: string | undefined) {
      refusal = code;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("the real SDK, through the wrapper's own client, against KMS's protocol served locally", () => {
  let kms: Awaited<ReturnType<typeof localKms>>;

  beforeAll(async () => {
    kms = await localKms();
  });

  afterAll(() => kms.close());

  /**
   * Production's construction path exactly: getKeyWrapper() builds the
   * wrapper, the wrapper imports the SDK and builds a KMSClient from
   * kmsClientConfig(). Only the endpoint and the credentials come from the
   * environment, as the SDK reads them; the credentials are AWS's documentation
   * placeholder, signed for an endpoint that never checks them.
   */
  const configure = () =>
    setKeyEnvironment({
      ...KMS_CONFIGURED,
      AWS_REGION: "us-east-1",
      AWS_ENDPOINT_URL: undefined,
      AWS_ENDPOINT_URL_KMS: kms.url,
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: undefined,
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "test-only-not-a-secret",
      AWS_SESSION_TOKEN: undefined,
      AWS_PROFILE: undefined,
    });

  test("the self-check passes, and the key's ARN is what goes on the wire", async () => {
    configure();
    kms.refuseWith(undefined);
    kms.requests.length = 0;

    expect(await selfCheckCredentialKey()).toEqual({ ok: true, at: expect.any(String) });
    expect(kms.requests).toEqual([
      { target: "TrentService.GenerateDataKey", keyId: TEST_KEY_ARN, keySpec: "AES_256" },
      { target: "TrentService.Decrypt", keyId: TEST_KEY_ARN },
    ]);
  });

  test.each([
    ["AccessDeniedException", "denied"],
    ["UnrecognizedClientException", "denied"],
    ["DisabledException", "key_unusable"],
    ["NotFoundException", "key_unusable"],
  ] as const)("KMS answering %s reads as %s", async (code, word) => {
    configure();
    kms.refuseWith(code);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await selfCheckCredentialKey();
    kms.refuseWith(undefined);

    expect(result).toEqual({ ok: false, at: expect.any(String), error: word });
    expect(JSON.stringify(result)).not.toContain("refused by the test endpoint");
  });

  /**
   * The construction site, not only kmsClientConfig()'s return value. Every
   * call above would succeed just the same from a wrapper that built
   * `new KMSClient({})`: configure() supplies the region and the endpoint
   * through the environment, this endpoint answers at once, and a 400 is never
   * retried. So what the wrapper's own client was constructed with is read
   * directly, since that is where the time limits either are or are not.
   */
  test("the wrapper builds its client from kmsClientConfig(), time limits included", async () => {
    const constructed: unknown[] = [];
    vi.resetModules();
    vi.doMock("@aws-sdk/client-kms", async (importOriginal) => {
      const sdk = await importOriginal<typeof import("@aws-sdk/client-kms")>();
      class RecordingKMSClient extends sdk.KMSClient {
        constructor(config: KMSClientConfig) {
          constructed.push(structuredClone(config));
          super(config);
        }
      }
      return { ...sdk, KMSClient: RecordingKMSClient };
    });

    try {
      const fresh = {
        envelope: await import("@/lib/crypto/envelope"),
        kms: await import("@/lib/crypto/kms"),
      };
      configure();
      kms.refuseWith(undefined);

      expect(await fresh.envelope.selfCheckCredentialKey()).toEqual({
        ok: true,
        at: expect.any(String),
      });
      // One client, for the seal and the open both, built from the bounded config.
      expect(constructed).toEqual([fresh.kms.kmsClientConfig()]);
      expect(constructed[0]).toMatchObject({
        region: "us-east-1",
        maxAttempts: 2,
        requestHandler: { requestTimeout: 5_000, throwOnRequestTimeout: true },
      });
    } finally {
      vi.doUnmock("@aws-sdk/client-kms");
      vi.resetModules();
    }
  });
});

// -----------------------------------------------------------------------------

describe("selfCheckCredentialKey()", () => {
  test("passes on the local wrapper the tests run with", async () => {
    const result = await selfCheckCredentialKey();
    expect(result).toEqual({ ok: true, at: expect.any(String) });
    expect(new Date(result.at).toISOString()).toBe(result.at);
  });

  test("passes through KMS with two calls, both naming the key, and keeps nothing", async () => {
    const kms = fakeKms();
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

    expect(await selfCheckCredentialKey()).toEqual({ ok: true, at: expect.any(String) });
    expect(kms.calls.map((call) => [call.command, call.keyId])).toEqual([
      ["GenerateDataKey", TEST_KEY_ARN],
      ["Decrypt", TEST_KEY_ARN],
    ]);
  });

  test.each([
    ["AccessDeniedException", "denied"],
    ["ExpiredTokenException", "denied"],
    ["CredentialsProviderError", "no_credentials"],
    ["KMSInvalidStateException", "key_unusable"],
    ["TimeoutError", "timeout"],
    ["KMSInternalException", "failed"],
  ] as const)(
    "a %s comes back as %s: answered, not thrown, and without the message",
    async (name, word) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const kms = fakeKms(TEST_KEY_ARN, { fail: name });
      __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

      const result = await selfCheckCredentialKey();

      expect(result).toEqual({ ok: false, at: expect.any(String), error: word });
      expect(JSON.stringify(result)).not.toContain("stand-in");
      // The detail goes to the log, scrubbed, once.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain(`"code":"${word}"`);
    },
  );

  test("a KMS that never answers is reported as a timeout, inside the check's own budget", async () => {
    const kms = fakeKms(TEST_KEY_ARN, { hang: true });
    __setKeyWrapperForTests(new AwsKmsKeyWrapper(TEST_KEY_ARN, { client: kms.client }));

    const started = Date.now();
    const result = await selfCheckCredentialKey({ budgetMs: 50 });
    expect(result).toEqual({ ok: false, at: expect.any(String), error: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a key id that is not a key ARN is reported as unconfigured, not thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setKeyEnvironment({ ...KMS_CONFIGURED, HEALDESK_KMS_KEY_ID: "alias/healdesk-credentials" });

    expect(await selfCheckCredentialKey()).toEqual({
      ok: false,
      at: expect.any(String),
      error: "unconfigured",
    });
  });
});

// -----------------------------------------------------------------------------

describe("credentialSealingProblem(): whether to start what only a sealed credential can finish", () => {
  test("none on the local wrapper outside production", async () => {
    expect(await credentialSealingProblem()).toBeNull();
  });

  test("none for a key ARN once the SDK loads, without calling KMS", async () => {
    setKeyEnvironment(KMS_CONFIGURED);
    expect(await credentialSealingProblem()).toBeNull();
  });

  test("the reason, when the key id is not a key ARN or production has no KMS", async () => {
    setKeyEnvironment({ ...KMS_CONFIGURED, HEALDESK_KMS_KEY_ID: "alias/healdesk-credentials" });
    expect(await credentialSealingProblem()).toMatch(/alias, not a key/);

    setKeyEnvironment({ HEALDESK_KMS_PROVIDER: "local", NODE_ENV: "production" });
    expect(await credentialSealingProblem()).toMatch(/Refusing to use the local key wrapper/);
  });

  test("the reason, when the build cannot load the SDK: every production build until 6 October 2026", async () => {
    vi.resetModules();
    vi.doMock("@aws-sdk/client-kms", () => {
      throw new Error("Cannot find module '@aws-sdk/client-kms'");
    });
    try {
      const fresh = await import("@/lib/crypto/kms");
      setKeyEnvironment(KMS_CONFIGURED);
      expect(await fresh.credentialSealingProblem()).toMatch(
        /@aws-sdk\/client-kms could not be loaded/,
      );
    } finally {
      vi.doUnmock("@aws-sdk/client-kms");
      vi.resetModules();
    }
  });
});

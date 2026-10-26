/**
 * The inbound bucket, as the handler and the sweep see it (lane P7g): read
 * one message, delete it, list what is left. S3 behind an interface, so the
 * tests hand in a store held in memory and nothing here reaches AWS.
 *
 * The SDK is loaded lazily by a literal specifier, as lib/patient-rights/
 * export-store.ts does, so nothing else in apps/app pays for it and the
 * production build traces it (next.config.ts lists it in
 * serverExternalPackages). The task role may get, delete and list under
 * mail/ and nothing else (infra/aws/iam.tf); S3 decrypts under the project's
 * key, so the bytes arrive as SES received them.
 */

export type StoredMail = {
  /** The object's size in bytes, before anything is read. */
  size: number;
  /** Read the whole object into memory. Called only when size is within the cap. */
  read(): Promise<Uint8Array>;
  /** Read only the first `bytes` (an oversize message's header block), by a ranged request. */
  readHead(bytes: number): Promise<Uint8Array>;
  /** Let go of the body unread (an oversize message). */
  discard(): void;
};

export type ListedMail = { key: string; lastModified: Date; size: number };

export interface MailStore {
  /** The object, or null when it is not there (already deleted, or expired). */
  get(bucket: string, key: string): Promise<StoredMail | null>;
  /** Delete the object. Deleting one that is not there is not an error (S3's own rule). */
  delete(bucket: string, key: string): Promise<void>;
  /** Every object under the prefix, at most `limit`. */
  list(bucket: string, prefix: string, limit: number): Promise<ListedMail[]>;
}

type Body = {
  transformToByteArray(): Promise<Uint8Array>;
  destroy?: () => void;
};

let client: Promise<{ send: (command: unknown) => Promise<unknown>; s3: typeof import("@aws-sdk/client-s3") }> | null = null;

function s3Client() {
  client ??= (async () => {
    const s3 = await import("@aws-sdk/client-s3");
    const c = new s3.S3Client({});
    return { send: (command: unknown) => c.send(command as never), s3 };
  })();
  return client;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/** The store on S3, through the task role. */
export const s3MailStore: MailStore = {
  async get(bucket, key) {
    const { send, s3 } = await s3Client();
    try {
      const out = (await send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        ContentLength?: number;
        Body?: Body;
      };
      const body = out.Body;
      if (!body) return null;
      return {
        size: Number(out.ContentLength ?? 0),
        read: () => body.transformToByteArray(),
        readHead: async (bytes) => {
          body.destroy?.();
          const ranged = (await send(
            new s3.GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` }),
          )) as { Body?: Body };
          return ranged.Body ? ranged.Body.transformToByteArray() : new Uint8Array();
        },
        discard: () => body.destroy?.(),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
  async delete(bucket, key) {
    const { send, s3 } = await s3Client();
    await send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
  async list(bucket, prefix, limit) {
    const { send, s3 } = await s3Client();
    const out: ListedMail[] = [];
    let token: string | undefined;
    do {
      const page = (await send(
        new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, limit) }),
      )) as { Contents?: { Key?: string; LastModified?: Date; Size?: number }[]; NextContinuationToken?: string; IsTruncated?: boolean };
      for (const item of page.Contents ?? []) {
        if (item.Key && item.LastModified) out.push({ key: item.Key, lastModified: item.LastModified, size: Number(item.Size ?? 0) });
        if (out.length >= limit) return out;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  },
};

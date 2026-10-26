import type { MailStore } from "@/lib/support/inbound/store";

/** A store held in memory, for the tests: what was put, read and deleted. */
export function memoryMailStore(initial: Record<string, { bytes: Uint8Array | string; lastModified?: Date }> = {}) {
  const objects = new Map<string, { bytes: Uint8Array; lastModified: Date }>();
  for (const [key, value] of Object.entries(initial)) {
    objects.set(key, {
      bytes: typeof value.bytes === "string" ? new TextEncoder().encode(value.bytes) : value.bytes,
      lastModified: value.lastModified ?? new Date("2026-10-26T12:00:00Z"),
    });
  }
  const deleted: string[] = [];
  const store: MailStore & {
    objects: typeof objects;
    deleted: string[];
    put(key: string, bytes: Uint8Array | string, lastModified?: Date): void;
    failDeletes: boolean;
    failGets: boolean;
  } = {
    objects,
    deleted,
    failDeletes: false,
    failGets: false,
    put(key, bytes, lastModified) {
      objects.set(key, {
        bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
        lastModified: lastModified ?? new Date("2026-10-26T12:00:00Z"),
      });
    },
    async get(_bucket, key) {
      if (store.failGets) throw new Error("storage unavailable");
      const o = objects.get(key);
      if (!o) return null;
      return { size: o.bytes.byteLength, read: async () => o.bytes, readHead: async (n: number) => o.bytes.subarray(0, n), discard: () => {} };
    },
    async delete(_bucket, key) {
      if (store.failDeletes) throw new Error("storage unavailable");
      objects.delete(key);
      deleted.push(key);
    },
    async list(_bucket, prefix, limit) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .slice(0, limit)
        .map(([key, o]) => ({ key, lastModified: o.lastModified, size: o.bytes.byteLength }));
    },
  };
  return store;
}

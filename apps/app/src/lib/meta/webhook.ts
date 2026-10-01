import { createHmac, timingSafeEqual } from "node:crypto";

import type { MetaPlatform } from "./front-door";

/**
 * Reading what Meta sends. Three products, two payload shapes:
 *
 *   Messenger and Instagram: `entry[].messaging[]`, each with `sender.id`,
 *   `recipient.id` (the page or Instagram account we are answering for) and
 *   `message.text`. `object` is "page" or "instagram".
 *
 *   WhatsApp Cloud API: `entry[].changes[].value` with `metadata.phone_number_id`
 *   (ours) and `messages[]` each with `from` and `text.body`. `object` is
 *   "whatsapp_business_account".
 *
 * Only text is read. Attachments, reactions, delivery receipts and echoes of
 * our own replies are dropped. The `externalId` is what resolves the clinic
 * (app_meta_channel); the `senderId` is the platform's opaque id for the
 * person, used once to address the reply and never stored.
 *
 * `sentAt` is when the person sent the message, as Meta stamps it
 * (`timestamp`: milliseconds on Messenger and Instagram, seconds as a string
 * on WhatsApp), never later than the moment it is read. It is the start of
 * the 24-hour window, so a webhook Meta retries a day late does not reopen a
 * window that has already closed. Absent when the payload carries none.
 */
export type InboundMetaMessage = {
  platform: MetaPlatform;
  externalId: string;
  senderId: string;
  text: string;
  sentAt?: Date;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Meta's `timestamp`, in the unit the platform uses, as a Date no later than now; undefined when missing or nonsense. */
function sentAtOf(raw: unknown, unit: "ms" | "s", now: Date): Date | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const at = new Date(unit === "s" ? n * 1000 : n);
  if (!Number.isFinite(at.getTime())) return undefined;
  return at.getTime() > now.getTime() ? now : at;
}

export function parseMetaEvents(body: unknown, now: Date = new Date()): InboundMetaMessage[] {
  const root = obj(body);
  const out: InboundMetaMessage[] = [];
  const object = str(root.object);
  for (const entryRaw of arr(root.entry)) {
    const entry = obj(entryRaw);
    if (object === "page" || object === "instagram") {
      const platform: MetaPlatform = object === "page" ? "messenger" : "instagram";
      for (const m of arr(entry.messaging)) {
        const msg = obj(m);
        const message = obj(msg.message);
        if (message.is_echo === true) continue;
        const text = str(message.text);
        const senderId = str(obj(msg.sender).id);
        const externalId = str(obj(msg.recipient).id) ?? str(entry.id);
        if (!text || !senderId || !externalId) continue;
        const sentAt = sentAtOf(msg.timestamp, "ms", now);
        out.push({ platform, externalId, senderId, text, ...(sentAt ? { sentAt } : {}) });
      }
    } else if (object === "whatsapp_business_account") {
      for (const c of arr(entry.changes)) {
        const value = obj(obj(c).value);
        const externalId = str(obj(value.metadata).phone_number_id);
        for (const m of arr(value.messages)) {
          const msg = obj(m);
          if (str(msg.type) !== "text") continue;
          const text = str(obj(msg.text).body);
          const senderId = str(msg.from);
          if (!text || !senderId || !externalId) continue;
          const sentAt = sentAtOf(msg.timestamp, "s", now);
          out.push({ platform: "whatsapp", externalId, senderId, text, ...(sentAt ? { sentAt } : {}) });
        }
      }
    }
  }
  return out;
}

/** X-Hub-Signature-256: "sha256=<hex hmac of the raw body with the app secret>". */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const presented = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signMetaBody(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

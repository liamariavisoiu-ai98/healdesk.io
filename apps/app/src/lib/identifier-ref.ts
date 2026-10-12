import { createHmac, hkdfSync } from "node:crypto";

import { env } from "@/lib/env";

/**
 * The reference we store in place of a vendor's identifier.
 *
 * Three ledgers have to recognise something they have seen before without
 * holding it: chat_threads finds a person's conversation by their sender id,
 * meta_inbound_messages skips a Meta message delivered twice, and
 * usage_events counts a call or a conversation once. A fourth, the record of
 * a deletion request, has to recognise the person it deleted if a restore
 * brings them back (erasure_requests.restore_refs). The 0043 design stored a
 * plain sha256 of each id, and a WhatsApp sender id is the sender's phone
 * number: there are few enough numbers to hash them all and read the table
 * back. So the reference is an HMAC-SHA256 under a key that lives only in the
 * environment (HEALDESK_IDENTIFIER_REF_KEY, see env.ts on why it must never
 * be rotated without a re-key plan), and a copy of the database alone reveals
 * nothing. slot_holds names who holds a time the same way (kind
 * `slot_holder`, lib/booking/holds.ts holderRefOf, which leaves the prefix
 * off for that column's CHECK).
 *
 * Construction, version 1:
 *
 *   key = HKDF-SHA256(HEALDESK_IDENTIFIER_REF_KEY, salt: none,
 *                     info: "healdesk.identifier-ref.v1", 32 bytes)
 *   ref = "v1:" + hex(HMAC-SHA256(key, kind || 0x00 || clinicId || 0x00 || value))
 *
 * The kind and the clinic are in the message, so the same id seen as a
 * different kind of thing, or at a different clinic, never yields the same
 * reference: a Meta message id cannot collide with a chat party, and one
 * clinic's references say nothing about another's. Neither the kind nor a
 * uuid can contain a NUL byte, so the encoding is unambiguous whatever the
 * value holds. The "v1:" prefix names the construction, so a later version
 * can sit beside this one in the same column during a re-key.
 *
 * Pure apart from reading the key: no clock, no database. The value is never
 * logged and never appears in an error.
 */

/**
 * `erasure` is the deletion request's own kind (lib/patient-rights/erasure.ts):
 * the reference to a telephone number ("phone:" + E.164) or an email address
 * ("email:" + the lower-cased address) that a deletion found, kept on the
 * request only to delete the person again after a restore, and never used to
 * find anyone for any other purpose.
 */
export type IdentifierRefKind =
  | "chat_party"
  | "meta_message"
  | "call"
  | "chat_conversation"
  | "slot_holder"
  | "erasure";

export const IDENTIFIER_REF_KINDS: readonly IdentifierRefKind[] = [
  "chat_party",
  "meta_message",
  "call",
  "chat_conversation",
  "slot_holder",
  "erasure",
];

export const IDENTIFIER_REF_HKDF_INFO = "healdesk.identifier-ref.v1";
export const IDENTIFIER_REF_PREFIX = "v1:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The derived key, kept per secret so a test that changes the variable gets a fresh one. */
let derived: { secret: string; key: Buffer } | null = null;

function derivedKey(): Buffer {
  const secret = env.identifierRefKey();
  if (derived?.secret !== secret) {
    const key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), IDENTIFIER_REF_HKDF_INFO, 32),
    );
    derived = { secret, key };
  }
  return derived.key;
}

/**
 * `kind`: what the identifier is. `clinicId`: the clinic it was seen at.
 * `value`: the vendor's identifier itself (a sender id, a message id, a call
 * id) or our own conversation id. Throws on an unknown kind, a clinic id that
 * is not a uuid, or an empty value, naming which, never the value.
 */
export function identifierRef(kind: IdentifierRefKind, clinicId: string, value: string): string {
  if (!IDENTIFIER_REF_KINDS.includes(kind)) {
    throw new Error(`identifierRef: unknown kind "${String(kind)}".`);
  }
  if (typeof clinicId !== "string" || !UUID.test(clinicId)) {
    throw new Error("identifierRef: the clinic id is not a uuid.");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("identifierRef: there is no identifier to reference.");
  }
  const mac = createHmac("sha256", derivedKey())
    .update(`${kind}\u0000${clinicId.toLowerCase()}\u0000`, "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `${IDENTIFIER_REF_PREFIX}${mac}`;
}

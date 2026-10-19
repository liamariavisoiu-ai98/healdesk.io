import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/**
 * The receipt that turns a closed clinic's download into a delivery
 * (plan Part F4: "a *complete* export after cancellation stamps
 * export_delivered_at").
 *
 * After cancellation the destruction clock reads export_delivered_at: on
 * BAA 1.3.0 and its successors and the DPA, the data goes thirty days after
 * the end once the export is delivered, and at the next hourly run when the
 * delivery is later. Stamping it when the server produced the file would
 * count a download that never arrived (a dropped connection, a timeout on a
 * large bundle) as delivered, and destroy the records sixty days early. So
 * the server hands the browser the file and this receipt, and stamps
 * nothing; the browser, holding the whole file, sends the receipt back with
 * the SHA-256 of what it received; and only a digest that matches the file
 * the server produced records the delivery.
 *
 * `<base64url(clinicId:issuedAtMs)>.<mac>`: the MAC, under a key of its own
 * derived from the auth secret, covers the clinic, the moment and the file's
 * digest. The digest itself is not in the receipt, so a browser cannot echo
 * one it did not compute from the whole file. Checkable without a database,
 * and good for EXPORT_RECEIPT_TTL_MS.
 */

/** How long a download has to report that it arrived in full. */
export const EXPORT_RECEIPT_TTL_MS = 60 * 60_000;

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(): Buffer {
  // Its own key, so a receipt's MAC can never be replayed as anything else
  // the auth secret signs, and the reverse.
  return createHmac("sha256", env.betterAuthSecret()).update("healdesk export receipt v1").digest();
}

function mac(head: string, digest: string): string {
  return createHmac("sha256", key()).update(`${head}.${digest}`).digest("base64url");
}

/** The SHA-256 of the file as the browser saves it: the body's UTF-8 bytes, in hex. */
export function exportDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The receipt for one file handed to the browser. */
export function exportReceipt(clinicId: string, body: string, issuedAt: Date): string {
  const head = Buffer.from(`${clinicId}:${issuedAt.getTime()}`, "utf8").toString("base64url");
  return `${head}.${mac(head, exportDigest(body))}`;
}

/**
 * Whether `receipt` was issued for this clinic, within its time, for a file
 * whose digest is `digest`. Anything malformed is simply no.
 */
export function receiptMatches(
  receipt: unknown,
  clinicId: string,
  digest: unknown,
  now: Date,
): boolean {
  if (typeof receipt !== "string" || receipt.length > 200) return false;
  if (typeof digest !== "string" || !HEX_DIGEST.test(digest)) return false;
  const parts = receipt.split(".");
  if (parts.length !== 2) return false;
  const [head, given] = parts as [string, string];
  const [id, at, ...rest] = Buffer.from(head, "base64url").toString("utf8").split(":");
  if (rest.length > 0 || !id || !UUID.test(id) || id.toLowerCase() !== clinicId.toLowerCase()) {
    return false;
  }
  if (!at || !/^\d{1,16}$/.test(at)) return false;
  const age = now.getTime() - Number(at);
  // A minute's grace for clocks read twice; never a receipt from the future.
  if (age > EXPORT_RECEIPT_TTL_MS || age < -60_000) return false;
  const want = Buffer.from(mac(head, digest));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

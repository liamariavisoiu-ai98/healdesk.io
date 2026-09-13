import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { verifySvix } from "./route";

const SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function sign(id: string, ts: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("Resend (Svix) signature verification", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.test"] } });
  const now = 1_800_000_000_000;
  const ts = Math.floor(now / 1000);

  test("accepts a correctly signed, fresh delivery", () => {
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(ts),
      "webhook-signature": `v0,garbage ${sign("msg_1", ts, body)}`,
    });
    expect(verifySvix(headers, body, SECRET, now)).toBe(true);
  });

  test("rejects a wrong secret, a tampered body, and a stale timestamp", () => {
    const good = sign("msg_1", ts, body);
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": good }), body + " ", SECRET, now),
    ).toBe(false);
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": good }), body, "whsec_" + Buffer.from("x".repeat(32)).toString("base64"), now),
    ).toBe(false);
    const old = ts - 10 * 60;
    expect(
      verifySvix(new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(old), "webhook-signature": sign("msg_1", old, body) }), body, SECRET, now),
    ).toBe(false);
  });
});

import { MAX_SKEW_SECONDS, sign, verify } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

const SECRET = "test-provisioning-secret";
const NOW = 1_800_000_000_000;

function signedAt(body: string, epochSeconds: number) {
  const timestamp = String(epochSeconds);
  return { timestamp, signature: sign(body, timestamp, SECRET) };
}

describe("request signing", () => {
  const body = JSON.stringify({ clinicName: "Radiance", plan: "core" });

  test("accepts a correctly signed request", () => {
    const { timestamp, signature } = signedAt(body, NOW / 1000);
    expect(verify(body, timestamp, signature, SECRET, NOW)).toEqual({
      ok: true,
    });
  });

  test("rejects a tampered body", () => {
    const { timestamp, signature } = signedAt(body, NOW / 1000);
    // The attack the body-signing exists to stop: same envelope, different plan.
    const tampered = JSON.stringify({ clinicName: "Radiance", plan: "multi" });

    expect(verify(tampered, timestamp, signature, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a replayed request once the window has passed", () => {
    const issued = NOW / 1000 - (MAX_SKEW_SECONDS + 1);
    const { timestamp, signature } = signedAt(body, issued);

    const result = verify(body, timestamp, signature, SECRET, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/window/);
  });

  test("rejects a far-future timestamp", () => {
    // A clock skew forward is as suspicious as a stale request, and without
    // this check a signature could be minted to stay valid indefinitely.
    const issued = NOW / 1000 + (MAX_SKEW_SECONDS + 1);
    const { timestamp, signature } = signedAt(body, issued);

    expect(verify(body, timestamp, signature, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a signature made with a different secret", () => {
    const timestamp = String(NOW / 1000);
    const signature = sign(body, timestamp, "someone-elses-secret");

    expect(verify(body, timestamp, signature, SECRET, NOW).ok).toBe(false);
  });

  test("rejects missing headers rather than throwing", () => {
    expect(verify(body, null, null, SECRET, NOW).ok).toBe(false);
    expect(verify(body, String(NOW / 1000), null, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the length check must come
    // first or an attacker learns the expected length from the error.
    const timestamp = String(NOW / 1000);
    expect(() => verify(body, timestamp, "short", SECRET, NOW)).not.toThrow();
    expect(verify(body, timestamp, "short", SECRET, NOW).ok).toBe(false);
  });
});

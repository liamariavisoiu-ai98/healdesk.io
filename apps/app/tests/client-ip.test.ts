import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { requestMeta as portalRequestMeta } from "@/app/c/[slug]/request-meta";
import { clientIp, TRUSTED_PROXY_HOPS } from "@/lib/client-ip";
import { requestContextFrom } from "@/lib/meta/connect-http";
import { requestMeta as sessionRequestMeta } from "@/lib/session";

/**
 * The client address behind the load balancer (src/lib/client-ip.ts).
 *
 * On AWS the ALB appends the address it accepted the connection from to
 * X-Forwarded-For and keeps whatever the browser sent to the left of it, so
 * the first entry is the browser's to choose. Every browser-facing reader
 * used to take that first entry: an audit row's address, a security event's,
 * a spent link's and every per-address throttle key were whatever the client
 * typed. These pin the rightmost entry, the readers that use it, and the one
 * door every new reader has to go through.
 */

const mocks = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));

/** What the ALB hands the app when the browser forged an entry of its own. */
const SPOOFED_THEN_REAL = "198.51.100.1, 203.0.113.7";

function forwarded(value: string | null, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  if (value !== null) headers.set("x-forwarded-for", value);
  return headers;
}

describe("clientIp", () => {
  test("trusts exactly one proxy, the ALB", () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });

  test("takes the entry the load balancer appended, never the browser's own", () => {
    expect(clientIp(forwarded("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(forwarded(SPOOFED_THEN_REAL))).toBe("203.0.113.7");
    expect(clientIp(forwarded("10.0.0.1, 192.0.2.44, 203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(forwarded("  198.51.100.1 ,203.0.113.7  "))).toBe("203.0.113.7");
  });

  test("reads IPv6, and drops the port the ALB adds when client-port preservation is on", () => {
    expect(clientIp(forwarded("2001:db8::21f:5bff:febf:ce22:8a2e"))).toBe(
      "2001:db8::21f:5bff:febf:ce22:8a2e",
    );
    expect(clientIp(forwarded("198.51.100.1, 203.0.113.7:8080"))).toBe("203.0.113.7");
    expect(clientIp(forwarded("[2001:db8:85a3:8d3:1319:8a2e:370:7348]:8080"))).toBe(
      "2001:db8:85a3:8d3:1319:8a2e:370:7348",
    );
    expect(clientIp(forwarded("::ffff:203.0.113.7"))).toBe("::ffff:203.0.113.7");
  });

  test("answers undefined rather than falling back to an entry the client controls", () => {
    // Junk, or nothing, in the trusted position must not promote the forged
    // entry before it.
    expect(clientIp(forwarded("198.51.100.1, unknown"))).toBeUndefined();
    expect(clientIp(forwarded("198.51.100.1, "))).toBeUndefined();
    expect(clientIp(forwarded("198.51.100.1,,"))).toBeUndefined();
    expect(clientIp(forwarded(""))).toBeUndefined();
    expect(clientIp(forwarded(" , "))).toBeUndefined();
    expect(clientIp(forwarded(null))).toBeUndefined();
    expect(clientIp(forwarded("fe80::1%eth0"))).toBeUndefined();
    expect(clientIp(forwarded(`fe80::1%${"a".repeat(300)}`))).toBeUndefined();
    expect(clientIp(forwarded("203.0.113.07"))).toBeUndefined();
  });

  test("ignores X-Real-IP, which the ALB neither sets nor strips", () => {
    expect(clientIp(forwarded(null, { "x-real-ip": "198.51.100.1" }))).toBeUndefined();
    expect(clientIp(forwarded("203.0.113.7", { "x-real-ip": "198.51.100.1" }))).toBe("203.0.113.7");
  });
});

describe("the browser-facing readers", () => {
  beforeEach(() => {
    mocks.headers = forwarded(SPOOFED_THEN_REAL, {
      "x-real-ip": "198.51.100.9",
      "user-agent": "vitest",
    });
  });

  test("the connect, setup, booking and channel pages and their actions", async () => {
    await expect(connectRequestContext()).resolves.toEqual({
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
    });
  });

  test("the portal's security events", async () => {
    await expect(portalRequestMeta()).resolves.toEqual({
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
    });
    mocks.headers = forwarded("198.51.100.1, junk");
    await expect(portalRequestMeta()).resolves.toEqual({ ipAddress: null, userAgent: null });
  });

  test("the audit trail's request metadata, and the sign-in form's throttle with it", async () => {
    const meta = await sessionRequestMeta();
    expect(meta.ipAddress).toBe("203.0.113.7");
    expect(meta.userAgent).toBe("vitest");
  });

  test("the Meta connect routes, read off the Request", () => {
    const request = new Request("https://app.healdesk.io/api/meta/login", {
      method: "POST",
      headers: forwarded(SPOOFED_THEN_REAL, { "user-agent": "vitest" }),
    });
    expect(requestContextFrom(request)).toEqual({ ipAddress: "203.0.113.7", userAgent: "vitest" });
  });
});

describe("one door", () => {
  const SRC = join(process.cwd(), "src");

  /**
   * The only other readers: routes apps/web calls with a signed request.
   * They keep the first entry on purpose (lib/client-ip.ts says why).
   */
  const SIGNED_SERVER_TO_SERVER = new Set([
    "app/api/provision/route.ts",
    "app/api/agreements/route.ts",
    "app/api/agreements/[id]/pdf/route.ts",
  ]);

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) yield full;
    }
  }

  test("nothing in apps/app/src reads a forwarded address except lib/client-ip.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === "lib/client-ip.ts" || SIGNED_SERVER_TO_SERVER.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
          if (/x-forwarded-for|x-real-ip/i.test(code)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders, "read the client address through clientIp() in lib/client-ip.ts").toEqual([]);
  });

  test("the sign-in link page spends its link with the load balancer's address", () => {
    const page = readFileSync(join(SRC, "app/link/[token]/page.tsx"), "utf8");
    expect(page).toMatch(/consumeSignInLink\(token, clientIp\(h\) \?\? null\)/);
  });
});

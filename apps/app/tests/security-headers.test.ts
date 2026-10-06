import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";

import nextConfig from "../next.config";
import { contentSecurityPolicy, proxy } from "../src/proxy";

/**
 * The headers every response from this app carries (plan Part D6).
 *
 * The app shows clinics their patients' conversations, so the rule that
 * matters most is that no script runs on a page unless the server put it
 * there: a script tag that reached a page through a transcript, a clinic's
 * knowledge or a crafted link would otherwise run with the clinic's
 * session. That is the nonce policy, set per request by the proxy. The rest
 * are static: HTTPS only, no framing, no sniffing, no caching, passkeys only
 * from our own pages.
 */

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values.join(" ")];
    }),
  );
}

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://app.healdesk.test${path}`, { headers });
}

describe("the Content-Security-Policy", () => {
  test("allows only scripts carrying this response's nonce, and what they load", () => {
    const policy = directives(contentSecurityPolicy("bm9uY2U=", true));
    expect(policy.get("script-src")).toBe("'self' 'nonce-bm9uY2U=' 'strict-dynamic'");
    expect(policy.get("style-src")).toBe("'self' 'nonce-bm9uY2U='");
    for (const [name, value] of policy) {
      expect(value, name).not.toContain("'unsafe-inline'");
      expect(value, name).not.toContain("'unsafe-eval'");
    }
    expect(policy.get("default-src")).toBe("'self'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'self'");
    expect(policy.get("frame-ancestors")).toBe("'none'");
    expect(policy.get("form-action")).toBe(
      "'self' https://accounts.google.com https://connect.stripe.com",
    );
    expect(policy.has("upgrade-insecure-requests")).toBe(true);
  });

  test("keeps eval and plain http for development only", () => {
    const policy = directives(contentSecurityPolicy("bm9uY2U=", false));
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.has("upgrade-insecure-requests")).toBe(false);
  });

  test("the proxy gives each request its own nonce, in the response and in what the page renders with", () => {
    const first = proxy(request("/c/glow/conversations"));
    const second = proxy(request("/c/glow/conversations"));

    const nonceOf = (policy: string | null) => /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
    const firstNonce = nonceOf(first.headers.get("content-security-policy"));
    expect(firstNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceOf(second.headers.get("content-security-policy"))).not.toBe(firstNonce);

    // What Next renders the page with: the same policy and nonce, on the
    // request it forwards.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(
      first.headers.get("content-security-policy"),
    );
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(firstNonce);
  });

  test("the path and nonce a page reads are the proxy's, never the client's", () => {
    const response = proxy(
      request("/c/glow/bookings", { "x-healdesk-path": "/c/other", "x-nonce": "chosen-by-client" }),
    );
    expect(response.headers.get("x-middleware-request-x-healdesk-path")).toBe("/c/glow/bookings");
    expect(response.headers.get("x-middleware-request-x-nonce")).not.toBe("chosen-by-client");
  });
});

describe("the static headers", () => {
  test("HTTPS only, no framing, no sniffing, no caching, no referrer, passkeys from our pages only", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = new Map(
      rules.find((r) => r.source === "/:path*")?.headers.map((h) => [h.key, h.value]),
    );
    expect(all.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(all.get("X-Frame-Options")).toBe("DENY");
    expect(all.get("X-Content-Type-Options")).toBe("nosniff");
    expect(all.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(all.get("Referrer-Policy")).toBe("no-referrer");
    expect(all.get("Permissions-Policy")).toBe(
      "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    );
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

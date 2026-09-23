import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * A "use client" file may import only TYPES from the two server-only admin
 * modules. A value import drags next/headers, HEALDESK_PROVISION_SECRET and
 * the rate limiter's dependencies into the browser bundle, and `next build`
 * fails — which is what broke CI on every push between 13 and 23 September
 * 2026 (CarePanel imported INCIDENT_CLASSES from ops-client). Typecheck and
 * the unit tests cannot see it; only the production build can, and CI is
 * the only place the build runs. This test fails first.
 */
const SERVER_ONLY = ["@/lib/admin/ops-client", "@/lib/admin/operator"];
const ROOT = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("client components and the server-only admin modules", () => {
  const offenders: string[] = [];
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8");
    if (!/^\s*["']use client["']/m.test(src)) continue;
    for (const mod of SERVER_ONLY) {
      const re = new RegExp(`import\\s+(?!type\\s)[^;]*?from\\s+["']${mod.replace("/", "\\/")}["']`, "g");
      if (re.test(src)) offenders.push(`${file.slice(ROOT.length + 1)} imports a value from ${mod}`);
    }
  }
  test("no 'use client' file imports a value from ops-client or operator", () => {
    expect(offenders).toEqual([]);
  });
});

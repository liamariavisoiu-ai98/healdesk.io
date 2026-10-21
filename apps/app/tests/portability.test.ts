import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * apps/app must be able to leave Vercel, and this file is what keeps it able.
 *
 * Vercel signs a business associate agreement only on Enterprise, so the PHI
 * side runs on AWS (ECS on Fargate) under `node server.js`, and the root
 * CLAUDE.md lists what would tie it back: a `@vercel/*` runtime package, an
 * `export const runtime = 'edge'` on anything touching PHI, Vercel-only
 * headers, geolocation or cron as load-bearing logic. "If it would not run
 * under `node server.js` in a container, it does not belong in apps/app."
 * That was checked by a manual audit (12 September, 30 September 2026); this
 * makes it fail the build instead, each failure naming the rule and the file:
 *
 *   1. no `@vercel/*` (or the `vercel` package) in apps/app/package.json, in
 *      the root lock's "apps/app" entry, under apps/app/node_modules in the
 *      lock, or in the lock entry of a workspace package apps/app links
 *      (@healdesk/catalog, @healdesk/connectors), since those ship in the image;
 *   2. no import, require or re-export of one in any scanned file;
 *   3. no edge runtime: `export const runtime = "edge"` (either quote, any
 *      spacing, optional type annotation, "experimental-edge" too) or a
 *      `runtime: "edge"` property in a route, middleware or next.config object;
 *   4. no read of `VERCEL` or `VERCEL_*` from the environment, no `x-vercel-*`
 *      header named in a string literal (any case), no `request.geo` or
 *      `req.geo`, no `geolocation(` call;
 *   5. no apps/app/vercel.json or vercel.ts, where a Vercel cron would live:
 *      scheduled work belongs to the worker (pg-boss), which runs on AWS.
 *
 * Scanned: every .ts, .tsx, .js, .mjs and .cjs file under apps/app/src,
 * tests and scripts, plus the config files at apps/app's root (next.config.ts
 * among them). Tests and scripts are in because they are clean today and both
 * ship in the image: the one-off tasks (migrate, destroy-due, patient-export)
 * run scripts on the AWS host. This file is the one exception, by path, since
 * its self-tests carry violations on purpose (built from parts, so a grep of
 * the tree stays clean).
 *
 * Mentions are allowed and need no allowlist. Twenty-odd comments under src
 * and tests say "Vercel" (where apps/web runs, where the TOTP secret moved,
 * docs/design/checkout-records-on-vercel-2026-10-14.md) and next.config.ts
 * explains the rule in its header. Every rule matches the syntax of a use, an
 * import specifier, an assignment, a property, a member read, a string
 * literal, never the bare word, and whole-line comments are blanked before the
 * scan (line numbers kept). No file is allowlisted.
 */

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SELF = "tests/portability.test.ts";

/** Packages that tie a runtime to Vercel. An entry ending in `*` is a prefix. */
const VERCEL_PACKAGES: readonly string[] = ["@vercel/*", "vercel"];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The package a specifier names: "@a/b/c" is "@a/b", "a/b" is "a". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function deniedBy(name: string, denylist: readonly string[] = VERCEL_PACKAGES): string | null {
  for (const entry of denylist) {
    if (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry) return entry;
  }
  return null;
}

/** The source with every whole-line comment blanked, so line numbers still hold. */
function blankCommentLines(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(\*|\/\/|\/\*)/.test(line) ? "" : line))
    .join("\n");
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

const SPECIFIER_PATTERNS = [
  // import x from "a"; export { x } from "a"; export * from "a"
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  // import "a";
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  // import("a"), require("a"), require.resolve("a")
  /\b(?:import|require|require\.resolve)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
];

/** Every import of a Vercel package in a source: "line N: specifier". */
function vercelImports(source: string): string[] {
  const code = blankCommentLines(source);
  const hits: { line: number; text: string }[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2] ?? "";
      if (deniedBy(packageName(specifier))) {
        hits.push({ line: lineOf(code, match.index), text: `imports "${specifier}"` });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line).map((hit) => `line ${hit.line}: ${hit.text}`);
}

const EDGE = String.raw`(['"\x60])(?:experimental-)?edge\1`;
const EDGE_PATTERNS: readonly { pattern: RegExp; text: string }[] = [
  {
    pattern: new RegExp(String.raw`\bexport\s+const\s+runtime\s*(?::[^=\n]+)?=\s*${EDGE}`, "g"),
    text: "exports an edge runtime",
  },
  {
    pattern: new RegExp(String.raw`\bruntime\s*:\s*${EDGE}`, "g"),
    text: "sets runtime: edge in a config object",
  },
];

/** Every edge-runtime declaration in a source. */
function edgeRuntimes(source: string): string[] {
  const code = blankCommentLines(source);
  return EDGE_PATTERNS.flatMap(({ pattern, text }) =>
    [...code.matchAll(pattern)].map((match) => `line ${lineOf(code, match.index)}: ${text}`),
  );
}

const VERCEL_ONLY_PATTERNS: readonly { pattern: RegExp; text: string }[] = [
  {
    // process.env.VERCEL, process.env?.VERCEL_ENV, env.VERCEL_URL
    pattern: /\benv\s*(?:\?\.|\.)\s*(VERCEL(?:_\w*)?)\b/g,
    text: "reads a Vercel environment variable",
  },
  {
    // process.env["VERCEL_ENV"], env['VERCEL']
    pattern: /\benv\s*(?:\?\.)?\s*\[\s*(['"`])VERCEL(?:_\w*)?\1\s*\]/g,
    text: "reads a Vercel environment variable",
  },
  {
    // const { VERCEL_ENV } = process.env
    pattern: /\{[^{}]*\bVERCEL(?:_\w*)?\b[^{}]*\}\s*=\s*(?:process\s*\.\s*)?env\b/g,
    text: "destructures a Vercel environment variable",
  },
  {
    // headers.get("x-vercel-ip-country"), "X-Vercel-Forwarded-For"
    pattern: /(['"`])x-vercel-[^'"`\n]*\1/gi,
    text: "names a Vercel-only x-vercel-* header",
  },
  {
    // request.geo / req.geo (NextRequest.geo was filled by Vercel only)
    pattern: /\b(?:req|request)\s*(?:\?\.|\.)\s*geo\b/g,
    text: "reads Vercel geolocation (request.geo)",
  },
  {
    // geolocation(request) from @vercel/functions
    pattern: /\bgeolocation\s*\(/g,
    text: "calls Vercel geolocation()",
  },
];

/** Every Vercel-only header, variable or geolocation use in a source. */
function vercelOnlyUses(source: string): string[] {
  const code = blankCommentLines(source);
  return VERCEL_ONLY_PATTERNS.flatMap(({ pattern, text }) =>
    [...code.matchAll(pattern)].map((match) => ({ line: lineOf(code, match.index), text })),
  )
    .sort((a, b) => a.line - b.line)
    .map((hit) => `line ${hit.line}: ${hit.text}`);
}

/** Every .ts, .tsx, .js, .mjs and .cjs file under a directory, relative to apps/app. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(APP, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(entry.name))
    .map((entry) => relative(APP, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((file) => file !== SELF && !file.includes("node_modules/"));
}

/** The config files at apps/app's root: next.config.ts, drizzle.config.ts, vitest.config.mts and so on. */
const ROOT_CONFIGS = readdirSync(APP).filter((name) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(name));

const SCANNED = [...sourceFiles("src"), ...sourceFiles("tests"), ...sourceFiles("scripts"), ...ROOT_CONFIGS];

function scan(check: (source: string) => string[]): string[] {
  return SCANNED.flatMap((file) =>
    check(readFileSync(join(APP, file), "utf8")).map((hit) => `apps/app/${file} ${hit}`),
  );
}

// Builds a violation from parts, so this file's own text never holds one.
const q = (s: string) => `"${s}"`;

describe("the scanners find what they are for (self-tests, no tree changes)", () => {
  test("Vercel packages are caught in every import form; lookalikes are not", () => {
    const source = [
      ["imp", "ort { Analytics } fr", "om ", q("@vercel/analytics/react"), ";"].join(""),
      ["const { waitUntil } = requ", "ire('@vercel/functions');"].join(""),
      ["await imp", "ort(", q("@vercel/kv"), ");"].join(""),
      ["exp", "ort * fr", "om ", q("vercel"), ";"].join(""),
      ["imp", "ort x fr", "om ", q("vercel-like"), ";"].join(""),
      ["imp", "ort x fr", "om ", q("@vercelx/thing"), ";"].join(""),
      ["// imp", "ort x fr", "om ", q("@vercel/og"), ";"].join(""),
    ].join("\n");
    expect(vercelImports(source)).toEqual([
      'line 1: imports "@vercel/analytics/react"',
      'line 2: imports "@vercel/functions"',
      'line 3: imports "@vercel/kv"',
      'line 4: imports "vercel"',
    ]);
  });

  test("an edge runtime is caught in every spelling", () => {
    const edge = (quote: string) => `${quote}edge${quote}`;
    const source = [
      ["exp", "ort const runtime = ", edge("'"), ";"].join(""),
      ["exp", "ort  const runtime=", edge('"')].join(""),
      ["exp", "ort const runtime: string = ", edge("`"), ";"].join(""),
      ["exp", "ort const config = { runt", "ime: ", edge("'"), " };"].join(""),
      ["exp", "ort const runtime = 'experimental-", "edge';"].join(""),
      ["exp", "ort const runtime = ", q("nodejs"), ";"].join(""),
      ["// exp", "ort const runtime = ", edge("'"), ";"].join(""),
      "const label = 'the edge of the map';",
    ].join("\n");
    expect(edgeRuntimes(source)).toEqual([
      "line 1: exports an edge runtime",
      "line 2: exports an edge runtime",
      "line 3: exports an edge runtime",
      "line 5: exports an edge runtime",
      "line 4: sets runtime: edge in a config object",
    ]);
  });

  test("Vercel-only variables, headers and geolocation are caught; mentions are not", () => {
    const source = [
      ["if (process", ".env.", "VERCEL) {}"].join(""),
      ["const e = process", ".env.", "VERCEL_ENV;"].join(""),
      ["const u = process.env[", q("VERCEL_URL"), "];"].join(""),
      ["const { ", "VERCEL_REGION } = process", ".env;"].join(""),
      ["req.headers.get(", q("X-Vercel-IP-Country"), ");"].join(""),
      ["const c = request", ".geo?.country;"].join(""),
      ["const g = geo", "location(request);"].join(""),
      " * Vercel replaces the header with the client's address",
      "// process.env.VERCEL_ENV is not read here",
      "const host = 'apps/web runs on Vercel';",
      "const DATABASE_URL_VERCEL_FREE = 1;",
    ].join("\n");
    expect(vercelOnlyUses(source)).toEqual([
      "line 1: reads a Vercel environment variable",
      "line 2: reads a Vercel environment variable",
      "line 3: reads a Vercel environment variable",
      "line 4: destructures a Vercel environment variable",
      "line 5: names a Vercel-only x-vercel-* header",
      "line 6: reads Vercel geolocation (request.geo)",
      "line 7: calls Vercel geolocation()",
    ]);
  });
});

describe("apps/app stays portable off Vercel (runs under node server.js on AWS)", () => {
  test("scans a real tree", () => {
    // A path mistake would make every check below pass on nothing.
    expect(SCANNED.length).toBeGreaterThan(300);
    expect(SCANNED).toContain("next.config.ts");
    expect(SCANNED).toContain("src/voice/server.ts");
  });

  test("apps/app/package.json depends on no @vercel/* package", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const offences = DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(pkg[field] ?? {})
        .filter((name) => deniedBy(name))
        .map((name) => `apps/app/package.json ${field}: "${name}"`),
    );
    expect(offences, "Portability: no @vercel/* runtime packages in apps/app").toEqual([]);
  });

  test("the lock installs no @vercel/* package for apps/app or the workspaces it links", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const app = lock.packages["apps/app"];
    if (!app) throw new Error('package-lock.json has no "apps/app" workspace entry');
    expect(app.name).toBe("@healdesk/app");

    // apps/app's own entry, then each workspace package it links (link: true).
    const entries: [string, Record<string, unknown>][] = [["apps/app", app]];
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys((app[field] as Record<string, string> | undefined) ?? {})) {
        const link = lock.packages[`node_modules/${name}`];
        const target = typeof link?.resolved === "string" ? lock.packages[link.resolved] : undefined;
        if (link?.link === true && target) entries.push([link.resolved as string, target]);
      }
    }
    expect(entries.map(([key]) => key)).toContain("packages/catalog");

    const offences = entries.flatMap(([key, entry]) =>
      DEPENDENCY_FIELDS.flatMap((field) =>
        Object.keys((entry[field] as Record<string, string> | undefined) ?? {})
          .filter((name) => deniedBy(name))
          .map((name) => `package-lock.json packages["${key}"].${field}: "${name}"`),
      ),
    );
    for (const key of Object.keys(lock.packages)) {
      if (!key.startsWith("apps/app/node_modules/")) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (deniedBy(name)) offences.push(`package-lock.json packages["${key}"]`);
    }
    expect(offences, "Portability: no @vercel/* runtime packages in apps/app").toEqual([]);
  });

  test("no scanned file imports a @vercel/* package", () => {
    expect(
      scan(vercelImports),
      "Portability: no @vercel/* runtime packages in apps/app; use plain Node and config from environment variables",
    ).toEqual([]);
  });

  test("no scanned file or next.config declares an edge runtime", () => {
    expect(
      scan(edgeRuntimes),
      "Portability: no `export const runtime = 'edge'` in apps/app; everything runs on the Node runtime under node server.js",
    ).toEqual([]);
  });

  test("no scanned file relies on a Vercel-only variable, header or geolocation", () => {
    expect(
      scan(vercelOnlyUses),
      "Portability: no Vercel-only headers, environment or geolocation as load-bearing logic in apps/app",
    ).toEqual([]);
  });

  test("apps/app has no vercel.json or vercel.ts, so no Vercel cron", () => {
    // Not `.vercel`: that is a local, git-ignored link a CLI run can leave in
    // any checkout, and failing on it would fail one machine, not the tree.
    const present = ["vercel.json", "vercel.ts"].filter((name) => existsSync(join(APP, name)));
    expect(
      present.map((name) => `apps/app/${name}`),
      "Portability: no Vercel cron or project config in apps/app; scheduled work belongs to the worker",
    ).toEqual([]);
  });
});

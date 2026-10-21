import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * apps/web has no database client, and this file is what keeps it that way.
 *
 * The PHI boundary in the root CLAUDE.md rests on one fact: apps/web, which is
 * hosted on Vercel without a business associate agreement, has no Drizzle, no
 * pg and no connection string, so nothing it does can read or write a patient
 * row. "If it needs the database, it goes in apps/app." Until SEC-01 that fact
 * was checked by reading the tree by hand (12 and 30 September 2026); a single
 * `npm i pg -w @healdesk/web`, or one route that read DATABASE_URL, would have
 * put an uncovered hop in front of PHI and nothing would have failed. Now four
 * things fail the build, each naming the rule and the file:
 *
 *   1. apps/web/package.json lists a database client in any dependency field;
 *   2. the root package-lock.json's entry for the workspace (key "apps/web")
 *      lists one, a workspace package it links lists one (@healdesk/catalog,
 *      bundled into apps/web), or the lock installs one under
 *      apps/web/node_modules. Other workspaces' entries are not read: apps/app
 *      depends on pg and Drizzle by design, and the lock holds both for it;
 *   3. a file under apps/web/src or apps/web/scripts imports, requires or
 *      re-exports one. Test files are scanned too: a test that opened a
 *      database would mean the workspace holds a connection string somewhere,
 *      which is the thing the boundary forbids, and today none does. This file
 *      is the one exception, by path, because its self-tests carry violations
 *      on purpose (and build them from parts, so a reader's grep stays clean);
 *   4. a file there reads DATABASE_URL, MIGRATION_DATABASE_URL, TEST_APP_URL
 *      or TEST_MIGRATOR_URL.
 *
 * What rule 4 deliberately allows. lib/admin/system-map.ts names
 * DATABASE_URL and MIGRATION_DATABASE_URL as data, `env: "DATABASE_URL"`
 * and the key ids "aws.DATABASE_URL", because /admin/map lists every key the
 * AWS host holds. That is a mention, not a read: the rule matches the syntax
 * of a read (`process.env.NAME`, `process.env["NAME"]`, `env.NAME`,
 * `{ NAME } = process.env`), never the bare name, so the map needs no
 * allowlist entry and no file is allowlisted. Whole-line comments are blanked
 * before the scan (line numbers kept), so a comment explaining the rule never
 * trips it. A read built from a computed name (`process.env[name]`) cannot be
 * seen by a text scan; that limit is accepted, as it is in system-map.test.ts.
 */

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SELF = "src/lib/boundary.test.ts";

/**
 * Database clients apps/web may never depend on or import. An entry ending in
 * `*` is a prefix: "@prisma/*" is every package in that scope, "pg-*" is
 * pg-boss, pg-pool, pg-protocol and the rest. Anything else matches the
 * package name exactly, so "pg" catches "pg" and "pg/lib/client" but never
 * "page" or "pgp-utils". Add to it; never remove an entry to make a build pass.
 */
const DATABASE_CLIENTS: readonly string[] = [
  // PostgreSQL drivers, pools and ORMs
  "pg",
  "pg-*",
  "postgres",
  "@neondatabase/*",
  "@vercel/postgres",
  "@vercel/kv",
  "@electric-sql/pglite",
  "@supabase/*",
  "@planetscale/*",
  // ORMs and query builders
  "drizzle-orm",
  "drizzle-kit",
  "drizzle-*",
  "@better-auth/drizzle-adapter",
  "@prisma/*",
  "prisma",
  "knex",
  "kysely",
  "typeorm",
  "sequelize",
  "@mikro-orm/*",
  "objection",
  // MySQL, SQLite, libSQL
  "mysql",
  "mysql2",
  "@libsql/*",
  "@tursodatabase/*",
  "better-sqlite3",
  "sqlite3",
  "sqlite",
  "node:sqlite",
  "bun:sqlite",
  // Document and key-value stores
  "mongodb",
  "mongoose",
  "redis",
  "ioredis",
  "@redis/*",
  "@upstash/redis",
  "@aws-sdk/client-rds*",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/lib-dynamodb",
];

/** The four variables that carry a connection string to the PHI database. */
const DATABASE_VARIABLES: readonly string[] = [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TEST_APP_URL",
  "TEST_MIGRATOR_URL",
];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The package a specifier names: "@a/b/c" is "@a/b", "a/b" is "a", "node:x" stays whole. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** The denylist entry a package name falls under, or null. */
function deniedBy(name: string, denylist: readonly string[] = DATABASE_CLIENTS): string | null {
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
  // import x from "a"; import { x } from "a"; export { x } from "a"; export * from "a"
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  // import "a";
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  // import("a"), require("a"), require.resolve("a")
  /\b(?:import|require|require\.resolve)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g,
];

/** Every module specifier in a source, with its line. */
function moduleSpecifiers(source: string): { specifier: string; line: number }[] {
  const code = blankCommentLines(source);
  const found: { specifier: string; line: number }[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      found.push({ specifier: match[2] ?? "", line: lineOf(code, match.index) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Every import of a denied package in a source: "line N: specifier (rule entry)". */
function deniedImports(source: string, denylist: readonly string[] = DATABASE_CLIENTS): string[] {
  return moduleSpecifiers(source).flatMap(({ specifier, line }) => {
    const entry = deniedBy(packageName(specifier), denylist);
    return entry ? [`line ${line}: "${specifier}" (denied as ${entry})`] : [];
  });
}

/**
 * Every read of a named variable in a source: `process.env.X`, `process.env?.X`,
 * `env.X` (which also covers an `env` object a module re-exports),
 * `process.env["X"]` and `env['X']`, and destructuring `{ X } = process.env`
 * or `= env`. A bare mention of the name (a string, a key id, a comment) is
 * not a read.
 */
function variableReads(source: string, names: readonly string[]): string[] {
  const code = blankCommentLines(source);
  const hits: string[] = [];
  for (const name of names) {
    const patterns = [
      new RegExp(`\\benv\\s*(?:\\?\\.|\\.)\\s*${name}\\b`, "g"),
      new RegExp(`\\benv\\s*(?:\\?\\.)?\\s*\\[\\s*(['"\`])${name}\\1\\s*\\]`, "g"),
      new RegExp(`\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=\\s*(?:process\\s*\\.\\s*)?env\\b`, "g"),
    ];
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        hits.push(`line ${lineOf(code, match.index)}: reads ${name}`);
      }
    }
  }
  return hits;
}

/** Every .ts, .tsx, .js, .mjs and .cjs file under a directory, relative to apps/web. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(WEB, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name))
    .map((entry) => relative(WEB, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((file) => file !== SELF && !file.includes("node_modules/"));
}

const SCANNED = [...sourceFiles("src"), ...sourceFiles("scripts")];

// Builds a violation from parts, so this file's own text never holds one.
const q = (s: string) => `"${s}"`;
const imp = (s: string) => ["imp", "ort x fr", "om ", q(s), ";"].join("");
const envRead = (s: string) => ["process", ".", "env", ".", s].join("");

describe("the scanners find what they are for (self-tests, no tree changes)", () => {
  test("package names match on path segments, not on string prefixes", () => {
    expect(deniedBy(packageName("pg"))).toBe("pg");
    expect(deniedBy(packageName("pg/lib/client"))).toBe("pg");
    expect(deniedBy(packageName("pg-boss"))).toBe("pg-*");
    expect(deniedBy(packageName("drizzle-orm/pg-core"))).toBe("drizzle-orm");
    expect(deniedBy(packageName("@neondatabase/serverless"))).toBe("@neondatabase/*");
    expect(deniedBy(packageName("@prisma/client/edge"))).toBe("@prisma/*");
    expect(deniedBy(packageName("node:sqlite"))).toBe("node:sqlite");
    expect(deniedBy(packageName("page"))).toBeNull();
    expect(deniedBy(packageName("pgp-utils"))).toBeNull();
    expect(deniedBy(packageName("postgres-interval-format"))).toBeNull();
    expect(deniedBy(packageName("@vercel/analytics"))).toBeNull();
    expect(deniedBy(packageName("next/server"))).toBeNull();
  });

  test("every import form is caught, with its line", () => {
    const source = [
      imp("drizzle-orm"),
      ["imp", "ort ", q("pg"), ";"].join(""),
      ["const m = await imp", "ort(", q("postgres"), ");"].join(""),
      ["const r = requ", "ire('ioredis');"].join(""),
      ["exp", "ort { x } fr", "om ", q("@prisma/client"), ";"].join(""),
      ["exp", "ort * fr", "om ", q("kysely"), ";"].join(""),
      imp("page"),
      imp("next/server"),
    ].join("\n");
    expect(deniedImports(source)).toEqual([
      'line 1: "drizzle-orm" (denied as drizzle-orm)',
      'line 2: "pg" (denied as pg)',
      'line 3: "postgres" (denied as postgres)',
      'line 4: "ioredis" (denied as ioredis)',
      'line 5: "@prisma/client" (denied as @prisma/*)',
      'line 6: "kysely" (denied as kysely)',
    ]);
  });

  test("a commented-out import is documentation, not an import", () => {
    expect(deniedImports(`// ${imp("pg")}\n * ${imp("drizzle-orm")}`)).toEqual([]);
  });

  test("a read of a database variable is caught; a mention is not", () => {
    const reads = [
      envRead("DATABASE_URL"),
      ["process", ".env", "?.", "TEST_APP_URL"].join(""),
      ["process.env[", q("MIGRATION_DATABASE_URL"), "]"].join(""),
      ["env['", "TEST_MIGRATOR_URL", "']"].join(""),
      ["const { ", "DATABASE_URL", ": url } = process", ".env;"].join(""),
    ].join("\n");
    expect(variableReads(reads, DATABASE_VARIABLES)).toEqual([
      "line 1: reads DATABASE_URL",
      "line 5: reads DATABASE_URL",
      "line 3: reads MIGRATION_DATABASE_URL",
      "line 2: reads TEST_APP_URL",
      "line 4: reads TEST_MIGRATOR_URL",
    ]);
    const mentions = [
      ["  env: ", q("DATABASE_URL"), ","].join(""),
      ["  id: ", q("aws.DATABASE_URL"), ","].join(""),
      ["// never ", envRead("DATABASE_URL"), " here"].join(""),
      "const label = 'set DATABASE_URL in Parameter Store';",
    ].join("\n");
    expect(variableReads(mentions, DATABASE_VARIABLES)).toEqual([]);
  });
});

describe("apps/web has no database client (the PHI boundary)", () => {
  test("scans a real tree", () => {
    // A path mistake would make every check below pass on nothing.
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED).toContain("src/lib/admin/system-map.ts");
  });

  test("apps/web/package.json depends on no database client", () => {
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const offences = DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(pkg[field] ?? {}).flatMap((name) => {
        const entry = deniedBy(name);
        return entry ? [`apps/web/package.json ${field}: "${name}" (denied as ${entry})`] : [];
      }),
    );
    expect(
      offences,
      "PHI boundary: apps/web may not depend on a database client. If it needs the database, it goes in apps/app.",
    ).toEqual([]);
  });

  test("the lock's apps/web entry depends on, and installs, no database client", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const entry = lock.packages["apps/web"];
    if (!entry) throw new Error('package-lock.json has no "apps/web" workspace entry');
    expect(entry.name).toBe("@healdesk/web");
    // apps/web's own entry, then each workspace package it links (link: true),
    // such as @healdesk/catalog: its dependencies are bundled into apps/web.
    const entries: [string, Record<string, unknown>][] = [["apps/web", entry]];
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys((entry[field] as Record<string, string> | undefined) ?? {})) {
        const link = lock.packages[`node_modules/${name}`];
        const target = typeof link?.resolved === "string" ? lock.packages[link.resolved] : undefined;
        if (link?.link === true && target) entries.push([link.resolved as string, target]);
      }
    }
    expect(entries.map(([key]) => key)).toContain("packages/catalog");
    const offences = entries.flatMap(([key, workspace]) =>
      DEPENDENCY_FIELDS.flatMap((field) =>
        Object.keys((workspace[field] as Record<string, string> | undefined) ?? {}).flatMap((name) => {
          const rule = deniedBy(name);
          return rule ? [`package-lock.json packages["${key}"].${field}: "${name}" (denied as ${rule})`] : [];
        }),
      ),
    );
    // A package hoisted under apps/web/node_modules was installed for this
    // workspace (or for one of its dependencies) and is on its require path.
    for (const key of Object.keys(lock.packages)) {
      if (!key.startsWith("apps/web/node_modules/")) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      const rule = deniedBy(name);
      if (rule) offences.push(`package-lock.json packages["${key}"] (denied as ${rule})`);
    }
    expect(
      offences,
      "PHI boundary: the lock installs a database client for apps/web. If it needs the database, it goes in apps/app.",
    ).toEqual([]);
  });

  test("no file under apps/web/src or apps/web/scripts imports a database client", () => {
    const offences = SCANNED.flatMap((file) =>
      deniedImports(readFileSync(join(WEB, file), "utf8")).map((hit) => `apps/web/${file} ${hit}`),
    );
    expect(
      offences,
      "PHI boundary: apps/web may not import a database client. If it needs the database, it goes in apps/app; ask apps/app over the signed ops request instead (lib/admin/ops-client.ts).",
    ).toEqual([]);
  });

  test("no file under apps/web/src or apps/web/scripts reads a database connection string", () => {
    const offences = SCANNED.flatMap((file) =>
      variableReads(readFileSync(join(WEB, file), "utf8"), DATABASE_VARIABLES).map(
        (hit) => `apps/web/${file} ${hit}`,
      ),
    );
    expect(
      offences,
      "PHI boundary: apps/web holds no connection string. DATABASE_URL and its siblings are read in apps/app only.",
    ).toEqual([]);
  });
});

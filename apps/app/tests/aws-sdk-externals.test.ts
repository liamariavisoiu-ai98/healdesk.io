import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import { sesClientConfig } from "@/lib/reporting/deliver";

import nextConfig from "../next.config";

/**
 * What else keeps the AWS SDKs reaching the production build as packages.
 *
 * tests/aws-sdk-clients.test.ts pins the three facts that fixed it: both SDKs
 * are dependencies, both are external, and each is imported by a literal
 * specifier. One more decides what a build does when a package goes missing,
 * and it is a rule for every file under src, not only kms.ts and deliver.ts.
 * Probe builds on Next 16.3 (6 October 2026) separated the cases: an import
 * that cannot be resolved fails the build when it sits outside a `try`, literal
 * or constant alike; inside one, Turbopack treats it as optional, compiles it
 * into `throw MODULE_NOT_FOUND` and passes the build with a warning. That is
 * how a build ships a KMS that can never seal and an SES that can never send
 * while reporting success. So:
 *
 *   - no dynamic import or require under src sits inside a `try`, so a package
 *     that goes missing fails the build instead of shipping;
 *   - every one names its module literally, so this file and the bundler can
 *     both see what it is;
 *   - kms.ts and deliver.ts carry no specifier constant and no bundler-ignore
 *     comment, the two halves of the arrangement that failed;
 *   - every SDK is a plain runtime dependency: an optional, dev or peer
 *     dependency is each a way for an install to go without it;
 *   - every @aws-sdk package src imports is in serverExternalPackages (S3,
 *     the export bucket's, was not until 14 October 2026).
 *
 * These read the source. The CI step after `npm run build` reads what the
 * build actually produced.
 */

const APP = fileURLToPath(new URL("..", import.meta.url));
const SDKS = [
  "@aws-sdk/client-kms",
  "@aws-sdk/client-sesv2",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-pinpoint-sms-voice-v2",
] as const;

/** Every module specifier a file under src imports, statically or dynamically, by a literal. */
function importedSpecifiers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (specifier: string, file: string) =>
    found.set(specifier, [...(found.get(specifier) ?? []), relative(APP, file)]);
  for (const entry of readdirSync(join(APP, "src"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        note(node.moduleSpecifier.text, file);
      }
      if (ts.isCallExpression(node)) {
        const loads =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require");
        const [specifier] = node.arguments;
        if (loads && specifier && ts.isStringLiteralLike(specifier)) note(specifier.text, file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("the AWS SDKs reach the production build as packages", () => {
  test("every SDK is a plain runtime dependency of @healdesk/app", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;

    for (const name of SDKS) {
      expect(pkg.dependencies?.[name], name).toMatch(/^\^3\.\d+\.\d+$/);
      expect(pkg.devDependencies?.[name], name).toBeUndefined();
      expect(pkg.optionalDependencies?.[name], name).toBeUndefined();
      expect(pkg.peerDependencies?.[name], name).toBeUndefined();
    }
  });

  /**
   * An AWS SDK left out of serverExternalPackages is bundled into the server
   * chunks instead of traced in as a package: the arrangement the 6 October
   * build fix ended for KMS and SES. export-store.ts imported S3 with
   * nothing listing it. So every @aws-sdk package any file under src imports
   * must be external and a plain dependency, whichever file it is and
   * whenever it arrives.
   */
  test("every @aws-sdk package imported under src is external and a runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const imported = [...importedSpecifiers().entries()].filter(([name]) =>
      name.startsWith("@aws-sdk/"),
    );
    expect(imported.map(([name]) => name).sort()).toEqual([...SDKS].sort());
    for (const [name, files] of imported) {
      expect(nextConfig.serverExternalPackages, `${name} (${files.join(", ")})`).toContain(name);
      expect(pkg.dependencies?.[name], name).toMatch(/^\^3\.\d+\.\d+$/);
    }
  }, 60_000);

  test("kms.ts, deliver.ts and sms/send.ts import their SDK by name, with no specifier constant", () => {
    const files = [
      ["src/lib/crypto/kms.ts", "@aws-sdk/client-kms"],
      ["src/lib/reporting/deliver.ts", "@aws-sdk/client-sesv2"],
      ["src/lib/sms/send.ts", "@aws-sdk/client-pinpoint-sms-voice-v2"],
    ] as const;

    for (const [file, sdk] of files) {
      const source = readFileSync(join(APP, file), "utf8");
      expect(source, file).not.toMatch(/_MODULE\s*=/);
      expect(source, file).not.toMatch(/@vite-ignore|webpackIgnore|turbopackIgnore/);
      expect(source, file).toContain(`import("${sdk}")`);
    }
  });

  /**
   * The same failure, anywhere under src. Every dynamic import and require
   * names its module with a string literal, and none sits inside a `try` block,
   * where Turbopack would turn a missing module into a warning and a throw.
   * Counted inside a `try` even through a nested function, which may be
   * stricter than Turbopack is; a false alarm costs a `.catch()`, a missed one
   * costs a production build. Read with the TypeScript parser rather than a
   * pattern, so a comment that mentions `import(...)` is not an import.
   *
   * Parsing every file under src is seconds of work, which a loaded machine
   * stretched past vitest's five-second default on 6 October (8.6 s) while
   * every import it checked was clean. The bound is a minute, so a real hang
   * still fails.
   */
  test("every dynamic import and require under src is literal, and outside any try block", () => {
    const offenders: string[] = [];

    const visit = (file: string, source: ts.SourceFile, node: ts.Node, inTry: boolean): void => {
      if (ts.isCallExpression(node)) {
        const loads =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require");
        const [specifier] = node.arguments;
        const literal = Boolean(specifier && ts.isStringLiteralLike(specifier));
        if (loads && (!literal || inTry)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const why = [!literal && "not a literal", inTry && "inside a try block"].filter(Boolean);
          offenders.push(`${relative(APP, file)}:${line + 1} (${why.join(", ")})`);
        }
      }
      if (ts.isTryStatement(node)) {
        visit(file, source, node.tryBlock, true);
        if (node.catchClause) visit(file, source, node.catchClause, inTry);
        if (node.finallyBlock) visit(file, source, node.finallyBlock, inTry);
        return;
      }
      ts.forEachChild(node, (child) => visit(file, source, child, inTry));
    };

    let scanned = 0;
    for (const entry of readdirSync(join(APP, "src"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      visit(file, source, source, false);
      scanned += 1;
    }

    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  }, 60_000);

  test("the SES client is bounded as deliver.ts says, which on this SDK needs throwOnRequestTimeout", () => {
    const region = process.env.AWS_REGION;
    try {
      // Unset, and empty as .env.example ships it: the SDK refuses an empty
      // region outright, so empty has to mean the fallback too.
      for (const value of [undefined, ""]) {
        if (value === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = value;

        expect(sesClientConfig(), JSON.stringify(value)).toEqual({
          region: "us-east-1",
          maxAttempts: 2,
          requestHandler: {
            connectionTimeout: 2_000,
            requestTimeout: 20_000,
            throwOnRequestTimeout: true,
          },
        });
      }

      process.env.AWS_REGION = "us-east-1";
      expect(sesClientConfig().region).toBe("us-east-1");
    } finally {
      if (region === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = region;
    }
  });
});

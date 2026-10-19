import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * The source check behind "Conversations and Bookings open only through the
 * patient-page guard" (tests/portal-shell.test.ts), with the TypeScript
 * compiler and its type checker rather than regular expressions, so a
 * comment, an arrow function, a directive without a semicolon or a helper in
 * another file does not get past it.
 *
 * For every file under a `conversations/` or `bookings/` directory:
 *
 * 1. **Entry points take the step-up.** A page's default export, a route's
 *    exported handlers and every export of a "use server" file call
 *    requirePatientPage, resolved by the checker to lib/portal/patient-page.ts.
 * 2. **The database only through withPatientPage.** Starting from the file,
 *    and following every function it calls, renders as JSX or passes along,
 *    into any file under src (not node_modules), nothing reaches withTenant,
 *    withTenantOn, withoutTenant, unsafeDb or the pool, except through the
 *    functions in SANCTIONED below. A function that takes the PatientTx reads
 *    through `tx.db`, which reaches none of them. Importing pg, pg-boss or
 *    drizzle's node-postgres driver there fails outright.
 * 3. **Rendered fresh, never prefetched.** A page or route exports
 *    `dynamic = "force-dynamic"` (which Next answers with Cache-Control
 *    no-store), and no element carries `prefetch` other than `{false}`.
 * 4. **No reads in a layout**, which does not run again on client navigation:
 *    a layout or template under these screens never calls withPatientPage.
 */

const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** What reads the database directly. A file under the patient screens reaches none of it. */
const FORBIDDEN = new Set([
  "src/lib/tenant.ts#withTenant",
  "src/lib/tenant.ts#withTenantOn",
  "src/lib/tenant.ts#withoutTenant",
  "src/db/index.ts#unsafeDb",
  "src/db/index.ts#pool",
]);
const FORBIDDEN_MODULES = new Set(["pg", "pg-boss", "drizzle-orm/node-postgres", "postgres"]);

/**
 * The functions a patient screen may call although they reach the database,
 * each with the reason. Not followed further. Add one only with its reason.
 */
export const SANCTIONED: Readonly<Record<string, string>> = {
  "src/lib/portal/patient-page.ts#requirePatientPage":
    "the door: the sign-in and the passkey step-up, no patient data",
  "src/lib/portal/patient-page.ts#withPatientPage":
    "the one way to read: one transaction, with the access row it requires",
  "src/lib/portal/patient-page.ts#logPatientAccess": "writes the access row",
  "src/lib/portal/patient-page.ts#patientGuardProps": "identifiers for the guard, no read",
  "src/lib/portal/page.ts#loadPortalPage":
    "the shell's business data (the practice, its setup, its locations), no patient",
  "src/app/c/[slug]/keep-open.ts#patientPageStatus": "the guard's question about the step-up",
  "src/app/c/[slug]/keep-open.ts#keepPatientPageOpen": "the guard's Keep open: a touch",
  // Bookings (package E).
  "src/lib/meta/booking-requests.ts#decideBookingRequest":
    "the desk's decision is several transactions by design (plan §7.10, the calendar session's " +
    "invariants): the assistant-write guard and Google's busy re-check run outside any " +
    "transaction, the decision in its own under the calendar and row locks, the calendar write " +
    "after it commits. Keyed by the page's clinic and the request's id, as the sign-in by its " +
    "passkey, every decision and refusal audited with the passkey; Bookings' action opens the " +
    "request in withPatientPage, with its access row, before it calls this",
  "src/lib/meta/booking-requests.ts#deskFreeTimes":
    "the calendar's free times for the request in focus, asked after the page's patient " +
    "transaction has committed, because Google is never asked inside one: availableSlotsFor " +
    "opens its own transactions for the hours, the holds and the calendar token, business data " +
    "and time spans, no patient row",
  "src/lib/booking/terms.ts#calendarTermsFor":
    "the location's calendar terms, read through the caller's tx.db; the checker reads the " +
    "`rows` of tx.db.execute's result as the pg driver's own. Business data, no patient row",
  // Conversations' Flag this answer (wave 2, R2).
  "src/lib/ops/flag-alert.ts#sendFlagAlert":
    "I4, the ops ticket a flag opens, sent after the flag's patient transaction has committed: " +
    "its row is in the ops log (ops_alerts), which has no clinic_id and holds the flag's, the " +
    "clinic's and the conversation's ids and a count, never a patient row, and the email carries " +
    "the same ids and counts through the payload allowlist",
  "src/app/c/[slug]/pause-actions.ts#pauseAyaAction":
    "the header's AYA is answering switch: writes the clinic's pause, reads no patient",
  "src/app/c/[slug]/pause-actions.ts#resumeAyaAction":
    "the header's AYA is answering switch: clears the clinic's pause, reads no patient",
};

const REQUIRE_PATIENT_PAGE = "src/lib/portal/patient-page.ts#requirePatientPage";
const WITH_PATIENT_PAGE = "src/lib/portal/patient-page.ts#withPatientPage";

export type Finding = { file: string; line: number; message: string };

/** Every .ts and .tsx file under `conversations/` or `bookings/` below `dir`. */
export function patientScreenFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, inside: boolean) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        walk(path, inside || name === "conversations" || name === "bookings");
      } else if (inside && /\.tsx?$/.test(name)) {
        out.push(path);
      }
    }
  };
  walk(dir, false);
  return out.sort();
}

/** Whether a file opens with the "use server" directive, semicolon or not. */
export function hasUseServer(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

/** The functions a module exports, by name ("default" for a default export), as written. */
export function exportedFunctions(source: ts.SourceFile): { name: string; node: ts.Node }[] {
  const out: { name: string; node: ts.Node }[] = [];
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && exported(statement)) {
      out.push({
        name: isDefault(statement) ? "default" : (statement.name?.text ?? "default"),
        node: statement,
      });
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isIdentifier(declaration.name)) {
          out.push({ name: declaration.name.text, node: declaration.initializer });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      out.push({ name: "default", node: statement.expression });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      out.push({ name: "{ re-export }", node: statement });
    }
  }
  return out;
}

/** Whether `node` contains a call to one of `names`, by name: comments and strings never count. */
export function callsByName(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function compilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(APP_ROOT, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!parsed) throw new Error("apps/app/tsconfig.json did not parse.");
  return { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined };
}

/** Check `files`, each one under a patient screen. */
export function checkPatientScreens(files: readonly string[]): Finding[] {
  if (files.length === 0) return [];
  const program = ts.createProgram({ rootNames: [...files], options: compilerOptions() });
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];

  const keyOf = (symbol: ts.Symbol | undefined): string | null => {
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration || !symbol) return null;
    const file = relative(APP_ROOT, declaration.getSourceFile().fileName).split(sep).join("/");
    return `${file}#${symbol.getName()}`;
  };
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
  /** A declaration in a database driver's own package: a Pool, a client, a raw connection. */
  const inDriver = (symbol: ts.Symbol | undefined) =>
    (symbol?.declarations ?? []).some((d) =>
      /[\\/]node_modules[\\/](@types[\\/])?(pg|pg-boss|postgres)[\\/]|[\\/]drizzle-orm[\\/]node-postgres[\\/]/.test(
        d.getSourceFile().fileName,
      ),
    );
  /** A name imported from a driver's package, whether or not the package resolves. */
  const importedFromDriver = (n: ts.Identifier) =>
    (checker.getSymbolAtLocation(n)?.declarations ?? []).some((d) => {
      const declaration = ts.findAncestor(d, ts.isImportDeclaration);
      return (
        !!declaration &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        FORBIDDEN_MODULES.has(declaration.moduleSpecifier.text)
      );
    });
  /** `import("pg")` or `require("pg")`, which no import declaration shows. */
  const loadsDriver = (n: ts.Node) =>
    ts.isCallExpression(n) &&
    (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
    n.arguments.length > 0 &&
    ts.isStringLiteral(n.arguments[0]!) &&
    FORBIDDEN_MODULES.has(n.arguments[0].text);
  const ours = (node: ts.Node) => {
    const file = node.getSourceFile();
    return (
      !file.isDeclarationFile &&
      !file.fileName.split(sep).includes("node_modules") &&
      // Table definitions: they describe the database and read nothing.
      !/[\\/]src[\\/]db[\\/](auth-)?schema\.ts$/.test(file.fileName)
    );
  };

  /** The code to follow for a symbol: a function's body, or the functions a wrapper is given. */
  const bodiesOf = (symbol: ts.Symbol): ts.Node[] => {
    const out: ts.Node[] = [];
    for (const declaration of symbol.declarations ?? []) {
      if (!ours(declaration)) continue;
      if (ts.isFunctionLike(declaration)) {
        out.push(declaration);
      } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const init = declaration.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push(init);
        // `cache(async () => ...)`: the wrapped function, not a config object's hooks.
        else if (ts.isCallExpression(init)) {
          out.push(
            ...init.arguments.filter((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)),
          );
        }
      }
    }
    return out;
  };

  const memo = new Map<ts.Node, string[] | null>();
  const inProgress = new Set<ts.Node>();

  /** A name being declared (a function's, a variable's, a parameter's), not used. */
  const declares = (n: ts.Identifier) => {
    const parent = n.parent as ts.NamedDeclaration | undefined;
    return (
      !!parent &&
      parent.name === n &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isBindingElement(parent))
    );
  };

  /** The chain from one place in the code to a direct database read, or null. */
  const site = (n: ts.Node): string[] | null => {
    if (loadsDriver(n)) return [n.getText()];
    if (!ts.isIdentifier(n) || declares(n)) return null;
    const symbol = ts.isShorthandPropertyAssignment(n.parent)
      ? checker.getShorthandAssignmentValueSymbol(n.parent)
      : resolve(n);
    const key = keyOf(symbol);
    if ((key && FORBIDDEN.has(key)) || inDriver(symbol) || importedFromDriver(n)) return [n.text];
    if (!symbol || (key && key in SANCTIONED)) return null;
    for (const body of bodiesOf(symbol)) {
      const below = follow(body);
      if (below) return [n.text, ...below];
    }
    return null;
  };
  const skipped = (n: ts.Node) =>
    ts.isTypeNode(n) ||
    ts.isImportDeclaration(n) ||
    ts.isTypeAliasDeclaration(n) ||
    ts.isInterfaceDeclaration(n);

  /** Every chain from `node`'s code to a direct database read. */
  const reachAll = (node: ts.Node): string[][] => {
    const out: string[][] = [];
    const visit = (n: ts.Node) => {
      if (skipped(n)) return;
      const chain = site(n);
      if (chain) out.push(chain);
      else if (!ts.isIdentifier(n) && !loadsDriver(n)) ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  /** The first such chain, for a function followed from elsewhere. */
  const reach = (node: ts.Node): string[] | null => {
    let found: string[] | null = null;
    const visit = (n: ts.Node) => {
      if (found || skipped(n)) return;
      found = site(n);
      if (!found && !ts.isIdentifier(n)) ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };
  const follow = (body: ts.Node): string[] | null => {
    if (memo.has(body)) return memo.get(body)!;
    if (inProgress.has(body)) return null;
    inProgress.add(body);
    const result = reach(body);
    inProgress.delete(body);
    memo.set(body, result);
    return result;
  };

  const callsSymbol = (node: ts.Node, wanted: string): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && keyOf(resolve(n.expression)) === wanted) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  for (const fileName of files) {
    const source = program.getSourceFile(fileName);
    if (!source) throw new Error(`${fileName} is not in the program.`);
    const where = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const add = (node: ts.Node, message: string) =>
      findings.push({ file: fileName, line: where(node), message });
    const name = basename(fileName);
    const isPage = /^page\.tsx?$/.test(name);
    const isRoute = /^route\.tsx?$/.test(name);
    const isLayout = /^(layout|template)\.tsx?$/.test(name);
    const isActions = hasUseServer(source);

    // Imports: no driver, and no direct database handle even unused.
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (FORBIDDEN_MODULES.has(from))
        add(statement, `imports ${from}: read through withPatientPage`);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const key = keyOf(resolve(element.name));
          if (key && FORBIDDEN.has(key)) {
            add(element, `imports ${element.name.text}: read through withPatientPage`);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings) && /^@\/(db|lib\/tenant)$/.test(from)) {
        add(statement, `imports all of ${from}: read through withPatientPage`);
      }
    }

    // 1. Entry points take the step-up.
    if (isPage || isRoute || isActions) {
      const entries = exportedFunctions(source).filter(
        (e) =>
          isActions ||
          (isPage && e.name === "default") ||
          (isRoute && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(e.name)),
      );
      for (const entry of entries) {
        if (!callsSymbol(entry.node, REQUIRE_PATIENT_PAGE)) {
          add(entry.node, `${entry.name} does not call requirePatientPage`);
        }
      }
    }

    // 2. The database only through withPatientPage.
    for (const statement of source.statements) {
      for (const chain of reachAll(statement)) {
        add(statement, `reaches the database outside withPatientPage: ${chain.join(" → ")}`);
      }
    }

    // 3. Rendered fresh, never prefetched.
    if (isPage || isRoute) {
      const dynamic = exportedFunctions(source).find((e) => e.name === "dynamic");
      if (!dynamic || !ts.isStringLiteral(dynamic.node) || dynamic.node.text !== "force-dynamic") {
        add(source, `does not export const dynamic = "force-dynamic"`);
      }
    }
    const visitJsx = (n: ts.Node) => {
      if (ts.isJsxAttribute(n) && n.name.getText(source) === "prefetch") {
        const value = n.initializer;
        const isFalse =
          value &&
          ts.isJsxExpression(value) &&
          value.expression?.kind === ts.SyntaxKind.FalseKeyword;
        if (!isFalse) add(n, "prefetches a patient page: prefetch={false}");
      }
      ts.forEachChild(n, visitJsx);
    };
    visitJsx(source);

    // 4. No reads in a layout.
    if (isLayout && callsSymbol(source, WITH_PATIENT_PAGE)) {
      add(
        source,
        "a layout reads patient data: it does not run again on navigation; read in the page",
      );
    }
  }
  return findings;
}

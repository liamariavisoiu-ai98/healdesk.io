/**
 * The grammar a db-apply change file's statement must fit
 * (docs/design/db-apply-grammar-2026-10-24.md). An allowlist: a tokenizer that
 * knows a handful of token kinds, and a recursive-descent parser that accepts
 * one INSERT ... VALUES, one INSERT ... SELECT over one of the three writable
 * tables, or one UPDATE ... WHERE, with literal values, three functions and
 * four casts. Anything else is refused, naming the first unexpected token and
 * its position, never quoting more than 40 characters of the statement.
 *
 * Why a grammar and not a list of bad words: a built-in that runs SQL from a
 * string can carry any word inside a quoted value, where a word list cannot
 * see it. Here no function runs SQL and no name can be spelt indirectly, so
 * what a file says is what the database runs. The database's grants,
 * row-level security and runParsed's two checks stay the real bound.
 */

/** The tables a change may write or read in its subselect, with their columns (checked against the live schema in tests/db-apply.test.ts). */
export const TABLE_COLUMNS = {
  clinic_closures: ["clinic_id", "location_id", "closed_on", "label", "created_at"],
  clinic_providers: [
    "id",
    "clinic_id",
    "display_name",
    "calendar_id",
    "active",
    "created_at",
    "updated_at",
  ],
  clinic_provider_services: ["clinic_id", "provider_id", "service_key", "created_at"],
} as const satisfies Record<string, readonly string[]>;

export type GrammarTable = keyof typeof TABLE_COLUMNS;

/** Columns an UPDATE may never set: which clinic a row is, and its identity. */
const NEVER_SET = new Set(["clinic_id", "id"]);
const CASTS = new Set(["date", "timestamptz", "uuid", "text"]);
const OPS = new Set(["=", "<>", "<", "<=", ">", ">="]);
const MAX_DEPTH = 16;

export class ChangeFileError extends Error {}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type Token =
  | { kind: "word"; text: string; value: string; at: number }
  | { kind: "string"; text: string; value: string; at: number }
  | { kind: "number"; text: string; value: string; at: number }
  | { kind: "punct"; text: string; value: string; at: number }
  /** Text no token starts with: the tokenizer stops there, and the parser refuses it when it reaches it. */
  | { kind: "bad"; text: string; value: string; at: number; why?: string }
  | { kind: "end"; text: ""; value: ""; at: number };

const PUNCT = ["::", "<=", ">=", "<>", "(", ")", ",", "=", "<", ">", "-", ";"] as const;

function show(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 40 ? `${flat.slice(0, 37)}...` : flat;
}

function refuse(what: string, at: number, why?: string): never {
  throw new ChangeFileError(`unexpected ${what} at character ${at + 1}${why ? `: ${why}` : ""}`);
}

/**
 * Split a statement into tokens. The first text that is not one of the tokens
 * below (quotes of other kinds, `$`, `\`, `&`, `|`, `/`, `.`, `*`, `+`, `!`,
 * `:` alone, a comment, a prefixed or unclosed string) becomes a "bad" token
 * and ends the list there, so the parser names whichever comes first: that,
 * or an earlier token in the wrong place.
 */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const bad = (text: string, at: number, why?: string): Token[] => {
    out.push({ kind: "bad", text, value: text, at, why });
    out.push({ kind: "end", text: "", value: "", at: sql.length });
    return out;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") return bad("--", i, "no comments inside the statement");
    if (c === "'") {
      // A prefix touching the quote (E'', U&'', B'', X'', N'') changes what the
      // string means; only a bare '...' with '' doubling is a value here.
      const prev = i > 0 ? sql[i - 1]! : " ";
      if (/[A-Za-z0-9_&]/.test(prev))
        return bad(sql.slice(i, i + 40), i, "only plain '...' strings");
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= sql.length) return bad(sql.slice(i, i + 40), i, "a string that is never closed");
        const d = sql[j]!;
        if (d === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        if (d === "\\") return bad("\\", j, "no backslashes, in a value or out of one");
        if (d === ";") return bad(";", j, "no semicolon inside a value");
        value += d;
        j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j + 1), value, at: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(sql.slice(i))!;
      const after = sql[i + m[0].length];
      if (after !== undefined && /[A-Za-z0-9_.]/.test(after))
        return bad(
          sql.slice(i, i + m[0].length + 1),
          i,
          "a number is digits with an optional fraction",
        );
      out.push({ kind: "number", text: m[0], value: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      const next = sql[i + m[0].length];
      if (next === "'" || next === "&" || next === "$")
        return bad(
          sql.slice(i, i + m[0].length + 1),
          i,
          "only plain '...' strings and plain names",
        );
      out.push({ kind: "word", text: m[0], value: m[0].toLowerCase(), at: i });
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((q) => sql.startsWith(q, i));
    if (p) {
      out.push({ kind: "punct", text: p, value: p, at: i });
      i += p.length;
      continue;
    }
    return bad(c, i);
  }
  out.push({ kind: "end", text: "", value: "", at: sql.length });
  return out;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export type Value =
  | { kind: "string"; value: string; cast: string | null }
  | { kind: "number"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "call"; name: "now" | "gen_random_uuid" }
  | { kind: "current_date" };

export type Operand = Value | { kind: "column"; name: string };

export type Predicate =
  | { kind: "or" | "and"; parts: Predicate[] }
  | { kind: "bool"; value: boolean }
  | { kind: "compare"; column: string; op: string; value: Value }
  | { kind: "in"; column: string; values: Value[] }
  | { kind: "is-null"; column: string; not: boolean };

export type Statement =
  | {
      verb: "insert";
      table: GrammarTable;
      columns: string[];
      source: { kind: "values"; rows: Value[][] };
    }
  | {
      verb: "insert";
      table: GrammarTable;
      columns: string[];
      source: { kind: "select"; items: Operand[]; from: GrammarTable; where: Predicate };
    }
  | {
      verb: "update";
      table: GrammarTable;
      set: { column: string; value: Operand }[];
      where: Predicate;
    };

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private fail(why?: string): never {
    const t = this.peek();
    if (t.kind === "bad") refuse(`"${show(t.text)}"`, t.at, t.why);
    if (t.kind === "punct" && t.value === ";")
      refuse(`";"`, t.at, "a change file is exactly one statement");
    refuse(t.kind === "end" ? "end of statement" : `"${show(t.text)}"`, t.at, why);
  }

  private isWord(...words: string[]): boolean {
    const t = this.peek();
    return t.kind === "word" && words.includes(t.value);
  }

  private isPunct(p: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === p;
  }

  private word(w: string, why?: string): void {
    if (!this.isWord(w)) this.fail(why ?? `expected ${w.toUpperCase()}`);
    this.i++;
  }

  private punct(p: string, why?: string): void {
    if (!this.isPunct(p)) this.fail(why ?? `expected "${p}"`);
    this.i++;
  }

  private table(): GrammarTable {
    const t = this.peek();
    if (t.kind !== "word" || !Object.hasOwn(TABLE_COLUMNS, t.value)) {
      this.fail(`a change may name only ${Object.keys(TABLE_COLUMNS).join(", ")}`);
    }
    this.i++;
    return t.value as GrammarTable;
  }

  private column(table: GrammarTable): string {
    const t = this.peek();
    if (t.kind !== "word" || !(TABLE_COLUMNS[table] as readonly string[]).includes(t.value)) {
      this.fail(`expected a column of ${table}`);
    }
    this.i++;
    return t.value;
  }

  private columnAhead(table: GrammarTable): boolean {
    const t = this.peek();
    return t.kind === "word" && (TABLE_COLUMNS[table] as readonly string[]).includes(t.value);
  }

  /** A literal, one of three functions, or a cast string. */
  private value(): Value {
    const t = this.peek();
    if (t.kind === "string") {
      this.i++;
      if (this.isPunct("::")) {
        this.i++;
        const c = this.peek();
        if (c.kind !== "word" || !CASTS.has(c.value))
          this.fail("a cast is to date, timestamptz, uuid or text");
        this.i++;
        return { kind: "string", value: t.value, cast: c.value };
      }
      return { kind: "string", value: t.value, cast: null };
    }
    if (t.kind === "number") {
      this.i++;
      return { kind: "number", value: t.value };
    }
    if (t.kind === "punct" && t.value === "-") {
      const n = this.tokens[this.i + 1]!;
      // Only a minus sign touching its number: "- 1" and "--1" are not values.
      if (n.kind !== "number" || n.at !== t.at + 1)
        this.fail("a minus sign goes right before a number");
      this.i += 2;
      return { kind: "number", value: `-${n.value}` };
    }
    if (t.kind === "word") {
      switch (t.value) {
        case "true":
        case "false":
          this.i++;
          return { kind: "bool", value: t.value === "true" };
        case "null":
          this.i++;
          return { kind: "null" };
        case "current_date":
          this.i++;
          return { kind: "current_date" };
        case "now":
        case "gen_random_uuid":
          this.i++;
          this.punct("(", `${t.value} takes no arguments: ${t.value}()`);
          this.punct(")", `${t.value} takes no arguments: ${t.value}()`);
          return { kind: "call", name: t.value };
      }
    }
    this.fail(
      "expected a value: a '...' string, a number, true, false, null, now(), gen_random_uuid() or current_date",
    );
  }

  private operand(table: GrammarTable): Operand {
    if (this.columnAhead(table)) return { kind: "column", name: this.column(table) };
    return this.value();
  }

  private predicate(table: GrammarTable): Predicate {
    if (++this.depth > MAX_DEPTH) this.fail(`no more than ${MAX_DEPTH} levels of parentheses`);
    const parts = [this.conjunct(table)];
    while (this.isWord("or")) {
      this.i++;
      parts.push(this.conjunct(table));
    }
    this.depth--;
    return parts.length === 1 ? parts[0]! : { kind: "or", parts };
  }

  private conjunct(table: GrammarTable): Predicate {
    const parts = [this.term(table)];
    while (this.isWord("and")) {
      this.i++;
      parts.push(this.term(table));
    }
    return parts.length === 1 ? parts[0]! : { kind: "and", parts };
  }

  private term(table: GrammarTable): Predicate {
    if (this.isPunct("(")) {
      this.i++;
      const inner = this.predicate(table);
      this.punct(")");
      return inner;
    }
    if (this.isWord("true", "false")) {
      const value = this.peek().value === "true";
      this.i++;
      return { kind: "bool", value };
    }
    const column = this.column(table);
    const t = this.peek();
    if (t.kind === "punct" && OPS.has(t.value)) {
      this.i++;
      return { kind: "compare", column, op: t.value, value: this.value() };
    }
    if (this.isWord("in")) {
      this.i++;
      this.punct("(");
      const values = [this.value()];
      while (this.isPunct(",")) {
        this.i++;
        values.push(this.value());
      }
      this.punct(")");
      return { kind: "in", column, values };
    }
    if (this.isWord("is")) {
      this.i++;
      let not = false;
      if (this.isWord("not")) {
        this.i++;
        not = true;
      }
      this.word("null", "IS is followed by [NOT] NULL");
      return { kind: "is-null", column, not };
    }
    this.fail("expected =, <>, <, <=, >, >=, IN or IS after a column");
  }

  private columnList(table: GrammarTable): string[] {
    this.punct("(");
    const cols = [this.column(table)];
    while (this.isPunct(",")) {
      this.i++;
      const at = this.peek();
      const c = this.column(table);
      if (cols.includes(c)) refuse(`"${c}"`, at.at, "a column is named once");
      cols.push(c);
    }
    this.punct(")");
    return cols;
  }

  private count(n: number, want: number, at: Token): void {
    if (n !== want) refuse(`"${show(at.text || "(")}"`, at.at, `${n} values for ${want} columns`);
  }

  statement(): Statement {
    let stmt: Statement;
    if (this.isWord("insert")) {
      this.i++;
      this.word("into");
      const table = this.table();
      const columns = this.columnList(table);
      if (this.isWord("values")) {
        this.i++;
        const rows: Value[][] = [];
        do {
          if (rows.length > 0) this.i++;
          const open = this.peek();
          this.punct("(");
          const row = [this.value()];
          while (this.isPunct(",")) {
            this.i++;
            row.push(this.value());
          }
          this.punct(")");
          this.count(row.length, columns.length, open);
          rows.push(row);
        } while (this.isPunct(","));
        stmt = { verb: "insert", table, columns, source: { kind: "values", rows } };
      } else if (this.isWord("select")) {
        const start = this.peek();
        this.i++;
        // The FROM table is known only after the items; read them as tokens
        // first, then check them against it.
        const itemStart = this.i;
        let n = 0;
        while (!this.isWord("from") && this.peek().kind !== "end" && this.peek().kind !== "bad")
          this.i++;
        this.word("from", "a subselect reads FROM one table");
        const from = this.table();
        const afterFrom = this.i;
        this.i = itemStart;
        const items = [this.operand(from)];
        n++;
        while (this.isPunct(",")) {
          this.i++;
          items.push(this.operand(from));
          n++;
        }
        if (!this.isWord("from")) this.fail("expected , or FROM");
        this.i = afterFrom;
        this.count(n, columns.length, start);
        this.word("where", "a subselect has a WHERE");
        const where = this.predicate(from);
        stmt = { verb: "insert", table, columns, source: { kind: "select", items, from, where } };
      } else {
        this.fail("expected VALUES or SELECT");
      }
    } else if (this.isWord("update")) {
      this.i++;
      const table = this.table();
      this.word("set");
      const set: { column: string; value: Operand }[] = [];
      do {
        if (set.length > 0) this.i++;
        const at = this.peek();
        const column = this.column(table);
        if (NEVER_SET.has(column))
          refuse(`"${column}"`, at.at, "an update never sets clinic_id or id");
        if (set.some((s) => s.column === column))
          refuse(`"${column}"`, at.at, "a column is set once");
        this.punct("=");
        set.push({ column, value: this.operand(table) });
      } while (this.isPunct(","));
      this.word(
        "where",
        "an update has a WHERE (where true, when every row of the clinic is meant)",
      );
      const where = this.predicate(table);
      stmt = { verb: "update", table, set, where };
    } else {
      this.fail("a change file is one INSERT INTO or UPDATE");
    }
    if (this.peek().kind !== "end") this.fail("one statement, and nothing after it");
    return stmt;
  }
}

/** Parse a statement (no header, no final `;`) or throw ChangeFileError. */
export function parseStatement(sql: string): Statement {
  return new Parser(tokenize(sql)).statement();
}

// ---------------------------------------------------------------------------
// Back to text: a canonical form, used by tests to show what was accepted is
// itself grammar text. The runner never runs this; it runs the file's own text.
// ---------------------------------------------------------------------------

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function valueText(v: Operand): string {
  switch (v.kind) {
    case "string":
      return v.cast ? `${quote(v.value)}::${v.cast}` : quote(v.value);
    case "number":
      return v.value;
    case "bool":
      return String(v.value);
    case "null":
      return "null";
    case "call":
      return `${v.name}()`;
    case "current_date":
      return "current_date";
    case "column":
      return v.name;
  }
}

function predicateText(p: Predicate): string {
  switch (p.kind) {
    case "or":
    case "and":
      return p.parts
        .map((q) =>
          q.kind === "or" || q.kind === "and" ? `(${predicateText(q)})` : predicateText(q),
        )
        .join(` ${p.kind} `);
    case "bool":
      return String(p.value);
    case "compare":
      return `${p.column} ${p.op} ${valueText(p.value)}`;
    case "in":
      return `${p.column} in (${p.values.map(valueText).join(", ")})`;
    case "is-null":
      return `${p.column} is ${p.not ? "not " : ""}null`;
  }
}

export function serialize(s: Statement): string {
  if (s.verb === "update") {
    return `update ${s.table} set ${s.set.map((x) => `${x.column} = ${valueText(x.value)}`).join(", ")} where ${predicateText(s.where)}`;
  }
  const head = `insert into ${s.table} (${s.columns.join(", ")})`;
  if (s.source.kind === "values") {
    return `${head} values ${s.source.rows.map((r) => `(${r.map(valueText).join(", ")})`).join(", ")}`;
  }
  return `${head} select ${s.source.items.map(valueText).join(", ")} from ${s.source.from} where ${predicateText(s.source.where)}`;
}

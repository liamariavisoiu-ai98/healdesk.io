import { describe, expect, test } from "vitest";

import { ChangeFileError, parseChangeFile } from "../scripts/db-change-file";
import { TABLE_COLUMNS, parseStatement, serialize, tokenize } from "../scripts/db-change-grammar";

/**
 * The change file's allowlist grammar (scripts/db-change-grammar.ts,
 * docs/design/db-apply-grammar-2026-10-24.md). Every accepted form runs as
 * written; ordinary forms outside the grammar are refused, each for its own
 * reason; and a mutated corpus is either accepted as grammar text or refused,
 * never thrown at with anything but a ChangeFileError.
 */

const C = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const P = "7d1e2f3a-2222-4c2a-9a8b-1f2e3d4c5b6b";

/** Every form the grammar doc lists, as the file would hold it. */
const ACCEPTED = [
  "update clinic_closures set label = label where false",
  `insert into clinic_closures (clinic_id, closed_on, label) values ('${C}', '2026-12-25', 'Christmas')`,
  `insert into clinic_closures (clinic_id, closed_on, label) values ('${C}', '2026-12-24'::date, 'Closed'), ('${C}', '2026-12-25'::date, null)`,
  "update clinic_closures set label = 'Bank holiday' where closed_on = '2026-12-26'",
  "update clinic_closures set label = 'Dr O''Brien''s day' where closed_on in ('2026-12-24', '2026-12-31') or label is null",
  "insert into clinic_closures (clinic_id, closed_on, label) select clinic_id, '2027-12-25'::date, label from clinic_closures where closed_on = '2026-12-25'",
  `insert into clinic_providers (id, clinic_id, display_name, calendar_id) values ('${P}'::uuid, '${C}', 'Dr Chen', 'primary')`,
  `insert into clinic_providers (id, clinic_id, display_name, calendar_id, active) values (gen_random_uuid(), '${C}'::uuid, 'Dr Lee', 'lee@example.com', true)`,
  `update clinic_providers set display_name = 'Dr A Chen', updated_at = now() where id = '${P}'`,
  `update clinic_providers set active = false, updated_at = '2026-10-24T09:00:00Z'::timestamptz where id = '${P}'::uuid and active = true`,
  "insert into clinic_provider_services (clinic_id, provider_id, service_key) select clinic_id, id, 'botox' from clinic_providers where calendar_id = 'primary' and active = true",
  "insert into clinic_provider_services (clinic_id, provider_id, service_key) select clinic_id, provider_id, 'fillers'::text from clinic_provider_services where service_key = 'botox' and (created_at >= '2026-01-01'::date or created_at < current_date)",
  "UPDATE Clinic_Closures SET label = 'Closed' WHERE closed_on >= current_date AND closed_on <> '2027-01-01' AND label IS NOT NULL",
  "update clinic_closures set label = 'Costs $0, closed' where ((closed_on > '2026-01-01') and (closed_on <= '2026-12-31'))",
  "update clinic_closures set label = 'x' where true",
];

describe("the forms the grammar accepts", () => {
  test.each(ACCEPTED)("%s", (sql) => {
    const file = parseChangeFile(`-- a header line\n-- and another\n\n${sql};\n`);
    // No rewriting: the runner sends the file's own text.
    expect(file.statement).toBe(sql);
    // And the tree goes back to grammar text that parses to the same tree.
    const again = parseStatement(serialize(file.ast));
    expect(again).toEqual(file.ast);
    expect(serialize(again)).toBe(serialize(file.ast));
  });

  test("the result says what the runner reports", () => {
    expect(parseChangeFile(ACCEPTED[5]!)).toMatchObject({
      verb: "insert",
      table: "clinic_closures",
    });
    expect(parseChangeFile(ACCEPTED[8]!)).toMatchObject({
      verb: "update",
      table: "clinic_providers",
    });
    expect(parseChangeFile(ACCEPTED[10]!).ast).toMatchObject({
      source: { kind: "select", from: "clinic_providers" },
    });
  });
});

/**
 * Ordinary statements outside the grammar, by category, each with the reason
 * it must be refused for. None is a novel payload; each is the plain form of
 * something the grammar leaves out.
 */
const REFUSED: Record<string, [string, RegExp][]> = {
  "a table outside the three": [
    ["update clinics set name = 'x' where true", /may name only/],
    ["update clinic_settings set updated_at = now() where true", /may name only/],
    ["insert into contacts (id) values ('x')", /may name only/],
    ["update clinic_locations set label = 'x' where true", /may name only/],
    [
      `insert into clinic_closures (clinic_id, closed_on) select id, '2027-01-01' from clinics where true`,
      /may name only/,
    ],
  ],
  "a schema-qualified or quoted name": [
    [
      "update public.clinic_closures set label = 'x' where true",
      /unexpected "public".*may name only/,
    ],
    [
      "insert into public.clinic_providers (clinic_id, display_name) values ('a', 'Dr Chen')",
      /unexpected "public".*may name only/,
    ],
    ["update \"clinic_closures\" set label = 'x' where true", /unexpected """/],
    ["update clinic_closures set \"label\" = 'x' where true", /unexpected """/],
    ["update clinic_closures set label = 'x' where pg_catalog.now() is null", /expected a column/],
  ],
  "a function not on the list": [
    [
      "update clinic_closures set label = set_config('app.clinic_id', 'x', true) where true",
      /expected a value/,
    ],
    [
      "update clinic_closures set label = current_setting('app.clinic_id') where true",
      /expected a value/,
    ],
    ["update clinic_closures set label = lower('X') where true", /expected a value/],
    ["update clinic_closures set label = 'x' where closed_on = pg_sleep(1)", /expected a value/],
    [
      "update clinic_closures set label = 'x' where query_to_xml('select 1', true, false, '') is not null",
      /expected a column/,
    ],
    ["update clinic_closures set label = coalesce(label, 'x') where true", /expected a value/],
    ["update clinic_providers set updated_at = now(1) where true", /takes no arguments/],
    ["update clinic_providers set updated_at = clock_timestamp() where true", /expected a value/],
  ],
  "a subselect beyond one level, one table, no extras": [
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures where closed_on in (select closed_on from clinic_closures where true)",
      /expected a value/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select c.clinic_id, c.closed_on from clinic_closures c join clinic_providers p on true where true",
      /unexpected "\."/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures, clinic_providers where true",
      /expected WHERE|a subselect has a WHERE/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures where true limit 1",
      /nothing after it/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures where true order by closed_on",
      /nothing after it/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures",
      /has a WHERE/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, max(closed_on) from clinic_closures where true",
      /expected a value/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select * from clinic_closures where true",
      /unexpected "\*"/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from clinic_closures where true union select clinic_id, closed_on from clinic_closures where true",
      /nothing after it/,
    ],
    [
      "update clinic_closures set label = (select label from clinic_closures where true) where true",
      /expected a value/,
    ],
    [
      "insert into clinic_closures (clinic_id, closed_on) select clinic_id, closed_on from generate_series(1, 2) where true",
      /may name only/,
    ],
  ],
  "a CTE": [
    [
      "with x as (select 1) update clinic_closures set label = 'x' where true",
      /one INSERT INTO or UPDATE/,
    ],
    [
      "with moved as (update clinic_closures set label = 'x' where true) insert into clinic_closures (clinic_id) values ('a')",
      /one INSERT INTO or UPDATE/,
    ],
  ],
  "more than one statement, or text after it": [
    [
      "update clinic_closures set label = 'a' where true; update clinic_closures set label = 'b' where true",
      /exactly one statement/,
    ],
    ["update clinic_closures set label = 'a' where true; select 1", /exactly one statement/],
    ["update clinic_closures set label = 'a' where true extra", /nothing after it/],
  ],
  "a comment inside the statement": [
    ["update clinic_closures set label = 'a' -- why\nwhere true", /no comments/],
    ["update clinic_closures set label = 'a' /* x */ where true", /unexpected "\/"/],
    ["update clinic_closures set label = 'a' where true --", /no comments/],
  ],
  "a string that is not a plain '...'": [
    ["update clinic_closures set label = E'a\\nb' where true", /only plain/],
    ["update clinic_closures set label = U&'\\0041' where true", /only plain/],
    ["update clinic_closures set label = $$a$$ where true", /unexpected "\$"/],
    ["update clinic_closures set label = $a$x$a$ where true", /unexpected "\$"/],
    ["update clinic_closures set label = 'a\\b' where true", /no backslashes/],
    ["update clinic_closures set label = B'01' where true", /only plain/],
    ["update clinic_closures set label = X'ff' where true", /only plain/],
    ["update clinic_closures set label = N'x' where true", /only plain/],
    [
      "update clinic_closures set label = 'Drop-in day; create a plan' where true",
      /no semicolon inside a value/,
    ],
    ["update clinic_closures set label = 'never closed where true", /never closed/],
  ],
  "DDL, DELETE, COPY, a bare SELECT and other verbs": [
    ["delete from clinic_closures where true", /one INSERT INTO or UPDATE/],
    ["truncate clinic_closures", /one INSERT INTO or UPDATE/],
    ["copy clinic_closures to stdout", /one INSERT INTO or UPDATE/],
    ["alter table clinic_closures add column x int", /one INSERT INTO or UPDATE/],
    ["drop table clinic_closures", /one INSERT INTO or UPDATE/],
    ["create table x (a int)", /one INSERT INTO or UPDATE/],
    ["grant all on clinic_closures to public", /one INSERT INTO or UPDATE/],
    ["select * from clinic_closures", /one INSERT INTO or UPDATE/],
    ["set app.clinic_id = 'x'", /one INSERT INTO or UPDATE/],
  ],
  "RETURNING, ON CONFLICT and other clauses left out": [
    ["update clinic_closures set label = 'a' where true returning *", /nothing after it/],
    [
      `insert into clinic_closures (clinic_id, closed_on) values ('${C}', '2027-01-01') returning label`,
      /nothing after it/,
    ],
    [
      `insert into clinic_closures (clinic_id, closed_on) values ('${C}', '2027-01-01') on conflict do nothing`,
      /nothing after it/,
    ],
    ["insert into clinic_closures default values", /unexpected "default"/],
    ["insert into clinic_closures values ('a', '2027-01-01')", /expected "\("/],
    ["update clinic_closures set label = 'a'", /has a WHERE/],
    ["update clinic_closures set label = 'a' from clinic_providers where true", /has a WHERE/],
  ],
  "an expression, operator, cast or column the grammar leaves out": [
    ["update clinic_closures set label = label || 'x' where true", /unexpected "\|"/],
    ["update clinic_closures set closed_on = closed_on + 1 where true", /unexpected "\+"/],
    ["update clinic_closures set label = 'x' where closed_on != '2027-01-01'", /unexpected "!"/],
    ["update clinic_closures set label = 'x' where label like 'a%'", /expected =/],
    ["update clinic_closures set label = 'x' where not label is null", /expected a column/],
    [
      "update clinic_closures set label = 'x' where closed_on between '2027-01-01' and '2027-02-01'",
      /expected =/,
    ],
    ["update clinic_closures set label = 'x' where closed_on = label", /expected a value/],
    ["update clinic_providers set active = false where active", /expected =/],
    ["update clinic_closures set label = '1'::int where true", /a cast is to/],
    ["update clinic_closures set label = 'clinics'::regclass where true", /a cast is to/],
    ["update clinic_closures set label = cast('x' as text) where true", /expected a value/],
    ["update clinic_closures set label = 1::text where true", /has a WHERE/],
    ["update clinic_closures set nope = 'x' where true", /expected a column of clinic_closures/],
    ["update clinic_closures set clinic_id = 'x' where true", /never sets clinic_id/],
    ["update clinic_providers set id = gen_random_uuid() where true", /never sets clinic_id or id/],
    ["update clinic_closures set label = 'a', label = 'b' where true", /set once/],
    ["insert into clinic_closures (clinic_id, clinic_id) values ('a', 'b')", /named once/],
    ["insert into clinic_closures (clinic_id, closed_on) values ('a')", /1 values for 2 columns/],
    [
      "insert into clinic_closures (clinic_id) select clinic_id, closed_on from clinic_closures where true",
      /2 values for 1 columns/,
    ],
    ["update clinic_closures set label = - 1 where true", /minus sign/],
    ["update clinic_closures set label = 1e5 where true", /digits with an optional fraction/],
  ],
};

describe("statements outside the grammar are refused", () => {
  const cases = Object.entries(REFUSED).flatMap(([category, list]) =>
    list.map(([sql, why]) => [category, sql, why] as const),
  );

  test("there are at least 40, in every category", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const list of Object.values(REFUSED)) expect(list.length).toBeGreaterThan(0);
  });

  test.each(cases)("%s: %s", (_category, sql, why) => {
    let error: unknown;
    try {
      parseChangeFile(sql);
    } catch (e) {
      error = e;
    }
    expect(error, sql).toBeInstanceOf(ChangeFileError);
    const message = (error as Error).message;
    expect(message).toMatch(why);
    // Never more than 40 characters of the statement in the message.
    const quoted = /unexpected "(.*)" at/.exec(message)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(40);
  });

  test("a long token is quoted at 40 characters at most, with its position", () => {
    const long = `update clinic_closures set label = 'x' where ${"a".repeat(200)} = 'y'`;
    const message = (() => {
      try {
        parseChangeFile(long);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(message).toMatch(/at character 46/);
    expect(message).not.toContain("a".repeat(41));
  });

  test("parentheses nest only so deep", () => {
    const deep = `update clinic_closures set label = 'x' where ${"(".repeat(40)}true${")".repeat(40)}`;
    expect(() => parseChangeFile(deep)).toThrow(/levels of parentheses/);
  });
});

/**
 * A fixed corpus, mutated by deleting or duplicating each token in turn and
 * by inserting a forbidden piece of text before each token. Every mutant is
 * either refused with a ChangeFileError or accepted as text that goes back to
 * grammar text, and nothing accepted holds a word outside the grammar's own
 * vocabulary outside a quoted value.
 */
describe("a mutated corpus", () => {
  const VOCAB = new Set<string>([
    "insert",
    "into",
    "values",
    "select",
    "from",
    "where",
    "update",
    "set",
    "and",
    "or",
    "in",
    "is",
    "not",
    "null",
    "true",
    "false",
    "now",
    "gen_random_uuid",
    "current_date",
    "date",
    "timestamptz",
    "uuid",
    "text",
    ...Object.keys(TABLE_COLUMNS),
    ...Object.values(TABLE_COLUMNS).flat(),
  ]);
  const PUNCT = new Set(["::", "<=", ">=", "<>", "(", ")", ",", "=", "<", ">", "-"]);
  const INJECT = [
    "set_config('app.clinic_id', 'x', true)",
    "; ",
    "-- ",
    "/* */",
    "$$x$$",
    "delete ",
    "returning * ",
    "pg_sleep(1) ",
    "E'x' ",
    '"label" ',
    "public.",
    "(select 1) ",
  ];

  function mutants(sql: string): string[] {
    const tokens = tokenize(sql).filter((t) => t.kind !== "end");
    const out: string[] = [];
    for (const t of tokens) {
      const end = t.at + t.text.length;
      out.push(sql.slice(0, t.at) + sql.slice(end));
      out.push(sql.slice(0, end) + " " + sql.slice(t.at));
      for (const bad of INJECT) out.push(sql.slice(0, t.at) + bad + sql.slice(t.at));
    }
    return out;
  }

  test("every mutant is refused cleanly or accepted as grammar text", () => {
    let accepted = 0;
    let refused = 0;
    for (const base of ACCEPTED) {
      for (const sql of mutants(base)) {
        let file;
        try {
          file = parseChangeFile(sql);
        } catch (error) {
          expect(error, sql).toBeInstanceOf(ChangeFileError);
          refused++;
          continue;
        }
        accepted++;
        expect(parseStatement(serialize(file.ast)), sql).toEqual(file.ast);
        for (const t of tokenize(file.statement)) {
          if (t.kind === "word") expect(VOCAB.has(t.value), `${t.value} in ${sql}`).toBe(true);
          if (t.kind === "punct") expect(PUNCT.has(t.value), `${t.value} in ${sql}`).toBe(true);
        }
      }
    }
    // Both outcomes happen: the corpus is not all refused by a broken parser.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(1000);
  });

  test("no injected forbidden text is ever accepted outside a quoted value", () => {
    for (const base of ACCEPTED) {
      for (const sql of mutants(base)) {
        if (!INJECT.some((bad) => sql.includes(bad.trim()) && !base.includes(bad.trim()))) continue;
        let ok = true;
        try {
          parseChangeFile(sql);
        } catch {
          ok = false;
        }
        expect(ok, sql).toBe(false);
      }
    }
  });
});

# What a db-apply change file may say: an allowlist grammar (24 October 2026)

Lane H of the ops-automation programme, wave 2. Owner decision of 23 October
2026: replace the change file's denylist of names with an allowlist grammar,
allowing simple subselects over the named clinic's own rows. Code:
`apps/app/scripts/db-change-grammar.ts` (tokenizer and parser),
`apps/app/scripts/db-change-file.ts` (the file format, then the grammar, then the
old denylist as a second layer). Tests: `apps/app/tests/db-change-grammar.test.ts`,
`apps/app/tests/db-change-file.test.ts`, `apps/app/tests/db-apply.test.ts`,
`apps/app/tests/db-apply-guards.test.ts`.

## What real change files need

The only file in `apps/app/scripts/db-changes/` today is `noop-smoke-test.sql`
(`update clinic_closures set label = label where false`). The changes ops will
write, from the design (`docs/design/db-access-2026-10-22.md`) and decision D8
(change files stay for closures and the roster):

| Need | Statement shape |
| --- | --- |
| Close a day, with a label | `insert into clinic_closures (clinic_id, closed_on, label) values ('<clinic>', '2026-12-25', 'Christmas')` |
| Relabel a closed day | `update clinic_closures set label = 'Bank holiday' where closed_on = '2026-12-26'` |
| Copy a closed day to another date | `insert into clinic_closures (clinic_id, closed_on, label) select clinic_id, '2027-12-25'::date, label from clinic_closures where closed_on = '2026-12-25'` |
| Add a provider | `insert into clinic_providers (id, clinic_id, display_name, calendar_id) values ('<uuid>'::uuid, '<clinic>', 'Dr Chen', 'primary')` |
| Rename or retire a provider | `update clinic_providers set display_name = 'Dr A Chen', updated_at = now() where id = '<uuid>'` / `set active = false` |
| Give a provider its services | `insert into clinic_provider_services (clinic_id, provider_id, service_key) select clinic_id, id, 'botox' from clinic_providers where calendar_id = 'primary' and active = true` (a bare `and active` is not a predicate here: write the comparison) |
| The smoke test | `update clinic_closures set label = label where false` |

None needs `ON CONFLICT`: a duplicate closed day fails the dry run with the
primary key's error, which is the signal the reviewer wants, and an upsert
would make the row count mean two different things. None needs `LIMIT`,
`ORDER BY`, joins, aggregates, arithmetic or a second statement. Removing a
row (a mapping is "replaced by deleting and inserting") stays out: the role
has no DELETE grant, and retiring a provider is `active = false`.

## The grammar

A file is: optional header lines, each starting `--`; then exactly one
statement; then an optional `;` and whitespace. The runner executes the
statement's own text, byte for byte (header and final `;` removed, nothing
rewritten).

```
statement  := insert | update
insert     := INSERT INTO table "(" column {"," column} ")" source
source     := VALUES row {"," row}
            | SELECT item {"," item} FROM table WHERE predicate
row        := "(" value {"," value} ")"          -- as many as the columns
item       := value | column-of-the-FROM-table    -- as many as the columns
update     := UPDATE table SET column "=" setval {"," column "=" setval} WHERE predicate
setval     := value | column-of-the-table         -- `label = label`
predicate  := conjunct {OR conjunct}
conjunct   := term {AND term}
term       := "(" predicate ")" | TRUE | FALSE
            | column op value | column IN "(" value {"," value} ")"
            | column IS [NOT] NULL
op         := = | <> | < | <= | > | >=
value      := string ["::" cast] | [-]number | TRUE | FALSE | NULL
            | NOW "(" ")" | GEN_RANDOM_UUID "(" ")" | CURRENT_DATE
cast       := date | timestamptz | uuid | text
table      := clinic_closures | clinic_providers | clinic_provider_services
```

- **Names** are plain, unquoted, unqualified identifiers, matched without
  regard to case. A column must be one of its table's columns, from a list
  checked in beside the parser (`TABLE_COLUMNS`); a database test compares
  that list with the live schema. A column appears once in an insert's list
  or an update's `SET`. Never written: `SET` never names `clinic_id` or `id`;
  `created_at` is the database's own clock, neither set nor inserted; and
  `clinic_closures.location_id` is never set (the trigger `app_location_fixed`
  raises on any change, so the grammar refuses it first with a readable
  message; an insert may still name it). `closed_on` and `provider_id` stay
  settable.
- **Strings** are single-quoted with `''` as the only escape. Refused: `E''`,
  `U&''`, `B''`, `X''`, `N''` or any prefix touching the quote, dollar quotes,
  a backslash anywhere, and a `;` inside a value. Inside a value the only
  space is the plain one (U+0020): control characters (NUL, ESC, C0, C1,
  and tab and newline too, since labels and names are one line), format
  characters (bidi overrides and isolates U+202A-202E and U+2066-2069,
  zero-width characters, the byte-order mark), line and paragraph separators
  (U+2028, U+2029) and every other space (a no-break space reads as a space
  and is not one) are refused, so a reviewed file reads as what runs. Other
  letters (`Café`, `Zoë`) are fine.
- **Numbers** are digits with an optional fraction; a minus sign only right
  before one.
- **The subselect** reads one of the three tables, once, one level deep: no
  join, no `WITH`, no nested select, no `LIMIT`/`ORDER BY`, no aggregate, no
  function but the three above. Row-level security shows the writer the
  named clinic's rows and no others, and both post-statement checks of
  `runParsed` still run.
- **Refused**: everything else, including a comment of any kind inside the
  statement, a second statement, `RETURNING`, `DELETE`, `COPY`, DDL, `SELECT`
  on its own, double-quoted identifiers, `public.` and every operator or
  character not listed. The message names the first unexpected token and its
  character position, quoting at most 40 characters and printing anything
  outside printable ASCII as `U+XXXX`. A trailing `; -- note` is refused as a
  comment ("comments are not allowed"), not as a second statement.
- **The file** uses LF line endings: a carriage return anywhere is refused
  with its position, never rewritten, since inside a value the database would
  read it. Between tokens, space, tab and newline separate; the header and
  the final `;` are cut with plain whitespace only, so the runner sends the
  statement's own characters.
- **Kept as a second layer**: the old denylist (no `set_config`,
  `current_setting`, `pg_*`, `*_to_xml`, `$` outside a value, `U&`, DDL
  words, `RETURNING`), exported as `denylist` and run after the grammar
  through one object (`layers`), so a test sees both run; it must read the
  same verb and table as the grammar. It refuses nothing the grammar accepts,
  and costs nothing.
- **Parentheses** nest at most 16 levels: 16 pass, 17 are refused.
- **The run** pins `SET LOCAL search_path = pg_catalog, public` right after
  it sets the clinic, before the statement (`runParsed`). The trigger
  functions pin their own search_path, and the post-statement checks name
  public functions, so neither is disturbed.

## What the tests prove, and what they do not

Every accepted form parses to its own text. Each category of refused form
is refused for its own reason. A mutated corpus (each token deleted,
duplicated, or preceded by a forbidden fragment) is refused cleanly or
accepted. With a database, every accepted form and every accepted mutant is
run as a dry run under the writer role and raises no syntax error (SQLSTATE
42601) and no other class-42 error but a missing privilege: refusals by data
(row-level security, the BAA gate, a bad date) are told apart by SQLSTATE.
The corpus checks re-read text with the grammar's own tokenizer, so they are
not a differential test against Postgres's lexer; no libpg_query or
pgsql-parser is in the repository, and none was added.

## How this changes the write rail

Before, a change file was any text that began with INSERT or UPDATE on a
writable table and avoided a list of words; a built-in that runs SQL from a
string could, in principle, carry a forbidden word past that list inside a
quoted value. Now a change file is a sentence of a small language in which no
function runs SQL, no name can be spelt indirectly and no value is anything
but a literal, so the list of words becomes a backstop, not the bound. What
still bounds a run, unchanged: the writer role's grants, row-level security
keyed on the clinic the run names, the triggers, and `runParsed`'s two checks
after the statement (the setting still names the clinic; every change row
written names only it). Two things a reviewer should know: an update must now
carry a `WHERE` (`where true` when every row of the clinic is meant, so the
breadth is written down), and a file that relied on `public.`, quoted names,
a `;` or an invisible character inside a label, CRLF line endings, or setting
`created_at` or a closed day's `location_id` must be rewritten. A database
error printed by `db-apply.ts` is cut to 200 characters.

`docs/design/db-access-2026-10-22.md` will link here from its write-path
section (lane G's file; the lead adds the link).

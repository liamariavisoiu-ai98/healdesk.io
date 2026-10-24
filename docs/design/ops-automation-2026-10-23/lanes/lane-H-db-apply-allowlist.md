# Lane H: a change file is checked against a grammar, not a list of bad words (wave 2) — builder: Opus

Read `RULES.md` first (trailer EXACTLY `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`).
Worktree `/Users/liamariavisoiu/projects/healdesk-ops-h`, branch `ops/h-db-apply-allowlist`, cut from main
`1fa04a6f`. Postgres container `hd-ops-h-pg`, port `55523`. **No migration.**

## Why (owner decisions, 23 Oct 2026)
`db-apply` (workflow `.github/workflows/db-apply.yml`, scripts `apps/app/scripts/db-change-file.ts`,
`db-apply-lib.ts`, `db-apply.ts`; design `docs/design/db-access-2026-10-22.md`) runs a reviewed change file as the
role `healdesk_writer` on production, one clinic per run, dry run first, with a stated row count. Today
`parseChangeFile` is a DENYLIST of names (`set_config`, `pg_*`, `*_to_xml`, `$` tags, `U&`...) applied after
single-quoted values are stripped. Reviews found that a denylist is not the real bound: any built-in that runs SQL
from text could hide forbidden words inside a quoted string, and the writer's reads are scoped by a session
setting the statement could in principle switch. Lane B added two post-statement checks (the setting still names
the clinic; every change row written names only that clinic) which stay. The owner chose to replace the denylist
with an ALLOWLIST GRAMMAR, **allowing simple subselects over the named clinic's own rows**.

This is defensive hardening of our own tooling: the work is a stricter parser and its tests. Test the grammar by
asserting that statements outside it are REFUSED (use ordinary representative refused forms: another table, a
schema-qualified name, a function not on the list, a nested or joined subselect, a CTE, two statements, a comment,
a dollar-quoted or escape string, DDL, DELETE, COPY, RETURNING...). Do not hunt for or construct novel
exploit payloads; if you believe the grammar has a gap, describe it in the report.

## What to build
1. **Read first**: the current parser and its tests (`tests/db-change-file.test.ts`, `tests/db-apply.test.ts`,
   `tests/clinic-change-direct.test.ts`, `tests/db-apply-guards.test.ts`), the change-file format (header,
   statement, expect_rows; find every example under the repo, e.g. the `noop-smoke-test` change and whatever
   directory holds change files), and the workflow. Write what real change files need (closures: insert/update
   a closed day and its label; providers: insert/update a provider and its service rows; copying a clinic's
   own closures) into a one-page grammar doc `docs/design/db-apply-grammar-2026-10-24.md` FIRST.
2. **A real tokenizer and a recursive-descent parser** (no regex matching of the whole statement) in
   `apps/app/scripts/db-change-file.ts` (or a new file it imports) that accepts ONLY:
   - exactly one statement, no trailing text, no comments of any kind (`--`, `/* */`), no `;` inside values;
   - `INSERT INTO <t> (<cols>) VALUES (<row>[, ...])`, `INSERT INTO <t> (<cols>) SELECT <items> FROM <t2>
     WHERE <predicate>` and `UPDATE <t> SET <col> = <value>[, ...] WHERE <predicate>`, where `<t>` and `<t2>` are
     exactly `clinic_closures`, `clinic_providers`, `clinic_provider_services` (unqualified; `<t2>` may be any one
     of the three: the named clinic's own rows are all the writer's row-level security lets it see, and the
     post-statement checks still apply); optional `ON CONFLICT (<cols>) DO NOTHING` or `DO UPDATE SET col =
     EXCLUDED.col, ...` only if real change files need it (decide from step 1 and document);
   - values: single-quoted strings (standard quote doubling only; NO escape strings `E''`, NO `U&`, NO dollar
     quotes, no backslashes interpreted), integers, decimals, `true`/`false`/`null`, dates and timestamps as
     quoted strings optionally followed by `::date`, `::timestamptz`, `::uuid` or `::text` (a closed cast
     list), and the functions `now()`, `gen_random_uuid()`, `current_date` ONLY;
   - predicates: `col <op> value` with `=`, `<>`, `<`, `<=`, `>`, `>=`, `col IN (values)`, `col IS [NOT] NULL`,
     combined with `AND`/`OR` and parentheses; columns are plain identifiers that exist on the target table
     (take the column list from the live schema in tests, and from a checked-in list in the parser so the parser
     needs no database);
   - the subselect shape above: one level only, one table, no joins, no `WITH`, no set-returning functions, no
     `LIMIT`/`ORDER BY` unless a real change needs it, no aggregates;
   - everything else is refused with a message naming the first unexpected token and its position (never echoing
     more than 40 characters of the statement). KEEP the existing denylist checks as an extra layer (they cost
     nothing), and keep both post-statement checks and `runParsed` as lane B built them.
3. **Tests** (extend `tests/db-change-file.test.ts` and add `tests/db-change-grammar.test.ts`): every accepted
   form in the doc parses and yields the SAME statement text the runner executes (assert no rewriting, or document
   a normalisation); every real existing change file in the repo still parses; a table-driven list of at least 40
   refused statements covering each category above (each fails with the right reason); a fuzz-style test with a
   small fixed corpus mutated by deleting/duplicating tokens asserting that the parser either accepts a statement
   that re-serialises to a grammar-valid one or refuses it, never throws an unexpected error and never accepts a
   statement containing a forbidden token outside a quoted string value; a dry-run and an apply through
   `runChange` under the real writer role (`TEST_WRITER_URL`) for one accepted subselect form on
   `clinic_closures` (copy one closed day to another date) showing it writes one `change_file` event row and
   stays inside the named clinic.
4. **Docs**: the grammar doc, plus one paragraph in `docs/design/db-access-2026-10-22.md`'s write-path section?
   NO: that file belongs to lane G; instead end the grammar doc with a "How this changes the write rail" section
   and tell the lead to link it.

## Files you OWN
`apps/app/scripts/db-change-file.ts`, any new parser file under `apps/app/scripts/`, `scripts/db-apply-lib.ts`
(only if the parser's result shape needs it), `tests/db-change-file.test.ts`, `tests/db-change-grammar.test.ts`,
`tests/db-apply*.test.ts` additions, `docs/design/db-apply-grammar-2026-10-24.md`. Not `.github/`, not `AGENTS.md`,
not migrations, not lane G's files.

## Report
RULES.md format; the grammar as a short list; which existing change files you found and that they parse; the
count of refused cases per category; any construct you wanted to allow but did not, and why; any gap you
suspect (described, not exploited).

-- Which tables in the public schema this role can SELECT, from the catalogue
-- rather than from any clinic's rows, so it does not depend on row-level
-- security. `readable_names` should equal READONLY_TABLES in
-- scripts/readonly-tables.ts exactly; `tables` is every table that exists, so
-- the gap between the two is what the role cannot read.
select
  count(*) filter (where has_table_privilege(c.oid, 'SELECT')) as readable,
  count(*) as tables,
  string_agg(c.relname, ',' order by c.relname) filter (where has_table_privilege(c.oid, 'SELECT')) as readable_names
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r';

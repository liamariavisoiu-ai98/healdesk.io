-- Who this task connected as and the limits that role carries: it should be
-- healdesk_readonly, read only by default, with a short statement timeout, and
-- neither a superuser nor able to bypass row-level security.
select
  current_user as who,
  current_setting('default_transaction_read_only') as read_only_default,
  current_setting('statement_timeout') as statement_timeout,
  (select rolsuper from pg_roles where rolname = current_user) as superuser,
  (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls;

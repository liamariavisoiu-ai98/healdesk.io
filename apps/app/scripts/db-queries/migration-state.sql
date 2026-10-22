-- How far the host's migrations reach: the count applied and the newest one's
-- time. Compare the count with `ls apps/app/drizzle/*.sql | wc -l` on the
-- commit that is deployed.
select count(*) as applied, max(created_at) as newest_created_at
from drizzle.__drizzle_migrations;

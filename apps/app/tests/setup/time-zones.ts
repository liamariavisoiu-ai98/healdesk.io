import { getMigratorPool } from "./db";

/**
 * Time zones a database session can set to stretch or shrink a day.
 *
 * Any role may SET TimeZone for its own session, the runtime role included,
 * and Postgres does day arithmetic on a timestamptz (`now() - interval '7
 * days'`, `make_interval(days => n)`) in that zone: it moves the local date,
 * keeps the local time, and converts back at whatever offset the new date
 * has. Across a change of offset a day lasts the change's length longer or
 * shorter. A POSIX rule can put standard and daylight time 334 hours apart
 * (±167 hours, the widest Postgres accepts), which turns seven days into
 * nearly twenty-one and twenty-nine into fifteen. Which rule does that
 * depends on today's date, so the zone is found by measuring, in SQL, a
 * change on every day of the year.
 *
 * `AT TIME ZONE` converts as a session set to the zone does, so the
 * measurement needs no session of its own; `sessionReach` checks a zone
 * found against a real session before a test relies on it.
 */
export type HostileZone = { zone: string; days: number };

/**
 * Standard time 167 hours east and daylight time 167 west, for one day from
 * day n: `now() - interval` reaches back further than the interval says.
 */
const STRETCHING = { pattern: "AAA-167BBB+167,J%s/0,J%s/0", span: 1 };
/**
 * Standard time 167 hours west and daylight time 167 east, for twenty days
 * from day n: `now() - interval` stops short of the interval, or lands ahead.
 */
const SHRINKING = { pattern: "AAA+167BBB-167,J%s/0,J%s/0", span: 20 };

async function measure(
  family: { pattern: string; span: number },
  interval: string,
  order: "asc" | "desc",
): Promise<HostileZone> {
  const { rows } = await getMigratorPool().query<{ zone: string; days: number }>(
    `select z.zone,
            extract(epoch from now() - (((now() at time zone z.zone) - $1::interval)
                                         at time zone z.zone))::float8 / 86400 as days
       from (select format($2, d, (d - 1 + $3) % 365 + 1) as zone
               from generate_series(1, 365) d) z
      order by days ${order}
      limit 1`,
    [interval, family.pattern, family.span],
  );
  return rows[0]!;
}

/** The zone in which `now() - interval` reaches furthest back, and how many days back it reaches. */
export function zoneStretching(interval: string): Promise<HostileZone> {
  return measure(STRETCHING, interval, "desc");
}

/** The zone in which `now() - interval` reaches back least (or lands ahead), and how far back it reaches. */
export function zoneShrinking(interval: string): Promise<HostileZone> {
  return measure(SHRINKING, interval, "asc");
}

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** Sets the zone for the rest of the caller's transaction, as any role may. */
export async function setLocalZone(client: Client, zone: string): Promise<void> {
  await client.query(`select set_config('TimeZone', $1, true)`, [zone]);
}

/** How many days back `now() - interval` reaches in this session, whose zone the caller set. */
export async function sessionReach(client: Client, interval: string): Promise<number> {
  const { rows } = await client.query<{ days: number }>(
    `select extract(epoch from now() - (now() - $1::interval))::float8 / 86400 as days`,
    [interval],
  );
  return rows[0]!.days;
}

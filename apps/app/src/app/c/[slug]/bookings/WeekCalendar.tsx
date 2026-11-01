import { WEEK_OFFSET_MAX, WEEK_OFFSET_MIN, type BookingsWeek } from "@/lib/portal/bookings-week";

/**
 * Bookings' week calendar (portal redesign, third slice, owner, 1 November
 * 2026): seven columns on a laptop, one list of days on a phone. Each
 * appointment is a link down to its card on this page, where its outcome and
 * deposit are handled. Previous and Next are plain links (`?week=`), so it
 * works without a script.
 */
export function WeekCalendar({ week, path }: { week: BookingsWeek; path: string }) {
  const link = (offset: number) => (offset === 0 ? `${path}#week` : `${path}?week=${offset}#week`);
  return (
    <section
      id="week"
      aria-labelledby="week-heading"
      className="border-line mt-6 scroll-mt-6 rounded-lg border bg-white px-4 py-4 shadow-sm sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="week-heading" className="text-xl font-semibold">
          {week.title}
        </h2>
        <nav aria-label="Weeks" className="flex items-center gap-2">
          {week.offset > WEEK_OFFSET_MIN ? (
            <a
              href={link(week.offset - 1)}
              className="border-line inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold"
            >
              <span aria-hidden="true">‹&nbsp;</span>Previous
            </a>
          ) : null}
          {week.offset !== 0 ? (
            <a
              href={link(0)}
              className="border-line inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold"
            >
              This week
            </a>
          ) : null}
          {week.offset < WEEK_OFFSET_MAX ? (
            <a
              href={link(week.offset + 1)}
              className="border-line inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold"
            >
              Next<span aria-hidden="true">&nbsp;›</span>
            </a>
          ) : null}
        </nav>
      </div>
      <p className="text-muted mt-1 text-sm">
        {week.count === 0
          ? "No appointments from AYA this week."
          : `${week.count} ${week.count === 1 ? "appointment" : "appointments"} from AYA. Tap one to mark how it went.`}
      </p>
      <ol className="mt-4 grid gap-2 lg:grid-cols-7">
        {week.days.map((d) => (
          <li
            key={d.date}
            className={`rounded-md px-3 py-3 lg:min-h-40 lg:px-2 ${d.isToday ? "border-ink border-2 bg-white" : "bg-paper-2"}`}
          >
            <p className="flex items-baseline gap-2 lg:flex-col lg:items-center lg:gap-0">
              <span className="text-muted text-xs font-semibold">{d.label}</span>
              <span className="text-sm font-semibold">
                {d.dayOfMonth}
                {d.isToday ? <span className="sr-only">, today</span> : null}
              </span>
            </p>
            {d.items.length > 0 ? (
              <ul className="mt-2 grid gap-1.5">
                {d.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#appointment-${item.id}`}
                      className={`block rounded-sm border px-2 py-1.5 text-left text-xs leading-snug ${
                        item.inactive
                          ? "border-line text-muted bg-white line-through"
                          : item.deposit
                            ? "border-orange bg-tint-peach"
                            : "border-line bg-white"
                      }`}
                    >
                      <span className="block font-bold">{item.time}</span>
                      <span className="block">{item.name}</span>
                      {item.treatment ? <span className="text-muted block">{item.treatment}</span> : null}
                      {item.deposit && !item.inactive ? (
                        <span className="block font-semibold">{item.deposit}</span>
                      ) : null}
                      {item.inactive ? <span className="sr-only"> (cancelled or moved)</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

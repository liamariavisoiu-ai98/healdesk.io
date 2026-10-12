import { HOURS_IN_A_WEEK, type WeekSchedule } from "@/lib/demo/opening-hours";

/**
 * The closing offer: the clinic's week as it is now against the week with
 * AYA, drawn Monday to Sunday, then what AYA covers and the way in.
 *
 * Each day is a 24-hour column. The clinic's open hours, from its Google
 * listing (or its website, or the stated 9-to-5 assumption, and the legend
 * says which), are drawn in one shade; every other hour is AYA's, in green,
 * so the gain is visible before it is read. The numbers under it come from
 * the same schedule.
 *
 * The four capabilities are the product's three voice coverage modes (all
 * calls, overflow, after hours) and chat, which always answers. "About 15
 * minutes of your time" is the set-up promise, word for word.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const AYA_GREEN = "#87d68d";

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

function fmt(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return m ? `${twelve}:${String(m).padStart(2, "0")}${suffix}` : `${twelve}${suffix}`;
}

export function CoverageOffer({
  slug,
  clinicName,
  agent,
  schedule,
  source,
}: {
  slug: string;
  clinicName: string;
  agent: string;
  schedule: WeekSchedule;
  /** Where the schedule came from; null means the 9-to-5 assumption. */
  source: { kind: "google"; place: string | null } | { kind: "website" } | null;
}) {
  const openMinutes = schedule.days.reduce((sum, spans) => sum + spans.reduce((s, [a, b]) => s + (b - a), 0), 0);
  const openHours = Math.round((openMinutes / 60) * 10) / 10;
  const closed = Math.round((HOURS_IN_A_WEEK - openHours) * 10) / 10;
  const nowShare = Math.round((openHours / HOURS_IN_A_WEEK) * 100);
  const increase = openHours > 0 ? Math.round((closed / openHours) * 100) : 0;
  const legend =
    source?.kind === "google"
      ? `Open now, per ${source.place ?? clinicName}'s Google hours`
      : source?.kind === "website"
        ? "Open now, per your website"
        : "Open now (assumed 9 to 5, Mon–Fri)";

  return (
    <section className="bg-ink mt-14 overflow-hidden rounded-[32px] px-5 py-12 text-center text-white sm:px-12 sm:py-14">
      <p className="text-[13.2px] font-bold tracking-[0.14em] text-white/60 uppercase">Reachable around the clock</p>
      <h2 className="font-display mx-auto mt-3 max-w-[24ch] text-[38px] leading-[1.05] font-medium tracking-[-0.025em] text-balance sm:text-[56px]">
        From {fmt(openHours)} to {HOURS_IN_A_WEEK} hours a week.
      </h2>
      <p className="mx-auto mt-4 max-w-[48ch] text-[18px] leading-[1.5] text-white/75">
        {agent} picks up the {fmt(closed)} hours {clinicName} is closed: evenings, early mornings, weekends and holidays.
      </p>

      {/* The week, Monday to Sunday. */}
      <figure className="mx-auto mt-9 max-w-[820px] rounded-3xl bg-white/[0.05] p-4 sm:p-6">
        <div className="flex gap-2 sm:gap-3">
          {/* Hour scale. */}
          <div className="relative mt-7 hidden h-[260px] w-10 shrink-0 text-right text-[11.5px] text-white/45 sm:block" aria-hidden>
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h} className="absolute right-0 -translate-y-1/2" style={{ top: `${(h / 24) * 100}%` }}>
                {clock(h * 60)}
              </span>
            ))}
          </div>
          {DAYS.map((day, i) => {
            const spans = schedule.days[i] ?? [];
            const open = spans.reduce((s, [a, b]) => s + (b - a), 0) / 60;
            return (
              <div key={day} className="flex min-w-0 flex-1 flex-col items-center">
                <span className="mb-2 h-5 text-[13.2px] font-bold text-white/80">{day}</span>
                <div
                  className="relative h-[260px] w-full overflow-hidden rounded-xl"
                  style={{ background: AYA_GREEN }}
                  role="img"
                  aria-label={
                    spans.length
                      ? `${day}: open ${spans.map(([a, b]) => `${clock(a)} to ${clock(b)}`).join(" and ")}; ${agent} covers the other ${fmt(24 - open)} hours`
                      : `${day}: closed; ${agent} covers all 24 hours`
                  }
                >
                  {spans.map(([a, b]) => (
                    <span
                      key={`${a}-${b}`}
                      className="absolute inset-x-0 grid place-items-center bg-[#3a4b5c] text-[11px] font-semibold text-white/85"
                      style={{ top: `${(a / 1440) * 100}%`, height: `${((b - a) / 1440) * 100}%` }}
                    >
                      <span className="hidden px-1 leading-tight sm:block">
                        {clock(a)}
                        <br />–{clock(b)}
                      </span>
                    </span>
                  ))}
                </div>
                <span className="mt-2 text-[12px] font-bold text-[#87d68d]">+{fmt(24 - open)}h</span>
              </div>
            );
          })}
        </div>
        <figcaption className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13.2px] font-semibold text-white/75">
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm bg-[#3a4b5c] ring-1 ring-white/30" />
            {legend}
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm" style={{ background: AYA_GREEN }} />
            The extra time {agent} answers
          </span>
        </figcaption>
      </figure>

      {/* Now, with AYA, and the difference. */}
      <div className="mx-auto mt-5 grid max-w-[820px] gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-white/[0.06] px-4 py-5">
          <p className="text-[13.2px] font-bold tracking-[0.1em] text-white/60 uppercase">Reachable now</p>
          <p className="font-display mt-1 text-[40px] leading-none font-medium">
            {fmt(openHours)}
            <span className="text-[18px] text-white/60"> hrs/wk</span>
          </p>
          <p className="mt-2 text-[14.4px] text-white/60">{nowShare}% of the week</p>
        </div>
        <div className="rounded-2xl bg-white/[0.12] px-4 py-5 ring-1 ring-white/20">
          <p className="text-[13.2px] font-bold tracking-[0.1em] text-white/60 uppercase">With {agent}</p>
          <p className="font-display mt-1 text-[40px] leading-none font-medium">
            {HOURS_IN_A_WEEK}
            <span className="text-[18px] text-white/60"> hrs/wk</span>
          </p>
          <p className="mt-2 text-[14.4px] text-white/60">100% of the week</p>
        </div>
        <div className="rounded-2xl px-4 py-5 text-[#172a3a]" style={{ background: AYA_GREEN }}>
          <p className="text-[13.2px] font-bold tracking-[0.1em] uppercase opacity-70">More time to book</p>
          <p className="font-display mt-1 text-[40px] leading-none font-medium">+{increase}%</p>
          <p className="mt-2 text-[14.4px] font-semibold opacity-75">+{fmt(closed)} hours a week</p>
        </div>
      </div>

      {/* What AYA covers: the three ways she takes calls, and chat. */}
      <ul className="mx-auto mt-5 grid max-w-[820px] gap-3 text-left sm:grid-cols-2">
        {[
          ["Answers 100% of your calls", "Every call, day and night, if you want her on the whole line."],
          ["Takes calls after hours", "Evenings, weekends and holidays, while your team keeps the day."],
          ["Steps in when your receptionist is busy", "With a patient or on another line, the call still gets answered."],
          ["Chats answered 24/7", "Your website, WhatsApp, Instagram and Messenger, always on."],
        ].map(([title, body]) => (
          <li key={title} className="flex gap-3 rounded-2xl bg-white/[0.06] px-4 py-4">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[#172a3a] [&_svg]:size-3.5" style={{ background: AYA_GREEN }}>
              {CHECK}
            </span>
            <span>
              <span className="block text-[16px] font-bold">{title}</span>
              <span className="block text-[14.4px] text-white/65">{body}</span>
            </span>
          </li>
        ))}
      </ul>

      <a
        href={`/demo/${slug}/onboard`}
        className="mt-10 inline-flex items-center gap-2 rounded-full bg-white px-8 py-4 text-[18px] font-bold text-[#172a3a] shadow-[0_10px_30px_-10px_rgb(0_0_0/0.5)] transition-all duration-200 hover:-translate-y-0.5"
      >
        Book my onboarding
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </a>

      <ul className="mx-auto mt-8 flex max-w-[720px] flex-col items-center justify-center gap-x-7 gap-y-2 text-[15.6px] font-semibold text-white/85 sm:flex-row">
        {["Already built from your website", "Set up in about 15 minutes of your time"].map((line) => (
          <li key={line} className="flex items-center gap-2">
            <span className="grid size-5 place-items-center rounded-full text-[#172a3a] [&_svg]:size-3" style={{ background: AYA_GREEN }}>
              {CHECK}
            </span>
            {line}
          </li>
        ))}
      </ul>
      <p className="mt-6 text-[13.2px] text-white/50">We sign a business associate agreement and handle patient data under it.</p>
    </section>
  );
}

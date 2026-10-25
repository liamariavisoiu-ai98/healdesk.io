/**
 * Opening hours as a clinic's website writes them ("Mon–Fri", "9am–6pm",
 * "Sat: 10:00 AM - 4:00 PM", "Closed"), read into days and spans. Business
 * data only. Shared by the demo page (apps/web lib/demo/opening-hours.ts,
 * the "reachable now" baseline) and the demo call (apps/app
 * lib/voice/demo-facts.ts, the days a week Aya says the practice is open), so
 * both read a site's hours the same way. Each parser gives up (null) on a
 * shape it does not know, rather than guess.
 */

const DAY_INDEX: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

/** The set of weekdays (0 = Monday) a "days" label names, or null when it cannot be read. */
export function parseDays(label: string): Set<number> | null {
  const text = label.toLowerCase().replace(/\./g, "").trim();
  if (/^(daily|every ?day|7 days( a week)?|mon(day)?\s*[-–—to]+\s*sun(day)?)$/.test(text)) return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (/^(weekdays?|monday through friday)$/.test(text)) return new Set([0, 1, 2, 3, 4]);
  if (/^weekends?$/.test(text)) return new Set([5, 6]);

  const days = new Set<number>();
  for (const part of text.split(/\s*(?:,|&|\band\b|\/)\s*/)) {
    if (!part) continue;
    const range = /^([a-z]+)\s*(?:-|–|—|to|through)\s*([a-z]+)$/.exec(part);
    if (range) {
      const from = DAY_INDEX[range[1]!];
      const to = DAY_INDEX[range[2]!];
      if (from === undefined || to === undefined) return null;
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    const single = DAY_INDEX[part];
    if (single === undefined) return null;
    days.add(single);
  }
  return days.size > 0 ? days : null;
}

/** Minutes after midnight for "9", "9am", "9:30 pm", "17:00", "noon"; null otherwise. */
function parseTime(raw: string, fallbackMeridiem?: "am" | "pm"): number | null {
  const text = raw.toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  if (text === "noon") return 12 * 60;
  if (text === "midnight") return 24 * 60;
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const meridiem = (m[3] as "am" | "pm" | undefined) ?? fallbackMeridiem;
  if (hour > 24 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** A day's open spans as [start, end] minutes after midnight, for "9am–1pm, 2pm–6pm" or "Closed"; null when it cannot be read. */
export function parseSpans(label: string): [number, number][] | null {
  const text = label.toLowerCase().trim();
  if (/^(closed|by appointment( only)?|appointment only)$/.test(text)) return [];
  if (/^(open )?24 ?(hours|hrs|h)$/.test(text)) return [[0, 24 * 60]];
  const spans: [number, number][] = [];
  // "9am–1pm, 2pm–6pm" splits into its spans.
  for (const span of text.split(/\s*(?:,|;|&|\band\b)\s*/)) {
    const m = /^(.+?)\s*(?:-|–|—|to)\s*(.+)$/.exec(span);
    if (!m) return null;
    const [startText, endText] = [m[1]!, m[2]!];
    const endMeridiem = /pm/.test(endText) ? "pm" : /am/.test(endText) ? "am" : undefined;
    // A start with no am/pm takes the end's, except "9-5pm", where a start
    // hour larger than the end hour can only be the morning.
    let startMeridiem: "am" | "pm" | undefined = endMeridiem;
    if (!/am|pm/.test(startText) && endMeridiem === "pm") {
      const startHour = Number(startText.split(":")[0]);
      const endHour = Number(endText.replace(/[^\d:]/g, "").split(":")[0]);
      if (startHour > endHour || startHour === 12) startMeridiem = startHour === 12 ? "pm" : "am";
    }
    const start = parseTime(startText, startMeridiem);
    let end = parseTime(endText);
    if (start === null || end === null) return null;
    // "10-4": no meridiem anywhere, the end is afternoon.
    if (!/am|pm/.test(span) && end <= start) end += 12 * 60;
    // A span past midnight is drawn to midnight; the next day's own row covers the rest.
    if (end <= start) end = 24 * 60;
    if (end - start <= 0 || end - start > 24 * 60) return null;
    spans.push([start, Math.min(end, 24 * 60)]);
  }
  const total = spans.reduce((sum, [a, b2]) => sum + (b2 - a), 0);
  return total > 24 * 60 ? null : spans;
}

/** Hours open in one day for a label like "9am–6pm" or "Closed"; null when it cannot be read. */
export function parseSpan(label: string): number | null {
  const spans = parseSpans(label);
  return spans === null ? null : spans.reduce((sum, [a, b]) => sum + (b - a), 0) / 60;
}

/**
 * How many days a week the listed hours open, or null when there are none or
 * any row cannot be read: a guessed count would be said aloud as a fact
 * ("I see you're open 5 days a week"). A day listed in two rows counts once,
 * from the later row, as a site's own correction would.
 */
export function openDaysPerWeek(rows: readonly { days: string; hours: string }[]): number | null {
  if (rows.length === 0) return null;
  const open = new Map<number, boolean>();
  for (const row of rows) {
    const days = parseDays(row.days);
    const spans = parseSpans(row.hours);
    if (!days || spans === null) return null;
    for (const day of days) open.set(day, spans.length > 0);
  }
  const count = [...open.values()].filter(Boolean).length;
  return count > 0 ? count : null;
}

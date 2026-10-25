import { BATCH_CLASS_WORDS, REACH_WORDS, SCOPE_CHANNEL_WORDS, VENDOR_WORDS } from "@/components/admin/incident-words";
import type { BatchClass, IncidentScopeQuery, ScopeChannel, ScopeReach, ScopeVendor } from "@/lib/admin/ops-client";

/**
 * The Incident assistant's scope form as a query apps/app reads
 * (lib/incidents/assistant/scope.ts readScopeArgs), built in the browser and
 * checked again by the page's server action with the same function, so a
 * browser that sends anything off a list is refused in a sentence before
 * the signed request. The lists are the words tables' keys, which
 * incident-words.test.ts holds to apps/app's own lists.
 *
 * Days are UTC days: the window runs from the first day's start to the end
 * of the last, held to now (apps/app refuses a window that ends in the
 * future) and to apps/app's 400 days. The class and the discovery time go
 * together or not at all: given, apps/app adds both clocks to each clinic,
 * and proposing a batch needs them. The database host and AWS hold every
 * clinic's data, so their reach may be every clinic holding data; every
 * other scope is read by its window alone. Pure.
 */

export type ScopeForm = {
  source: "vendor" | "channel";
  vendor: string;
  channel: string;
  /** YYYY-MM-DD, the first and last UTC days of the window. */
  fromDay: string;
  toDay: string;
  /** A class from the list, or "" for none. */
  incidentClass: string;
  /** An ISO instant, or "" for none. */
  discoveredAt: string;
  includeDemo: boolean;
  reach: string;
};

export const MAX_SCOPE_WINDOW_DAYS = 400;
export const HOLDING_VENDORS: readonly ScopeVendor[] = ["database_host", "aws"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function realDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export type ScopeCheck = { ok: true; query: IncidentScopeQuery } | { ok: false; problem: string };

/** Whether a vendor's scope may reach every clinic holding data (vocab.ts HOLDING_VENDORS). */
export function holdsAll(form: Pick<ScopeForm, "source" | "vendor">): boolean {
  return form.source === "vendor" && (HOLDING_VENDORS as readonly string[]).includes(form.vendor);
}

/** The form as a query, or the one sentence saying what is missing. */
export function scopeQueryFrom(form: ScopeForm, nowIso: string): ScopeCheck {
  if (form.source === "vendor" && !Object.hasOwn(VENDOR_WORDS, form.vendor)) return { ok: false, problem: "Pick the vendor from the list." };
  if (form.source === "channel" && !Object.hasOwn(SCOPE_CHANNEL_WORDS, form.channel)) return { ok: false, problem: "Pick the channel from the list." };
  if (!realDay(form.fromDay) || !realDay(form.toDay)) return { ok: false, problem: "Give the window as two days, the first and the last." };
  if (form.fromDay > form.toDay) return { ok: false, problem: "The window's first day must not be after its last." };
  const now = Date.parse(nowIso);
  const from = Date.parse(`${form.fromDay}T00:00:00.000Z`);
  if (from > now) return { ok: false, problem: "The window cannot start in the future." };
  const to = Math.min(Date.parse(`${form.toDay}T00:00:00.000Z`) + DAY_MS, now);
  if (to - from > MAX_SCOPE_WINDOW_DAYS * DAY_MS) return { ok: false, problem: `The window is at most ${MAX_SCOPE_WINDOW_DAYS} days.` };
  const hasClass = form.incidentClass !== "";
  const discoveredAt = instant(form.discoveredAt);
  if (hasClass !== (discoveredAt !== null)) return { ok: false, problem: "Give the class and the discovery time together, or neither." };
  if (hasClass && !Object.hasOwn(BATCH_CLASS_WORDS, form.incidentClass)) return { ok: false, problem: "Pick the class from the list." };
  if (discoveredAt !== null) {
    const at = Date.parse(discoveredAt);
    if (at > now + 60_000) return { ok: false, problem: "When was it discovered? A past time." };
    if (at < from) return { ok: false, problem: "It cannot have been discovered before the window began." };
  }
  if (!Object.hasOwn(REACH_WORDS, form.reach)) return { ok: false, problem: "Pick the reach from the list." };
  const all = holdsAll(form);
  if (form.reach === "all_holding" && !all) return { ok: false, problem: "Only the database host and AWS hold every clinic's data; this scope is read by its window." };
  const base = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...(hasClass ? { class: form.incidentClass as BatchClass } : {}),
    ...(discoveredAt ? { discoveredAt } : {}),
    ...(form.includeDemo ? { includeDemo: true } : {}),
    // The reach is sent only where apps/app reads one; its default for the two holding vendors is every clinic holding data.
    ...(all ? { reach: form.reach as ScopeReach } : {}),
  };
  const query: IncidentScopeQuery = form.source === "vendor" ? { vendor: form.vendor as ScopeVendor, ...base } : { channel: form.channel as ScopeChannel, ...base };
  return { ok: true, query };
}

/** A query a browser sent, read back as a form and checked the same way: the one path to apps/app. */
export function checkScopeQuery(raw: unknown, nowIso: string): ScopeCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "The scope could not be read." };
  const q = raw as Record<string, unknown>;
  const allowed = new Set(["vendor", "channel", "from", "to", "class", "discoveredAt", "includeDemo", "reach"]);
  if (Object.keys(q).some((key) => !allowed.has(key))) return { ok: false, problem: "The scope could not be read." };
  const from = instant(q.from);
  const to = instant(q.to);
  if (!from || !to) return { ok: false, problem: "Give the window as two times, from and to." };
  if (q.includeDemo !== undefined && typeof q.includeDemo !== "boolean") return { ok: false, problem: "The scope could not be read." };
  const form: ScopeForm = {
    source: q.vendor !== undefined ? "vendor" : "channel",
    vendor: typeof q.vendor === "string" ? q.vendor : "",
    channel: typeof q.channel === "string" ? q.channel : "",
    fromDay: from.slice(0, 10),
    toDay: new Date(Date.parse(to) - 1).toISOString().slice(0, 10),
    incidentClass: typeof q.class === "string" ? q.class : "",
    discoveredAt: typeof q.discoveredAt === "string" ? q.discoveredAt : "",
    includeDemo: q.includeDemo === true,
    reach: typeof q.reach === "string" ? q.reach : holdsAll({ source: q.vendor !== undefined ? "vendor" : "channel", vendor: typeof q.vendor === "string" ? q.vendor : "" }) ? "all_holding" : "window_only",
  };
  if (q.vendor !== undefined && q.channel !== undefined) return { ok: false, problem: "Name a vendor or a channel, one of the two." };
  const checked = scopeQueryFrom(form, nowIso);
  if (!checked.ok) return checked;
  // The instants as sent, not rounded to days: the proposal must read the same window the owner saw.
  return { ok: true, query: { ...checked.query, from, to: to <= checked.query.to ? to : checked.query.to } };
}

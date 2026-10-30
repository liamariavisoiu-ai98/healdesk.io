import { randomUUID } from "node:crypto";

import { deleteRows } from "@/lib/leads";
import { isMarketingStoreConfigured, sheetsClient, type SheetsClient } from "@/lib/sheets/client";
import { dataRange, DEMO_EVENTS, type DemoEvent, ensureSheetSchema, recordToRow, rowToRecord } from "@/lib/sheets/schema";

import type { CloseVariant } from "./close";
import type { DemoSession } from "./sessions";

/**
 * The personalised demo's own measurement, first party and server side.
 *
 * /demo/ runs no third-party script, consent or not (lib/analytics.ts
 * `isAnalyticsExcludedPath`): the slug in its URL is the only key to the
 * demo. And /api/track records only a visitor the homepage gate identified,
 * which the owner of a demo an operator built never is. So the demo page
 * sends its few events to /api/demo/[slug]/event, which appends them here,
 * to the marketing Sheet's `demo_events` tab, keyed by the slug the
 * demo_sessions tab already holds. The Stripe webhook adds `checkout_paid`
 * when it claims the demo.
 *
 * A closed vocabulary, like lib/analytics.ts: each name, and the one short
 * detail it may carry, from a fixed list. Never a message, a figure the
 * owner typed, a phone number or anything about a visitor.
 */

export const DEMO_EVENT_DETAILS = {
  demo_viewed: [],
  demo_ended: ["voice", "chat"],
  close_card_shown: ["voice", "chat"],
  close_card_cta: ["voice", "chat"],
  coverage_mode_changed: ["after-hours", "overflow", "all"],
  value_inputs_used: [],
  offer_seen: ["top-bar", "close-card", "closing"],
  // "checkout": Pay in the owner's demo page's checkout card (lib/demo/v2/render.ts).
  cta_clicked: ["top-bar", "header", "close-card", "coverage", "value", "closing", "mobile-bar", "checkout"],
  checkout_paid: [],
  // The owner's demo page lists Metachat as coming soon, with a free list to join (lib/demo/v2/render.ts).
  metachat_vip: ["joined", "left"],
} as const satisfies Record<string, readonly string[]>;

export type DemoEventName = keyof typeof DEMO_EVENT_DETAILS;

export function isDemoEventName(value: unknown): value is DemoEventName {
  return typeof value === "string" && Object.hasOwn(DEMO_EVENT_DETAILS, value);
}

/** The detail if the event allows it, else null: anything off the list is dropped, never stored. */
export function demoEventDetail(name: DemoEventName, detail: unknown): string | null {
  const allowed = DEMO_EVENT_DETAILS[name] as readonly string[];
  return typeof detail === "string" && allowed.includes(detail) ? detail : null;
}

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

/** Append one event. Never throws: instrumentation must not break a page or a webhook. */
export async function recordDemoEvent(input: {
  slug: string;
  variant: CloseVariant;
  name: DemoEventName;
  detail?: string | null;
  at?: Date;
}): Promise<void> {
  if (!isMarketingStoreConfigured()) return;
  const event: DemoEvent = {
    id: randomUUID(),
    slug: input.slug,
    variant: input.variant,
    name: input.name,
    detail: input.detail ? demoEventDetail(input.name, input.detail) : null,
    at: input.at ?? new Date(),
  };
  try {
    await (await store()).appendRows(DEMO_EVENTS.title, [recordToRow(DEMO_EVENTS, event)]);
  } catch (error) {
    console.error("[healdesk] demo event dropped", { name: input.name, error: (error as Error).message });
  }
}

type Located = { row: number; value: DemoEvent };

async function readLocated(client: SheetsClient): Promise<Located[]> {
  const rows = await client.getValues(dataRange(DEMO_EVENTS));
  const out: Located[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => c === "" || c === undefined)) return;
    const value = rowToRecord(DEMO_EVENTS, cells) as DemoEvent;
    if (value.slug) out.push({ row: i + 2, value });
  });
  return out;
}

export async function listDemoEvents(): Promise<DemoEvent[]> {
  if (!isMarketingStoreConfigured()) return [];
  return (await readLocated(await store())).map((r) => r.value);
}

/** The events of demos that have been deleted go with them (lib/demo/sessions.ts `purgeExpiredDemoSessions`). */
export async function purgeDemoEvents(slugs: ReadonlySet<string>): Promise<number> {
  if (slugs.size === 0 || !isMarketingStoreConfigured()) return 0;
  const client = await store();
  const doomed = (await readLocated(client)).filter((r) => slugs.has(r.value.slug)).map((r) => r.row);
  await deleteRows(client, DEMO_EVENTS, doomed);
  return doomed.length;
}

export type CloseFunnelRow = {
  variant: CloseVariant;
  /** Ready demos shown this close that someone opened. */
  viewed: number;
  /** Of those, demos where "Activate my AYA" was pressed at least once. */
  clicked: number;
  /** Of those viewed, demos that were bought. */
  paid: number;
  /** Where the first press on each demo came from. */
  firstClickFrom: Record<string, number>;
};

/**
 * Demo → press → paid, per close, counted by demo rather than by event: one
 * owner pressing five times is one demo that was pressed. Paid is the demo
 * row's own `claimed`, which the Stripe webhook sets on the paid purchase.
 */
export function closeFunnel(
  sessions: readonly Pick<DemoSession, "slug" | "claimed">[],
  events: readonly Pick<DemoEvent, "slug" | "variant" | "name" | "detail" | "at">[],
): CloseFunnelRow[] {
  const claimed = new Map(sessions.map((s) => [s.slug, s.claimed]));
  const rows = new Map<CloseVariant, CloseFunnelRow>();
  for (const variant of ["close", "control"] as const) {
    rows.set(variant, { variant, viewed: 0, clicked: 0, paid: 0, firstClickFrom: {} });
  }
  const bySlug = new Map<string, Pick<DemoEvent, "variant" | "name" | "detail" | "at">[]>();
  for (const e of events) {
    if (!claimed.has(e.slug)) continue;
    bySlug.set(e.slug, [...(bySlug.get(e.slug) ?? []), e]);
  }
  for (const [slug, list] of bySlug) {
    const viewedEvent = list.find((e) => e.name === "demo_viewed");
    const row = viewedEvent ? rows.get(viewedEvent.variant as CloseVariant) : undefined;
    if (!row) continue;
    row.viewed += 1;
    const clicks = list.filter((e) => e.name === "cta_clicked").sort((a, b) => a.at.getTime() - b.at.getTime());
    if (clicks.length > 0) {
      row.clicked += 1;
      const from = clicks[0]!.detail ?? "unknown";
      row.firstClickFrom[from] = (row.firstClickFrom[from] ?? 0) + 1;
    }
    if (claimed.get(slug)) row.paid += 1;
  }
  return [...rows.values()];
}

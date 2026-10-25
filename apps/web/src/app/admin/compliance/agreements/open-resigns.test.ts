import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OpenResignRow, OpsResult } from "@/lib/admin/ops-client";

import { CHASE_RULE, chaseWords, EMPTY_RESIGNS, OpenResigns, unreadWords } from "./OpenResigns";

/**
 * Compliance › Agreements › Open BAA re-signs (lane P6j): every open re-sign
 * with its facts in words, the floor and the pause as tags, whether the
 * approvals job may chase it now or why not, and no button: apps/app has no
 * operation that proposes a chase by hand, so the section says what does.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NOW = "2026-11-03T12:00:00.000Z";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const version: OpenResignRow = {
  resignId: "aa0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  reason: "baa_version",
  fromVersion: "1.5.0",
  toVersion: "1.5.1",
  startedAt: "2026-10-20T09:00:00.000Z",
  lastL22SentAt: "2026-10-27T09:00:00.000Z",
  daysOpen: 14,
  linkExpiresAt: "2026-11-10T09:00:00.000Z",
  belowFloor: true,
  fromVersionAcceptable: false,
  holdsPause: false,
  lastChaseAt: null,
  chaseBlocked: null,
};

const dpa: OpenResignRow = {
  ...version,
  resignId: "bb0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
  clinic: { id: CLINIC, name: null },
  reason: "not_sure",
  fromVersion: "dpa/1.0.0",
  daysOpen: 1,
  lastL22SentAt: null,
  linkExpiresAt: "2026-10-21T09:00:00.000Z",
  belowFloor: false,
  holdsPause: true,
  lastChaseAt: "2026-11-01T09:00:00.000Z",
  chaseBlocked: "not_baa_version",
};

const render = (resigns: OpsResult<{ resigns: OpenResignRow[]; unread: number }>) => renderToStaticMarkup(h(OpenResigns, { resigns, now: NOW }));

describe("the section", () => {
  test("its anchor and title, the rule in one sentence, and each row's facts in words with its tags", () => {
    const html = render({ ok: true, data: { resigns: [version, dpa], unread: 0 } });
    const page = text(html);
    expect(html).toContain('id="open-resigns"');
    expect(page).toContain("Open BAA re-signs");
    expect(page).toContain(CHASE_RULE);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain(
      "Radiance Med Spa Below the floor: phone the practice a newer version of the business associate agreement 1.5.0 → 1.5.1 14 days, since 20 Oct 2026 27 Oct 2026 10 Nov 2026, 09:00 UTC none yet nothing in the re-sign blocks one; the approvals job proposes it at its next run while it is on, unless this round's chase is already waiting or was rejected",
    );
    expect(page).toContain(
      "A clinic with no printable name Holds AYA paused answered Not sure whether HIPAA covers it: its DPA no longer covers it dpa/1.0.0 → 1.5.1 1 day, since 20 Oct 2026 none recorded 21 Oct 2026, 09:00 UTC (expired) 1 Nov 2026 not now: this is not a BAA version re-sign: it pauses AYA, and its own emails say so",
    );
    // The rule once, above the table, not per row.
    expect(page.match(/Chases are the approvals job's/g)).toHaveLength(1);
    expect(page).toContain("for a BAA version re-sign");
    // No button of any kind: apps/app has none to call.
    expect(html).not.toContain("<button");
    expect(page).not.toContain("Propose a chase");
    for (const raw of ["baa_version", "not_sure", "not_baa_version", version.resignId]) expect(page).not.toContain(raw);
  });

  test("empty, unread and failed each say so, never a zero", () => {
    expect(text(render({ ok: true, data: { resigns: [], unread: 0 } }))).toContain(EMPTY_RESIGNS);
    const unread = text(render({ ok: true, data: { resigns: [version], unread: 2 } }));
    expect(unread).toContain(unreadWords(2));
    expect(unread).toContain("Radiance Med Spa");
    const failed = text(render({ ok: false, code: "failed", message: "The open re-signs could not be read." }));
    expect(failed).toContain("Could not read the open re-signs: The open re-signs could not be read.");
    expect(failed).not.toContain(EMPTY_RESIGNS);
  });

  test("whether a chase may go now, in words from the closed list; nothing blocking is not a promise that one is proposed", () => {
    expect(chaseWords({ chaseBlocked: null })).toBe(
      "nothing in the re-sign blocks one; the approvals job proposes it at its next run while it is on, unless this round's chase is already waiting or was rejected",
    );
    expect(chaseWords({ chaseBlocked: "chased_recently" })).toBe("not now: the practice was chased less than 7 days ago");
    expect(chaseWords({ chaseBlocked: "too_early" })).toContain("a chase can go from day 8");
  });

  test("the rule's numbers are apps/app's (open-resigns.ts CHASE_FROM_DAY, CHASE_EVERY_DAYS; resign.ts RESIGN_REMINDER_DAYS), and no chase operation exists to call", () => {
    const APP = join(__dirname, "..", "..", "..", "..", "..", "..", "app", "src");
    const openResigns = readFileSync(join(APP, "lib", "agreements", "open-resigns.ts"), "utf8");
    expect(openResigns).toContain("export const CHASE_EVERY_DAYS = 7;");
    expect(openResigns).toContain("export const CHASE_FROM_DAY = 8;");
    expect(readFileSync(join(APP, "lib", "agreements", "resign.ts"), "utf8")).toContain("export const RESIGN_REMINDER_DAYS = [3, 7] as const;");
    expect(readFileSync(join(APP, "lib", "ops", "api.ts"), "utf8")).not.toMatch(/propose\w*Chase/i);
  });
});

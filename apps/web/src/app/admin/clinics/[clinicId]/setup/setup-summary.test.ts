import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import type { ClinicCards, OpsResult } from "@/lib/admin/ops-client";

import { SetupSummary } from "./SetupSummary";

/**
 * What the old clinic card said once and the Setup tab now says once: the
 * agreement the clinic is under, its channels' states in the portal's words,
 * and the build tracker with what is left; a cards read that failed costs
 * only this line; and the panel's tabs carry the account link the card had.
 * The fixtures are the ones the clinic-card tests used until 23 October 2026.
 */

const router = vi.hoisted(() => ({ segment: "setup" as string | null }));
vi.mock("next/navigation", () => ({ useSelectedLayoutSegment: () => router.segment }));

const { ClinicTabs } = await import("../ClinicTabs");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|\u2019/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const cards: OpsResult<ClinicCards> = {
  ok: true,
  data: {
    limit: 50,
    cards: [
      {
        id: CLINIC,
        agreementKind: "dpa",
        agreementLabel: "Data protection agreement",
        channels: [
          { channel: "web", status: "live" },
          { channel: "voice", status: "waiting" },
        ],
        tracker: [
          { id: "agreement", label: "Agreement signed", state: "done" },
          { id: "built", label: "Assistant built", state: "not_done" },
        ],
        trackerLeft: ["Assistant built"],
      },
    ],
  },
};

describe("the Setup tab's summary line", () => {
  test("carries the agreement, the channels and the build, once", () => {
    const page = text(h(SetupSummary, { cards, clinicId: CLINIC }));
    expect(page).toContain("Data protection agreement");
    expect(page).toContain("Website chat: live · Phone: waiting on the clinic");
    expect(page).toContain("✓ Agreement signed");
    expect(page).toContain("Still to do: Assistant built.");
    expect(page.match(/Agreement signed/g)).toHaveLength(1);
  });

  test("a cards read that could not reach apps/app says so, and nothing else is lost", () => {
    const page = text(h(SetupSummary, { cards: { ok: false, code: "timeout", message: "late" }, clinicId: CLINIC }));
    expect(page).toContain("Could not read the clinic's agreement, channels and build: late");
    expect(page).not.toContain("Still to do");
    const beyond = text(h(SetupSummary, { cards: { ok: true, data: { limit: 50, cards: [] } }, clinicId: CLINIC }));
    expect(beyond).toContain("were not read for this clinic");
  });

  test("the panel's tabs link to the account page, as the card did", () => {
    const html = renderToStaticMarkup(h(ClinicTabs, { clinicId: CLINIC }));
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/account"`);
    expect(html).toMatch(/aria-current="page"[^>]*>Setup</);
  });
});

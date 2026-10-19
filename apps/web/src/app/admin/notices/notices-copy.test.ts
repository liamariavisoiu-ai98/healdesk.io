import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { OperatorNoticesView, OpsResult } from "@/lib/admin/ops-client";

import { NoticesBoard, resignsOffLine, resignsSaid } from "./NoticesBoard";

/**
 * What /admin/notices tells the operator (WP7). The owner's decisions of
 * 12 October 2026 are held on the page as in the emails: the subcontractor
 * notice links to no vendor list (the list is given on written request), the
 * terms notice goes 30 days ahead and can't be unsubscribed from, product
 * updates can be, and every form offers only the catalog's choices.
 * Rendered to static markup and read as text.
 */

function render(record: OpsResult<OperatorNoticesView>): { html: string; text: string } {
  const NEVER = async (): Promise<never> => {
    throw new Error("an action ran during a static render");
  };
  const html = renderToStaticMarkup(
    h(NoticesBoard, {
      record,
      clinics: [{ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", name: "Radiance Med Spa" }],
      today: "2026-10-14",
      actions: {
        sendTermsNotice: NEVER,
        sendSubprocessorNotice: NEVER,
        sendProductUpdate: NEVER,
        startBaaVersionResigns: NEVER,
        recordGuaranteeClaim: NEVER,
        sendGuaranteeFinding: NEVER,
        suspendForCause: NEVER,
      },
    }),
  );
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|\u2019/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { html, text };
}

const WAITING =
  "Waits for the calendar fix: a re-sign signed now would leave the practice's location without calendar terms, and its Google Calendar would disconnect.";

const EMPTY: OpsResult<OperatorNoticesView> = {
  ok: true,
  data: {
    broadcasts: [],
    notices: [],
    openClaims: [],
    baaVersionResigns: { ready: false, waiting: WAITING },
  },
};

describe("the notices page", () => {
  test("the subcontractor notice links to no vendor list: the list is on written request", () => {
    const { html, text } = render(EMPTY);
    expect(text).toContain("offers our list on written request. It links to no vendor list.");
    expect(html).not.toMatch(/href="[^"]*subprocessors/);
  });

  test("the terms notice is 30 days ahead and can't be unsubscribed from; product updates can be", () => {
    const { text } = render(EMPTY);
    expect(text).toContain("at least 30 days before the change applies (Terms §4 and §16)");
    expect(text).toContain("It can't be unsubscribed from.");
    expect(text).toContain("Each practice can stop these with one click");
  });

  test("states no reporting promise, and sends incident reports from Incidents", () => {
    const { text } = render(EMPTY);
    expect(text).not.toMatch(/report\w* within 24 hours|five days/i);
    expect(text).toContain("Incident reports are sent from Incidents");
  });

  test("lists what went, with a dead letter marked, and the claims still owed a finding", () => {
    const { text } = render({
      ok: true,
      data: {
        broadcasts: [
          {
            kind: "terms_notice",
            subject: "2026-11-30.1",
            firstQueuedAt: "2026-10-14 15:00 UTC",
            counts: { sent: 3, switched_off: 0, not_sent: 0, dead: 1, pending: 0 },
          },
        ],
        notices: [
          {
            clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            clinicSlug: "radiance",
            clinicName: "Radiance Med Spa",
            kind: "suspended_for_cause",
            subject: "2026-10-14T15:00:00.000Z",
            queuedAt: "2026-10-14 15:00 UTC",
            state: "sent",
          },
        ],
        openClaims: [
          {
            clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            clinicSlug: "radiance",
            clinicName: "Radiance Med Spa",
            claimReceivedOn: "2026-10-01",
            findingByOn: "2026-10-13",
          },
        ],
        baaVersionResigns: { ready: false, waiting: WAITING },
      },
    });
    expect(text).toContain(
      "Terms notice (L28) · 2026-11-30.1 · first queued 2026-10-14 15:00 UTC · 3 sent, 1 undelivered",
    );
    expect(text).toContain("Suspended for a legal or security reason (L31)");
    expect(text).toContain(
      "Radiance Med Spa: claim of 2026-10-01, finding due by 2026-10-13 — OVERDUE",
    );
  });

  test("the updated agreement (L22) starts every older BAA on the current version, and AYA keeps answering", () => {
    const { text } = render(EMPTY);
    expect(text).toContain("Updated agreement to sign (L22)");
    expect(text).toContain(
      "AYA keeps answering while it signs, whatever its version: the agreement it signed governs until the newer one is.",
    );
    expect(text).toContain("Start the re-signs");
  });

  test("the broadcast's answer is said in counts, a refusal in apps/app's words", () => {
    const base = {
      status: "started" as const,
      version: "1.6.0",
      opened: 3,
      emailed: 2,
      alreadyOpen: 1,
      failed: 0,
      auditRecorded: true,
    };
    expect(resignsSaid({ ok: true, data: base })).toEqual({
      ok: true,
      text: "Started 3 practices on v1.6.0; 1 not emailed yet (the hourly job sends it); 1 already had a re-sign open.",
    });
    expect(
      resignsSaid({
        ok: true,
        data: { ...base, opened: 0, emailed: 0, alreadyOpen: 0, auditRecorded: false },
      }).text,
    ).toBe(
      "No practice on an older version was left to start on v1.6.0. It is NOT in the audit log: record it by hand.",
    );
    expect(
      resignsSaid({
        ok: true,
        data: { status: "refused", message: "Version 1.6.0 isn't released for signing in the database yet." },
      }),
    ).toEqual({ ok: false, text: "Version 1.6.0 isn't released for signing in the database yet." });
    // apps/app before its deploy has no such operation: the operator is told, nothing breaks.
    expect(
      resignsSaid({ ok: false, code: "refused", message: "The ops API refused the request." }),
    ).toEqual({ ok: false, text: "The ops API refused the request." });
  });

  test("Start the re-signs is disabled, with its reason, until the calendar fix switches it on, and from an older apps/app", () => {
    const button = (html: string) => html.match(/<button[^>]*>Start the re-signs<\/button>/)?.[0] ?? "";
    const off = render(EMPTY);
    expect(button(off.html)).toContain('disabled=""');
    expect(off.text).toContain(WAITING);

    // An older apps/app's reply has no switch: disabled too, saying why.
    const older = render({ ok: true, data: { ...EMPTY.data, baaVersionResigns: null } as never });
    expect(button(older.html)).toContain('disabled=""');
    expect(older.text).toContain("Not available until apps/app is deployed with it.");

    // Once the calendar fix has switched it on.
    const on = render({
      ok: true,
      data: { ...(EMPTY as { data: OperatorNoticesView }).data, baaVersionResigns: { ready: true, waiting: null } },
    });
    expect(button(on.html)).not.toContain('disabled=""');
    expect(on.text).not.toContain(WAITING);
    expect(resignsOffLine({ ready: true, waiting: null })).toBeNull();
  });
});

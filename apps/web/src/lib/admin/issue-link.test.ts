import { describe, expect, test } from "vitest";

import { cardAnchorFor, clinicTabPath, ISSUE_TABS, issueAnchorId, issueLink, issueTabFor, parseIssueHash } from "./issue-link";
import { OPS_EVENTS } from "./ops-events";

/**
 * One URL shape for every issue: `/admin/clinics/<id>/<tab>#<event>-<id>`,
 * ids only, refused rather than encoded when a part is not an id, an event
 * or a tab. Every event has a tab, so no alert can arrive with nowhere to go.
 */

const CLINIC = "3FA85F64-5717-4562-B3FC-2C963F66AFA6";
const ALERT = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

describe("the issue link", () => {
  test("is the clinic's tab with the event and id as the anchor, lower-cased", () => {
    expect(issueLink(CLINIC, "transcript_undelivered", ALERT)).toBe(
      `/admin/clinics/${CLINIC.toLowerCase()}/deliveries#transcript_undelivered-${ALERT}`,
    );
    expect(issueLink(CLINIC, "calendar_broken", ALERT)).toBe(
      `/admin/clinics/${CLINIC.toLowerCase()}/setup#calendar_broken-${ALERT}`,
    );
    expect(issueLink(CLINIC, "usage_near_cap", ALERT, "care")).toContain("/care#usage_near_cap-");
  });

  test("refuses anything that is not an id, an event or a tab", () => {
    expect(() => clinicTabPath("radiance", "setup")).toThrow();
    expect(() => clinicTabPath(CLINIC, "transcripts" as never)).toThrow();
    expect(() => issueAnchorId("Transcript undelivered" as never, ALERT)).toThrow();
    expect(() => issueAnchorId("transcript_undelivered", "alert-1")).toThrow();
    expect(() => issueLink(`${CLINIC}/../`, "transcript_undelivered", ALERT)).toThrow();
  });

  test("reads its own anchor back, and nothing else", () => {
    const link = issueLink(CLINIC, "voice_agent_drift", ALERT);
    expect(parseIssueHash(link.slice(link.indexOf("#")))).toEqual({ event: "voice_agent_drift", id: ALERT });
    expect(parseIssueHash(`voice_agent_drift-${ALERT}`)).toEqual({ event: "voice_agent_drift", id: ALERT });
    expect(parseIssueHash("#jobs")).toBeNull();
    expect(parseIssueHash(`#made_up_event-${ALERT}`)).toBeNull();
    expect(parseIssueHash(`#voice_agent_drift-${ALERT}<script>`)).toBeNull();
  });

  test("the events with a card of their own name it, on the tab that draws that card; the rest land on the panel", () => {
    // Every lifecycle event in the mirrored list, and the availability change.
    const lifecycle = OPS_EVENTS.filter((e) => e.startsWith("lifecycle_"));
    expect(lifecycle).toHaveLength(9);
    const tabOfCard = { availability: "setup", "setup-window": "setup", reminders: "deliveries" } as const;
    for (const event of [...lifecycle, "clinic_availability_changed" as const]) {
      const card = cardAnchorFor(event);
      expect(card, event).not.toBeNull();
      expect(issueTabFor(event), event).toBe(tabOfCard[card!]);
    }
    expect(cardAnchorFor("clinic_availability_changed")).toBe("availability");
    expect(cardAnchorFor("lifecycle_reminder_undelivered")).toBe("reminders");
    expect(cardAnchorFor("lifecycle_reminders_unanswered")).toBe("setup-window");
    for (const event of ["lifecycle_no_progress", "lifecycle_closing_soon", "lifecycle_decision_due", "lifecycle_waiting_on_us", "lifecycle_waiting_on_us_long", "lifecycle_channel_waiting", "lifecycle_closing_waiting_on_us"] as const) {
      expect(cardAnchorFor(event)).toBe("setup-window");
    }
    for (const event of OPS_EVENTS) {
      if (!event.startsWith("lifecycle_") && event !== "clinic_availability_changed") expect(cardAnchorFor(event), event).toBeNull();
    }
  });

  test("every event has a tab from the closed list", () => {
    for (const event of OPS_EVENTS) expect(ISSUE_TABS).toContain(issueTabFor(event));
    // The alerts apps/app sent to the onboarding page land on Setup.
    for (const event of ["calendar_broken", "go_live_held", "web_widget_to_confirm", "voice_agent_drift", "practice_question_failed", "connection_broken"] as const) {
      expect(issueTabFor(event)).toBe("setup");
    }
    expect(issueTabFor("transcript_undelivered")).toBe("deliveries");
    expect(issueTabFor("usage_near_cap")).toBe("billing");
    expect(issueTabFor("incident_notice_overdue")).toBe("care");
    expect(issueTabFor("address_change_stalled")).toBe("account");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runOperation, type CareView, type OpenIncidentOutcome, type Operator } from "@/lib/ops/api";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * The care operations behind /admin/ops/[clinicId]/care: recipients,
 * incidents and offboarding as the console drives them. The one property
 * worth a test of its own is the PHI scan on operator-typed prose — the
 * console lives in the app that must never hold a patient, and an incident
 * summary is the field most likely to be typed with one in it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "127.0.0.1" } };

function data<T>(outcome: Awaited<ReturnType<typeof runOperation>>): T {
  if (outcome.status !== 200) throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { data: T }).data;
}

describeDb("care operations", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("recipients are added and removed from the console, and shown in the view", async () => {
    const c = await seedClinic("care-recip");
    const added = data<{ status: string }>(
      await runOperation("addReportRecipient", { clinicId: c.clinicId, email: "Desk@Example-Clinic.test", label: "Front desk" }, OPERATOR),
    );
    expect(added.status).toBe("updated");
    const bad = data<{ status: string; message?: string }>(
      await runOperation("addReportRecipient", { clinicId: c.clinicId, email: "not-an-address" }, OPERATOR),
    );
    expect(bad.status).toBe("error");

    let view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.recipients.map((r) => r.email)).toEqual(["desk@example-clinic.test"]);
    expect(view.recipients[0]!.addedBy).toBe("ops@healdesk.test");
    expect(view.clinic.offboardingStartedAt).toBeNull();

    const removed = data<{ status: string }>(
      await runOperation("removeReportRecipient", { clinicId: c.clinicId, email: "desk@example-clinic.test" }, OPERATOR),
    );
    expect(removed.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.recipients).toEqual([]);
  });

  test("an incident summary that carries a phone number or an email is refused with the reason", async () => {
    const c = await seedClinic("care-phi");
    const withPhone = data<OpenIncidentOutcome>(
      await runOperation(
        "openIncident",
        { clinicId: c.clinicId, class: "breach", summary: "Sent the recording for +1 555 010 0123 to the wrong inbox" },
        OPERATOR,
      ),
    );
    expect(withPhone.status).toBe("error");
    expect(withPhone.status === "error" && withPhone.message).toMatch(/patient details/);

    const withEmail = data<OpenIncidentOutcome>(
      await runOperation(
        "openIncident",
        { clinicId: c.clinicId, class: "breach", summary: "Emailed jane@example.com the wrong appointment" },
        OPERATOR,
      ),
    );
    expect(withEmail.status).toBe("error");

    const view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.incidents).toEqual([]);
  });

  test("an incident in ids is opened with its clocks, notified, and resolved", async () => {
    const c = await seedClinic("care-incident");
    const opened = data<OpenIncidentOutcome>(
      await runOperation(
        "openIncident",
        {
          clinicId: c.clinicId,
          class: "security_incident",
          summary: "Webhook signature failures from one IP, 40 in an hour; no row written.",
          discoveredAt: "2026-09-11T15:00:00Z",
        },
        OPERATOR,
      ),
    );
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    // 24 hours from discovery, at every clinic (BAA 1.3.0; §12.14, gate 5).
    expect(opened.notifyBy).toBe("2026-09-12T15:00:00.000Z");
    expect(opened.ftcNotifyBy).toBeNull();

    const notified = data<{ status: string }>(
      await runOperation("markIncidentNotified", { clinicId: c.clinicId, incidentId: opened.id, how: "Phoned the practice manager" }, OPERATOR),
    );
    expect(notified.status).toBe("updated");
    const resolved = data<{ status: string }>(
      await runOperation("resolveIncident", { clinicId: c.clinicId, incidentId: opened.id, resolution: "Blocked the IP; secret rotated." }, OPERATOR),
    );
    expect(resolved.status).toBe("updated");
    const twice = data<{ status: string }>(
      await runOperation("resolveIncident", { clinicId: c.clinicId, incidentId: opened.id, resolution: "again" }, OPERATOR),
    );
    expect(twice.status).toBe("error");

    const view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]!.notifiedHow).toContain("ops@healdesk.test");
    expect(view.incidents[0]!.resolvedAt).not.toBeNull();
  });

  test("offboarding is started from the console, and the export cannot be marked delivered before it", async () => {
    const c = await seedClinic("care-offboard");
    const early = data<{ status: string; message?: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "bundle by SFTP" }, OPERATOR),
    );
    expect(early.status).toBe("error");
    expect(early.message).toMatch(/Start offboarding first/);

    const started = data<{ status: string }>(
      await runOperation("startOffboarding", { clinicId: c.clinicId, reason: "cancelled by phone" }, OPERATOR),
    );
    expect(started.status).toBe("updated");
    let view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.clinic.offboardingStartedAt).not.toBeNull();
    expect(view.clinic.destroyAfter).not.toBeNull();
    expect(view.clinic.exportDeliveredAt).toBeNull();

    const delivered = data<{ status: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "bundle by SFTP" }, OPERATOR),
    );
    expect(delivered.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.clinic.exportDeliveredAt).not.toBeNull();
  });
});

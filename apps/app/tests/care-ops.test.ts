import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runOperation, type CareView, type OpenIncidentOutcome, type Operator } from "@/lib/ops/api";
import { exportClinic } from "@/lib/patient-rights/export";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
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
const ACTOR = { type: "service", serviceName: "test" } as const;

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
    // No agreement on file: the strictest rule, a day before the thirty days.
    expect(view.clinic.destruction).toMatchObject({ rule: "thirty_days", basis: "no_agreement" });

    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportClinic(tx, "practice"));
    const delivered = data<{ status: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "bundle by SFTP" }, OPERATOR),
    );
    expect(delivered.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.clinic.exportDeliveredAt).not.toBeNull();
  }, 120_000);

  // The calendar session's re-audit (C19, 12 October 2026): the return
  // bundle left out the raw payloads, the only place a transcript's words
  // sit in the database, kept up to the record clock when never processed,
  // while clause 17 promises "an export of the patient information it holds".
  test("the clinic's return bundle carries its raw payloads, decoded where they parse, with its threads and drafts", async () => {
    const c = await seedClinic("care-export-payloads");
    const at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const deep = "[".repeat(100_000) + '"x"' + "]".repeat(100_000);
    // Deep enough to parse, and to pass a check that writes the body alone,
    // but not to be written inside the bundle (third review of C19).
    const deepish = "[".repeat(7_000) + '"x"' + "]".repeat(7_000);
    // The cap itself: 512 levels decode, 513 go as text. Where the stack runs
    // out depends on the process, so the cap, not the stack, decides.
    const atCap = "[".repeat(512) + '"x"' + "]".repeat(512);
    const pastCap = "[".repeat(513) + '"x"' + "]".repeat(513);
    const client = await getMigratorPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await client.query(
        `insert into webhook_events (clinic_id, provider, delivery_id, signature_valid, raw_payload, processed_at, received_at)
         values ($1, 'synthflow', 'call_export_1', true, $2, $3, $3),
                ($1, 'mindbody', 'evt_export_text', false, 'From: Ann <ann@mail.test>', null, $3),
                ($1, 'mindbody', 'evt_export_deep', true, $4, null, $3),
                ($1, 'mindbody', 'evt_export_deepish', true, $5, null, $3),
                ($1, 'mindbody', 'evt_export_at_cap', true, $6, null, $3),
                ($1, 'mindbody', 'evt_export_past_cap', true, $7, null, $3)`,
        [
          c.clinicId,
          JSON.stringify({ call_id: "call_export_1", transcript: "Caller asked about a consultation." }),
          at,
          deep,
          deepish,
          atCap,
          pastCap,
        ],
      );
      await client.query(
        `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
         values ($1, 'instagram', 'ref_export_thread', gen_random_uuid(), $2, $2)`,
        [c.clinicId, at],
      );
      await client.query(
        `insert into meta_booking_drafts (clinic_id, platform, sender_id, external_id, first_name, phone, updated_at)
         values ($1, 'instagram', 'ig_export', 'page_1', 'Sam', null, $2)`,
        [c.clinicId, at],
      );
      await client.query("commit");
    } finally {
      client.release();
    }

    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportClinic(tx, "practice"));
    const byDelivery = Object.fromEntries((bundle.rawPayloads ?? []).map((p) => [p.deliveryId, p]));
    expect(Object.keys(byDelivery).sort()).toEqual([
      "call_export_1",
      "evt_export_at_cap",
      "evt_export_deep",
      "evt_export_deepish",
      "evt_export_past_cap",
      "evt_export_text",
    ]);
    expect(byDelivery.call_export_1).toMatchObject({
      provider: "synthflow",
      processed: true,
      text: null,
      body: { call_id: "call_export_1", transcript: "Caller asked about a consultation." },
    });
    expect(byDelivery.evt_export_text).toMatchObject({
      provider: "mindbody",
      processed: false,
      signatureValid: false,
      body: null,
      text: "From: Ann <ann@mail.test>",
    });
    // Past DECODED_PAYLOAD_MAX_DEPTH: its text, as received, however it parses.
    expect(byDelivery.evt_export_deep).toMatchObject({ body: null, text: deep });
    expect(byDelivery.evt_export_deepish).toMatchObject({ body: null, text: deepish });
    expect(byDelivery.evt_export_past_cap).toMatchObject({ body: null, text: pastCap });
    expect(byDelivery.evt_export_at_cap!.text).toBeNull();
    expect(byDelivery.evt_export_at_cap!.body).toEqual(JSON.parse(atCap));
    expect(byDelivery.call_export_1!.receivedAt).toEqual(at);
    expect(bundle.messagingThreads).toEqual([
      expect.objectContaining({ channel: "instagram", partyRef: "ref_export_thread", conversationsCount: 1 }),
    ]);
    expect(bundle.metaBookingDrafts).toEqual([expect.objectContaining({ senderId: "ig_export", firstName: "Sam" })]);
    // And it survives being written out, as patient-export writes it.
    expect(() => JSON.stringify(bundle, null, 2)).not.toThrow();
  });

  // BAA 1.3.0 release gate 7: "delivered" means the export reached the
  // practice, never that it was produced.
  test("producing the export stamps nothing; the operator's record of its handover does, once, and not before a bundle exists", async () => {
    const c = await seedClinic("care-delivered");
    await runOperation("startOffboarding", { clinicId: c.clinicId, reason: "cancelled by email" }, OPERATOR);
    const stamp = async () =>
      (
        await getMigratorPool().query<{ export_delivered_at: Date | null }>(
          `select export_delivered_at from clinics where id = $1`,
          [c.clinicId],
        )
      ).rows[0]!.export_delivered_at;

    // Nothing produced: the record is refused, and nothing is stamped.
    const unproduced = data<{ status: string; message?: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "bundle by SFTP" }, OPERATOR),
    );
    expect(unproduced.status).toBe("error");
    expect(unproduced.message).toMatch(/No return bundle has been produced/);
    // As run-task.sh takes it: the clinic's id, and nothing else (C19).
    expect(unproduced.message).toContain("(bash run-task.sh patient-export <clinic id>)");
    expect(await stamp()).toBeNull();

    // Produced, as the patient-export script does: still nothing stamped.
    const bundle = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => exportClinic(tx, "practice"));
    expect(bundle.producedAt).toBeTruthy();
    expect(await stamp()).toBeNull();

    // Handed over and recorded: stamped by the database, at the record.
    const before = Date.now();
    const delivered = data<{ status: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "bundle by SFTP to the practice manager" }, OPERATOR),
    );
    expect(delivered.status).toBe("updated");
    const first = await stamp();
    expect(first).not.toBeNull();
    expect(first!.getTime()).toBeGreaterThanOrEqual(before - 60_000);

    // Once: a second record is refused and the stamp stays.
    const again = data<{ status: string; message?: string }>(
      await runOperation("markExportDelivered", { clinicId: c.clinicId, how: "again" }, OPERATOR),
    );
    expect(again.status).toBe("error");
    expect((await stamp())!.getTime()).toBe(first!.getTime());
  }, 120_000);

  test("the Retell deletion shows as outstanding, with its deadline, until an operator records it", async () => {
    const c = await seedClinic("care-retell");
    let view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    // Not offboarding: there is no step yet, and none can be recorded.
    expect(view.clinic.voiceVendorDeletion).toBeNull();
    const early = data<{ status: string; message?: string }>(
      await runOperation("markVoiceVendorDataDeleted", { clinicId: c.clinicId, how: "deleted in Retell" }, OPERATOR),
    );
    expect(early.status).toBe("error");

    await runOperation("startOffboarding", { clinicId: c.clinicId, reason: "cancelled by email" }, OPERATOR);
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.clinic.voiceVendorDeletion).toEqual({
      deadline: view.clinic.destruction!.destroyDueAt,
      recordedAt: null,
      recordedBy: null,
      how: null,
    });

    // The operator's note is scanned like every other: no patient in it.
    const withPhone = data<{ status: string; message?: string }>(
      await runOperation("markVoiceVendorDataDeleted", { clinicId: c.clinicId, how: "deleted the call from +1 555 010 0123" }, OPERATOR),
    );
    expect(withPhone.status).toBe("error");

    const recorded = data<{ status: string }>(
      await runOperation("markVoiceVendorDataDeleted", { clinicId: c.clinicId, how: "agent and calls deleted in Retell's console" }, OPERATOR),
    );
    expect(recorded.status).toBe("updated");
    view = data<CareView>(await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR));
    expect(view.clinic.voiceVendorDeletion).toMatchObject({
      recordedBy: "ops@healdesk.test",
      how: "agent and calls deleted in Retell's console",
    });
    expect(view.clinic.voiceVendorDeletion!.recordedAt).not.toBeNull();

    // Recorded once, as a security event naming the operator.
    const twice = data<{ status: string; message?: string }>(
      await runOperation("markVoiceVendorDataDeleted", { clinicId: c.clinicId, how: "again" }, OPERATOR),
    );
    expect(twice.status).toBe("error");
    const { rows } = await getMigratorPool().query<{ actor_label: string }>(
      `select actor_label from security_events where event = 'voice_vendor_data_deleted' and metadata->>'clinicId' = $1`,
      [c.clinicId],
    );
    expect(rows).toEqual([{ actor_label: "ops@healdesk.test" }]);
  }, 120_000);
});

import { randomUUID } from "node:crypto";

import { collectedFieldRows, metaEligible, resolveBookingRequirements } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

// The desk's token, where createBookingRequest mints it: no email carries it
// since the clinic's booking alert became a pointer into the portal.
vi.mock("@/lib/meta/booking-requests", async (importOriginal) =>
  (await import("./setup/minted-tokens")).recordingMints(await importOriginal()),
);

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import type { AssistantResponder } from "@/lib/assistant/turn";
import {
  sendWebChatMessage,
  startWebChat,
  webChatClinic,
  type WebChatClinic,
} from "@/lib/chat/web-chat";
import { cleanCollectedFields, resolveBookingRequest } from "@/lib/meta/booking-requests";
import { issueConnectionLink } from "@/lib/connections/links";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import { buildFrontDoorPrompt } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import {
  confirmBookingRequirementsWithin,
  setBookingRequirementsWithin,
} from "@/lib/onboarding/requirements";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { addRecipient } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";
import { bookingRequestFrom, type VoiceCallEvent } from "@/lib/voice/ingest";
import { RetellCallSession } from "@/lib/voice/retell";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedClinic,
  seedEntitled,
  setWeekdayHours,
} from "./setup/factories";
import { lastMintedToken } from "./setup/minted-tokens";

/**
 * A veterinary booking's animal name and species (owner, 6 October 2026; the
 * spec's "A veterinary booking may record the animal's name and species"):
 * asked for on a call and in a website chat at a practice that cares for
 * animals, cleaned to their own rules, stored in the request's collected
 * fields, shown to the desk in the vet's words, and never asked for, kept or
 * carried on a Meta thread. Synthetic clinics, fake models, fake mail.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "vet-fields-test" } as const;
const APP_SECRET = "meta-app-secret-for-vet-field-tests";
const WINDOW_START = new Date("2026-10-01T00:00:00Z");

const VET = resolveBookingRequirements("veterinary", null);

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `ses-${randomUUID()}` };
  }
}

/** The system prompt as text, whatever shape the responder is handed it in. */
const promptText = (system: unknown) =>
  typeof system === "string" ? system : JSON.stringify(system);

async function asVet(clinicId: string): Promise<void> {
  await getMigratorPool().query(`update clinics set specialty = 'veterinary' where id = $1`, [
    clinicId,
  ]);
}

async function collected(clinicId: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ channel: string; collected_fields: Record<string, string> }>(
      `select channel, collected_fields from booking_requests order by created_at`,
    ),
  );
  return rows;
}

async function refusals(clinicId: string) {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ field: string; reason: string }>(
      `select metadata->>'field' as field, metadata->>'reason' as reason from audit_log
        where metadata->>'outcome' = 'field_refused' order by metadata->>'field'`,
    ),
  );
  return rows;
}

describe("cleaning what a call or a chat collected", () => {
  test("a vet's request keeps the animal's name and species, each to its own rule", () => {
    const { accepted, refused } = cleanCollectedFields(VET, {
      animal_name: "  Mr   Whiskers ",
      animal_species: "Small-Mammal",
      last_name: "Okafor",
    });
    expect(accepted).toEqual({
      animal_name: "Mr Whiskers",
      animal_species: "small mammal",
      last_name: "Okafor",
    });
    expect(refused).toEqual([]);
    expect(cleanCollectedFields(VET, { animal_species: "other (ferret)" }).accepted).toEqual({
      animal_species: "other: ferret",
    });
  });

  test("a clinical word in the name, an unknown species, a digit, or a sentence is refused and named", () => {
    expect(cleanCollectedFields(VET, { animal_name: "Max allergic" })).toEqual({
      accepted: {},
      refused: [{ field: "animal_name", reason: "clinical" }],
    });
    expect(cleanCollectedFields(VET, { animal_species: "dragon" })).toEqual({
      accepted: {},
      refused: [{ field: "animal_species", reason: "invalid" }],
    });
    expect(cleanCollectedFields(VET, { animal_name: "Rex2" }).refused).toEqual([
      { field: "animal_name", reason: "invalid" },
    ]);
    expect(
      cleanCollectedFields(VET, { animal_species: "a dog with an infection" }).refused,
    ).toEqual([{ field: "animal_species", reason: "clinical" }]);
    expect(cleanCollectedFields(VET, { animal_name: "A".repeat(41) }).refused).toEqual([
      { field: "animal_name", reason: "invalid" },
    ]);
  });

  test("a practice whose patients are people never keeps them, even from a stored list", () => {
    const medSpa = resolveBookingRequirements("med-spa", [
      "animal_name",
      "animal_species",
      "service",
    ]);
    expect(cleanCollectedFields(medSpa, { animal_name: "Biscuit", animal_species: "dog" })).toEqual(
      {
        accepted: {},
        refused: [
          { field: "animal_name", reason: "not_required" },
          { field: "animal_species", reason: "not_required" },
        ],
      },
    );
  });

  test("the post-call ingest keeps them for a vet", () => {
    const event: VoiceCallEvent = {
      externalCallId: "call-vet-1",
      clinicId: randomUUID(),
      startedAt: WINDOW_START,
      endedAt: WINDOW_START,
      durationSeconds: 60,
      outcome: "booked",
      booking: { preferredWindow: "Thursday afternoon" },
      collectedFields: {
        animal_name: "Biscuit",
        animal_species: "Dog",
        new_or_existing: "returning",
      },
    };
    const request = bookingRequestFrom(event, randomUUID(), "America/Los_Angeles", VET)!;
    expect(request.collectedFields).toEqual({ animal_name: "Biscuit", animal_species: "dog" });
    // A vet's defaults do not ask whether they have been before.
    expect(request.refusedFields).toEqual([{ field: "new_or_existing", reason: "not_required" }]);
  });
});

describe("a vet's Meta thread", () => {
  test("its prompt asks for the locked four and never for the animal", () => {
    const prompt = buildFrontDoorPrompt({
      clinicName: "Paws & Claws",
      phone: "+1 415 555 0199",
      websiteHint: null,
      services: [{ name: "Wellness exam", priceFromUsd: 80, priceToUsd: 80 }],
      notes: null,
      escalationHours: null,
      requirements: metaEligible(VET),
      deferredRequirements: VET.filter((f) => !f.metaEligible),
      neverSay: [],
    }, "messenger");
    expect(prompt).toMatch(
      /your first name; a number the practice can call; a day or time that works best; one or two other times that could work; nothing else may be asked/,
    );
    expect(prompt).not.toMatch(/animal|species/i);
  });
});

describeDb("collected on a call and in a chat, refused on Meta, shown to the desk", () => {
  const transport = new FakeTransport();

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await getMigratorPool().query(
      `update scheduled_jobs set enabled = true where name = 'transcript-emails'`,
    );
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "verify-me";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 180_000);

  afterEach(() => {
    transport.sent.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  async function liveVetChat(label: string): Promise<WebChatClinic> {
    const c = await seedClinic(label);
    await asVet(c.clinicId);
    await bindAgreementInEffect(c.clinicId);
    await setWeekdayHours(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), website = $2 where id = $1`,
      [c.clinicId, `${label}.test`],
    );
    await seedEntitled(c.clinicId, {
      planId: "webchat-1000",
      planStartedAt: WINDOW_START,
      channelRows: [{ channel: "web", liveAt: WINDOW_START }],
    });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Wellness exam", priceFromUsd: 80, priceToUsd: 80, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await addRecipient(tx, { email: `desk@${label}.test`, addedBy: "test" });
    });
    const clinic = await webChatClinic(c.slug);
    if (!clinic) throw new Error("no clinic");
    return clinic;
  }

  test("a website chat asks for them, stores them cleaned, and the desk reads them in the vet's words", async () => {
    const clinic = await liveVetChat("vet-chat");
    const prompts: string[] = [];
    const responder: AssistantResponder = async ({ system }) => {
      prompts.push(promptText(system));
      return JSON.stringify({
        reply: "Thanks Dana, the team will confirm Thursday afternoon within a day.",
        booking: {
          wants: true,
          first_name: "Dana",
          phone: "415 555 0192",
          window: "Thursday afternoon",
          service: "Wellness exam",
          fields: {
            last_name: "Okafor",
            animal_name: "Biscuit",
            animal_species: "Other: ferret",
            new_or_existing: "returning",
          },
        },
      });
    };
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const reply = await sendWebChatMessage(
      clinic,
      start.token,
      "Dana Okafor, 415 555 0192, Thursday afternoon for Biscuit, my ferret",
      { responder, transport },
    );
    expect(reply.mode).toBe("chat");

    // The model was told to ask for both, and how the species is written.
    expect(prompts[0]).toContain("- animal_name: the animal's name");
    expect(prompts[0]).toMatch(
      /- animal_species: what kind of animal it is \(write it as one of: dog, cat, rabbit, bird, reptile, small mammal, horse;/,
    );

    expect(await collected(clinic.clinicId)).toEqual([
      {
        channel: "web_chat",
        collected_fields: {
          last_name: "Okafor",
          animal_name: "Biscuit",
          animal_species: "other: ferret",
        },
      },
    ]);
    expect(await refusals(clinic.clinicId)).toEqual([
      { field: "new_or_existing", reason: "not_required" },
    ]);

    // The clinic's alert is a pointer, and the desk's page names the animal.
    const desk = transport.sent.filter((s) => s.message.phiClass !== "may-carry-phi");
    expect(JSON.stringify(desk.map((s) => s.message))).not.toMatch(/Biscuit|ferret/);
    const { rows: alerts } = await inTenant(clinic.clinicId, (client) =>
      client.query<{ payload: Record<string, unknown> }>(`select payload from billing_notices where kind = 'booking_request'`),
    );
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toMatch(/Biscuit|ferret|Okafor/);
    const req = (await resolveBookingRequest(lastMintedToken()))!;
    expect(req.audience).toBe("clients");
    expect(collectedFieldRows(req.collectedFields, req.audience)).toEqual([
      { id: "last_name", label: "Last name", value: "Okafor" },
      { id: "animal_name", label: "Animal's name", value: "Biscuit" },
      { id: "animal_species", label: "Species", value: "Other: ferret" },
    ]);
  });

  test("a call asks for them and its request keeps them; a clinical name and an unknown species are refused and audited", async () => {
    const clinic = await seedClinic("vet-call");
    await asVet(clinic.clinicId);
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      addRecipient(tx, { email: "desk@vet-call.test", addedBy: "test" }),
    );

    async function oneCall(callId: string, fields: Record<string, string>) {
      const prompts: string[] = [];
      const responder: AssistantResponder = async ({ system }) => {
        prompts.push(promptText(system));
        return JSON.stringify({
          reply:
            "Thanks Dana. I'll pass Thursday afternoon to the team, who will confirm within a day.",
          booking: { wants: true, first_name: "Dana", window: "Thursday afternoon", fields },
        });
      };
      const session = new RetellCallSession(clinic.clinicId, callId, () => {}, {
        responder,
        transport,
      });
      await session.open();
      await session.handle(
        JSON.stringify({
          interaction_type: "call_details",
          call: {
            call_id: callId,
            from_number: "+14155550192",
            direction: "inbound",
            start_timestamp: Date.now() - 60_000,
          },
        }),
      );
      await session.handle(
        JSON.stringify({
          interaction_type: "response_required",
          response_id: 1,
          transcript: [{ role: "user", content: "Dana, Thursday afternoon, for my cat Jean-Luc" }],
        }),
      );
      const result = await session.finish();
      expect(result, callId).not.toBeNull();
      return prompts;
    }

    const prompts = await oneCall("call_vet_ok", {
      animal_name: "Jean-Luc",
      animal_species: "Cat",
    });
    expect(prompts[0]).toContain("- animal_name: the animal's name");
    expect(prompts[0]).toContain("- animal_species: what kind of animal it is");
    expect(await collected(clinic.clinicId)).toEqual([
      { channel: "voice", collected_fields: { animal_name: "Jean-Luc", animal_species: "cat" } },
    ]);

    await oneCall("call_vet_bad", {
      animal_name: "Max allergic",
      animal_species: "dragon",
      last_name: "Okafor",
    });
    const rows = await collected(clinic.clinicId);
    expect(rows[1]).toEqual({ channel: "voice", collected_fields: { last_name: "Okafor" } });
    expect(await refusals(clinic.clinicId)).toEqual([
      { field: "animal_name", reason: "clinical" },
      { field: "animal_species", reason: "invalid" },
    ]);
  });

  test("a Meta thread at a vet keeps the locked four and nothing of the animal, whatever the model hands over", async () => {
    const pageId = "423456789012345";
    const c = await seedClinic("vet-meta");
    await asVet(c.clinicId);
    await bindAgreementInEffect(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [c.clinicId],
    );
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "meta", liveAt: new Date() }] });
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`,
        [c.clinicId, "desk@vet-meta.test"],
      ),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Wellness exam", priceFromUsd: 80, priceToUsd: 80, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-page-token-0123456789",
        label: "Main page",
      });
      await setMetaFrontDoor(tx, true);
    });

    const systems: string[] = [];
    const sent: Parameters<MetaSender>[0][] = [];
    __setMetaRuntimeForTests(
      async (system) => {
        systems.push(system);
        return JSON.stringify({
          reply: "Got it — the practice will call you.",
          booking: {
            wants: true,
            first_name: "Sam",
            phone: "+14155550177",
            window: "Saturday afternoon",
            alt_windows: [],
            fields: { animal_name: "Biscuit", animal_species: "dog", last_name: "Okafor" },
          },
        });
      },
      async (input) => {
        sent.push(input);
      },
      transport,
    );
    const body = JSON.stringify({
      object: "page",
      entry: [
        {
          id: pageId,
          messaging: [
            {
              sender: { id: "user-vet" },
              recipient: { id: pageId },
              message: {
                mid: `m-${randomUUID()}`,
                text: "Sam, +1 415 555 0177, Saturday afternoon please, for Biscuit",
              },
            },
          ],
        },
      ],
    });
    const res = await POST(
      new Request("http://app.test/api/webhooks/meta", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signMetaBody(body, APP_SECRET),
        },
        body,
      }),
    );
    expect(res.status).toBe(200);

    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toMatch(/animal|species/i);
    expect(await collected(c.clinicId)).toEqual([{ channel: "meta", collected_fields: {} }]);
    const everything = await inTenant(c.clinicId, (client) =>
      client.query<{ row: string }>(
        `select row_to_json(r)::text as row from booking_requests r
         union all select row_to_json(d)::text from meta_booking_drafts d
         union all select row_to_json(a)::text from audit_log a`,
      ),
    );
    expect(everything.rows.map((r) => r.row).join("\n")).not.toMatch(/Biscuit|Okafor/);
    expect(sent.map((s) => s.text).join("\n")).not.toMatch(/Biscuit|dog/i);
  });

  test("a setup link keeps a vet's animal fields and drops them from any other practice's submission", async () => {
    async function submitted(clinicId: string, fields: string[]) {
      const { token } = await issueConnectionLink(
        clinicId,
        { purpose: "setup" },
        { actor: ACTOR, request: {} },
      );
      const result = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        confirmBookingRequirementsWithin(tx, {
          token,
          ip: null,
          fields,
          election: null,
          clinicName: "Setup Clinic",
          platformId: "acuity",
        }),
      );
      const { rows } = await getMigratorPool().query<{ booking_requirements: string[] | null }>(
        `select booking_requirements from clinics where id = $1`,
        [clinicId],
      );
      expect(rows[0]!.booking_requirements).toEqual(result.fields);
      return result.fields;
    }
    const locked = ["first_name", "phone", "preferred_window", "alternative_windows"];
    const medSpa = await seedClinic("vet-setup-medspa");
    expect(await submitted(medSpa.clinicId, ["service", "animal_name", "animal_species"])).toEqual([
      ...locked,
      "service",
    ]);
    const vet = await seedClinic("vet-setup-vet");
    await asVet(vet.clinicId);
    expect(await submitted(vet.clinicId, ["animal_species", "animal_name", "service"])).toEqual([
      ...locked,
      "service",
      "animal_name",
      "animal_species",
    ]);
  });

  test("an operator cannot give a practice whose patients are people an animal field; a vet can have them", async () => {
    const medSpa = await seedClinic("vet-field-medspa");
    await expect(
      withTenant({ clinicId: medSpa.clinicId, actor: ACTOR }, (tx) =>
        setBookingRequirementsWithin(tx, ["service", "animal_name"]),
      ),
    ).rejects.toThrow(/not offered to this practice: animal_name/);

    const vet = await seedClinic("vet-field-vet");
    await asVet(vet.clinicId);
    const saved = await withTenant({ clinicId: vet.clinicId, actor: ACTOR }, (tx) =>
      setBookingRequirementsWithin(tx, ["animal_species", "animal_name"]),
    );
    expect(saved).toEqual([
      "first_name",
      "phone",
      "preferred_window",
      "alternative_windows",
      "animal_name",
      "animal_species",
    ]);

    // The operator console's catalogue is the practice's own: the animal
    // fields at the vet, in its words, and nowhere else.
    const { runOperation } = await import("@/lib/ops/api");
    const catalogue = async (clinicId: string) => {
      const view = await runOperation(
        "getOnboarding",
        { clinicId },
        { email: "ops@healdesk.test", request: {} },
      );
      const data = (
        view.body as { data: { requirements: { catalogue: { id: string; label: string }[] } } }
      ).data;
      return data.requirements.catalogue;
    };
    const vetCatalogue = await catalogue(vet.clinicId);
    expect(vetCatalogue.map((f) => f.id)).toEqual(
      expect.arrayContaining(["animal_name", "animal_species"]),
    );
    expect(vetCatalogue.find((f) => f.id === "new_or_existing")?.label).toBe(
      "New or returning client",
    );
    const medSpaCatalogue = await catalogue(medSpa.clinicId);
    expect(medSpaCatalogue.map((f) => f.id)).not.toContain("animal_name");
    expect(medSpaCatalogue.map((f) => f.id)).not.toContain("animal_species");
    expect(medSpaCatalogue.find((f) => f.id === "new_or_existing")?.label).toBe(
      "New or returning patient",
    );
  });
});

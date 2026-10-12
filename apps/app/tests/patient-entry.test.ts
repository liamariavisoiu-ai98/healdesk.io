import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { parseEnvelope, runOperation, type CareView, type Operator } from "@/lib/ops/api";
import {
  amendContactFromShell,
  amendRecordFromShell,
  askLines,
  erasePersonFromShell,
  optionsFrom,
  parseArgs,
  refusePatientDataInArgs,
  shellOperator,
  typedEntryAllowed,
} from "@/lib/ops/patient-entry";
import { ERASURE_STEP_OUTCOMES } from "@/lib/patient-rights/erasure";
import { REQUESTER_LABELS } from "@/lib/patient-rights/requesters";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * Patient data is entered in apps/app's own shell, never through apps/web
 * (review of 12 October 2026).
 *
 * The care page's forms took a person's number and address for a deletion,
 * an amendment's words and a contact's corrected details, and each crossed a
 * Vercel server action into the signed ops request: a hop through a host
 * with no business associate agreement. The three operations are gone from
 * the envelope; the operator runs ops:erase-person, ops:amend-record and
 * ops:amend-contact on the app host, which read the patient data from a
 * prompt, never the command line. These tests hold the envelope to carrying
 * nothing of a patient, and the scripts to their prompt.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "127.0.0.1" } };
const SHELL = { label: "ops@healdesk.test" };
const DAY = 24 * 60 * 60 * 1000;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

/** One of the operator scripts, as the operator runs it, with what they type piped in. */
function runScript(
  script: string,
  args: string[],
  typed: string,
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [TSX, `scripts/${script}.ts`, ...args], {
    cwd: APP_DIR,
    input: typed,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

/**
 * The scripts as a one-off task on the AWS host runs them: NODE_ENV
 * production, as the image sets it, and a database URL that passes the
 * production check but is never reached, since each refusal comes first.
 */
const AWS_HOST = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://unused:unused@localhost:1/unused?sslmode=verify-full",
};

describe("the shell takes patient data from the prompt, never the command line", () => {
  test("a number or an address in any argument is refused, the operator's own address aside", () => {
    const ok = parseArgs([
      "--clinic",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "--operator",
      "ops@healdesk.test",
      "--requested-by",
      "practice",
    ]);
    expect(() => refusePatientDataInArgs(ok)).not.toThrow();
    expect(shellOperator(ok)).toEqual({ label: "ops@healdesk.test" });
    for (const argv of [
      ["--phone", "+15550138501"],
      ["--note", "call 555 013 8501"],
      ["--email", "dana@example-patient.test"],
    ]) {
      expect(() => refusePatientDataInArgs(parseArgs(argv)), argv.join(" ")).toThrow(
        /command line/,
      );
    }
    expect(() => shellOperator(parseArgs(["--clinic", "x"]))).toThrow(/--operator/);
  });

  test("on the AWS host options come from the task's environment, screened as arguments are, and nothing is typed", () => {
    const env = {
      HEALDESK_ERASURE_CLINIC_ID: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      HEALDESK_ERASURE_CONTACT_ID: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
      HEALDESK_ERASURE_REQUESTED_BY: "practice",
      HEALDESK_ERASURE_RECEIVED_AT: "2026-10-05T09:00:00Z",
      HEALDESK_OPS_OPERATOR: "ops@healdesk.test",
    };
    const keys = {
      clinic: "HEALDESK_ERASURE_CLINIC_ID",
      contact: "HEALDESK_ERASURE_CONTACT_ID",
      "requested-by": "HEALDESK_ERASURE_REQUESTED_BY",
      "received-at": "HEALDESK_ERASURE_RECEIVED_AT",
      operator: "HEALDESK_OPS_OPERATOR",
    };
    const args = optionsFrom([], env, keys);
    expect(Object.fromEntries(args)).toEqual({
      clinic: env.HEALDESK_ERASURE_CLINIC_ID,
      contact: env.HEALDESK_ERASURE_CONTACT_ID,
      "requested-by": "practice",
      "received-at": "2026-10-05T09:00:00Z",
      operator: "ops@healdesk.test",
    });
    // An ISO time is a time; a number in the same place is refused.
    expect(() => refusePatientDataInArgs(args)).not.toThrow();
    expect(() =>
      refusePatientDataInArgs(
        optionsFrom([], { ...env, HEALDESK_ERASURE_RECEIVED_AT: "+1 555 013 8501" }, keys),
      ),
    ).toThrow(/command line/);
    // A number in the environment is refused as one on the command line is.
    expect(() =>
      refusePatientDataInArgs(
        optionsFrom([], { ...env, HEALDESK_ERASURE_CONTACT_ID: "+15550138501" }, keys),
      ),
    ).toThrow(/command line/);
    // An argument wins over the environment.
    expect(
      optionsFrom(["--requested-by", "person_via_practice"], env, keys).get("requested-by"),
    ).toBe("person_via_practice");
    expect(typedEntryAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(typedEntryAllowed({ NODE_ENV: "development" })).toBe(true);
  });

  test("where NODE_ENV is production, as in the image, no script asks for a patient's details", () => {
    const base = [
      "--clinic",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "--operator",
      "ops@healdesk.test",
      "--requested-by",
      "practice",
    ];
    const erase = runScript("ops-erase-person", base, "+15550138501\n\n", AWS_HOST);
    expect(erase.status).toBe(1);
    expect(erase.stderr).toMatch(
      /by a contact's id only \(HEALDESK_ERASURE_CONTACT_ID\), through run-task\.sh/,
    );
    const amend = runScript(
      "ops-amend-record",
      [...base, "--kind", "conversation"],
      "words\n",
      AWS_HOST,
    );
    expect(amend.status).toBe(1);
    expect(amend.stderr).toMatch(/wait for the M5 portal/);
    const correct = runScript(
      "ops-amend-contact",
      [...base, "--contact", "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a"],
      "Name\n\n\n",
      AWS_HOST,
    );
    expect(correct.status).toBe(1);
    expect(correct.stderr).toMatch(/can only clear fields/);
  }, 120_000);

  test("the prompt reads one answer per question, a blank line an empty one, and writes only the questions", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => (written += String(chunk)));
    input.end("+15550138501\n\nleft over\n");
    expect(await askLines(["Number: ", "Address: "], { input, output })).toEqual([
      "+15550138501",
      "",
    ]);
    expect(written).toBe("Number: Address: ");
  });
});

describeDb("patient data never crosses the ops envelope", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the deletion, amendments and corrections are not operations of the envelope", () => {
    for (const op of ["erasePerson", "amendRecord", "amendContact"]) {
      const parsed = parseEnvelope(
        JSON.stringify({
          op,
          args: { clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", phone: "+15550138501" },
        }),
      );
      expect(parsed.ok, op).toBe(false);
      if (!parsed.ok) expect(parsed.outcome.body, op).toMatchObject({ code: "unknown_operation" });
    }
  });

  test("what the care page reads back about them is ids, dates, counts and closed labels, and its one write takes a closed outcome", async () => {
    const c = await seedClinic("entry-care");
    const at = new Date(Date.now() - 2 * DAY);
    const person = await seedContact(c.clinicId, "+15550138601");
    const neighbour = await seedContact(c.clinicId, "+15550138602");
    const { conversationId } = await seedConversation(c.clinicId, {
      startedAt: at,
      contactId: neighbour,
    });
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update contacts set created_at = $1, email = 'dana@example-patient.test' where id = $2`,
        [at, person],
      ),
    );

    const erased = await erasePersonFromShell({
      clinicId: c.clinicId,
      phone: "+15550138601",
      requestedBy: "person_via_practice",
      operator: SHELL,
    });
    if (erased.status !== "erased") throw new Error(JSON.stringify(erased));
    const amended = await amendRecordFromShell({
      clinicId: c.clinicId,
      targetKind: "conversation",
      targetId: conversationId,
      amendment: "Asked about lip filler, not botox.",
      requestedBy: "practice",
      operator: SHELL,
    });
    expect(amended.status).toBe("amended");
    const corrected = await amendContactFromShell({
      clinicId: c.clinicId,
      contactId: neighbour,
      fullName: "Robin Okafor",
      requestedBy: "practice",
      operator: SHELL,
    });
    expect(corrected).toEqual({ status: "corrected", fields: ["fullName"] });

    // The stamp's outcome is chosen; a typed one is refused.
    const typed = await runOperation(
      "markErasureVendorDeleted",
      {
        clinicId: c.clinicId,
        erasureId: erased.erasureId,
        step: "retell",
        how: "deleted Dana's calls",
      },
      OPERATOR,
    );
    expect((typed.body as { data: { status: string } }).data.status).toBe("error");
    await runOperation(
      "markErasureVendorDeleted",
      { clinicId: c.clinicId, erasureId: erased.erasureId, step: "retell", how: "nothing_held" },
      OPERATOR,
    );

    const view = (
      (await runOperation("getClinicCare", { clinicId: c.clinicId }, OPERATOR)).body as {
        data: CareView;
      }
    ).data;
    expect(view.patientRights).toEqual({ amendments: 1, corrections: 1 });
    expect(view.deletionRequests).toHaveLength(1);
    const request = view.deletionRequests[0]!;
    expect(Object.values(REQUESTER_LABELS)).toContain(request.requestedBy);
    expect(request.steps.map((s) => s.how)).toEqual([ERASURE_STEP_OUTCOMES.nothing_held]);
    // Nothing of the person, the neighbour or the practice's words.
    const reply = JSON.stringify({
      patientRights: view.patientRights,
      deletionRequests: view.deletionRequests,
    });
    expect(reply).not.toMatch(/555013860|example-patient|filler|botox|Robin|Okafor|Dana/i);
  });

  test("a deletion by contact id runs the one-step rule from that contact's details, read in the transaction", async () => {
    const c = await seedClinic("entry-by-contact");
    const at = new Date(Date.now() - 2 * DAY);
    const named = await seedContact(c.clinicId, "+15550138801");
    const sharing = await seedContact(c.clinicId, "+15550138801");
    const other = await seedContact(c.clinicId, "+15550138809");
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update contacts set created_at = $1, email = case when id = $2 then 'kai@example-patient.test' else email end`,
        [at, named],
      ),
    );
    expect(
      await erasePersonFromShell({
        clinicId: c.clinicId,
        contactId: named,
        phone: "+15550138801",
        requestedBy: "practice",
        operator: SHELL,
      }),
    ).toMatchObject({ status: "error", message: expect.stringMatching(/not both/) });
    expect(
      await erasePersonFromShell({
        clinicId: c.clinicId,
        contactId: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
        requestedBy: "practice",
        operator: SHELL,
      }),
    ).toEqual({ status: "error", message: "No such contact at this clinic." });
    const erased = await erasePersonFromShell({
      clinicId: c.clinicId,
      contactId: named,
      requestedBy: "practice",
      operator: SHELL,
    });
    if (erased.status !== "erased") throw new Error(JSON.stringify(erased));
    expect(erased.identifiers).toEqual({ phones: 1, emails: 1 });
    expect(erased.deleted.contacts).toBe(2);
    const left = await inTenant(c.clinicId, (client) =>
      client.query<{ id: string }>(`select id from contacts`),
    );
    expect(left.rows.map((r) => r.id)).toEqual([other]);
    expect(sharing).toBeTruthy();
  });

  test("ops:erase-person runs from a one-off task's environment alone, by contact id, with nothing typed", async () => {
    const c = await seedClinic("entry-by-env");
    const person = await seedContact(c.clinicId, "+15550138901");
    const run = runScript("ops-erase-person", [], "", {
      HEALDESK_ERASURE_CLINIC_ID: c.clinicId,
      HEALDESK_ERASURE_CONTACT_ID: person,
      HEALDESK_ERASURE_REQUESTED_BY: "representative_via_practice",
      HEALDESK_OPS_OPERATOR: "ops@healdesk.test",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/erased: request [0-9a-f-]{36}/);
    expect(run.stderr).not.toMatch(/telephone number/);
    const gone = await inTenant(c.clinicId, (client) =>
      client.query(`select 1 from contacts where id = $1`, [person]),
    );
    expect(gone.rows).toEqual([]);
  }, 120_000);

  test("ops:erase-person deletes the person typed at its prompt, prints ids and counts only, and refuses a number on the command line", async () => {
    const c = await seedClinic("entry-script");
    const person = await seedContact(c.clinicId, "+15550138701");
    const base = [
      "--clinic",
      c.clinicId,
      "--operator",
      "ops@healdesk.test",
      "--requested-by",
      "practice",
    ];

    const onArgv = runScript("ops-erase-person", [...base, "--phone", "+15550138701"], "\n\n");
    expect(onArgv.status).toBe(1);
    expect(onArgv.stderr).toMatch(/command line/);
    const stillThere = await inTenant(c.clinicId, (client) =>
      client.query(`select 1 from contacts where id = $1`, [person]),
    );
    expect(stillThere.rows).toHaveLength(1);

    const typed = runScript("ops-erase-person", base, "+1 (555) 013-8701\n\n");
    expect(typed.status, typed.stderr).toBe(0);
    expect(typed.stdout).toMatch(/erased: request [0-9a-f-]{36}, \d+ rows/);
    expect(`${typed.stdout}${typed.stderr}`).not.toMatch(/013.?8701/);
    const gone = await inTenant(c.clinicId, (client) =>
      client.query(`select 1 from contacts where id = $1`, [person]),
    );
    expect(gone.rows).toEqual([]);
  }, 120_000);
});

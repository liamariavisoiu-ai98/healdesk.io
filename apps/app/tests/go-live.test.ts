import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  BAA_TEMPLATES,
  CHANNELS,
  CURRENT_BAA_VERSION,
  DPA_TEMPLATES,
  type Channel,
} from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { unsafeDb } from "@/db";
import { agreementTemplateReleased } from "@/lib/agreements/kind";
import {
  decideChannel,
  evaluateChannels,
  readGoLiveCheck,
  sweepChannelStates,
} from "@/lib/channels/events";
import {
  ANSWER_GATE_CHANNELS,
  gateBInCode,
  gateBNotBuilt,
  pendingLiveSet,
  routedAnsweredCounterBuilt,
} from "@/lib/compliance/gate-b";
import { casesNotAskable, practiceCases } from "@/lib/engine/practice/cases";
import {
  decidePlatform,
  platformMissing,
  readPlatformCompliance,
  subjectsFor,
  type PlatformEntry,
} from "@/lib/compliance/platform";
import { PLATFORM_SUBJECTS, type PlatformSubject } from "@/lib/compliance/subjects";
import { copyProblems } from "@/lib/email/lint";
import { afterPass } from "@/lib/engine/practice/store";
import {
  GO_LIVE_CODES,
  goLiveCodes,
  goLivePreconditions,
  goLiveSummary,
  refusalReason,
  type GoLiveChannelGate,
  type GoLiveFacts,
} from "@/lib/onboarding/go-live";
import { runOperation, type Operator } from "@/lib/ops/api";
import { readHomeFacts } from "@/lib/portal/home";
import { purgeIsPromised } from "@/lib/retention/purge";
import { readSetupState } from "@/lib/setup/state";
import { buildTracker } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedChannels,
  seedClinic,
  seedDemoClinic,
  setWeekdayHours,
} from "./setup/factories";
import { finishWizard, readyForGoLive, readyWebChat, setAgreement } from "./setup/go-live";
import { attestPlatform, setGateBCodeBuilt, withdrawPlatform } from "./setup/platform";
import { passPracticeQuestions } from "./setup/practice";

// What Gate B asks of the code is not built today, so every clinic's go-live
// waits on it (gate_b_not_built). The tests that take a clinic live stand in
// for the commit that builds it: this list empty here, and
// app_gate_b_code_built() true in the database (setGateBCodeBuilt). Null
// reads the real list.
const gate = vi.hoisted(() => ({ notBuilt: null as string[] | null }));
vi.mock("@/lib/compliance/gate-b", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compliance/gate-b")>();
  return { ...actual, gateBNotBuilt: () => gate.notBuilt ?? actual.gateBNotBuilt() };
});

/**
 * Automatic go-live (WP2; plan Part G "Automatic go-live", Part J "Go-live",
 * Part K's attestation, the Gates table): app_mark_clinic_production and
 * goLivePreconditions rewritten together, platform_compliance, and go-live
 * fired by the practice questions' pass and by every other channel input,
 * with no operator step.
 *
 *   - the pure rules, and the clinic's and the console's words for them;
 *   - the SQL and the TypeScript held together, code for code, over every
 *     fixture below (the parity the brief asks for);
 *   - a pass that takes a clinic live, a refusal that leaves it as it is and
 *     says why, and nothing ever taken offline;
 *   - platform_compliance's grants, its trigger and the ops envelope.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "go-live-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const CALENDAR = { status: "not_connected", accessRemovedAt: null } as const;

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

const WEB_MET: GoLiveChannelGate = {
  channel: "web",
  live: false,
  met: true,
  missing: [],
  platform: [],
};

const READY: GoLiveFacts = {
  production: false,
  leaving: false,
  demo: false,
  regulatoryRegime: "hipaa-if-covered",
  agreementKind: "baa",
  isCoveredEntity: false,
  agreement: { version: CURRENT_BAA_VERSION, kind: "baa" },
  platform: [],
  channels: [WEB_MET],
  notBuilt: [],
};

describe("goLivePreconditions", () => {
  test("everything in place is ok; anything Gate B asks of the code and is not built holds it, named", () => {
    const check = goLivePreconditions(READY);
    expect(check).toEqual({ ok: true, missing: [], notBuilt: [] });
    const counter = "The routed/answered counter and its miss notice: Not built.";
    const held = goLivePreconditions({ ...READY, notBuilt: [counter] });
    expect(held).toEqual({
      ok: false,
      missing: [
        {
          code: "gate_b_not_built",
          side: "ours",
          text: `Gate B asks what is not built yet, so no clinic goes live: ${counter}`,
        },
      ],
      notBuilt: [counter],
    });
    // The real list, today: the counter is on it.
    expect(gate.notBuilt).toBeNull();
    expect(
      gateBInCode()
        .filter((i) => !i.built)
        .map((i) => i.id),
    ).toContain("routed_answered_counter");
  });

  test("each precondition missing alone is its own code, in the database's order", () => {
    const cases: [Partial<GoLiveFacts>, string][] = [
      [{ leaving: true }, "leaving"],
      [{ demo: true }, "demo"],
      [{ isCoveredEntity: null }, "covered_status"],
      [{ agreement: null }, "no_agreement"],
      [{ agreement: { version: "1.5.0", kind: "baa" } }, "agreement_version"],
      [{ agreementKind: null }, "agreement_kind_mismatch"],
      [{ regulatoryRegime: "non-hipaa" }, "agreement_insufficient"],
      [{ platform: ["anthropic"] }, "platform"],
      [{ channels: [{ ...WEB_MET, met: false, missing: ["audit"] }] }, "gate_b"],
      [
        { notBuilt: ["The live emails (Annex X9): Still without a template: L17."] },
        "gate_b_not_built",
      ],
    ];
    for (const [over, code] of cases) {
      expect(goLiveCodes(goLivePreconditions({ ...READY, ...over })), code).toEqual([code]);
    }
    const everything = goLivePreconditions({
      ...READY,
      leaving: true,
      demo: true,
      isCoveredEntity: null,
      // A DPA version that is not released (dpa/1.0.0 is, since 20 October 2026).
      agreement: { version: "dpa/9.9.9", kind: "dpa" },
      platform: ["aws"],
      channels: [],
      notBuilt: ["x"],
    });
    // No agreement and a version to judge are each other's opposites; every other code comes in order.
    expect(goLiveCodes(everything)).toEqual(GO_LIVE_CODES.filter((c) => c !== "no_agreement"));
    expect(
      goLiveCodes(goLivePreconditions({ ...READY, leaving: true, agreement: null, channels: [] })),
    ).toEqual(["leaving", "no_agreement", "gate_b"]);
  });

  test("the covered status is asked where the regime asks it: a hipaa practice is covered in practice, a vet is outside HIPAA", () => {
    expect(
      goLivePreconditions({ ...READY, regulatoryRegime: "hipaa", isCoveredEntity: null }).ok,
    ).toBe(true);
    // The DPA is released (20 October 2026): a vet under it, never asked the
    // covered question, and a "No" practice under it both pass the agreement's rules.
    const vet = goLivePreconditions({
      ...READY,
      regulatoryRegime: "non-hipaa",
      agreementKind: "dpa",
      isCoveredEntity: null,
      agreement: { version: "dpa/1.0.0", kind: "dpa" },
    });
    expect(goLiveCodes(vet)).toEqual([]);
    expect(vet.ok).toBe(true);
    const no = goLivePreconditions({
      ...READY,
      agreementKind: "dpa",
      isCoveredEntity: false,
      agreement: { version: "dpa/1.0.0", kind: "dpa" },
    });
    expect(goLiveCodes(no)).toEqual([]);
    // A "Not sure" under the DPA is not covered by it, released or not.
    const unsure = goLivePreconditions({
      ...READY,
      agreementKind: "dpa",
      isCoveredEntity: null,
      agreement: { version: "dpa/1.0.0", kind: "dpa" },
    });
    expect(goLiveCodes(unsure)).not.toContain("agreement_version");
    expect(unsure.ok).toBe(false);
  });

  test("the version rule knows the agreement's kind: a superseded BAA names the current one, an unreleased DPA says it is not released", () => {
    const baa = goLivePreconditions({ ...READY, agreement: { version: "1.0.0", kind: "baa" } });
    expect(baa.missing[0]!.text).toBe(
      `The agreement in effect is BAA v1.0.0, which has been superseded. The practice must accept v${CURRENT_BAA_VERSION} before go-live.`,
    );
    const dpa = goLivePreconditions({
      ...READY,
      agreementKind: "dpa",
      agreement: { version: "dpa/9.9.9", kind: "dpa" },
    });
    expect(dpa.missing.map((m) => m.text)).toEqual([
      "The agreement in effect is DPA dpa/9.9.9, which is not released. The DPA's release lets it go live.",
    ]);
    // dpa/1.0.0 is released, so the version rule says nothing of it.
    const released = goLivePreconditions({
      ...READY,
      agreementKind: "dpa",
      agreement: { version: "dpa/1.0.0", kind: "dpa" },
    });
    expect(released).toEqual({ ok: true, missing: [], notBuilt: [] });
  });

  test("Gate B says what each channel waits on, and the answer gate is the code's part of it", () => {
    const check = goLivePreconditions({
      ...READY,
      channels: [
        {
          channel: "voice",
          live: false,
          met: false,
          missing: ["direct_line", "clinic_step"],
          platform: ["retell"],
        },
        { ...WEB_MET, met: false, missing: ["audit"] },
      ],
    });
    expect(check.missing).toEqual([
      {
        code: "gate_b",
        side: "clinic",
        text: "No channel meets Gate B yet. Phone waits on a direct line, the clinic's own step, Retell (phone); Website chat waits on its practice questions.",
      },
    ]);
    expect(goLivePreconditions({ ...READY, channels: [] }).missing[0]!.text).toBe(
      "No channel is bought, so none can go live.",
    );
    // A channel whose own inputs are all in, held only by its attestations, is ours to move.
    expect(
      goLivePreconditions({
        ...READY,
        channels: [{ ...WEB_MET, met: false, platform: ["runtime_web"] }],
      }).missing[0]!.side,
    ).toBe("ours");
    for (const channel of CHANNELS) expect(ANSWER_GATE_CHANNELS).toContain(channel);
  });

  test("the clinic reads one line, in its own words: its moves first, then a channel's, then ours", () => {
    const line = (over: Partial<GoLiveFacts>) =>
      goLiveSummary(false, goLivePreconditions({ ...READY, ...over })).line;
    expect(goLiveSummary(true, goLivePreconditions(READY))).toEqual({
      production: true,
      line: "Everything on our side is in place: each channel goes live as soon as its own step is done.",
    });
    expect(line({ isCoveredEntity: null, platform: ["aws"] })).toMatch(
      /bill insurance electronically/,
    );
    expect(line({ agreement: { version: "1.4.0", kind: "baa" } })).toMatch(/signed again/);
    expect(
      line({ platform: ["aws"], channels: [{ ...WEB_MET, met: false, missing: ["clinic_step"] }] }),
    ).toMatch(/Your channels, below/);
    expect(line({ notBuilt: ["x"] })).toBe(
      "Your part is done. We're finishing the last checks on our side before AYA answers anyone, and she goes live without anything more from you.",
    );
    expect(line({ platform: ["anthropic"] })).toBe(
      "Your part is done. We're finishing the last checks on our side before AYA answers anyone, and she goes live without anything more from you.",
    );
    for (const over of [
      {},
      { isCoveredEntity: null },
      { agreement: null },
      { platform: ["aws"] as PlatformSubject[] },
    ]) {
      const text = line(over);
      expect(copyProblems(text), text).toEqual([]);
      // "patients" or "clients" only through audienceFor; this line names neither.
      expect(text).not.toMatch(/\b(patients?|clients?|Anthropic|Retell|AWS)\b/);
    }
  });

  test("the channel's own decision waits on the platform without waiting on the clinic", () => {
    const inputs = {
      channel: "web" as Channel,
      leaving: false,
      auditPassed: true,
      runtimeOurs: true,
      setupDone: true,
      hours: true,
      directLine: true,
      vetReferral: true,
      pricesChecked: true,
      coveredStatus: true,
      clinicStepDone: true,
      platform: false,
      opsReady: true,
    };
    expect(decideChannel(inputs)).toEqual({
      ready: true,
      waitingOn: null,
      live: false,
      missing: ["platform"],
    });
    expect(decideChannel({ ...inputs, opsReady: false }).missing).toEqual(["platform", "go_live"]);
  });

  test("a subject counts while its latest row attests it and it has not lapsed, by the UTC day", () => {
    const at = (
      action: PlatformEntry["action"],
      expiresOn: string | null = null,
    ): PlatformEntry => ({
      action,
      documentRef: "ref",
      effectiveOn: "2026-10-01",
      expiresOn,
      actorLabel: "ops@healdesk.test",
      recordedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const now = new Date("2026-10-19T23:30:00-05:00"); // 04:30 on the 20th, UTC
    const status = decidePlatform(
      new Map<PlatformSubject, PlatformEntry>([
        ["anthropic", at("attested")],
        ["aws", at("attested", "2026-10-19")],
        ["database_host", at("attested", "2026-10-20")],
        ["retell", at("withdrawn")],
      ]),
      now,
    );
    expect(status.anthropic).toMatchObject({ attested: true, lapsed: false });
    expect(status.aws).toMatchObject({ attested: false, lapsed: true });
    expect(status.database_host).toMatchObject({ attested: true, lapsed: false });
    expect(status.retell).toMatchObject({ attested: false, lapsed: false });
    expect(platformMissing(status, null)).toEqual(["aws", "launch_promises"]);
    expect(platformMissing(status, "voice")).toEqual([
      "retell",
      "runtime_voice",
      "voice_pass_through",
    ]);
  });
});

describe("Gate B in code", () => {
  test("each runtime that answers a patient asks the answer gate first", () => {
    const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    expect(read("lib/voice/retell.ts")).toMatch(
      /voiceAnswerDecision[\s\S]*from "@\/lib\/billing\/answering"/,
    );
    expect(read("lib/chat/web-chat.ts")).toMatch(
      /assistantMayAnswer \} from "@\/lib\/billing\/answering"/,
    );
    expect(read("app/api/webhooks/meta/route.ts")).toMatch(
      /assistantMayAnswer \} from "@\/lib\/billing\/answering"/,
    );
  });

  // The 19 October audit: the booking and deposit cases are hard-coded not
  // applicable while the brain has no tools, the channel's result passed
  // without them, and Gate B marked the practice questions built, so go-live
  // could proceed on a pass that never asked them. Pass means every case.
  test("the practice questions are not built while a case cannot be asked: the booking and deposit cases, on every channel, until the brain has booking tools", () => {
    expect(casesNotAskable()).toEqual(["booking", "deposit_booking"]);
    const profile = {
      clinicName: "Glow",
      specialty: "med-spa",
      services: [{ name: "Botox", priceFromUsd: 12, priceToUsd: 12, depositUsd: 50 }],
      knownText: "",
      languages: ["en"] as const,
    };
    for (const channel of ["web", "voice", "meta"] as const) {
      const unasked = practiceCases({ ...profile, languages: [...profile.languages] }, channel)
        .filter((c) => c.notApplicable === "runtime_has_no_tools")
        .map((c) => c.id);
      expect(unasked, channel).toEqual(["booking", "deposit_booking"]);
    }
    const item = gateBInCode().find((i) => i.id === "practice_questions")!;
    expect(item).toMatchObject({ built: false, checked: true });
    expect(item.detail).toMatch(/a straightforward booking/);
    expect(item.detail).toMatch(/a booking for a deposit-required service/);
    expect(item.detail).toMatch(/Pass means every case/);
    // Named where go-live names what is not built, so it holds every clinic.
    expect(gateBNotBuilt()).toContain(`${item.label}: ${item.detail}`);
  });

  test("what is not built is named and asked: the routed/answered counter while it and its templates wait, and each live email still without one", () => {
    const items = gateBInCode();
    // Gate B is fail-closed: every item is asked.
    expect(items.every((i) => i.checked)).toBe(true);
    expect(items.map((i) => i.id)).toEqual([
      "practice_questions",
      "answer_gate",
      "routed_answered_counter",
      "live_email_set",
    ]);
    const counter = items.find((i) => i.id === "routed_answered_counter")!;
    expect(counter.built).toBe(routedAnsweredCounterBuilt());
    // Today the outage and miss notices (L17, L18, L21) wait on the runtime's counter.
    expect(routedAnsweredCounterBuilt()).toBe(false);
    expect(counter.detail).toMatch(/L17, L18, L21/);
    const live = items.find((i) => i.id === "live_email_set")!;
    expect(live.built).toBe(pendingLiveSet().length === 0);
    for (const pending of pendingLiveSet()) expect(live.detail).toContain(pending.annex);
    expect(pendingLiveSet().map((p) => p.annex)).toEqual(
      expect.arrayContaining(["L17", "L18", "L21"]),
    );
    // L32, a patient's request, left the list when its template shipped
    // (drizzle/0094): what still holds Gate B's live set is the runtime's.
    expect(pendingLiveSet().map((p) => p.annex)).not.toContain("L32");
    expect(live.detail).not.toMatch(/L32|patient_request/);
    expect(pendingLiveSet().every((p) => p.package === "runtime")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** The database's codes, on the runtime role inside the clinic's tenant, rolled back. */
async function sqlCodes(clinicId: string): Promise<string[]> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const { rows } = await (client as unknown as Client).query<{ codes: string[] }>(
      `select app_go_live_missing($1::uuid) as codes`,
      [clinicId],
    );
    return rows[0]!.codes;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function tsCodes(clinicId: string): Promise<string[]> {
  const read = await withTenant({ clinicId, actor: ACTOR }, (tx) => readGoLiveCheck(tx));
  return goLiveCodes(read!.check);
}

/** Both, which must agree. */
async function codes(clinicId: string): Promise<string[]> {
  const [db, ts] = await Promise.all([sqlCodes(clinicId), tsCodes(clinicId)]);
  expect(db, `SQL ${JSON.stringify(db)} against TS ${JSON.stringify(ts)}`).toEqual(ts);
  return ts;
}

function evaluate(clinicId: string, only?: Channel) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => evaluateChannels(tx, { only }));
}

async function clinicRow(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    data_classification: string;
    went_live_at: Date | null;
    baa_signed_at: Date | null;
  }>(`select data_classification, went_live_at, baa_signed_at from clinics where id = $1`, [
    clinicId,
  ]);
  return rows[0]!;
}

async function liveAt(clinicId: string, channel: Channel): Promise<Date | null> {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query<{ live_at: Date | null }>(`select live_at from clinic_channels where channel = $1`, [
      channel,
    ]),
  );
  return rows[0]?.live_at ?? null;
}

async function heldAlerts(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    fields: Record<string, unknown>;
    repeats: number;
  }>(
    `select fields, repeats from ops_alerts where event = 'go_live_held' and fields->>'clinicId' = $1 order by raised_at`,
    [clinicId],
  );
  return rows;
}

async function wentLiveEvents(slug: string) {
  const { rows } = await getMigratorPool().query<{
    actor_label: string;
    metadata: Record<string, unknown>;
  }>(
    `select actor_label, metadata from security_events where event = 'clinic_went_live' and metadata->>'clinicSlug' = $1`,
    [slug],
  );
  return rows;
}

const data = async (op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) =>
  ((await runOperation(op, args, OPERATOR)).body as { data: Record<string, unknown> }).data;

/** A synthetic clinic with everything go-live asks, but what the fixture leaves out. */
async function ready(label: string, fixture: Parameters<typeof readyForGoLive>[2] = {}) {
  const c = await seedClinic(label);
  await readyForGoLive(c.clinicId, c.organizationId, fixture);
  return c;
}

/** A passed run of the practice questions with website chat's result passed, as the job records one. */
async function passedRun(
  clinicId: string,
  channel: Channel = "web",
  status: "passed" | "failed" = "passed",
) {
  const runId = randomUUID();
  const version = "a".repeat(64);
  await inTenant(clinicId, async (c) => {
    await c.query(
      `insert into practice_question_runs (id, clinic_id, status, reason, requested_at, run_after, started_at, finished_at, cases_version, input_version)
       values ($1, $2, $3, 'knowledge', now(), now(), now(), clock_timestamp(), '1.0.0', $4)`,
      [runId, clinicId, status, version],
    );
    await c.query(
      `insert into practice_question_results (clinic_id, run_id, channel, input_version, status, cases)
       values ($1, $2, $3, $4, $5, '[]'::jsonb)`,
      [clinicId, runId, channel, version, status],
    );
  });
  return runId;
}

describeDb("Gate B's code, as the database and the TypeScript read it", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform();
  }, 180_000);

  test("app_gate_b_code_built() is gateBNotBuilt() being empty: both say not built today", async () => {
    const { rows } = await getMigratorPool().query<{ built: boolean }>(
      `select app_gate_b_code_built() as built`,
    );
    expect(rows[0]!.built).toBe(gateBInCode().every((i) => i.built));
    expect(rows[0]!.built).toBe(false);
  });

  test("everything else holds and only the counter is missing: the clinic stays as it is, and ops, the console and the tracker say why", async () => {
    const counter = gateBInCode().find((i) => i.id === "routed_answered_counter")!;
    const line = `${counter.label}: ${counter.detail}`;
    gate.notBuilt = [line];
    try {
      const c = await ready("gl-not-built");
      expect(await codes(c.clinicId)).toEqual(["gate_b_not_built"]);
      await evaluate(c.clinicId);
      expect((await clinicRow(c.clinicId)).data_classification).toBe("synthetic");
      expect(await liveAt(c.clinicId, "web")).toBeNull();
      expect((await heldAlerts(c.clinicId)).map((a) => a.fields.code)).toEqual([
        "gate_b_not_built",
      ]);

      const text = `Gate B asks what is not built yet, so no clinic goes live: ${line}`;
      const view = await data("getOnboarding", { clinicId: c.clinicId });
      expect(view.goLive).toEqual({
        ok: false,
        missing: [text],
        codes: ["gate_b_not_built"],
        notBuilt: [line],
      });
      expect(await data("goLive", { clinicId: c.clinicId })).toEqual({
        status: "refused",
        message: "Not ready.",
        missing: [text],
      });
      // The database refuses on its own, by name.
      await expect(
        withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          tx.db.execute(sql`select app_mark_clinic_production(${c.clinicId}::uuid)`),
        ).catch((error: unknown) => Promise.reject(new Error(refusalReason(error)))),
      ).rejects.toThrow(/Gate B asks what is not built yet/);

      const facts = await readHomeFacts({ clinicId: c.clinicId, address: null, actor: ACTOR });
      expect(facts.goLive?.line).toMatch(
        /^Your part is done\. We're finishing the last checks on our side/,
      );
      const state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        readSetupState(tx, { userId: null }),
      );
      expect(
        buildTracker(state!, CALENDAR, facts.practice, facts.goLive!).stages.at(-1),
      ).toMatchObject({
        id: "go_live",
        state: "not_done",
        detail: facts.goLive!.line,
      });

      // Built, on both sides, is what opens it: the next check takes it live.
      gate.notBuilt = [];
      await setGateBCodeBuilt(true);
      expect(await codes(c.clinicId)).toEqual([]);
      await evaluate(c.clinicId);
      expect((await clinicRow(c.clinicId)).data_classification).toBe("production");
      expect(await liveAt(c.clinicId, "web")).not.toBeNull();
    } finally {
      gate.notBuilt = null;
      await setGateBCodeBuilt(false);
    }
  });
});

describeDb("automatic go-live against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform();
    // Every test below takes clinics live, so it stands in for the commit
    // that builds Gate B's code; the describe above holds today's state.
    gate.notBuilt = [];
    await setGateBCodeBuilt(true);
  }, 180_000);

  afterAll(async () => {
    gate.notBuilt = null;
    await setGateBCodeBuilt(false);
    await closePools();
  });

  test("the SQL and the TypeScript agree on what go-live waits on, fixture for fixture", async () => {
    const cases: [string, Parameters<typeof readyForGoLive>[2], string[]][] = [
      ["ready", {}, []],
      ["a hipaa practice not sure whether it is covered", { regime: "hipaa", covered: null }, []],
      ["no agreement", { version: null }, ["no_agreement"]],
      ["a superseded BAA", { version: "1.5.0" }, ["agreement_version"]],
      ["an unreleased DPA version", { kind: "dpa", version: "dpa/9.9.9" }, ["agreement_version"]],
      // Released by the owner on 20 October 2026 (drizzle/0104).
      ["the released DPA at a practice that bills no insurance", { kind: "dpa", version: "dpa/1.0.0" }, []],
      // A vet waits on Gate B until its emergency referral number is set
      // (0079), whichever agreement; the test below sets it and goes live.
      [
        "the released DPA at a vet, with no emergency referral number yet",
        { regime: "non-hipaa", kind: "dpa", version: "dpa/1.0.0" },
        ["gate_b"],
      ],
      ["the clinic's kind not the agreement's", { kind: "dpa" }, ["agreement_kind_mismatch"]],
      [
        "a DPA practice now covered",
        { kind: "dpa", covered: true, version: "dpa/1.0.0" },
        ["agreement_insufficient"],
      ],
      [
        "an unreleased DPA at a practice now covered",
        { kind: "dpa", covered: true, version: "dpa/9.9.9" },
        ["agreement_version", "agreement_insufficient"],
      ],
      [
        "a BAA at a vet",
        { regime: "non-hipaa", version: CURRENT_BAA_VERSION },
        ["agreement_insufficient", "gate_b"],
      ],
      ["the covered status open", { covered: null }, ["covered_status", "gate_b"]],
      ["no audit", { web: { audit: false } }, ["gate_b"]],
      ["the line not confirmed", { web: { runtime: false } }, ["gate_b"]],
      ["setup unfinished", { web: { setup: false } }, ["gate_b"]],
    ];
    for (const [i, [label, fixture, expected]] of cases.entries()) {
      const c = await ready(`gl-parity-${i}`, fixture);
      expect(await codes(c.clinicId), label).toEqual(expected);
    }

    // What Gate B asks of the code, not built: last, after everything else.
    const unbuilt = await ready("gl-parity-not-built", { version: "1.5.0" });
    gate.notBuilt = ["The routed/answered counter and its miss notice: Not built."];
    await setGateBCodeBuilt(false);
    try {
      expect(await codes(unbuilt.clinicId)).toEqual(["agreement_version", "gate_b_not_built"]);
    } finally {
      gate.notBuilt = [];
      await setGateBCodeBuilt(true);
    }

    // Leaving, and healdesk's own demo clinic.
    const leaving = await ready("gl-parity-leaving");
    await getMigratorPool().query(
      `update clinics set offboarding_started_at = now() where id = $1`,
      [leaving.clinicId],
    );
    expect(await codes(leaving.clinicId)).toContain("leaving");
    const demo = await seedDemoClinic("gl-parity-demo");
    await readyWebChat(demo.clinicId);
    expect(await codes(demo.clinicId)).toContain("demo");

    // The practice questions' record counts only while their gate is open.
    const practice = await ready("gl-parity-practice", { web: { audit: false } });
    await passedRun(practice.clinicId);
    await inTenant(practice.clinicId, (c) =>
      c.query(
        `insert into channel_events (clinic_id, channel, kind, actor, detail) values ($1, 'web', 'audit_passed', 'system', '{"via":"practice_questions"}')`,
        [practice.clinicId],
      ),
    );
    expect(await codes(practice.clinicId)).toEqual([]);
    await passedRun(practice.clinicId, "web", "failed");
    expect(await codes(practice.clinicId)).toEqual(["gate_b"]);
    await inTenant(practice.clinicId, (c) =>
      c.query(
        `insert into practice_question_runs (clinic_id, status, reason) values ($1, 'queued', 'knowledge')`,
        [practice.clinicId],
      ),
    );
    expect(await codes(practice.clinicId)).toEqual(["gate_b"]);

    // What the retired operator paths wrote (19 October 2026) counts in
    // neither: an attestation with no run behind it, and the script
    // approval's override, a passed run with no cases. Nor does an override
    // hide a real pass recorded before it.
    const attested = await ready("gl-parity-attested", { web: { audit: false } });
    await inTenant(attested.clinicId, (c) =>
      c.query(
        `insert into channel_events (clinic_id, channel, kind, actor, detail) values ($1, 'web', 'audit_passed', 'ops', '{"via":"ops_attested"}')`,
        [attested.clinicId],
      ),
    );
    expect(await codes(attested.clinicId)).toEqual(["gate_b"]);
    const overrideRun = (clinicId: string) =>
      inTenant(clinicId, (c) =>
        c.query(
          `insert into practice_question_runs (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, override_label)
           values ($1, 'passed', 'override', now(), now(), now(), clock_timestamp(), 'Laura Owner (recorded by ops@healdesk.test)')`,
          [clinicId],
        ),
      );
    await overrideRun(attested.clinicId);
    expect(await codes(attested.clinicId)).toEqual(["gate_b"]);
    // The old row stays the channel's one record: once the questions pass it, it goes.
    await passPracticeQuestions(attested.clinicId, ["web"]);
    expect(await codes(attested.clinicId)).toEqual([]);
    const before = await ready("gl-parity-override-after-pass");
    expect(await codes(before.clinicId)).toEqual([]);
    await overrideRun(before.clinicId);
    expect(await codes(before.clinicId)).toEqual([]);
    // Only the label marks an override, which the runtime role cannot write:
    // a real run it renames 'override' (it may update reason) is still read.
    await passedRun(before.clinicId, "web", "failed");
    expect(await codes(before.clinicId)).toEqual(["gate_b"]);
    const renamer = await getAppPool().connect();
    try {
      await renamer.query("begin");
      await renamer.query(`select set_config('app.clinic_id', $1, true)`, [before.clinicId]);
      const renamed = await renamer.query(
        `update practice_question_runs set reason = 'override' where status = 'failed'`,
      );
      expect(renamed.rowCount).toBe(1);
      await renamer.query("commit");
    } finally {
      renamer.release();
    }
    expect(await codes(before.clinicId)).toEqual(["gate_b"]);

    // The platform: one shared subject withdrawn is go-live's own code; a
    // channel's own is Gate B's. Restored after, for the tests below.
    const shared = await ready("gl-parity-platform");
    await withdrawPlatform(["anthropic"]);
    expect(await codes(shared.clinicId)).toEqual(["platform"]);
    await attestPlatform(["anthropic"]);
    await withdrawPlatform(["runtime_web"]);
    expect(await codes(shared.clinicId)).toEqual(["gate_b"]);
    await attestPlatform(["runtime_web"]);
    expect(await codes(shared.clinicId)).toEqual([]);
  });

  test("the SQL copies of the catalog's rules agree with it: the version by its kind, the subjects, an attestation's standing", async () => {
    for (const version of [
      ...BAA_TEMPLATES.map((t) => t.version),
      ...DPA_TEMPLATES.map((t) => t.version),
      "dpa/9.9.9",
      "9.9.9",
      "",
    ]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean; dpa: boolean }>(
        `select app_agreement_version_acceptable($1) as ok, app_dpa_version_released($1) as dpa`,
        [version],
      );
      expect(rows[0]!.ok, version).toBe(agreementTemplateReleased(version));
      if (version.startsWith("dpa/"))
        expect(rows[0]!.dpa, version).toBe(agreementTemplateReleased(version));
    }
    for (const channel of [null, ...CHANNELS] as (Channel | null)[]) {
      const { rows } = await getMigratorPool().query<{ s: string[] }>(
        `select app_platform_subjects_for($1) as s`,
        [channel],
      );
      expect(rows[0]!.s, String(channel)).toEqual([...subjectsFor(channel)]);
    }
    // An attestation that lapsed yesterday counts in neither.
    await attestPlatform(["retell"], { effectiveOn: "2020-01-01", expiresOn: "2020-01-02" });
    const status = await readPlatformCompliance(unsafeDb);
    const { rows } = await getMigratorPool().query<{ subject: string; ok: boolean }>(
      `select s as subject, app_platform_attested(s) as ok from unnest($1::text[]) as s`,
      [[...PLATFORM_SUBJECTS]],
    );
    for (const row of rows)
      expect(row.ok, row.subject).toBe(status[row.subject as PlatformSubject].attested);
    expect(status.retell).toMatchObject({ attested: false, lapsed: true });
    await attestPlatform(["retell"]);
  });

  test("the practice questions' pass takes a ready clinic to production and its channel live, with no operator step", async () => {
    const c = await ready("gl-pass", { web: { audit: false } });
    expect(await codes(c.clinicId)).toEqual(["gate_b"]);
    const runId = await passedRun(c.clinicId);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      afterPass(tx, {
        runId,
        inputVersion: "a".repeat(64),
        agentVersion: null,
        slug: c.slug,
        channels: ["web"],
        now: new Date(),
        talkToAyaBuilt: false,
      }),
    );
    const row = await clinicRow(c.clinicId);
    expect(row.data_classification).toBe("production");
    expect(row.baa_signed_at).not.toBeNull();
    expect(await liveAt(c.clinicId, "web")).not.toBeNull();
    expect(await wentLiveEvents(c.slug)).toEqual([
      {
        actor_label: "healdesk (automatic go-live)",
        metadata: { clinicSlug: c.slug, via: "practice_questions", baaSigned: true },
      },
    ]);
    const { rows: notices } = await inTenant(c.clinicId, (cl) =>
      cl.query(`select dedupe_key from billing_notices where kind = 'channel_live'`),
    );
    expect(notices).toEqual([{ dedupe_key: "channel_live:web" }]);
    // The purge follows the agreement in effect, which states it: nothing to switch on.
    expect(purgeIsPromised(CURRENT_BAA_VERSION)).toBe(true);
    expect(await heldAlerts(c.clinicId)).toEqual([]);
  });

  test("since the DPA's release, a vet and a practice that bills no insurance go live under it, with no operator step", async () => {
    // docs/counsel/dpa.md, gap 11: the release's migration (0104) lets
    // go-live admit dpa/1.0.0, as agreementTemplateReleased does.
    for (const [label, fixture] of [
      ["gl-dpa-vet", { regime: "non-hipaa", kind: "dpa", version: "dpa/1.0.0" }],
      ["gl-dpa-no", { regime: "hipaa-if-covered", kind: "dpa", covered: false, version: "dpa/1.0.0" }],
    ] as const) {
      const c = await ready(label, { ...fixture, web: { audit: false } });
      if (fixture.regime === "non-hipaa") {
        // A vet's website chat answers only with an emergency referral number (0079).
        await inTenant(c.clinicId, (client) =>
          client.query(
            `insert into clinic_settings (clinic_id, vet_referral_e164) values ($1, $2)
             on conflict (clinic_id) do update set vet_referral_e164 = excluded.vet_referral_e164`,
            [c.clinicId, "+14155550911"],
          ),
        );
      }
      expect(await codes(c.clinicId), label).toEqual(["gate_b"]);
      const runId = await passedRun(c.clinicId);
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        afterPass(tx, {
          runId,
          inputVersion: "a".repeat(64),
          agentVersion: null,
          slug: c.slug,
          channels: ["web"],
          now: new Date(),
          talkToAyaBuilt: false,
        }),
      );
      const row = await clinicRow(c.clinicId);
      expect(row.data_classification, label).toBe("production");
      expect(row.baa_signed_at, label).not.toBeNull();
      expect(await liveAt(c.clinicId, "web"), label).not.toBeNull();
      expect(await heldAlerts(c.clinicId), label).toEqual([]);
    }
    // The purge follows the DPA, which states it.
    expect(purgeIsPromised("dpa/1.0.0")).toBe(true);
  });

  test("a refusal leaves the clinic as it is and says why: to ops once, to the console and on Home; the sweep goes live once it can", async () => {
    const c = await ready("gl-held");
    await withdrawPlatform(["launch_promises"]);
    try {
      await evaluate(c.clinicId);
      await evaluate(c.clinicId);
      expect((await clinicRow(c.clinicId)).data_classification).toBe("synthetic");
      expect(await liveAt(c.clinicId, "web")).toBeNull();
      const alerts = await heldAlerts(c.clinicId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.fields).toMatchObject({ clinicId: c.clinicId, code: "platform" });

      // The console: the onboarding view and "Check go-live now".
      const view = await data("getOnboarding", { clinicId: c.clinicId });
      expect(view.goLive).toMatchObject({
        ok: false,
        codes: ["platform"],
        missing: ["Not attested on /admin/compliance: Launch promises."],
      });
      expect(await data("goLive", { clinicId: c.clinicId })).toEqual({
        status: "refused",
        message: "Not ready.",
        missing: ["Not attested on /admin/compliance: Launch promises."],
      });

      // Home: the tracker's "Going live", in the practice's words.
      const facts = await readHomeFacts({ clinicId: c.clinicId, address: null, actor: ACTOR });
      expect(facts.goLive).toEqual({
        production: false,
        line: "Your part is done. We're finishing the last checks on our side before AYA answers anyone, and she goes live without anything more from you.",
      });
      const state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        readSetupState(tx, { userId: null }),
      );
      const tracker = buildTracker(state!, CALENDAR, facts.practice, facts.goLive!);
      expect(tracker.stages.at(-1)).toEqual({
        id: "go_live",
        label: "Going live",
        state: "not_done",
        detail: facts.goLive!.line,
        blocks: false,
      });
      // Talk to your AYA never waits on it.
      expect(buildTracker(state!, CALENDAR, facts.practice).left).toEqual(tracker.left);
    } finally {
      await attestPlatform(["launch_promises"]);
    }
    const summary = await sweepChannelStates();
    expect(summary.failures).toBe(0);
    expect((await clinicRow(c.clinicId)).data_classification).toBe("production");
    expect(await liveAt(c.clinicId, "web")).not.toBeNull();
    expect((await wentLiveEvents(c.slug))[0]!.metadata).toMatchObject({ via: "sweep" });
  });

  test("going live waits on no transaction that only references the clinic: a call being recorded while it flips, and both finish", async () => {
    // healdesk-io-58's review: a transaction that inserted a row referencing
    // the clinic (a conversation at voice ingest, a connection in
    // attachMetaChannel) holds FOR KEY SHARE on the clinic until it commits,
    // and then asks for the channel rows. Go-live holds the channel rows and
    // locks the clinic. Under FOR UPDATE the two waited on each other and
    // Postgres aborted one; the flip changes no key, so FOR NO KEY UPDATE.
    const c = await ready("gl-locks");
    const call = await getAppPool().connect();
    const flip = await getAppPool().connect();
    const tenant = `select set_config('app.clinic_id', $1, true)`;
    const lockChannels = `select channel from clinic_channels where clinic_id = $1 order by channel for update`;
    try {
      await call.query("begin");
      await call.query(tenant, [c.clinicId]);
      await call.query(
        `insert into conversations (clinic_id, channel, started_at) values ($1, 'web_chat', now())`,
        [c.clinicId],
      );
      await flip.query("begin");
      await flip.query(tenant, [c.clinicId]);
      await flip.query(lockChannels, [c.clinicId]);
      const flipped = flip.query(`select app_mark_clinic_production($1::uuid) as signed`, [
        c.clinicId,
      ]);
      const calling = call.query(lockChannels, [c.clinicId]);
      const signed = await flipped;
      expect(signed.rows[0]!.signed).toBeInstanceOf(Date);
      await flip.query("commit");
      await expect(calling).resolves.toMatchObject({ rows: [{ channel: "web" }] });
      await call.query("commit");
    } finally {
      await flip.query("rollback").catch(() => {});
      await call.query("rollback").catch(() => {});
      flip.release();
      call.release();
    }
    expect((await clinicRow(c.clinicId)).data_classification).toBe("production");
  });

  test("nothing takes a live channel offline: a withdrawn attestation holds back only what has not gone live", async () => {
    const c = await ready("gl-offline");
    await evaluate(c.clinicId);
    const webLive = await liveAt(c.clinicId, "web");
    expect(webLive).not.toBeNull();

    // Phone bought later, with everything but Retell's agreement.
    await seedChannels(c.clinicId, [{ channel: "voice" }]);
    await setWeekdayHours(c.clinicId);
    await getMigratorPool().query(
      `update clinics set assistant_number_e164 = '+15125550142', onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('hours_confirmed', now()::text),
              forwarding_test_observed = jsonb_build_object('arrivedAt', now()::text, 'windowUntil', now()::text, 'conversationId', gen_random_uuid()::text, 'callerIdPreserved', true, 'condition', 'no_answer')
        where id = $1`,
      [c.clinicId],
    );
    await inTenant(c.clinicId, async (cl) => {
      await cl.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550123')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [c.clinicId],
      );
    });
    await passPracticeQuestions(c.clinicId, ["voice"]);
    await finishWizard(c.clinicId);
    await withdrawPlatform(["retell", "anthropic"]);
    try {
      const moved = await evaluate(c.clinicId);
      expect(moved.find((m) => m.channel === "voice")).toMatchObject({
        wentLive: false,
        missing: ["platform"],
      });
      expect(moved.find((m) => m.channel === "web")).toMatchObject({
        wentLive: false,
        missing: [],
      });
      expect(await liveAt(c.clinicId, "web")).toEqual(webLive);
      expect(await liveAt(c.clinicId, "voice")).toBeNull();
      expect((await clinicRow(c.clinicId)).data_classification).toBe("production");
      // The database agrees: phone may not go live.
      const { rows } = await inTenant(c.clinicId, (cl) =>
        cl.query<{ ok: boolean }>(`select app_channel_live_ok($1, 'voice') as ok`, [c.clinicId]),
      );
      expect(rows[0]!.ok).toBe(false);
    } finally {
      await attestPlatform(["retell", "anthropic"]);
    }
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({ wentLive: true });
  });

  test("a demo clinic never goes live by itself, and no one is told it didn't", async () => {
    const demo = await seedDemoClinic("gl-demo");
    await readyWebChat(demo.clinicId);
    await evaluate(demo.clinicId);
    expect((await clinicRow(demo.clinicId)).data_classification).toBe("synthetic");
    expect(await heldAlerts(demo.clinicId)).toEqual([]);
    expect(await data("goLive", { clinicId: demo.clinicId })).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/demo clinic/),
    });
  });

  test("an agreement that needs signing again is told to ops even before the clinic's part is done", async () => {
    const c = await ready("gl-agreement", { version: "1.4.0", web: { runtime: false } });
    await evaluate(c.clinicId);
    expect((await heldAlerts(c.clinicId)).map((a) => a.fields.code)).toEqual(["agreement_version"]);
    const facts = await readHomeFacts({ clinicId: c.clinicId, address: null, actor: ACTOR });
    expect(facts.goLive?.line).toMatch(/signed again/);
  });

  test("a superseded agreement is refused in the console's words and the database's; once the current one is bound, go-live follows", async () => {
    const c = await ready("gl-superseded", { version: "1.0.0" });
    const superseded = `The agreement in effect is BAA v1.0.0, which has been superseded. The practice must accept v${CURRENT_BAA_VERSION} before go-live.`;
    expect(await data("goLive", { clinicId: c.clinicId })).toEqual({
      status: "refused",
      message: "Not ready.",
      missing: [superseded],
    });
    // The database refuses on its own, and its sentence, not drizzle's
    // "Failed query", is what the console would show.
    const refused = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      tx.db
        .transaction((sp) =>
          sp.execute(sql`select app_mark_clinic_production(${c.clinicId}::uuid)`),
        )
        .then(
          () => null,
          (error: unknown) => error,
        ),
    );
    const reason = refusalReason(refused);
    expect(reason).toContain(
      "version 1.0.0, which has been superseded; refusing to mark it production.",
    );
    expect(reason).toContain("The practice accepts the current agreement first");
    expect(reason).not.toMatch(/Failed query/);
    expect((await clinicRow(c.clinicId)).data_classification).toBe("synthetic");

    // Re-accepted and bound (as the migrator: the re-acceptance path is
    // WP9's), it is the agreement in effect; the operator's check goes live.
    await setAgreement(c.clinicId, c.organizationId);
    expect(await data("goLive", { clinicId: c.clinicId })).toMatchObject({ status: "live" });
    expect(await wentLiveEvents(c.slug)).toEqual([
      {
        actor_label: OPERATOR.email,
        metadata: { clinicSlug: c.slug, via: "operator", baaSigned: true },
      },
    ]);
    expect(await liveAt(c.clinicId, "web")).not.toBeNull();
    expect(await data("goLive", { clinicId: c.clinicId })).toMatchObject({
      status: "refused",
      message: "Already in production.",
    });
  });

  test("phone can't go live without a direct line: Gate B says so, in both", async () => {
    // CLAUDE.md, "Failure": every call AYA can't answer goes to the direct
    // line. The wizard lets it be skipped and says phone can't go live
    // without it; go-live holds that through phone's own Gate B.
    const c = await seedClinic("gl-line");
    await setAgreement(c.clinicId, c.organizationId);
    await seedChannels(c.clinicId, [{ channel: "voice" }]);
    await finishWizard(c.clinicId);
    await setWeekdayHours(c.clinicId);
    await getMigratorPool().query(
      `update clinics set assistant_number_e164 = '+15125550143', onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('hours_confirmed', now()::text),
              forwarding_test_observed = jsonb_build_object('arrivedAt', now()::text, 'windowUntil', now()::text, 'conversationId', gen_random_uuid()::text, 'callerIdPreserved', true, 'condition', 'no_answer')
        where id = $1`,
      [c.clinicId],
    );
    await passPracticeQuestions(c.clinicId, ["voice"]);
    expect(await codes(c.clinicId)).toEqual(["gate_b"]);
    const view = await data("getOnboarding", { clinicId: c.clinicId });
    expect((view.goLive as { missing: string[] }).missing[0]).toBe(
      "No channel meets Gate B yet. Phone waits on a direct line.",
    );
    await inTenant(c.clinicId, (cl) =>
      cl.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550190')`,
        [c.clinicId],
      ),
    );
    expect(await codes(c.clinicId)).toEqual([]);
    expect((await evaluate(c.clinicId, "voice"))[0]).toMatchObject({ wentLive: true });
  });
});

describeDb("platform_compliance: the table and the ops envelope", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("the runtime role reads and appends, never rewrites or erases, and never writes from inside a tenant", async () => {
    const { clinicId } = await seedClinic("gl-pc-grants");
    const insert = `insert into platform_compliance (subject, action, document_ref, effective_on, actor_label)
                    values ('aws', 'attested', 'AWS Artifact, account agreements', current_date, 'ops@healdesk.test')`;
    await getAppPool().query(insert);
    const client = await getAppPool().connect();
    try {
      for (const statement of [
        `update platform_compliance set document_ref = 'rewritten'`,
        `delete from platform_compliance`,
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
      await expect(client.query(insert)).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/outside any tenant/),
      });
      await client.query("rollback");
      // What it may not hold: a subject off the list, an expiry on a
      // withdrawal, a reference over more than one line.
      for (const statement of [
        `insert into platform_compliance (subject, action, document_ref, effective_on, actor_label) values ('meta', 'attested', 'x', current_date, 'ops')`,
        `insert into platform_compliance (subject, action, document_ref, effective_on, expires_on, actor_label) values ('aws', 'withdrawn', 'x', current_date, current_date, 'ops')`,
        `insert into platform_compliance (subject, action, document_ref, effective_on, actor_label) values ('aws', 'attested', E'two\\nlines', current_date, 'ops')`,
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      client.release();
    }
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from platform_compliance`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  test("the envelope lists every subject with what it attests and what Gate B names, and records an attestation with the operator's address", async () => {
    const view = await data("listPlatformCompliance", {});
    const subjects = view.subjects as {
      subject: string;
      kind: string;
      channels: unknown;
      attested: boolean;
    }[];
    expect(subjects.map((s) => s.subject)).toEqual([...PLATFORM_SUBJECTS]);
    expect(subjects.find((s) => s.subject === "retell")).toMatchObject({
      kind: "vendor",
      channels: ["voice"],
    });
    expect(subjects.find((s) => s.subject === "anthropic")).toMatchObject({
      kind: "vendor",
      channels: "all",
    });
    expect(subjects.find((s) => s.subject === "voice_pass_through")).toMatchObject({
      kind: "readiness",
    });
    expect((view.gateB as { id: string }[]).map((g) => g.id)).toContain("routed_answered_counter");

    const today = new Date().toISOString().slice(0, 10);
    expect(
      await data("attestPlatformCompliance", {
        subject: "anthropic",
        documentRef: "Anthropic BAA, countersigned, legal drive",
        effectiveOn: today,
      }),
    ).toEqual({ status: "recorded", subject: "anthropic", attested: true, auditRecorded: true });
    const { rows } = await getMigratorPool().query<{ actor_label: string; metadata: unknown }>(
      `select actor_label, metadata from security_events where event = 'platform_compliance_attested'`,
    );
    expect(rows).toEqual([{ actor_label: OPERATOR.email, metadata: { subject: "anthropic" } }]);
    const { rows: stored } = await getMigratorPool().query(
      `select subject, action, document_ref, expires_on, actor_label from platform_compliance where subject = 'anthropic'`,
    );
    expect(stored).toEqual([
      {
        subject: "anthropic",
        action: "attested",
        document_ref: "Anthropic BAA, countersigned, legal drive",
        expires_on: null,
        actor_label: OPERATOR.email,
      },
    ]);

    expect(
      await data("withdrawPlatformCompliance", {
        subject: "anthropic",
        documentRef: "Agreement ended",
        effectiveOn: today,
      }),
    ).toMatchObject({ status: "recorded", attested: false });
    const after = await data("listPlatformCompliance", {});
    expect((after.history as { subject: string; action: string }[]).slice(0, 2)).toMatchObject([
      { subject: "anthropic", action: "withdrawn" },
      { subject: "anthropic", action: "attested" },
    ]);
  });

  test("the envelope refuses what isn't an attestation: an unknown subject, a day ahead or a lapsed expiry, a withdrawal of nothing, and the launch promises while one is open", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const refusals: [string, Record<string, unknown>, RegExp][] = [
      [
        "attestPlatformCompliance",
        { subject: "meta", documentRef: "x", effectiveOn: today },
        /isn't something/,
      ],
      [
        "attestPlatformCompliance",
        { subject: "aws", documentRef: " ", effectiveOn: today },
        /where the document is kept/,
      ],
      [
        "attestPlatformCompliance",
        { subject: "aws", documentRef: "x", effectiveOn: tomorrow },
        /no later than today/,
      ],
      [
        "attestPlatformCompliance",
        { subject: "aws", documentRef: "x", effectiveOn: "2026-02-30" },
        /YYYY-MM-DD/,
      ],
      [
        "attestPlatformCompliance",
        { subject: "aws", documentRef: "x", effectiveOn: today, expiresOn: "2020-01-01" },
        /no earlier than today/,
      ],
      [
        "withdrawPlatformCompliance",
        { subject: "retell", documentRef: "x", effectiveOn: today },
        /nothing to withdraw/,
      ],
      [
        "attestPlatformCompliance",
        { subject: "launch_promises", documentRef: "x", effectiveOn: today },
        /must say which launch promises/,
      ],
      [
        "attestPlatformCompliance",
        {
          subject: "launch_promises",
          documentRef: "x",
          effectiveOn: today,
          openLaunchPromises: ["no-audio"],
        },
        /still open \(no-audio\)/,
      ],
    ];
    for (const [op, args, message] of refusals) {
      expect(await data(op as never, args), `${op} ${JSON.stringify(args)}`).toEqual({
        status: "refused",
        message: expect.stringMatching(message),
      });
    }
    expect(
      await data("attestPlatformCompliance", {
        subject: "launch_promises",
        documentRef: "/admin/seo: every blocking item on",
        effectiveOn: today,
        openLaunchPromises: [],
      }),
    ).toMatchObject({ status: "recorded", attested: true });
  });
});

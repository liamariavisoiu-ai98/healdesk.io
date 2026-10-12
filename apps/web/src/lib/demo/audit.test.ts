import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AUDIT_WEIGHTS,
  auditDemo,
  AuditUnavailableError,
  buildProbes,
  checkDemo,
  decide,
  demoFingerprint,
  overallScore,
  verifyEvidence,
  type AuditDimension,
  type AuditIssue,
  type ProbeResult,
} from "./audit";
import { normalizeProfile, type ClinicProfile } from "./profile";

/**
 * The handoff audit (lib/demo/audit.ts). What these pin: the threshold the
 * owner agreed, band by band; the deterministic checks that hold a demo with
 * no model involved; the evidence rule that stops a model blocker without a
 * quote from holding a good demo; and that an audit which cannot run never
 * returns a verdict.
 */

const PROFILE: ClinicProfile = normalizeProfile(
  {
    clinic_name: "Smith Dental",
    summary: "Family and cosmetic dentistry in Austin.",
    specialty: "dental",
    phone: "(512) 555-0100",
    address: "1 Congress Ave, Austin, TX",
    hours: [{ days: "Mon–Fri", hours: "8am–5pm" }],
    services: [
      { name: "Teeth whitening", description: "In-office whitening", price: "$399", duration: "60 min" },
      { name: "Invisalign", description: "", price: "from $1,200", duration: "" },
    ],
    providers: [{ name: "Dr. Jane Smith", title: "DDS" }],
    faqs: [{ question: "Do you have parking?", answer: "Yes, free parking behind the building." }],
    policies: ["24 hours' notice to cancel."],
    booking: "Online booking through the website.",
    highlights: [],
  },
  "Smith Dental",
);

const ENV = { RETELL_API_KEY: "key", RETELL_CLINIC_DEMO_AGENT_ID: "agent", ANTHROPIC_API_KEY: "x" };

function scores(n: number, overrides: Partial<Record<AuditDimension, number>> = {}): Record<AuditDimension, number> {
  return { accuracy: n, conversation: n, personalisation: n, voice: n, presentation: n, ...overrides };
}

const BLOCKER: AuditIssue = {
  severity: "blocker",
  code: "invented_fact",
  dimension: null,
  evidence: "x",
  where: "profile",
  problem: "p",
  source: "model",
};

function probes(answer: (id: string) => string = () => "We're open Mon–Fri, 8am–5pm."): ProbeResult[] {
  return buildProbes(PROFILE).map((p) => ({ ...p, answer: answer(p.id), outcome: "ok" as const }));
}

describe("the threshold", () => {
  const at = (overall: number, extra: { blockers?: AuditIssue[]; low?: Partial<Record<AuditDimension, number>> } = {}) => ({
    overall,
    scores: scores(overall, extra.low),
    blockers: extra.blockers ?? [],
  });

  it("weights the five dimensions to 100", () => {
    expect(Object.values(AUDIT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(overallScore(scores(80, { accuracy: 50 }))).toBe(71);
  });

  it("ships at 80 with no blockers and no dimension under 60", () => {
    expect(decide(at(80), { canRepair: true })).toBe("pass");
    expect(decide(at(95), { canRepair: false })).toBe("pass");
  });

  it("repairs a near miss once, then ships it flagged from 70", () => {
    expect(decide(at(75), { canRepair: true })).toBe("repair");
    expect(decide(at(75), { canRepair: false })).toBe("flagged");
    expect(decide(at(85, { low: { voice: 50 } }), { canRepair: true })).toBe("repair");
    expect(decide(at(85, { low: { voice: 50 } }), { canRepair: false })).toBe("flagged");
  });

  it("holds below 70, and below 65 without trying a repair", () => {
    expect(decide(at(67), { canRepair: true })).toBe("repair");
    expect(decide(at(67), { canRepair: false })).toBe("held");
    expect(decide(at(60), { canRepair: true })).toBe("held");
  });

  it("never ships a demo with a blocker, whatever its score", () => {
    expect(decide(at(95, { blockers: [BLOCKER] }), { canRepair: true })).toBe("repair");
    expect(decide(at(95, { blockers: [BLOCKER] }), { canRepair: false })).toBe("held");
  });
});

describe("the deterministic checks", () => {
  it("pass a clean demo", () => {
    expect(checkDemo(PROFILE, probes(), ENV).filter((i) => i.severity === "blocker")).toEqual([]);
  });

  it("accept a price the site lists, however it is written", () => {
    const issues = checkDemo(PROFILE, probes(() => "Whitening is $399.00 and Invisalign starts from $1200, as the website lists."), ENV);
    expect(issues.filter((i) => i.code === "off_menu_price")).toEqual([]);
  });

  it("hold a price the site does not list, quoting the sentence", () => {
    const issues = checkDemo(PROFILE, probes((id) => (id === "off-menu-price" ? "Hair transplants are $4,500. Want to book?" : "Sure.")), ENV);
    const priced = issues.filter((i) => i.code === "off_menu_price");
    expect(priced).toHaveLength(1);
    expect(priced[0]!.evidence).toBe("Hair transplants are $4,500.");
  });

  it("hold a demo whose chat mostly does not answer", () => {
    const silent = probes().map((p, i) => (i % 2 === 0 ? { ...p, answer: "", outcome: "refused" as const } : p));
    expect(checkDemo(PROFILE, silent, ENV).some((i) => i.code === "broken" && i.where === "chat")).toBe(true);
    const oneOff = probes().map((p, i) => (i === 0 ? { ...p, answer: "", outcome: "empty" as const } : p));
    const issues = checkDemo(PROFILE, oneOff, ENV);
    expect(issues.some((i) => i.severity === "blocker")).toBe(false);
    expect(issues.some((i) => i.severity === "fix" && i.dimension === "conversation")).toBe(true);
  });

  it("hold template debris and a voice demo this deployment cannot start", () => {
    expect(checkDemo(PROFILE, probes(() => "Our hours are undefined."), ENV).some((i) => i.code === "broken")).toBe(true);
    const unconfigured = checkDemo(PROFILE, probes(), { ANTHROPIC_API_KEY: "x" });
    expect(unconfigured.find((i) => i.where === "voice")?.problem).toMatch(/RETELL_API_KEY and RETELL_CLINIC_DEMO_AGENT_ID/);
  });

  it("ask the off-menu price about something the clinic does not offer", () => {
    const offMenu = buildProbes(PROFILE).find((p) => p.id === "off-menu-price")!;
    expect(offMenu.question).toContain("hair transplant");
    const implants = normalizeProfile({ ...PROFILE, clinic_name: "X", services: [{ name: "Hair transplant" }] }, "X");
    expect(buildProbes(implants).find((p) => p.id === "off-menu-price")!.question).toContain("dental implants");
  });
});

describe("the evidence rule", () => {
  const material = "Thank you for calling Smith Dental. This is the clinic’s AI assistant.\nWhitening is $399.";

  it("keeps a blocker that quotes the demo, through curly quotes and spacing", () => {
    const { kept, downgraded } = verifyEvidence(
      [{ code: "invented_fact", evidence: "this is the clinic's   AI assistant", where: "voice", problem: "p" }],
      material,
    );
    expect(kept).toHaveLength(1);
    expect(downgraded).toEqual([]);
  });

  it("downgrades a blocker with no quote, or one the demo never said, to a finding", () => {
    const { kept, downgraded } = verifyEvidence(
      [
        { code: "invented_fact", evidence: "", where: "profile", problem: "made up" },
        { code: "off_menu_price", evidence: "Botox is $9 a unit", where: "chat", problem: "made up" },
      ],
      material,
    );
    expect(kept).toEqual([]);
    expect(downgraded.map((d) => [d.severity, d.dimension])).toEqual([
      ["fix", "accuracy"],
      ["fix", "accuracy"],
    ]);
  });
});

describe("the fingerprint", () => {
  it("survives the trip through the Sheet, and changes with the profile", () => {
    const stored = normalizeProfile(JSON.parse(JSON.stringify(PROFILE)), "Smith Dental");
    expect(demoFingerprint(stored)).toBe(demoFingerprint(PROFILE));
    expect(demoFingerprint({ ...PROFILE, phone: "(512) 555-0199" })).not.toBe(demoFingerprint(PROFILE));
  });
});

describe("one audit round", () => {
  type Grade = { scores: Record<AuditDimension, number>; blockers: unknown[]; findings: unknown[]; summary: string };

  function fakeClient(grade: Grade | Error, answer = "We're open Mon–Fri, 8am–5pm.") {
    const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
    return {
      beta: {
        messages: {
          create: async () => text(answer),
          stream: () => ({
            finalMessage: async () => {
              if (grade instanceof Error) throw grade;
              return text(JSON.stringify(grade));
            },
          }),
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
  }

  const input = { profile: PROFILE, operatorName: "Smith Dental", pages: [{ url: "https://smithdental.com/", title: "Home", text: "Smith Dental" }], round: 0 as const, canRepair: true };

  it("passes a good demo, and ignores a blocker the model could not quote", async () => {
    const report = await auditDemo(input, {
      env: ENV,
      client: fakeClient({
        scores: scores(88),
        blockers: [{ code: "invented_fact", evidence: "Dr. Who, MD", where: "profile", problem: "unsupported provider" }],
        findings: [],
        summary: "Good.",
      }),
    });
    expect(report.decision).toBe("pass");
    expect(report.overall).toBe(88);
    expect(report.blockers).toEqual([]);
    expect(report.findings.some((f) => f.problem.includes("without a quote"))).toBe(true);
    expect(report.probes).toHaveLength(10);
  });

  it("asks for a repair when a quoted blocker stands", async () => {
    const report = await auditDemo(input, {
      env: ENV,
      client: fakeClient({
        scores: scores(88),
        blockers: [{ code: "invented_fact", evidence: "Dr. Jane Smith, DDS", where: "profile: providers", problem: "not on the site" }],
        findings: [],
        summary: "",
      }),
    });
    expect(report.blockers).toHaveLength(1);
    expect(report.decision).toBe("repair");
  });

  it("throws rather than returning a verdict when the grade cannot run", async () => {
    await expect(auditDemo(input, { env: ENV, client: fakeClient(new Error("overloaded")) })).rejects.toBeInstanceOf(AuditUnavailableError);
    await expect(auditDemo(input, { env: { RETELL_API_KEY: "k" } })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("refuses to start with too little of the build's time left, rather than be cut off mid-audit", async () => {
    const client = fakeClient({ scores: scores(90), blockers: [], findings: [], summary: "" });
    await expect(auditDemo({ ...input, deadline: Date.now() + 10_000 }, { env: ENV, client })).rejects.toThrow(/too little time/);
  });
});

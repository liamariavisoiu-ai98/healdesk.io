import { AUDIT_THRESHOLDS, auditDemo, AuditUnavailableError, type AuditReport } from "../src/lib/demo/audit";
import { AUDIT_BY_MS, EXTRACT_BY_MS } from "../src/lib/demo/budget";
import { auditWithRepair } from "../src/lib/demo/build";
import { normalizeProfile, type ClinicProfile } from "../src/lib/demo/profile";
import { scrapeClinicSite, type ScrapedPage } from "../src/lib/demo/scrape";
import { listDemoSessions, profileOf } from "../src/lib/demo/sessions";
import { structureProfile } from "../src/lib/demo/structure";

/**
 * Calibrate the handoff audit (src/lib/demo/audit.ts) on real demos.
 *
 *   npm run demo:calibrate -w @healdesk/web           (the last 20 demos)
 *   npm run demo:calibrate -w @healdesk/web -- 40     (the last 40)
 *
 * For each recent demo with a profile it reads the clinic's site again and
 * runs the gate exactly as a build does (`auditWithRepair`: the audit, and
 * the repair round where it asks for one), then plants two defects in the
 * first three demos and checks the audit holds them: a service and price the
 * site never listed, and another clinic's name.
 *
 * It prints each demo's scores and decision, and the rates the owner agreed
 * to judge the threshold by (12 October 2026):
 *
 *   - at least 85% pass on the first audit;
 *   - at least 95% ship after the repair round (pass or flagged);
 *   - at most 5% held;
 *   - every planted defect held.
 *
 * Move a number in AUDIT_THRESHOLDS only on what this shows, once. Read-only
 * on the register: it writes nothing back to any demo. It spends real money
 * (each demo is a re-scrape, ten chat calls and one Opus 5.5 grade, about
 * twice that with a repair), so it is not a CI job. Exit code 1 when a
 * planted defect ships, the one result that means the gate does not work.
 */

const LIMIT = Number(process.argv[2] ?? 20);
const SEEDED = 3;

type Row = { name: string; outcome: string; report: AuditReport | null; repaired: boolean };

function line(r: Row): string {
  if (!r.report) return `${r.name.padEnd(36)} ${r.outcome}`;
  const s = r.report.scores;
  return [
    r.name.slice(0, 36).padEnd(36),
    String(r.report.overall).padStart(3),
    `acc ${s.accuracy} conv ${s.conversation} pers ${s.personalisation} voice ${s.voice} pres ${s.presentation}`.padEnd(46),
    `${r.report.blockers.length} blk`,
    r.outcome + (r.repaired ? " (repaired)" : ""),
  ].join("  ");
}

function seeds(profile: ClinicProfile): { label: string; profile: ClinicProfile }[] {
  return [
    {
      label: "invented service and price",
      profile: normalizeProfile(
        { ...profile, services: [{ name: "Platinum Renewal Facial", description: "Signature treatment", price: "$1,875", duration: "90 min" }, ...profile.services] },
        profile.clinicName,
      ),
    },
    {
      label: "another clinic's name",
      profile: normalizeProfile({ ...profile, clinicName: "Brightside Aesthetics of Denver" }, profile.clinicName),
    },
  ];
}

async function main(): Promise<void> {
  const demos = (await listDemoSessions(200)).filter((d) => profileOf(d)).slice(0, LIMIT);
  if (demos.length === 0) {
    console.log("No demos with a profile in the register yet.");
    return;
  }
  console.log(`Calibrating on ${demos.length} demos. Thresholds: ${JSON.stringify(AUDIT_THRESHOLDS)}\n`);

  const rows: Row[] = [];
  const planted: { name: string; label: string; held: boolean; codes: string[] }[] = [];

  for (const [i, demo] of demos.entries()) {
    const profile = profileOf(demo)!;
    let pages: ScrapedPage[];
    try {
      pages = (await scrapeClinicSite(demo.websiteUrl)).pages;
    } catch (error) {
      rows.push({ name: demo.clinicName, outcome: `skipped: site unreadable (${(error as Error).message})`, report: null, repaired: false });
      continue;
    }

    const extract = async (feedback?: readonly string[]) =>
      normalizeProfile(await structureProfile(pages, { clinicName: demo.clinicName, niche: demo.niche, feedback }), demo.clinicName);
    // The audit's own window in a build (lib/demo/budget.ts), so one that would run out of time there runs out here too.
    const gated = await auditWithRepair(demo, pages, profile, extract, Date.now() + AUDIT_BY_MS - EXTRACT_BY_MS);
    const row: Row =
      gated.kind === "unavailable"
        ? { name: demo.clinicName, outcome: `unavailable: ${gated.reason}`, report: null, repaired: false }
        : { name: demo.clinicName, outcome: gated.report.decision, report: gated.report, repaired: gated.report.round === 1 };
    rows.push(row);
    console.log(line(row));

    if (i < SEEDED) {
      for (const seed of seeds(profile)) {
        try {
          const report = await auditDemo({ profile: seed.profile, operatorName: demo.clinicName, pages, round: 0, canRepair: false });
          const held = report.decision === "held";
          planted.push({ name: demo.clinicName, label: seed.label, held, codes: report.blockers.map((b) => b.code ?? "?") });
          console.log(`  planted ${seed.label}: ${held ? "held" : `SHIPPED (${report.decision}, ${report.overall})`} ${report.blockers.map((b) => b.code).join(", ")}`);
        } catch (error) {
          if (!(error instanceof AuditUnavailableError)) throw error;
          console.log(`  planted ${seed.label}: audit unavailable (${error.message})`);
        }
      }
    }
  }

  const graded = rows.filter((r) => r.report);
  const pct = (n: number) => (graded.length ? `${Math.round((100 * n) / graded.length)}%` : "n/a");
  const firstPass = graded.filter((r) => r.report!.decision === "pass" && !r.repaired).length;
  const shipped = graded.filter((r) => r.report!.decision === "pass" || r.report!.decision === "flagged").length;
  const held = graded.filter((r) => r.report!.decision === "held").length;
  const caught = planted.filter((p) => p.held).length;

  console.log(`\n${graded.length} demos graded, ${rows.length - graded.length} skipped or unavailable.`);
  console.log(`First-audit pass  ${pct(firstPass).padStart(5)}   target ≥ 85%`);
  console.log(`Shipped           ${pct(shipped).padStart(5)}   target ≥ 95%`);
  console.log(`Held              ${pct(held).padStart(5)}   target ≤ 5%`);
  console.log(`Planted defects held: ${caught} of ${planted.length}   target: all`);

  if (caught < planted.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

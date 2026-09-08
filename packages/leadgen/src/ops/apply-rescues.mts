/**
 * Apply the confirmed not-a-target rescues to data/03-labels.json.
 *
 * An adversarial review of the 1,317 clinics labelled not-a-target screened the
 * 415 whose own page text carried 3+ clinical signals, proposed 22 as
 * misclassified, and confirmed 12 after a second pass whose job was to refute
 * each one. The other 10 were training academies, private-equity ophthalmology
 * MSOs, a Shopify skincare store and home care agencies: businesses whose
 * vocabulary is clinical because clinics are their customers.
 *
 * Run from packages/leadgen:
 *   npx tsx src/ops/apply-rescues.mts          # show what would change
 *   npx tsx src/ops/apply-rescues.mts --write  # apply
 *
 * Writing to a tmp file and renaming, because rename is atomic on one
 * filesystem and 03-labels.json is the output of a paid Batch API run.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

type Label = {
  clinicId: string;
  segment: string;
  confidence: string;
  evidence: string;
  [k: string]: unknown;
};

/**
 * Two reviewers returned "med-spa" and "medspa", neither of which is a segment.
 * Both are aesthetic practices, which is `injectables` in this taxonomy, so
 * they are normalised rather than written through — an invalid segment reaches
 * SEGMENT_LABELS as undefined and takes the CSV write down with it.
 */
const NORMALISE: Record<string, string> = {
  "med-spa": "injectables",
  medspa: "injectables",
};

const RESCUES: { clinicId: string; name: string; segment: string; confidence: string }[] = [
  { clinicId: "7380a03c128c2474", name: "LCMC Health", segment: "other-medical", confidence: "low" },
  { clinicId: "dde1d12091566844", name: "R&A Home Health Services", segment: "other-medical", confidence: "medium" },
  { clinicId: "58b7c616a001655f", name: "Pause Pain & Wellness", segment: "other-medical", confidence: "high" },
  { clinicId: "050e6b37fa4289c4", name: "Color Box", segment: "med-spa", confidence: "low" },
  { clinicId: "de895e3945f1d469", name: "Skin Pharm", segment: "medspa", confidence: "high" },
  { clinicId: "fce1d048d3c73a44", name: "Angel HCS", segment: "other-medical", confidence: "medium" },
  { clinicId: "afd77861b2bc3446", name: "Sculp'd", segment: "body-contouring", confidence: "medium" },
  { clinicId: "b1d5eea3e4877bf3", name: "Complexion", segment: "injectables", confidence: "medium" },
  { clinicId: "e3f21f3b1d0f7a78", name: "Bluewave Wellness", segment: "other-medical", confidence: "medium" },
  { clinicId: "863fe2373c36f48e", name: "Zignagenix", segment: "other-medical", confidence: "low" },
  { clinicId: "520a19db1b94b120", name: "Compassionate Clinics Of America", segment: "other-medical", confidence: "medium" },
  { clinicId: "223e28f0b8dbd245", name: "Camelback Integrated Health And Wellness", segment: "other-medical", confidence: "medium" },
];

const PATH = "data/03-labels.json";
const write = process.argv.includes("--write");

if (!existsSync(PATH)) {
  console.error(`${PATH} not found. Run from packages/leadgen.`);
  process.exit(1);
}

const labels = JSON.parse(readFileSync(PATH, "utf8")) as Label[];
const byId = new Map(labels.map((l) => [l.clinicId, l]));

let applied = 0;
let missing = 0;
let alreadyChanged = 0;

for (const r of RESCUES) {
  const label = byId.get(r.clinicId);
  if (!label) {
    console.log(`  MISSING  ${r.name} (${r.clinicId}) is not in the labels`);
    missing++;
    continue;
  }
  if (label.segment !== "not-a-target") {
    // The re-label may already have moved it, in which case leave it alone
    // rather than overwriting a fresher classification with an older one.
    console.log(`  SKIP     ${r.name} is already "${label.segment}", not not-a-target`);
    alreadyChanged++;
    continue;
  }

  const segment = NORMALISE[r.segment] ?? r.segment;
  console.log(`  ${write ? "APPLY  " : "WOULD  "}  ${r.name}: not-a-target -> ${segment} (${r.confidence})`);

  if (write) {
    label.segment = segment;
    // The confidence the VERIFIER reached, not the original classifier's, and
    // the evidence records that a human-triggered review moved this row so the
    // change is legible six weeks from now.
    label.confidence = r.confidence;
    label.evidence = `[rescued from not-a-target by adversarial review] ${label.evidence}`;
  }
  applied++;
}

console.log(
  `\n${applied} ${write ? "applied" : "would change"}, ${alreadyChanged} already moved, ${missing} not found`,
);

if (write && applied) {
  writeFileSync(`${PATH}.tmp`, JSON.stringify(labels, null, 2));
  renameSync(`${PATH}.tmp`, PATH);
  console.log(`wrote ${PATH}`);
} else if (!write) {
  console.log("dry run. pass --write to apply.");
}

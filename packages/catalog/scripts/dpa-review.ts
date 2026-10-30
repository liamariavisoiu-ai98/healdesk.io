import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dpaDraft110ReviewDocument, dpaReviewDocument } from "../src/dpa-review";

/**
 * Rewrites docs/dpa-v1.0.0.txt, the released copy, and docs/dpa-v1.1.0.txt,
 * the 1.1.0 draft, from the renderer:
 *   npm run dpa:review -w @healdesk/catalog
 * Run it in the same commit as any change to a clause the DPA renders,
 * including the clauses it shares with the BAA; dpa.test.ts fails until it
 * has been run.
 */
const files: readonly [string, string][] = [
  ["../../../docs/dpa-v1.0.0.txt", dpaReviewDocument()],
  ["../../../docs/dpa-v1.1.0.txt", dpaDraft110ReviewDocument()],
];
for (const [path, text] of files) {
  const target = fileURLToPath(new URL(path, import.meta.url));
  writeFileSync(target, text);
  process.stdout.write(`wrote ${target}\n`);
}

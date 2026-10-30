import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dpaDraftReviewDocument110, dpaReviewDocument } from "../src/dpa-review";

/**
 * Rewrites docs/dpa-v1.0.0.txt, the released copy, and docs/dpa-v1.1.0.txt,
 * the dpa/1.1.0 draft's review copy, from the renderer:
 *   npm run dpa:review -w @healdesk/catalog
 * Run it in the same commit as any change to a clause the DPA renders,
 * including the clauses it shares with the BAA; dpa.test.ts fails until it
 * has been run.
 */
const target = fileURLToPath(new URL("../../../docs/dpa-v1.0.0.txt", import.meta.url));
writeFileSync(target, dpaReviewDocument());
process.stdout.write(`wrote ${target}\n`);

const draft = fileURLToPath(new URL("../../../docs/dpa-v1.1.0.txt", import.meta.url));
writeFileSync(draft, dpaDraftReviewDocument110());
process.stdout.write(`wrote ${draft}\n`);

import { mkdirSync, writeFileSync } from "node:fs";

import { EVAL_SPECIALTIES } from "./rubric";
import { SCENARIO_DIR, scenarioFile, scenarioFileText } from "./scenarios";

/**
 * Writes the scenario data files from the deterministic generator:
 *
 *   npm run voice-eval:scenarios -w @healdesk/app
 *
 * Run it after changing scenarios.ts, then review the diff of
 * scripts/voice-eval/scenarios/*.json before committing: those files are
 * what the eval runs, and the test fails when they and the generator differ.
 */
mkdirSync(SCENARIO_DIR, { recursive: true });
for (const specialty of EVAL_SPECIALTIES) {
  writeFileSync(scenarioFile(specialty), scenarioFileText(specialty));
  console.log(`wrote ${scenarioFile(specialty)}`);
}

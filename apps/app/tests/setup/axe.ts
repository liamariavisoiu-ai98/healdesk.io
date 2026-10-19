import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { AxeResults, RunOptions } from "axe-core";
import { Window } from "happy-dom";

/**
 * axe-core over a page's rendered HTML (plan Part F8), for the portal's
 * screens: the page placed in the root layout's document (`<html lang="en">`
 * and a title, as app/layout.tsx gives every page), loaded into its own
 * happy-dom window, and axe run inside that window, so the test itself keeps
 * Node's environment for the database and the page's server code.
 *
 * WCAG 2.2 A and AA, the rules a static render can decide. Colour contrast
 * needs layout and the stylesheet, which a render without CSS has neither of,
 * so it is axe's "incomplete" here, never a pass; the tokens are checked
 * where they are defined. Returns one line per failing node, empty when
 * none fail.
 */

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const OPTIONS: RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "color-contrast": { enabled: false } },
  resultTypes: ["violations"],
};

type AxeWindow = Window & {
  eval(code: string): unknown;
  axe: { run(context: unknown, options: RunOptions): Promise<AxeResults> };
};

export async function axeViolations(html: string, title = "healdesk"): Promise<string[]> {
  const window = new Window({ url: "https://app.healdesk.test/" }) as AxeWindow;
  try {
    window.document.write(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${html}</body></html>`,
    );
    window.eval(AXE_SOURCE);
    const results = await window.axe.run(window.document, OPTIONS);
    return results.violations.flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id} (${violation.help}): ${node.target.join(" ")}`,
      ),
    );
  } finally {
    await window.happyDOM.close();
  }
}

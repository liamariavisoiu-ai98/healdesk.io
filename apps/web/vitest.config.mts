import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * apps/web had no test runner at all, which is why the knowledge tree and the
 * checkout funnel were both unguarded. This covers the pure modules — the tree,
 * the catalog contract, the gate and rate-limit helpers. Route handlers need a
 * running Next server and are out of scope here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  /**
   * The app's tsconfig sets `jsx: "preserve"` — Next compiles the JSX itself —
   * so without this the transform refuses any file that imports a component and
   * every rule that lives in a `.tsx` is untestable. That is not a hypothetical:
   * the honesty rules on /admin (an em-dash where nothing was measured, a
   * hatched day where nobody looked, an empty state that names which kind of
   * empty it is) are all in components, and all of them were unguarded.
   *
   * The tests render to static markup and assert on the text, so `node` stays
   * the environment — no testing-library. One file opts into a DOM with its own
   * `@vitest-environment happy-dom` line: the agreement step's "Sign again"
   * test, because that bug lived in an effect, which static markup never runs.
   */
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

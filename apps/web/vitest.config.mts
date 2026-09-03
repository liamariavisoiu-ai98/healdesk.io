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
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

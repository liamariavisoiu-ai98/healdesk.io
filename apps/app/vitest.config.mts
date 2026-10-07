import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig keeps JSX as written ("preserve") for Next to compile, which Vite
  // cannot load: this compiles it for the tests that render a page, such as
  // the public Connect done page, whose whole risk is what it prints.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // Tenant-isolation tests share a database and truncate between files, so
    // they must not run concurrently with each other.
    fileParallelism: false,
    setupFiles: ["./tests/setup/env.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

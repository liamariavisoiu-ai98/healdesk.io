import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
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

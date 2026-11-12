import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mon22r/domain": `${root}packages/domain/src/index.ts`,
      "@mon22r/db": `${root}packages/db/src/index.ts`,
      "@mon22r/importers": `${root}packages/importers/src/index.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts"],
    server: {
      deps: {
        external: ["better-sqlite3"],
      },
    },
  },
});

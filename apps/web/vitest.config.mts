import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The real marker package throws outside a React Server Component bundle.
      {
        find: /^server-only$/,
        replacement: stub("./test/stubs/server-only.ts"),
      },
      // Raw-TS workspace package: force an in-process transform instead of
      // letting Vitest externalise a .ts file into node_modules.
      {
        find: /^@ai-showdown\/shared$/,
        replacement: stub("../../packages/shared/src/index.ts"),
      },
      // Same mapping as tsconfig "paths": "@/*" -> apps/web/*
      { find: /^@\//, replacement: stub("./") },
    ],
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});

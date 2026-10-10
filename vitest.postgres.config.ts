import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/integration/b1f-postgres.test.ts",
  "tests/integration/d2c-postgres.test.ts", "tests/integration/d3-postgres.test.ts",
  "tests/integration/d3n-postgres.test.ts", "tests/integration/d4s-postgres.test.ts"],
  testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1, fileParallelism: false } });

import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/integration/c2b3-postgres.test.ts",
  "tests/integration/task051-postgres.test.ts"],
  testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1, fileParallelism: false } });

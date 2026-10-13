import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/integration/sandbox-e2e-postgres.test.ts"],
  testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1, fileParallelism: false } });

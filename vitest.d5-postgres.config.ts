import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/integration/d5-postgres.test.ts"],
  testTimeout: 30000, hookTimeout: 30000, maxWorkers: 1, fileParallelism: false } });

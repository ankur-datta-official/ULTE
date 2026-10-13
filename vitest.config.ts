import { defineConfig } from "vitest/config";

export default defineConfig({ test: { exclude: ["**/node_modules/**", "**/dist/**",
  "**/b1f-postgres.test.ts", "**/b1f-postgres.test.js",
  "**/d4s-postgres.test.ts", "**/d4s-postgres.test.js",
  "**/d4-postgres.test.ts", "**/d4-postgres.test.js",
  "**/d5-postgres.test.ts", "**/d5-postgres.test.js",
  "**/c2b3-postgres.test.ts", "**/c2b3-postgres.test.js"] } });

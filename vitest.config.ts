import { defineConfig } from "vitest/config";

export default defineConfig({ test: { exclude: ["**/node_modules/**", "**/dist/**",
  "**/b1f-postgres.test.ts", "**/b1f-postgres.test.js"] } });

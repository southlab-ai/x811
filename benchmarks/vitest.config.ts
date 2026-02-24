import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@x811/core": resolve(__dirname, "../packages/core/src/index.ts"),
    },
  },
  test: {
    benchmark: {
      include: ["**/*.bench.ts"],
    },
  },
});

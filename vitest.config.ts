import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.test.ts"],
    exclude: ["**/.orchestrai/**", "**/dist/**", "**/node_modules/**"],
    coverage: {
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.d.ts", "src/types/**", "src/dashboard-client.browser.tsx"]
    }
  }
});

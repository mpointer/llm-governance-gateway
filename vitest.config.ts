import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "text"],
      reportsDirectory: "coverage",
      // A floor, about one point under where the suite stood when it was set
      // (87.1 / 80.8 / 88.8 / 88.3 on 2026-11-26). `npm run test:coverage`
      // fails below it, which is what CI runs. Raise it as coverage rises;
      // lowering it is a decision to make in review, not a way to get green.
      thresholds: {
        statements: 86,
        branches: 79,
        functions: 87,
        lines: 87,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The entry point: process.exit, stdio transport and the top-level
      // catch are not reachable from an in-process test.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-27: 94.38 / 87.81 / 97.34 / 97.80.
      // Set just below, with headroom on functions. If a change pushes a
      // number under one of these, write the missing test — never lower the
      // threshold to make the run green.
      thresholds: {
        statements: 92,
        branches: 84,
        functions: 92,
        lines: 95,
      },
    },
  },
});

/**
 * Vitest config for long-context eval tasks.
 * Mirrors the upstream gemini-cli/evals/vitest.config.ts pattern.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 300000, // 5 minutes per eval
    reporters: ['default', 'json'],
    outputFile: {
      json: 'evals/logs/report.json',
    },
    include: ['**/*.eval.ts'],
    environment: 'node',
    globals: true,
  },
});

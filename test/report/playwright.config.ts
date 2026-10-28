// LOCAL TEST ONLY. Runs the phase 11 capture and the report verification.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './out/test-results',
  use: { trace: 'off' },
});

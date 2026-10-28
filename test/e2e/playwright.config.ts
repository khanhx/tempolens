// LOCAL TEST ONLY. Runs against the local Tempolens instance started by the e2e compose.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './out/test-results',
  use: {
    baseURL: process.env.BASE ?? 'http://localhost:8236',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});

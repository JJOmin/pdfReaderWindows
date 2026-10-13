import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app, so run them with `npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
});

import { defineConfig } from '@playwright/test';

// Browser tests of the app, against the production build: npm run test:app. Kept out of npm test because they
// need Chromium.
export default defineConfig({
  testDir: 'test/app',
  testMatch: '*.e2e.ts',
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
  },
});

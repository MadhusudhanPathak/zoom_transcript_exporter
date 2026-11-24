// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  fullyParallel: true,
  reporter: 'list',
});

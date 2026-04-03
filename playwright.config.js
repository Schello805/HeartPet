const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:3210",
    headless: true,
  },
});

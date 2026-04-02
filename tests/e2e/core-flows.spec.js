const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const adminCredentials = {
  name: "E2E Admin",
  email: "admin@heartpet-e2e.local",
  password: "passwort123",
};

let server;
let tempDataDir;

test.beforeAll(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-playwright-"));
  process.env.HEARTPET_DATA_DIR = tempDataDir;
  process.env.HEARTPET_SESSION_SECRET = "playwright-secret";

  const app = require("../../src/app");
  await new Promise((resolve) => {
    server = app.listen(3210, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (tempDataDir) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

async function ensureAuthenticated(page) {
  await page.goto("/setup");

  if (page.url().includes("/setup")) {
    await page.locator('input[name="admin_name"]').fill(adminCredentials.name);
    await page.locator('input[name="admin_email"]').fill(adminCredentials.email);
    await page.locator('input[name="admin_password"]').fill(adminCredentials.password);
    await page.locator('input[name="organization_name"]').fill("HeartPet E2E");
    await page.locator('input[name="veterinarian_name"]').fill("Praxis E2E");
    await page.locator('input[name="animal_name"]').fill("Minka");
    await page.locator('input[name="species_name"]').fill("Katze");
    await page.getByRole("button", { name: "Ersteinrichtung abschließen" }).click();
    await expect(page).toHaveURL(/\/animals(\/\d+)?(\?.*)?$/);
    return;
  }

  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(adminCredentials.email);
  await page.getByLabel("Passwort").fill(adminCredentials.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/($|dashboard|animals(\/.*)?$)/);
}

test("Tiere-Arbeitsansicht lädt die Akte im Browser-Kontext", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto("/animals");

  await expect(page.locator("h1", { hasText: "Aktive Tiere" })).toBeVisible();
  await page.getByRole("link", { name: /Minka/i }).click();

  await expect(page.locator("[data-animal-workspace-target]")).toContainText("Minka");
  await expect(page.locator("[data-animal-workspace-target]")).toContainText("Schneller neuer Eintrag");
});

test("Dokumentkategorie lässt sich im Bearbeiten-Dialog speichern", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto("/admin/stammdaten");

  await page.locator('[aria-label="Dokumentkategorie bearbeiten"]').first().click();
  await expect(page.getByRole("button", { name: "Kategorie speichern" })).toBeVisible();

  const updatedName = `Impfbescheinigung E2E ${Date.now()}`;
  await page.getByLabel("Name").fill(updatedName);
  await page.getByRole("button", { name: "Kategorie speichern" }).click();

  await expect(page.locator("body")).toContainText(updatedName);
});

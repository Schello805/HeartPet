const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const adminCredentials = {
  name: "E2E Admin",
  email: "admin@heartpet-e2e.local",
  password: "passwort123",
};

let server;
let tempDataDir;

async function waitForServer(url, timeoutMs = 5_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const isReachable = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 500);
      });

      request.on("error", () => resolve(false));
      request.setTimeout(500, () => {
        request.destroy();
        resolve(false);
      });
    });

    if (isReachable) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Server unter ${url} wurde nicht rechtzeitig erreichbar.`);
}

test.beforeEach(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-playwright-"));
  process.env.HEARTPET_DATA_DIR = tempDataDir;
  process.env.HEARTPET_SESSION_SECRET = "playwright-secret";

  delete require.cache[require.resolve("../../src/app")];
  const app = require("../../src/app");
  await new Promise((resolve) => {
    server = app.listen(3210, "127.0.0.1", resolve);
  });
  await waitForServer("http://127.0.0.1:3210/login");
});

test.afterEach(async () => {
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
  server = null;

  if (tempDataDir) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
  tempDataDir = null;
});

async function ensureAuthenticated(page) {
  await page.goto("/setup");

  if (page.url().includes("/setup")) {
    for (const sectionTitle of ["1. Administrator", "2. Tierarzt", "3. Erstes Tier"]) {
      const sectionSummary = page.getByText(sectionTitle, { exact: true });
      await sectionSummary.click();
    }

    await page.locator('input[name="admin_name"]').fill(adminCredentials.name);
    await page.locator('input[name="admin_email"]').fill(adminCredentials.email);
    await page.locator('input[name="admin_password"]').fill(adminCredentials.password);
    await page.locator('input[name="organization_name"]').fill("HeartPet E2E");
    await page.locator('input[name="veterinarian_name"]').fill("Praxis E2E");
    await page.locator('input[name="animal_name"]').fill("Minka");
    await page.locator('input[name="species_name"]').fill("Katze");
    await page.getByRole("button", { name: "Ersteinrichtung abschließen" }).click();
    await page.waitForLoadState("networkidle");

    if (page.url().includes("/login")) {
      await page.getByLabel("E-Mail").fill(adminCredentials.email);
      await page.getByLabel("Passwort").fill(adminCredentials.password);
      await page.getByRole("button", { name: "Anmelden" }).click();
    }

    await expect(page).toHaveURL(/\/($|dashboard|animals(\/.*)?$)/);
    return;
  }

  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(adminCredentials.email);
  await page.getByLabel("Passwort").fill(adminCredentials.password);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/($|dashboard|animals(\/.*)?$)/);
}

test("Tiere-Arbeitsansicht zeigt die Akte im Browser-Kontext", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto("/animals");

  await expect(page.locator("h1", { hasText: "Aktive Tiere" })).toBeVisible();
  const animalWorkspaceLink = page.locator("[data-animal-workspace-link]").first();
  await expect(animalWorkspaceLink).toBeVisible();
  const workspaceHref = await animalWorkspaceLink.getAttribute("href");
  await page.goto(workspaceHref || "/animals");

  const workspaceTarget = page.locator("[data-animal-workspace-target]");
  await expect(workspaceTarget).toContainText("Minka");
  await expect(workspaceTarget).toContainText("Schneller neuer Eintrag");
});

test("Dokumentkategorie lässt sich im Bearbeiten-Dialog speichern", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto("/admin/stammdaten");
  await page.getByText("Dokumentkategorien", { exact: true }).click();

  await page.locator('[aria-label="Dokumentkategorie bearbeiten"]').first().click();
  await expect(page.getByRole("button", { name: "Kategorie speichern" })).toBeVisible();

  const updatedName = `Impfbescheinigung E2E ${Date.now()}`;
  await page.getByLabel("Name").fill(updatedName);
  await page.getByRole("button", { name: "Kategorie speichern" }).click();

  await expect(page.locator("body")).toContainText(updatedName);
});

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
  process.env.HEARTPET_SESSION_STORE = "memory";

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
    await page.getByRole("button", { name: "1. Administrator" }).click();
    await expect(page.locator('input[name="admin_name"]')).toBeVisible();
    await page.locator('input[name="admin_name"]').fill(adminCredentials.name);
    await page.locator('input[name="admin_email"]').fill(adminCredentials.email);
    await page.locator('input[name="admin_password"]').fill(adminCredentials.password);
    await page.locator('input[name="organization_name"]').fill("HeartPet E2E");

    await page.getByRole("button", { name: "2. Tierarzt" }).click();
    await expect(page.locator('input[name="veterinarian_name"]')).toBeVisible();
    await page.locator('input[name="veterinarian_name"]').fill("Praxis E2E");

    await page.getByRole("button", { name: "3. Erstes Tier" }).click();
    await expect(page.locator('input[name="animal_name"]')).toBeVisible();
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
  await expect(page.locator("h1", { hasText: "Meine Tiere" })).toBeVisible();
  const listToggle = page.getByRole("button", { name: "Tierliste anzeigen" });
  if (await listToggle.isVisible()) {
    await listToggle.click();
  }
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

test("Benachrichtigungs-Checkboxen sind mobil sichtbar aktivierbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ensureAuthenticated(page);
  await page.goto("/admin/benachrichtigungen");

  const digestCheckbox = page.getByLabel("Tägliche Erinnerungs-Zusammenfassung aktivieren");
  await expect(digestCheckbox).toBeVisible();
  await digestCheckbox.check();
  await expect(digestCheckbox).toBeChecked();

  const checkedVisualState = await digestCheckbox.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      accentColor: styles.accentColor,
    };
  });

  expect(checkedVisualState.accentColor).not.toBe("auto");
});

test("Kernseiten bleiben kompakt und kontrastreich", async ({ page }) => {
  await ensureAuthenticated(page);

  const pagesToCheck = [
    "/",
    "/animals",
    "/admin/stammdaten",
    "/admin/benachrichtigungen",
  ];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);

    for (const path of pagesToCheck) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const result = await page.evaluate(() => {
        const parseRgb = (value) => {
          const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          return match ? match.slice(1, 4).map(Number) : null;
        };
        const brightness = (rgb) => rgb ? ((rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000) : 255;
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const styles = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && styles.visibility !== "hidden" && styles.display !== "none";
        };

        const pageHeader = document.querySelector(".page-header h1");
        const headerFontSize = pageHeader ? Number.parseFloat(window.getComputedStyle(pageHeader).fontSize) : 0;
        const darkControls = Array.from(document.querySelectorAll("input:not(.form-check-input), select, textarea, .form-control, .form-select"))
          .filter(isVisible)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || "",
            name: element.getAttribute("name") || "",
            background: window.getComputedStyle(element).backgroundColor,
          }))
          .filter((item) => brightness(parseRgb(item.background)) < 150);
        const wideElements = Array.from(document.body.querySelectorAll("*"))
          .filter(isVisible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              className: String(element.className || "").slice(0, 120),
              text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              width: Math.round(rect.width),
            };
          })
          .filter((item) => item.left < -2 || item.right > window.innerWidth + 2)
          .slice(0, 8);

        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headerFontSize,
          darkControls,
          wideElements,
        };
      });

      expect(result.overflowX, `${path} @ ${viewport.width}px hat horizontalen Overflow: ${JSON.stringify(result.wideElements)}`).toBeLessThanOrEqual(2);
      expect(result.headerFontSize, `${path} @ ${viewport.width}px hat einen zu großen Header`).toBeLessThanOrEqual(viewport.width < 768 ? 22 : 24);
      expect(result.darkControls, `${path} @ ${viewport.width}px hat dunkle Formularfelder`).toEqual([]);
    }
  }
});

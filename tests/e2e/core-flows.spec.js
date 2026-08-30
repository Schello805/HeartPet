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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/animals");
  await expect(page.locator("h1", { hasText: "Meine Tiere" })).toBeVisible();
  const gridColumns = await page.locator(".animals-choice-list").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(gridColumns).toBeGreaterThanOrEqual(3);
  const animalWorkspaceLink = page.locator("[data-animal-workspace-link]").first();
  await expect(animalWorkspaceLink).toBeVisible();
  const workspaceHref = await animalWorkspaceLink.getAttribute("href");
  expect(workspaceHref).not.toContain("#selected-animal");
  await page.goto(workspaceHref || "/animals");

  const workspaceTarget = page.locator("[data-animal-workspace-target]");
  await expect(workspaceTarget).toContainText("Minka");
  await expect(workspaceTarget).toContainText("Was möchtest du tun?");
  await expect(workspaceTarget).toContainText("Weitere Details");
  await expect(workspaceTarget.getByRole("button", { name: "Tier mit allen Daten kopieren" })).toBeVisible();
});

test("Dashboard zeigt mobil nur einen Einstieg für ein neues Tier", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator(".app-mobile-topbar")).toBeVisible();
  await expect(page.locator(".page-header")).toBeHidden();
  await expect(page.locator(".app-mobile-topbar").getByRole("button", { name: /Menü/ })).toHaveCount(0);
  await expect(page.locator(".app-mobile-bottom-nav")).toBeVisible();
  await expect(page.locator(".app-mobile-bottom-nav").getByText("Start", { exact: true })).toBeVisible();
  await expect(page.locator(".app-mobile-bottom-nav").getByText("Tiere", { exact: true })).toBeVisible();
  await expect(page.locator(".app-mobile-bottom-nav").getByText("Historie", { exact: true })).toBeVisible();
  await expect(page.locator(".app-mobile-bottom-nav").getByText("Ruhestätte", { exact: true })).toHaveCount(0);
  await expect(page.locator(".app-mobile-bottom-nav").getByText("Mehr", { exact: true })).toBeVisible();
  await expect(page.locator('a[data-drawer="animal-form"]:visible')).toHaveCount(1);
  await expect(page.locator("main").getByText("Was ist heute wichtig?", { exact: true })).toHaveCount(0);

  await page.locator(".app-mobile-bottom-nav").getByText("Tiere", { exact: true }).click();
  await expect(page).toHaveURL(/\/animals$/);
  await expect(page.locator("body")).toHaveClass(/animals-page/);
  const mobileGrid = page.locator(".animals-choice-list");
  const mobileGridStyle = await mobileGrid.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns.split(" ").length,
      gap: Number.parseFloat(style.gap),
    };
  });
  expect(mobileGridStyle.columns).toBe(2);
  expect(mobileGridStyle.gap).toBeGreaterThan(0);
  await expect(page.locator('a[data-drawer="animal-form"]:visible')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Aktualisieren" })).toHaveCount(0);
  await expect(page.locator(".animals-choice-list img")).toHaveCount(0);

  await page.locator(".app-mobile-bottom-nav").getByRole("button", { name: "Mehr" }).click();
  await expect(page.locator("#mobileNavOffcanvas")).toBeVisible();
  const adminNav = page.locator("#mobileNavOffcanvas .mobile-admin-nav");
  await expect(adminNav.getByRole("link")).toHaveCount(7);
  await expect(adminNav.getByRole("link", { name: /Stall/ })).toBeVisible();
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

test("Checkbox-Labels sind visuell mittig ausgerichtet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ensureAuthenticated(page);
  await page.goto("/admin/benachrichtigungen");

  const alignment = await page.locator(".form-check").first().evaluate((element) => {
    const checkbox = element.querySelector(".form-check-input");
    const label = element.querySelector(".form-check-label");
    const checkboxRect = checkbox.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return Math.abs((checkboxRect.top + checkboxRect.height / 2) - (labelRect.top + labelRect.height / 2));
  });

  expect(alignment).toBeLessThanOrEqual(2);
});

test("Kernseiten bleiben kompakt und kontrastreich", async ({ page }) => {
  await ensureAuthenticated(page);

  const pagesToCheck = [
    "/",
    "/animals",
    "/animals/1",
    "/admin/stammdaten",
    "/admin/benachrichtigungen",
    "/admin/import",
    "/admin/benutzer",
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
        const bodyFontSize = Number.parseFloat(window.getComputedStyle(document.body).fontSize);
        const undersizedHeadings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, .h1, .h2, .h3, .h4, .h5, .h6"))
          .filter(isVisible)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: String(element.className || "").slice(0, 120),
            text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
            fontSize: Number.parseFloat(window.getComputedStyle(element).fontSize),
          }))
          .filter((item) => item.fontSize + 0.1 < bodyFontSize);
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
        const edgeTargets = Array.from(document.querySelectorAll([
          "button",
          "a.btn",
          "input:not(.form-check-input)",
          "select",
          "textarea",
          ".form-control",
          ".form-select",
          ".card p",
          ".card h2",
          ".card h3",
          ".card h4",
          ".card strong",
        ].join(",")))
          .filter(isVisible)
          .map((element) => {
            const container = element.closest(".card, .accordion-body, .drawer-body, .modal-body");
            if (!container || !isVisible(container)) {
              return null;
            }
            const rect = element.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const leftGap = rect.left - containerRect.left;
            const rightGap = containerRect.right - rect.right;
            const nearlyFullWidth = rect.width >= containerRect.width - 14;
            const isTextElement = ["P", "H2", "H3", "H4", "STRONG"].includes(element.tagName);
            return {
              tag: element.tagName.toLowerCase(),
              className: String(element.className || "").slice(0, 120),
              text: String(element.textContent || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 80),
              leftGap: Math.round(leftGap),
              rightGap: Math.round(rightGap),
              width: Math.round(rect.width),
              containerWidth: Math.round(containerRect.width),
              nearlyFullWidth,
              isTextElement,
            };
          })
          .filter(Boolean)
          .filter((item) => {
            if (item.nearlyFullWidth) {
              return false;
            }
            if (item.isTextElement) {
              return item.leftGap < 7;
            }
            return item.leftGap < 7 || item.rightGap < 7;
          })
          .slice(0, 10);

        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headerFontSize,
          undersizedHeadings,
          darkControls,
          wideElements,
          edgeTargets,
        };
      });

      expect(result.overflowX, `${path} @ ${viewport.width}px hat horizontalen Overflow: ${JSON.stringify(result.wideElements)}`).toBeLessThanOrEqual(2);
      expect(result.headerFontSize, `${path} @ ${viewport.width}px hat einen zu großen Header`).toBeLessThanOrEqual(viewport.width < 768 ? 22 : 24);
      expect(result.undersizedHeadings, `${path} @ ${viewport.width}px hat Überschriften kleiner als Fließtext`).toEqual([]);
      expect(result.darkControls, `${path} @ ${viewport.width}px hat dunkle Formularfelder`).toEqual([]);
      expect(result.edgeTargets, `${path} @ ${viewport.width}px hat Elemente ohne ausreichenden Kartenabstand`).toEqual([]);
    }
  }
});

test("Mobiler Seiteninhalt endet vollständig oberhalb der Navigation", async ({ page }) => {
  await ensureAuthenticated(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const spacing = await page.evaluate(() => {
    const container = document.querySelector(".app-main-container");
    const navigation = document.querySelector(".app-mobile-bottom-nav");
    return {
      paddingBottom: Number.parseFloat(getComputedStyle(container).paddingBottom),
      navigationHeight: navigation.getBoundingClientRect().height,
    };
  });

  expect(spacing.paddingBottom).toBeGreaterThan(spacing.navigationHeight);
});

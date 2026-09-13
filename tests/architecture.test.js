const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Systemlog-Router kapselt SQL im Repository", () => {
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "systemlog.js"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "..", "src", "repositories", "systemlog-repository.js"), "utf8");
  assert.doesNotMatch(router, /\bdb\.prepare\s*\(/);
  assert.match(repository, /notification_logs/);
  assert.match(repository, /audit_logs/);
});

test("Tierübersicht und Tierdetail bleiben im fachlichen Router und Service", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "animals.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "..", "src", "services", "animal-workspace.js"), "utf8");
  assert.match(appSource, /app\.use\("\/animals", createAnimalsRouter/);
  assert.doesNotMatch(appSource, /app\.get\("\/animals"\s*,/);
  assert.doesNotMatch(appSource, /app\.get\("\/animals\/historie"\s*,/);
  assert.doesNotMatch(appSource, /app\.get\("\/animals\/:id"\s*,/);
  assert.match(router, /router\.get\("\/historie"/);
  assert.match(router, /router\.get\(\/\^\\\/\(\\d\+\)\$\//);
  assert.doesNotMatch(router, /\bdb\.prepare\s*\(/);
  assert.match(service, /function buildWorkspace\(/);
  assert.match(service, /function buildDetailView\(/);
});

test("Tier-Stammdaten und Statuswechsel bleiben im fachlichen Router", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "animal-records.js"), "utf8");
  assert.match(appSource, /app\.use\("\/animals", createAnimalRecordsRouter/);
  assert.doesNotMatch(appSource, /app\.(?:get|post)\("\/animals\/(?:new|:id\/(?:edit|update|memorial-note|duplicate|delete))"/);
  assert.match(router, /router\.post\("\/:id\/update"/);
  assert.match(router, /router\.post\("\/:id\/memorial-note"/);
  assert.match(router, /router\.post\("\/:id\/duplicate"/);
  assert.match(router, /router\.post\("\/:id\/delete"/);
});

test("Tierdokumente und Bilder bleiben im Medien-Router", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "animal-media.js"), "utf8");
  assert.match(appSource, /app\.use\(createAnimalMediaRouter/);
  assert.doesNotMatch(appSource, /app\.post\("\/animals\/:id\/(?:documents|profile-image|images)"/);
  assert.match(router, /router\.post\("\/animals\/:id\/documents"/);
  assert.match(router, /router\.post\("\/animals\/:id\/profile-image"/);
  assert.match(router, /router\.post\("\/animals\/:id\/images"/);
});

test("Medizinische Tierdaten bleiben im Gesundheits-Router", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "animal-health.js"), "utf8");
  assert.match(appSource, /app\.use\(createAnimalHealthRouter/);
  assert.doesNotMatch(appSource, /app\.post\("\/animals\/:id\/(?:conditions|medications|vaccinations|appointments)"/);
  assert.match(router, /router\.post\("\/animals\/:id\/vaccinations"/);
  assert.match(router, /router\.post\("\/animals\/:id\/appointments"/);
  assert.match(router, /router\.post\("\/animals\/vaccinations\/bulk"/);
});

test("Angemeldete Erinnerungsaktionen bleiben im Erinnerungs-Router", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "animal-reminders.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "..", "src", "services", "animal-reminders.js"), "utf8");
  assert.match(appSource, /app\.use\(createAnimalRemindersRouter/);
  assert.doesNotMatch(appSource, /app\.post\("\/(?:animals\/:id\/reminders|reminders\/:id\/(?:complete|reopen))"/);
  assert.match(router, /router\.post\("\/animals\/:id\/reminders"/);
  assert.match(router, /router\.post\("\/reminders\/:id\/complete"/);
  assert.match(service, /function createAnimalReminderService/);
  assert.doesNotMatch(appSource, /function syncVaccinationReminders/);
});

test("Setup und Anmeldung bleiben im Auth-Router", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "auth.js"), "utf8");
  assert.match(appSource, /app\.use\(createAuthRouter/);
  assert.doesNotMatch(appSource, /app\.(?:get|post)\("\/(?:setup|login|logout|password-reset|password-forgot|invite\/accept)"/);
  assert.match(router, /router\.post\("\/login"/);
  assert.match(router, /router\.post\("\/password-reset"/);
  assert.match(router, /router\.post\("\/invite\/accept"/);
});

test("Stall-Endpunkte und Wetterlogik bleiben fachlich getrennt", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const router = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "coop.js"), "utf8");
  const weather = fs.readFileSync(path.join(__dirname, "..", "src", "services", "weather.js"), "utf8");
  const camera = fs.readFileSync(path.join(__dirname, "..", "src", "services", "camera.js"), "utf8");
  assert.match(appSource, /app\.use\(createCoopRouter/);
  assert.doesNotMatch(appSource, /app\.(?:get|post)\("\/(?:coop\/(?:door|cameras)|admin\/coop\/(?:climate-status|homematic-datapoints|door-test))/);
  assert.match(router, /router\.post\("\/coop\/door\/open"/);
  assert.match(router, /router\.get\("\/admin\/coop\/climate-status"/);
  assert.match(weather, /function createWeatherService/);
  assert.match(camera, /function createCameraService/);
  assert.match(camera, /createCameraService\(\{ cameraCacheDir, normalizeConfiguredUrl, isCameraUrl, isRtspUrl \}\)/);
  assert.doesNotMatch(appSource, /async function readOutdoorWeather/);
  assert.doesNotMatch(appSource, /function parseCoopCameraLines/);
});

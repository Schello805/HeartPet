const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const request = require("supertest");

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-test-"));
process.env.HEARTPET_DATA_DIR = tempDataDir;
process.env.HEARTPET_SESSION_SECRET = "test-secret";

const app = require("../src/app");
const agent = request.agent(app);

test.after(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test("Ersteinrichtung funktioniert", async () => {
  const setupPage = await agent.get("/setup");
  assert.equal(setupPage.status, 200);

  const setupResponse = await agent.post("/setup").type("form").send({
    admin_name: "Test Admin",
    admin_email: "admin@test.local",
    admin_password: "passwort123",
    organization_name: "Test Tierbestand",
    veterinarian_name: "Tierarzt Test",
    species_name: "Katze",
    animal_name: "Minka",
  });

  assert.equal(setupResponse.status, 302);
  assert.match(setupResponse.headers.location || "", /^\/animals\/\d+$/);
});

test("Systemlog ist erreichbar (inkl. Alias)", async () => {
  const systemlog = await agent.get("/admin/systemlog");
  assert.equal(systemlog.status, 200);
  assert.match(systemlog.text, /Systemlog/i);

  const alias = await agent.get("/systemlog");
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.location, "/admin/systemlog");

  const aliasDash = await agent.get("/system-log");
  assert.equal(aliasDash.status, 302);
  assert.equal(aliasDash.headers.location, "/admin/systemlog");

  const nestedAlias = await agent.get("/admin/irgendwas/systemlog");
  assert.equal(nestedAlias.status, 302);
  assert.equal(nestedAlias.headers.location, "/admin/systemlog");
});

test("Such-Suggestions liefern Ergebnisse", async () => {
  const response = await agent.get("/api/search/suggest").query({ q: "min" });
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(response.body.results), true);
  assert.ok(response.body.results.length >= 1);

  const alias = await agent.get("/api/suggest").query({ q: "min" });
  assert.equal(alias.status, 200);
  assert.equal(Array.isArray(alias.body.results), true);

  const nestedAlias = await agent.get("/animals/suggest").query({ q: "min" });
  assert.equal(nestedAlias.status, 200);
  assert.equal(Array.isArray(nestedAlias.body.results), true);
});

test("SMTP-Verbindungstest Route ist erreichbar", async () => {
  const response = await agent.post("/admin/test-smtp-connection").type("form").send({});
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/admin/benachrichtigungen");
});

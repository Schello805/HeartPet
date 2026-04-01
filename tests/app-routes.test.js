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

test("Benachrichtigungen Alias ist erreichbar", async () => {
  const direct = await agent.get("/admin/benachrichtigungen");
  assert.equal(direct.status, 200);

  const alias = await agent.get("/benachrichtigungen");
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.location, "/admin/benachrichtigungen");
});

test("Tierarzt kann als Standard markiert werden", async () => {
  const createVet = await agent.post("/admin/veterinarians").type("form").send({
    name: "Praxis Mitte",
    street: "Musterstraße 10",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
  });
  assert.equal(createVet.status, 302);

  const masterData = await agent.get("/admin/stammdaten");
  assert.equal(masterData.status, 200);
  const match = masterData.text.match(/\/admin\/veterinarians\/(\d+)\/set-default/);
  assert.ok(match && match[1]);

  const setDefault = await agent.post(`/admin/veterinarians/${match[1]}/set-default`).type("form").send({});
  assert.equal(setDefault.status, 302);
  assert.equal(setDefault.headers.location, "/admin/stammdaten");
});

test("Adressvalidierung für Tierarzt greift", async () => {
  const invalid = await agent.post("/admin/veterinarians").type("form").send({
    name: "Ungültig",
    street: "X",
    postal_code: "12",
    city: "!",
    country: "1",
  });
  assert.equal(invalid.status, 302);
  assert.equal(invalid.headers.location, "/admin/stammdaten");
});

test("CRUD-Updates für Stammdaten funktionieren", async () => {
  const createCategory = await agent.post("/admin/categories").type("form").send({
    name: "Labor",
    is_required: "on",
  });
  assert.equal(createCategory.status, 302);

  const createSpecies = await agent.post("/admin/species").type("form").send({
    name: "Pony",
    notes: "Testart",
  });
  assert.equal(createSpecies.status, 302);

  const master = await agent.get("/admin/stammdaten");
  assert.equal(master.status, 200);
  const categoryMatch = master.text.match(/\/admin\/categories\/(\d+)\/delete/);
  const speciesMatch = master.text.match(/\/admin\/species\/(\d+)\/delete/);
  const vetMatch = master.text.match(/\/admin\/veterinarians\/(\d+)\/delete/);
  assert.ok(categoryMatch?.[1]);
  assert.ok(speciesMatch?.[1]);
  assert.ok(vetMatch?.[1]);

  const updateCategory = await agent.post(`/admin/categories/${categoryMatch[1]}/update`).type("form").send({
    name: "Laborbericht",
    is_required: "on",
  });
  assert.equal(updateCategory.status, 302);

  const updateSpecies = await agent.post(`/admin/species/${speciesMatch[1]}/update`).type("form").send({
    name: "Mini-Pony",
    default_veterinarian_id: "",
    notes: "Aktualisiert",
  });
  assert.equal(updateSpecies.status, 302);

  const updateVet = await agent.post(`/admin/veterinarians/${vetMatch[1]}/update`).type("form").send({
    name: "Praxis Mitte Neu",
    street: "Hauptstraße 5",
    postal_code: "10115",
    city: "Berlin",
    country: "Deutschland",
    phone: "",
    email: "",
    notes: "",
  });
  assert.equal(updateVet.status, 302);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PassThrough } = require("node:stream");
const request = require("supertest");
const dayjs = require("dayjs");

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-test-"));
process.env.HEARTPET_DATA_DIR = tempDataDir;
process.env.HEARTPET_SESSION_SECRET = "test-secret";

const { initDatabase } = require("../src/db");
const { createAnimalPdf } = require("../src/exporters");
const { buildReminderActionToken, buildReminderEmailHtml, sendTelegramReminder } = require("../src/reminders");
const app = require("../src/app");
const agent = request.agent(app);
const db = initDatabase();

function collectInternalLinks(html) {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => href && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/media/"))
    .filter((href) => !href.startsWith("/documents/"))
    .filter((href) => !href.startsWith("/logout"))
    .filter((href) => !href.startsWith("/confirm-email-change"))
    .filter((href) => !href.includes("#"));
}

function assertNoTemplateError(response, label) {
  assert.equal(response.status, 200, label);
  assert.doesNotMatch(response.text, /(ReferenceError|TypeError|SyntaxError):/i, label);
  assert.doesNotMatch(response.text, /Seite nicht gefunden\./i, `${label} sollte keine Not-Found-Seite rendern`);
}

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

  const speciesRows = db.prepare("SELECT name FROM species ORDER BY name ASC").all();
  assert.deepEqual(speciesRows.map((item) => item.name), ["Katze"]);
});

test("Einmalige Tierarten-Bereinigung entfernt ungenutzte Vorgaben und behält verwendete Arten", async () => {
  db.prepare("INSERT INTO species (name, notes) VALUES (?, ?)").run("Hund", "Soll entfernt werden");
  const parrotInsert = db.prepare("INSERT INTO species (name, notes) VALUES (?, ?)").run("Papagei", "Soll bleiben");
  db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Kiki", parrotInsert.lastInsertRowid, "Aktiv");
  db.prepare("DELETE FROM settings WHERE key = ?").run("species_catalog_pruned_v1");

  const reloadedDb = initDatabase();
  const speciesRows = reloadedDb.prepare("SELECT name FROM species ORDER BY name ASC").all();
  const kiki = reloadedDb.prepare(`
    SELECT animals.name, species.name AS species_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    WHERE animals.name = ?
  `).get("Kiki");

  assert.deepEqual(speciesRows.map((item) => item.name), ["Katze", "Papagei"]);
  assert.equal(kiki?.species_name, "Papagei");
  assert.equal(reloadedDb.prepare("SELECT value FROM settings WHERE key = ?").get("species_catalog_pruned_v1")?.value, "true");
  reloadedDb.close();
});

test("Datenbank-Migrationen werden protokolliert", () => {
  const migrationRows = db.prepare("SELECT id FROM schema_migrations ORDER BY id ASC").all();
  assert.deepEqual(
    migrationRows.map((row) => row.id),
    ["001_initial_schema", "002_schema_updates"]
  );
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

test("Stammdaten Alias ist erreichbar", async () => {
  const alias = await agent.get("/admin/masterdata");
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.location, "/admin/stammdaten");
});

test("Importseite erklärt klar, was importiert wird und was nicht", async () => {
  const page = await agent.get("/admin/import");
  assert.equal(page.status, 200);
  assert.match(page.text, /legt daraus immer eine <strong>neue Tierakte<\/strong> an/i);
  assert.match(page.text, /Was exportiert und importiert werden kann/i);
  assert.match(page.text, /Was bewusst nicht übernommen wird/i);
  assert.match(page.text, /PDF-Dateien oder andere Formate können nicht importiert werden/i);
});

test("Weitere Admin-Aliase sind erreichbar", async () => {
  const aliases = [
    ["/admin/general", "/admin/allgemein"],
    ["/admin/settings", "/admin/allgemein"],
    ["/admin/users", "/admin/benutzer"],
    ["/admin/user-management", "/admin/benutzer"],
    ["/admin/imports", "/admin/import"],
  ];

  for (const [source, target] of aliases) {
    const response = await agent.get(source);
    assert.equal(response.status, 302, source);
    assert.equal(response.headers.location, target, source);
  }
});

test("Tierarzt kann als Standard markiert werden", async () => {
  const createVet = await agent.post("/admin/veterinarians").type("form").send({
    name: "Praxis Mitte",
    street: "Musterstraße 10",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
  });
  assert.ok([302, 303].includes(createVet.status));

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
  assert.ok([302, 303].includes(invalid.status));
  assert.equal(invalid.headers.location, "/admin/stammdaten");
});

test("E-Mail und Telefon beim Tierarzt werden serverseitig validiert", async () => {
  const invalidEmail = await agent.post("/admin/veterinarians").type("form").send({
    name: "Praxis Mailtest",
    street: "Hauptstraße 1",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
    email: "ungueltig",
  });
  assert.ok([302, 303].includes(invalidEmail.status));
  assert.equal(invalidEmail.headers.location, "/admin/stammdaten");

  const invalidPhone = await agent.post("/admin/veterinarians").type("form").send({
    name: "Praxis Telefontest",
    street: "Hauptstraße 1",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
    phone: "abc",
  });
  assert.ok([302, 303].includes(invalidPhone.status));
  assert.equal(invalidPhone.headers.location, "/admin/stammdaten");
});

test("CRUD-Updates für Stammdaten funktionieren", async () => {
  const createCategory = await agent.post("/admin/categories").type("form").send({
    name: "Labor",
    is_required: "on",
  });
  assert.ok([302, 303].includes(createCategory.status));

  const createSpecies = await agent.post("/admin/species").type("form").send({
    name: "Pony",
    notes: "Testart",
  });
  assert.ok([302, 303].includes(createSpecies.status));

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
  assert.ok([302, 303].includes(updateCategory.status));

  const updateSpecies = await agent.post(`/admin/species/${speciesMatch[1]}/update`).type("form").send({
    name: "Mini-Pony",
    default_veterinarian_id: "",
    notes: "Aktualisiert",
  });
  assert.ok([302, 303].includes(updateSpecies.status));

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
  assert.ok([302, 303].includes(updateVet.status));
});

test("Tierarzt-Speichern aus eingeblendetem Formular landet sauber zurück", async () => {
  const master = await agent.get("/admin/stammdaten");
  assert.equal(master.status, 200);
  const vetMatch = master.text.match(/\/admin\/veterinarians\/(\d+)\/edit/);
  assert.ok(vetMatch?.[1]);

  const drawerGet = await agent
    .get(`/admin/veterinarians/${vetMatch[1]}/edit`)
    .set("X-Requested-With", "heartpet-drawer")
    .query({ return_to: "/admin/stammdaten" });
  assert.equal(drawerGet.status, 200);
  assert.match(drawerGet.text, /Tierarzt bearbeiten/i);

  const save = await agent
    .post(`/admin/veterinarians/${vetMatch[1]}/update`)
    .set("X-Requested-With", "heartpet-drawer")
    .type("form")
    .send({
      name: "Praxis Mitte Final",
      street: "Tierweg 7",
      postal_code: "50667",
      city: "Koeln",
      country: "Deutschland",
      phone: "",
      email: "",
      notes: "",
      return_to: "/admin/stammdaten",
    })
    .redirects(2);
  assert.equal(save.status, 200);
  assert.match(save.text, /Stammdaten/i);
});

test("Dokumentkategorie-Speichern aus eingeblendetem Formular landet sauber zurück", async () => {
  const master = await agent.get("/admin/stammdaten");
  assert.equal(master.status, 200);
  const categoryMatch = master.text.match(/\/admin\/categories\/(\d+)\/edit/);
  assert.ok(categoryMatch?.[1]);

  const drawerGet = await agent
    .get(`/admin/categories/${categoryMatch[1]}/edit`)
    .set("X-Requested-With", "heartpet-drawer")
    .query({ return_to: "/admin/stammdaten" });
  assert.equal(drawerGet.status, 200);
  assert.match(drawerGet.text, /Dokumentkategorie bearbeiten/i);

  const save = await agent
    .post(`/admin/categories/${categoryMatch[1]}/update`)
    .set("X-Requested-With", "heartpet-drawer")
    .type("form")
    .send({
      name: "Kategorie im Drawer aktualisiert",
      is_required: "on",
      return_to: "/admin/stammdaten",
    })
    .redirects(2);
  assert.equal(save.status, 200);
  assert.match(save.text, /Stammdaten/i);
});

test("Tierart-Speichern aus eingeblendetem Formular landet sauber zurück", async () => {
  const master = await agent.get("/admin/stammdaten");
  assert.equal(master.status, 200);
  const speciesMatch = master.text.match(/\/admin\/species\/(\d+)\/edit/);
  assert.ok(speciesMatch?.[1]);

  const drawerGet = await agent
    .get(`/admin/species/${speciesMatch[1]}/edit`)
    .set("X-Requested-With", "heartpet-drawer")
    .query({ return_to: "/admin/stammdaten" });
  assert.equal(drawerGet.status, 200);
  assert.match(drawerGet.text, /Tierart bearbeiten/i);

  const save = await agent
    .post(`/admin/species/${speciesMatch[1]}/update`)
    .set("X-Requested-With", "heartpet-drawer")
    .type("form")
    .send({
      name: "Tierart im Drawer aktualisiert",
      default_veterinarian_id: "",
      notes: "Aktualisiert im Drawer",
      return_to: "/admin/stammdaten",
    })
    .redirects(2);
  assert.equal(save.status, 200);
  assert.match(save.text, /Stammdaten/i);
});

test("Falsche GET-Aufrufe auf Admin-Speicherpfade liefern kein 404", async () => {
  const master = await agent.get("/admin/stammdaten");
  assert.equal(master.status, 200);

  const categoryId = master.text.match(/\/admin\/categories\/(\d+)\/edit/)?.[1];
  const speciesId = master.text.match(/\/admin\/species\/(\d+)\/edit/)?.[1];
  const vetId = master.text.match(/\/admin\/veterinarians\/(\d+)\/edit/)?.[1];
  assert.ok(categoryId);
  assert.ok(speciesId);
  assert.ok(vetId);

  const usersPage = await agent.get("/admin/benutzer");
  assert.equal(usersPage.status, 200);
  let userId = usersPage.text.match(/\/admin\/users\/(\d+)\/edit/)?.[1];
  if (!userId) {
    await agent.post("/admin/users").type("form").send({
      name: "Linktest Nutzer",
      email: "linktest@test.local",
      password: "passwort123",
      role: "viewer",
    });
    const nextUsersPage = await agent.get("/admin/benutzer");
    userId = nextUsersPage.text.match(/\/admin\/users\/(\d+)\/edit/)?.[1];
  }
  assert.ok(userId);

  const routes = [
    [`/admin/categories/${categoryId}/update`, /Dokumentkategorie bearbeiten/i],
    [`/admin/species/${speciesId}/update`, /Tierart bearbeiten/i],
    [`/admin/veterinarians/${vetId}/update`, /Tierarzt bearbeiten/i],
    [`/admin/users/${userId}/update`, /Benutzer bearbeiten/i],
    [`/admin/users/${userId}/save`, /Benutzer bearbeiten/i],
  ];

  for (const [href] of routes) {
    const response = await agent.get(href);
    assert.notEqual(response.status, 404, href);
    assert.equal(response.status, 302, href);
    assert.match(response.headers.location || "", /\?drawer=/, href);
  }
});

test("Falsche GET-Aufrufe auf Tier-Speicherpfade liefern kein 404", async () => {
  await agent.post("/animals/1/conditions").type("form").send({
    title: "Alias Arthrose",
    details: "Test",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/feedings").type("form").send({
    label: "Alias Futter",
    food: "Futter",
    amount: "10 g",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/notes").type("form").send({
    title: "Alias Notiz",
    content: "Test",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/reminders").type("form").send({
    title: "Alias Erinnerung",
    reminder_type: "Allgemein",
    due_at: "2026-04-06T09:00",
    return_to: "/animals/1",
  });

  const animalPage = await agent.get("/animals/1");
  assert.equal(animalPage.status, 200);

  const conditionId = animalPage.text.match(/\/animals\/1\/conditions\/(\d+)\/edit/)?.[1];
  const feedingId = animalPage.text.match(/\/animals\/1\/feedings\/(\d+)\/edit/)?.[1];
  const noteId = animalPage.text.match(/\/animals\/1\/notes\/(\d+)\/edit/)?.[1];
  const reminderId = animalPage.text.match(/\/animals\/1\/reminders\/(\d+)\/edit/)?.[1];
  assert.ok(conditionId);
  assert.ok(feedingId);
  assert.ok(noteId);
  assert.ok(reminderId);

  const routes = [
    ["/animals/1/update", /bearbeiten/i],
    [`/animals/1/conditions/${conditionId}/update`, /Vorerkrankung bearbeiten/i],
    [`/animals/1/feedings/${feedingId}/update`, /Fütterung bearbeiten/i],
    [`/animals/1/notes/${noteId}/update`, /Protokoll bearbeiten/i],
    [`/animals/1/reminders/${reminderId}/update`, /Erinnerung bearbeiten/i],
  ];

  for (const [href] of routes) {
    const response = await agent.get(href);
    assert.notEqual(response.status, 404, href);
    assert.equal(response.status, 302, href);
    assert.match(response.headers.location || "", /\?drawer=/, href);
  }
});

test("Speichern über alte Admin-Rückwege landet nicht auf 404", async () => {
  const createCategory = await agent.post("/admin/categories").type("form").send({
    name: "Rueckweg Kategorie",
    return_to: "/admin/masterdata",
  }).redirects(2);
  assert.equal(createCategory.status, 200);
  assert.match(createCategory.text, /Stammdaten/i);

  const createSpecies = await agent.post("/admin/species").type("form").send({
    name: "Rueckweg Art",
    notes: "Alias-Test",
    return_to: "/admin/masterdata",
  }).redirects(2);
  assert.equal(createSpecies.status, 200);
  assert.match(createSpecies.text, /Stammdaten/i);

  const createVet = await agent.post("/admin/veterinarians").type("form").send({
    name: "Rueckweg Praxis",
    street: "Musterweg 1",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
    return_to: "/admin/masterdata",
  }).redirects(2);
  assert.equal(createVet.status, 200);
  assert.match(createVet.text, /Stammdaten/i);

  const createUser = await agent.post("/admin/users").type("form").send({
    name: "Rueckweg Nutzer",
    email: "rueckweg@test.local",
    password: "passwort123",
    role: "viewer",
    return_to: "/admin/users",
  }).redirects(2);
  assert.equal(createUser.status, 200);
  assert.match(createUser.text, /Benutzer/i);
});

test("Admin-Drawer-Routen sind erreichbar", async () => {
  const userDrawer = await agent.get("/admin/users/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(userDrawer.status, 200);
  assert.match(userDrawer.text, /Benutzer anlegen/i);
  assert.match(userDrawer.text, /data-drawer-fragment="admin-user"/i);

  const categoryDrawer = await agent.get("/admin/categories/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(categoryDrawer.status, 200);
  assert.match(categoryDrawer.text, /Neue Dokumentkategorie/i);
  assert.match(categoryDrawer.text, /data-drawer-fragment="masterdata-form"/i);
});

test("Tierakten-Drawer-Routen sind erreichbar", async () => {
  const eventDrawer = await agent.get("/animals/1/events/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(eventDrawer.status, 200);
  assert.match(eventDrawer.text, /Ereignis erstellen/i);
  assert.match(eventDrawer.text, /data-drawer-fragment="animal-entry"/i);

  const noteDrawer = await agent.get("/animals/1/notes/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(noteDrawer.status, 200);
  assert.match(noteDrawer.text, /Protokoll anlegen/i);

  const documentDrawer = await agent.get("/animals/1/documents/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(documentDrawer.status, 200);
  assert.match(documentDrawer.text, /Dokument hochladen/i);
});

test("Direkte Seitenaufrufe von eingeblendeten Formularen leiten in den Kontext zurück", async () => {
  const vetCreate = await agent.get("/admin/veterinarians/new");
  assert.equal(vetCreate.status, 302);
  assert.match(vetCreate.headers.location || "", /^\/admin\/stammdaten\?drawer=/);

  const vetEdit = await agent.get("/admin/veterinarians/1/edit");
  assert.equal(vetEdit.status, 302);
  assert.match(vetEdit.headers.location || "", /^\/admin\/stammdaten\?drawer=/);

  const animalEdit = await agent.get("/animals/1/edit");
  assert.equal(animalEdit.status, 302);
  assert.match(animalEdit.headers.location || "", /^\/animals\/1\?drawer=/);

  const eventCreate = await agent.get("/animals/1/events/new");
  assert.equal(eventCreate.status, 302);
  assert.match(eventCreate.headers.location || "", /^\/animals\/1\?drawer=/);
});

test("Alle Tierakten-Aktionen liefern keine 404", async () => {
  await agent.post("/animals/1/conditions").type("form").send({
    title: "Arthrose",
    details: "Altbefund",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/feedings").type("form").send({
    label: "Morgens",
    food: "Trockenfutter",
    amount: "50 g",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/notes").type("form").send({
    title: "Tagesnotiz",
    content: "Alles ruhig.",
    return_to: "/animals/1",
  });
  await agent.post("/animals/1/reminders").type("form").send({
    title: "Kontrolle",
    reminder_type: "Allgemein",
    due_at: "2026-04-05T09:00",
    return_to: "/animals/1",
  });

  const animalPage = await agent.get("/animals/1");
  assert.equal(animalPage.status, 200);

  const conditionId = animalPage.text.match(/\/animals\/1\/conditions\/(\d+)\/edit/)?.[1];
  const feedingId = animalPage.text.match(/\/animals\/1\/feedings\/(\d+)\/edit/)?.[1];
  const noteId = animalPage.text.match(/\/animals\/1\/notes\/(\d+)\/edit/)?.[1];
  const reminderId = animalPage.text.match(/\/animals\/1\/reminders\/(\d+)\/edit/)?.[1];
  assert.ok(conditionId);
  assert.ok(feedingId);
  assert.ok(noteId);
  assert.ok(reminderId);

  const urls = [
    "/animals/1/events/new",
    "/animals/1/conditions/new",
    `/animals/1/conditions/${conditionId}/edit`,
    "/animals/1/feedings/new",
    `/animals/1/feedings/${feedingId}/edit`,
    "/animals/1/notes/new",
    `/animals/1/notes/${noteId}/edit`,
    "/animals/1/documents/new",
    "/animals/1/images/new",
    `/animals/1/reminders/${reminderId}/edit`,
  ];

  for (const url of urls) {
    const response = await agent.get(url).set("X-Requested-With", "heartpet-drawer").query({ return_to: "/animals/1" });
    assert.notEqual(response.status, 404, url);
    assert.equal(response.status, 200, url);
  }
});

test("Tiere-Arbeitsansicht zeigt Liste und ausgewählte Akte", async () => {
  const response = await agent.get("/animals").query({ animal_id: "1" });
  assert.equal(response.status, 200);
  assert.match(response.text, /animals-workspace/);
  assert.match(response.text, /Tierbestand/);
  assert.match(response.text, /Tobi|Minka/);
});

test("Tiere-Arbeitsansicht kann die rechte Akte separat laden", async () => {
  const response = await agent.get("/animals/1/workspace-panel").query({ animal_id: "1" });
  assert.equal(response.status, 200);
  assert.match(response.text, /data-animal-workspace-panel/);
  assert.match(response.text, /Ausgewähltes Tier/);
  assert.match(response.text, /Minka/);
});

test("Dashboard zeigt dringende Erinnerungen nicht doppelt bei den nächsten Erinnerungen", async () => {
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(1, "Heute fällig", "Impfung", dayjs().hour(16).minute(42).format("YYYY-MM-DDTHH:mm"), "dringend");

  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(1, "Morgen fällig", "Termin", dayjs().add(1, "day").hour(9).minute(0).format("YYYY-MM-DDTHH:mm"), "spaeter");

  const response = await agent.get("/");
  assert.equal(response.status, 200);

  const urgentSection = response.text.match(/<article class="panel" id="dringende-erinnerungen">([\s\S]*?)<\/article>/);
  const upcomingSection = response.text.match(/<article class="panel" id="naechste-erinnerungen">([\s\S]*?)<\/article>/);

  assert.ok(urgentSection?.[1]?.includes("Heute fällig"));
  assert.ok(!upcomingSection?.[1]?.includes("Heute fällig"));
  assert.ok(upcomingSection?.[1]?.includes("Morgen fällig"));
  assert.ok(upcomingSection?.[1]?.includes("Als erledigt markieren"));
});

test("Tierseite zeigt Tierarzt-Kontakt per Klick und erklärt die Schnellerfassung", async () => {
  const master = await agent.get("/admin/stammdaten");
  const vetId = master.text.match(/\/admin\/veterinarians\/(\d+)\/edit/)?.[1];
  assert.ok(vetId);

  await agent.post(`/admin/veterinarians/${vetId}/update`).type("form").send({
    name: "Praxis Kontakt",
    street: "Musterweg 12",
    postal_code: "12345",
    city: "Berlin",
    country: "Deutschland",
    email: "praxis@test.local",
    phone: "+49 123 456789",
    notes: "",
  });

  await agent.post("/animals/1/update").type("form").send({
    name: "Minka",
    species_name: "Katze",
    sex: "Weiblich",
    status: "Aktiv",
    veterinarian_id: vetId,
  });

  const response = await agent.get("/animals/1");
  assert.equal(response.status, 200);
  assert.match(response.text, /Kontaktdaten anzeigen/i);
  assert.match(response.text, /Schneller neuer Eintrag/i);
  assert.match(response.text, /Medikament/i);
  assert.match(response.text, /Vorerkrankung/i);
  assert.doesNotMatch(response.text, /animal-hero-address/i);
  assert.match(response.text, /Musterweg 12/i);
});

test("Wichtige interne Links liefern keine 404", async () => {
  const pages = [
    "/",
    "/animals",
    "/animals/1",
    "/admin/allgemein",
    "/admin/benachrichtigungen",
    "/admin/stammdaten",
    "/admin/benutzer",
    "/admin/import",
    "/admin/systemlog",
    "/hilfe",
  ];

  const checked = new Set();

  for (const page of pages) {
    const response = await agent.get(page);
    assert.equal(response.status, 200, page);

    const links = collectInternalLinks(response.text);
    for (const href of links) {
      if (checked.has(href)) {
        continue;
      }
      checked.add(href);
      const target = await agent.get(href).redirects(3);
      assert.notEqual(target.status, 404, href);
    }
  }
});

test("Wichtige Hauptseiten rendern ohne Template-Fehler", async () => {
  const routes = [
    "/",
    "/animals",
    "/animals/1",
    "/admin/allgemein",
    "/admin/benachrichtigungen",
    "/admin/stammdaten",
    "/admin/benutzer",
    "/admin/import",
    "/admin/systemlog",
    "/hilfe",
  ];

  for (const href of routes) {
    const response = await agent.get(href);
    assertNoTemplateError(response, href);
  }
});

test("Rechtstexte verwenden hinterlegte Organisations- und Kontaktdaten", async () => {
  const saveSettings = await agent.post("/admin/settings").type("form").send({
    _fields: "organization_name,legal_responsible_name,legal_content_responsible_name,legal_contact_street,legal_contact_postal_city,legal_contact_country,legal_contact_phone,legal_contact_email",
    organization_name: "Schellenbergers Tiere",
    legal_responsible_name: "Michael Schellenberger",
    legal_content_responsible_name: "Michael Schellenberger",
    legal_contact_street: "Musterweg 7",
    legal_contact_postal_city: "12345 Berlin",
    legal_contact_country: "Deutschland",
    legal_contact_phone: "+49 123 456789",
    legal_contact_email: "recht@schellenberger.biz",
  });
  assert.equal(saveSettings.status, 302);

  const imprint = await agent.get("/impressum");
  assert.equal(imprint.status, 200);
  assert.match(imprint.text, /Michael Schellenberger/);
  assert.match(imprint.text, /Musterweg 7/);
  assert.match(imprint.text, /12345 Berlin/);
  assert.match(imprint.text, /Deutschland/);
  assert.match(imprint.text, /\+49 123 456789/);
  assert.match(imprint.text, /recht@schellenberger\.biz/);
  assert.doesNotMatch(imprint.text, /\[Anschrift(?:, falls abweichend)?\]/);

  const privacy = await agent.get("/datenschutz");
  assert.equal(privacy.status, 200);
  assert.match(privacy.text, /Michael Schellenberger/);
  assert.match(privacy.text, /Musterweg 7/);
  assert.match(privacy.text, /12345 Berlin/);
  assert.match(privacy.text, /Deutschland/);
  assert.match(privacy.text, /recht@schellenberger\.biz/);
  assert.doesNotMatch(privacy.text, /\[Anschrift\]/);

  const contact = await agent.get("/kontakt");
  assert.equal(contact.status, 200);
  assert.match(contact.text, /Michael Schellenberger/);
  assert.match(contact.text, /recht@schellenberger\.biz/);
  assert.match(contact.text, /\+49 123 456789/);
  assert.doesNotMatch(contact.text, /\[optional\]/);

  const adminGeneral = await agent.get("/admin/allgemein");
  assert.equal(adminGeneral.status, 200);
  assert.match(adminGeneral.text, /Schellenbergers Tiere/);
  assert.match(adminGeneral.text, /Michael Schellenberger/);
  assert.match(adminGeneral.text, /Musterweg 7/);
  assert.match(adminGeneral.text, /12345 Berlin/);
  assert.match(adminGeneral.text, /Deutschland/);
  assert.match(adminGeneral.text, /recht@schellenberger\.biz/);
  assert.doesNotMatch(adminGeneral.text, /\[Anschrift\]/);
});

test("Rechtstext-Felder speichern keine Platzhalter als echte Daten", async () => {
  const saveSettings = await agent.post("/admin/settings").type("form").send({
    _fields: "legal_contact_street,legal_contact_postal_city,legal_contact_country,legal_contact_phone,legal_contact_email",
    legal_contact_street: "[Straße und Hausnummer]",
    legal_contact_postal_city: "[PLZ Ort]",
    legal_contact_country: "[Land]",
    legal_contact_phone: "[Telefonnummer optional]",
    legal_contact_email: "[recht@beispiel.de]",
  });
  assert.equal(saveSettings.status, 302);

  const adminGeneral = await agent.get("/admin/allgemein");
  assert.equal(adminGeneral.status, 200);
  assert.doesNotMatch(adminGeneral.text, /value="\[Straße und Hausnummer\]"/);
  assert.doesNotMatch(adminGeneral.text, /value="\[PLZ Ort\]"/);
  assert.doesNotMatch(adminGeneral.text, /value="\[Land\]"/);
  assert.doesNotMatch(adminGeneral.text, /value="\[Telefonnummer optional\]"/);
  assert.doesNotMatch(adminGeneral.text, /value="\[recht@beispiel\.de\]"/);
  assert.match(adminGeneral.text, /placeholder="z\. B\. Musterstraße 12"/);
  assert.match(adminGeneral.text, /placeholder="z\. B\. 12345 Musterstadt"/);
});

test("App-Logo kann hochgeladen und in der Oberflaeche verwendet werden", async () => {
  const logoPath = path.join(process.cwd(), "public", "images", "logo-heartpet.png");

  const saveLogo = await agent
    .post("/admin/settings")
    .field("_fields", "app_name")
    .field("app_name", "HeartPet")
    .attach("app_logo", logoPath);

  assert.equal(saveLogo.status, 302);

  const adminGeneral = await agent.get("/admin/allgemein");
  assert.equal(adminGeneral.status, 200);
  assert.match(adminGeneral.text, /\/media\/\d+-logo-heartpet\.png/);
});

test("Erinnerungs-Mail verwendet Umlaute und Direktlink", async () => {
  const reminder = {
    id: 99,
    animal_id: 1,
    animal_name: "Tobi",
    title: "Impftermin: Wurmkur",
    reminder_type: "Impfung",
    due_at: "2026-04-05T09:00",
    source_kind: "vaccination",
    source_id: 1,
  };

  const html = buildReminderEmailHtml({
    appName: "HeartPet",
    logoUrl: "",
    animalName: reminder.animal_name,
    title: reminder.title,
    type: reminder.reminder_type,
    dueLabel: "05.04.2026 09:00",
    notes: "Bitte Impfpass bereithalten.",
    animalUrl: "https://heartpet.de/animals/1",
    dashboardUrl: "https://heartpet.de/",
    completeUrl: "https://heartpet.de/reminders/99/email-complete?token=abc",
  });

  assert.match(html, /Für <strong>Tobi<\/strong> ist eine Erinnerung eingegangen\./);
  assert.match(html, /Fälligkeit/);
  assert.match(html, /Als erledigt markieren/);
});

test("Testmail enthält keinen Erledigt-Link ohne echte Erinnerung", async () => {
  const html = buildReminderEmailHtml({
    appName: "HeartPet",
    logoUrl: "",
    animalName: "Testtier",
    title: "SMTP-Test",
    type: "Test",
    dueLabel: "05.04.2026 09:00",
    notes: "Dies ist eine Testnachricht.",
    animalUrl: "",
    dashboardUrl: "https://heartpet.de/",
    completeUrl: "",
  });

  assert.doesNotMatch(html, /Als erledigt markieren/);
});

test("Erinnerung kann über Mail-Link als erledigt markiert werden", async () => {
  const vaccination = db.prepare(`
    INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, notes)
    VALUES (?, ?, NULL, ?, ?)
  `).run(1, "Wurmkur", "2026-04-05", "Testeintrag");

  const inserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes, source_kind, source_id)
    VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)
  `).run(1, "Impftermin: Wurmkur", "Impfung", "2026-04-05T09:00", "Test", "vaccination", vaccination.lastInsertRowid);

  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(inserted.lastInsertRowid);
  const token = buildReminderActionToken(reminder, "complete");

  const response = await agent.get(`/reminders/${reminder.id}/email-complete`).query({ token });
  assert.equal(response.status, 200);
  assert.match(response.text, /Erinnerung bestätigt/);

  const updatedReminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminder.id);
  assert.ok(updatedReminder.completed_at);

  const updatedVaccination = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ?").get(vaccination.lastInsertRowid);
  assert.ok(updatedVaccination.vaccination_date);
});

test("Telegram-Erinnerung enthält Aktionsbuttons", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };

  try {
    await sendTelegramReminder({
      app_name: "HeartPet",
      app_domain: "heartpet.de",
      telegram_bot_token: "123456:ABCDEF",
      telegram_chat_id: "987654",
    }, {
      id: 55,
      animal_id: 1,
      animal_name: "Tobi",
      title: "Impftermin: Wurmkur",
      reminder_type: "Impfung",
      due_at: "2026-04-05T09:00",
      notes: "Bitte Impfpass bereithalten.",
      source_kind: "vaccination",
      source_id: 1,
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.reply_markup);
  const buttons = body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((button) => /Als erledigt markieren/.test(button.text)));
  assert.ok(buttons.some((button) => /\+60 Min/.test(button.text)));
  assert.ok(buttons.some((button) => /\+6 Std/.test(button.text)));
  assert.ok(buttons.some((button) => /\+1 Tag/.test(button.text)));
  assert.ok(buttons.some((button) => /\+3 Tage/.test(button.text)));
});

test("Erinnerung kann über Link um 60 Minuten zurückgestellt werden", async () => {
  const inserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes, source_kind, source_id)
    VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?, ?)
  `).run(1, "Medikamentengabe: Test", "Medikament", "2026-04-05T09:00", "Test", "medication", 1);

  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(inserted.lastInsertRowid);
  const token = buildReminderActionToken(reminder, "snooze", "60");

  const response = await agent.get(`/reminders/${reminder.id}/email-snooze`).query({ token, value: "60" });
  assert.equal(response.status, 200);
  assert.match(response.text, /Erinnerung zurückgestellt/);

  const updatedReminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminder.id);
  assert.notEqual(updatedReminder.due_at, reminder.due_at);
  assert.equal(updatedReminder.completed_at, null);
  assert.equal(updatedReminder.last_notified_at, null);
  assert.equal(updatedReminder.last_delivery_status, "pending");
});

test("Erinnerungs-Bestätigungsseite verwendet absolute Asset-Links", async () => {
  const saveSettings = await agent.post("/admin/settings").type("form").send({
    _fields: "app_domain",
    app_domain: "heartpet.de",
  });
  assert.equal(saveSettings.status, 302);

  const response = await agent.get("/reminders/999999/email-complete").query({ token: "ungueltig" });
  assert.equal(response.status, 200);
  assert.match(response.text, /https:\/\/heartpet\.de\/static\/css\/app\.css/);
  assert.match(response.text, /https:\/\/heartpet\.de\/static\/js\/app\.js/);
});

test("Benachrichtigungskanaele lassen sich gezielt aktivieren und deaktivieren", async () => {
  let response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_email_enabled", reminder_email_enabled: "true" });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /E-Mail-Benachrichtigungen wurden aktiviert\./);
  assert.match(response.text, /Aktiviert/);

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_email_enabled", reminder_email_enabled: "false" });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /E-Mail-Benachrichtigungen wurden deaktiviert\./);
  assert.match(response.text, /Deaktiviert/);

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_telegram_enabled", reminder_telegram_enabled: "true" });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /Telegram-Benachrichtigungen wurden aktiviert\./);
  assert.match(response.text, /Aktiviert/);

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_telegram_enabled", reminder_telegram_enabled: "false" });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /Telegram-Benachrichtigungen wurden deaktiviert\./);
  assert.match(response.text, /Deaktiviert/);
});

test("Telegram-Testformular ist kein verschachteltes Formular", async () => {
  const response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);

  const telegramSettingsFormIndex = response.text.indexOf('id="telegram-settings-form"');
  const telegramSettingsSaveIndex = response.text.indexOf("Telegram speichern");
  const telegramTestFormIndex = response.text.indexOf('id="telegram-test-form"');
  assert.ok(telegramSettingsFormIndex >= 0);
  assert.ok(telegramSettingsSaveIndex >= 0);
  assert.ok(telegramTestFormIndex >= 0);
  assert.ok(
    telegramTestFormIndex > telegramSettingsSaveIndex,
    "Das Telegram-Testformular muss nach dem Telegram-Einstellungsformular kommen."
  );
});

test("Normales Speichern von E-Mail und Telegram ändert den Aktiv-Status nicht", async () => {
  let response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_email_enabled", reminder_email_enabled: "true" });
  assert.ok([302, 303].includes(response.status));

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({
      _fields: "smtp_host,smtp_port,smtp_user,smtp_password,smtp_from,notification_email_to,smtp_secure",
      smtp_host: "smtp.ionos.de",
      smtp_port: "587",
      smtp_user: "noreply@schellenberger.biz",
      smtp_password: "geheim",
      smtp_from: "noreply@schellenberger.biz",
      notification_email_to: "admin@schellenberger.biz",
    });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /Aktiviert/);

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "reminder_telegram_enabled", reminder_telegram_enabled: "true" });
  assert.ok([302, 303].includes(response.status));

  response = await agent
    .post("/admin/settings")
    .type("form")
    .send({
      _fields: "telegram_bot_token,telegram_chat_id",
      telegram_bot_token: "123456:abc",
      telegram_chat_id: "987654",
    });
  assert.ok([302, 303].includes(response.status));

  response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /Telegram/);
  assert.match(response.text, /Aktiviert/);
});

test("Benachrichtigungen zeigen den letzten erfolgreichen Test je Kanal an", async () => {
  db.prepare(`
    INSERT INTO notification_logs (channel, notification_type, recipient, subject, status, error_message, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "email",
    "test",
    "admin@test.local",
    "SMTP-Testnachricht",
    "sent",
    "",
    "{}",
    "2026-04-02 09:15:00"
  );

  db.prepare(`
    INSERT INTO notification_logs (channel, notification_type, recipient, subject, status, error_message, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "telegram",
    "test",
    "12345",
    "Telegram-Testnachricht",
    "sent",
    "",
    "{}",
    "2026-04-02 10:45:00"
  );

  const response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);
  assert.match(response.text, /Letzter erfolgreicher Test:/);
  assert.match(response.text, /02\.04\.2026 09:15/);
  assert.match(response.text, /02\.04\.2026 10:45/);
});

test("PDF-Export bleibt bei typischen Tierdaten auf einer A4-Seite", async () => {
  const chunks = [];
  const res = new PassThrough();
  res.setHeader = () => {};
  res.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    res.on("end", resolve);
    res.on("error", reject);
  });

  await createAnimalPdf(
    res,
    {
      id: 99,
      name: "Tobi",
      species_name: "Katze",
      sex: "Weiblich",
      birth_date: "2022-01-01",
      intake_date: "2022-02-01",
      status: "Aktiv",
      source: "Tierheim",
      breed: "EKH",
      color: "Weiß",
      weight_kg: "4.2",
      veterinarian_name: "Praxis Eichelberger",
      notes: "Kurzer Testfall für den PDF-Export.",
    },
    {
      conditions: [{ title: "Chronisch", details: "Muss beobachtet werden" }],
      medications: [{ name: "Wurmkur", dosage: "1x", schedule: "monatlich" }],
      vaccinations: [{ name: "Impfung", next_due_date: "2026-04-03" }],
      appointments: [{ title: "Nachkontrolle", appointment_at: "2026-04-03T10:00", location_mode: "praxis" }],
      feedings: [{ label: "Morgens", time_of_day: "08:00", food: "Nassfutter" }],
      reminders: [{ title: "Impfung erinnern", due_at: "2026-04-03T09:00" }],
      documents: [{ title: "Vertrag", category_name: "Dokument" }],
      images: [{ title: "Profilbild", original_name: "bild.jpg" }],
      notes: [{ title: "Beobachtung", content: "Frisst gut und ist aktiv." }],
    },
    { domain: "heartpet.de" }
  );

  await finished;
  const pdfText = Buffer.concat(chunks).toString("latin1");
  const pageCount = Number(pdfText.match(/\/Type \/Pages\s*\/Count (\d+)/)?.[1] || "0");

  assert.equal(pageCount, 1);
});

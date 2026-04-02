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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PassThrough } = require("node:stream");
const request = require("supertest");
const dayjs = require("dayjs");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-test-"));
process.env.HEARTPET_DATA_DIR = tempDataDir;
process.env.NODE_ENV = "test";
process.env.HEARTPET_SESSION_SECRET = "test-secret";
process.env.HEARTPET_SESSION_STORE = "memory";
process.env.HEARTPET_DISABLE_EXTERNAL_WEATHER = "true";
process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK = "true";

const { initDatabase, upsertSetting } = require("../src/db");
const { createInitialAdmin, generateInitialPassword } = require("../src/initial-admin");
const { createAnimalPdf } = require("../src/exporters");
const { buildReminderActionToken, buildReminderEmailHtml, sendTelegramReminder, sendTestNtfy, processDueReminders } = require("../src/reminders");
const { getVaccinationSuggestionGroups, getVaccinationSuggestionsForSpecies } = require("../src/vaccination-suggestions");
const { runMigrations } = require("../src/migrations");
const { FIELD_SCHEMAS, htmlConstraints, validateText } = require("../src/validation");
const app = require("../src/app");
const agent = request.agent(app);
const db = initDatabase();

test("Häufige Impfungen werden passend zur Tierart vorgeschlagen", () => {
  assert.deepEqual(getVaccinationSuggestionsForSpecies("Hühner").suggestions, [
    "Newcastle-Krankheit (ND)",
    "Infektiöse Bronchitis (IB)",
  ]);
  assert.deepEqual(getVaccinationSuggestionsForSpecies("Katze").suggestions, [
    "RCP (Katzenschnupfen und Katzenseuche)",
    "Tollwut",
  ]);
  assert.deepEqual(getVaccinationSuggestionsForSpecies("Papagei").suggestions, []);
  assert.deepEqual(getVaccinationSuggestionGroups(["Katze", "Katzen", "Huhn"]).map((group) => group.speciesName), ["Huhn", "Katze"]);
});

test("Impfvorschläge erkennen zusammengesetzte Tierartnamen", () => {
  assert.deepEqual(
    getVaccinationSuggestionsForSpecies("Legehuhn").suggestions,
    getVaccinationSuggestionsForSpecies("Huhn").suggestions,
  );
  assert.deepEqual(
    getVaccinationSuggestionsForSpecies("Hauskatze").suggestions,
    getVaccinationSuggestionsForSpecies("Katze").suggestions,
  );
});

test("Impfvorschläge fallen bei einer leeren Stammdatenliste auf sichere Vorgaben zurück", () => {
  assert.deepEqual(getVaccinationSuggestionsForSpecies("Katze", []).suggestions, [
    "RCP (Katzenschnupfen und Katzenseuche)",
    "Tollwut",
  ]);
});

test("CCU-Sitzungsverlängerung behält die bestehende ID bei boolescher Bestätigung", () => {
  assert.equal(app.__test.resolveRenewedHomematicSid(true, "SESSION-123"), "SESSION-123");
  assert.equal(app.__test.resolveRenewedHomematicSid("true", "SESSION-123"), "SESSION-123");
  assert.equal(app.__test.resolveRenewedHomematicSid(false, "SESSION-123"), "");
  assert.equal(app.__test.resolveRenewedHomematicSid({ _session_id_: "SESSION-456" }, "SESSION-123"), "SESSION-456");
});

test("CCU öffnet nach vorübergehenden Verlängerungsfehlern keine neue Sitzung", () => {
  assert.equal(app.__test.shouldReplaceHomematicSessionAfterRenewError(new Error("CCU antwortet mit HTTP 503.")), false);
  assert.equal(app.__test.shouldReplaceHomematicSessionAfterRenewError(new Error("This session is invalid")), true);
  assert.equal(app.__test.shouldReplaceHomematicSessionAfterRenewError(new Error("Die CCU hat die Verlängerung der Sitzung abgelehnt.")), true);
});

test("Mehrdeutige CCU-Anmeldefehler sperren weitere Versuche für 30 Minuten", () => {
  assert.equal(app.__test.getHomematicLoginRetryDelay("invalid credentials or too many sessions"), 30 * 60 * 1000);
  assert.equal(app.__test.getHomematicLoginRetryDelay("Verbindung abgebrochen"), 5 * 60 * 1000);
});

test("Alle HTML-Pattern sind mit der aktuellen Browser-RegExp-Syntax gültig", () => {
  const templatesDir = path.join(__dirname, "..", "views");
  const templates = fs.readdirSync(path.join(templatesDir, "pages"))
    .filter((name) => name.endsWith(".ejs"))
    .map((name) => path.join(templatesDir, "pages", name));
  for (const template of templates) {
    const source = fs.readFileSync(template, "utf8");
    for (const match of source.matchAll(/\bpattern="([^"]+)"/g)) {
      assert.doesNotThrow(() => new RegExp(match[1], "v"), `${path.basename(template)}: pattern=${match[1]}`);
    }
  }
});

test("Kamera-Zugangsdaten werden als Basic-Auth-Header statt in der Fetch-URL verwendet", () => {
  const target = app.__test.createAuthenticatedFetchTarget("http://admin:p%40ss%21@192.168.1.80/video/mjpg.cgi");
  assert.equal(target.url, "http://192.168.1.80/video/mjpg.cgi");
  assert.equal(target.headers.Authorization, `Basic ${Buffer.from("admin:p@ss!").toString("base64")}`);
});

test("Kameraproxy kann Digest-Authentifizierung für IP-Kameras aufbauen", () => {
  const authorization = app.__test.buildDigestAuthorization({
    username: "admin",
    password: "secret",
    method: "GET",
    requestUrl: "http://192.168.1.80/video/mjpg.cgi?chn=0",
    challengeHeader: 'Digest realm="camera", nonce="abc123", qop="auth", algorithm=MD5',
  });
  assert.match(authorization, /^Digest /);
  assert.match(authorization, /username="admin"/);
  assert.match(authorization, /uri="\/video\/mjpg\.cgi\?chn=0"/);
  assert.match(authorization, /response="[a-f0-9]{32}"/);
});

test("RTSP-Kameras werden als ffmpeg-Quelle erkannt", () => {
  const cameras = app.__test.parseCoopCameras("Wansview W2|rtsp://admin:secret@192.168.1.172:554/live/ch0");
  assert.deepEqual(cameras, [{
    name: "Wansview W2",
    url: "rtsp://admin:secret@192.168.1.172:554/live/ch0",
    snapshotUrl: "rtsp://admin:secret@192.168.1.172:554/live/ch0",
    streamUrl: "rtsp://admin:secret@192.168.1.172:554/live/ch0",
    group: "Kameras",
    snapshotProtocol: "rtsp",
    protocol: "rtsp",
  }]);
});

test("Kameras können getrennte Standbild- und Stream-URLs verwenden", () => {
  const cameras = app.__test.parseCoopCameras("Stall|http://camera/snapshot.jpg|rtsp://camera/live/ch0|Hühnerstall");
  assert.equal(cameras[0].snapshotUrl, "http://camera/snapshot.jpg");
  assert.equal(cameras[0].streamUrl, "rtsp://camera/live/ch0");
  assert.equal(cameras[0].snapshotProtocol, "http");
  assert.equal(cameras[0].protocol, "rtsp");
  assert.equal(cameras[0].group, "Hühnerstall");
});

test("Kamera-Platzhalter zeigt Fehlercode und maskiert XML-Zeichen", () => {
  const svg = app.__test.buildCameraPlaceholderSvg({
    cameraName: "Stall <innen>",
    statusCode: "TIMEOUT",
    message: "Kamera & Netzwerk nicht erreichbar.",
  });
  assert.match(svg, /Stall &lt;innen&gt;/);
  assert.match(svg, /Kamera &amp; Netzwerk/);
  assert.match(svg, /TIMEOUT/);
  assert.doesNotMatch(svg, /Stall <innen>/);
});

test("Wettercodes liefern verständliche und visuelle Zustände", () => {
  assert.deepEqual(app.__test.getWeatherCodeMeta(0, 1), { label: "Klar", icon: "☀️" });
  assert.deepEqual(app.__test.getWeatherCodeMeta(63, 1), { label: "Regen", icon: "🌧️" });
  assert.deepEqual(app.__test.getWeatherCodeMeta(95, 1), { label: "Gewitter", icon: "⛈️" });
});

test("ntfy sendet Topic, Token und verständliche Testnachricht", async () => {
  const previousFetch = global.fetch;
  let requestData = null;
  global.fetch = async (url, options) => {
    requestData = { url, options };
    return { ok: true, status: 200 };
  };
  try {
    await sendTestNtfy({
      app_name: "HeartPet",
      app_domain: "heartpet.de",
      ntfy_server_url: "https://ntfy.example",
      ntfy_topic: "stall",
      ntfy_access_token: "secret",
    });
  } finally {
    global.fetch = previousFetch;
  }
  assert.equal(requestData.url, "https://ntfy.example/stall");
  assert.equal(requestData.options.headers.Authorization, "Bearer secret");
  assert.match(requestData.options.body, /funktioniert/);
});

test("Homematic-Klimawerte ignorieren IDs und lesen JSON- oder XML-Werte", () => {
  assert.equal(app.__test.parseHomematicTextValue('<state><datapoint ise_id="1234" value="21.7"/></state>', ["temperature", "temperatur", "temp"]), 21.7);
  const deviceXml = '<state><device ise_id="2341"><channel ise_id="2361"><datapoint ise_id="2362" name="HmIP-SWO:1.ACTUAL_TEMPERATURE" value="18.6"/><datapoint ise_id="2363" name="HmIP-SWO:1.HUMIDITY" value="67"/></channel></device></state>';
  assert.equal(app.__test.findHomematicXmlDatapoint(deviceXml, ["actual_temperature", "temperature"]), 18.6);
  assert.equal(app.__test.findHomematicXmlDatapoint(deviceXml, ["humidity", "luftfeuchte"]), 67);
  assert.equal(app.__test.findHomematicValue({ ise_id: 1234, HmIP_TEMPERATURE: 19.4 }, ["temperature", "temperatur", "temp"]), 19.4);
  assert.equal(app.__test.findHomematicValue({ id: 99, value: 63 }, ["humidity", "luftfeuchte", "feuchte", "hum"]), 63);
});

test("Als Markdown eingefügte Homematic-URLs werden auf die reine URL reduziert", () => {
  const pasted = "[http://192.168.1.22/addons/xmlapi/state.cgi?sid=abc\\&channel\\_id=2361](http://example.invalid)";
  assert.equal(
    app.__test.normalizeConfiguredUrl(pasted),
    "http://192.168.1.22/addons/xmlapi/state.cgi?sid=abc&channel_id=2361"
  );
});

test("XML-API-Aufrufe übernehmen den konfigurierten addons-Pfad und Token", () => {
  const url = new URL(app.__test.buildHomematicXmlApiUrl({
    homematic_ccu_url: "http://192.168.1.22/addons/xmlapi/?sid=token-aus-url",
    homematic_xmlapi_token: "alter-separater-token",
  }, "state.cgi", { datapoint_id: "2363,2362" }));
  assert.equal(url.pathname, "/addons/xmlapi/state.cgi");
  assert.equal(url.searchParams.get("sid"), "token-aus-url");
  assert.equal(url.searchParams.get("datapoint_id"), "2363,2362");
  assert.match(url.href, /datapoint_id=2363,2362/);
});

test("XML-API-Token kann auch als vollständige URL eingefügt werden", () => {
  assert.equal(
    app.__test.normalizeHomematicXmlApiToken("http://192.168.1.22/addons/xmlapi/?sid=@token@"),
    "@token@"
  );
});

test("XML-API-Token wird sicher als sid-Parameter an die Klima-URL angehängt", () => {
  assert.equal(
    app.__test.buildHomematicClimateUrl(
      "http://192.168.1.22/addons/xmlapi/state.cgi?channel_id=2361",
      "token mit leerzeichen"
    ),
    "http://192.168.1.22/addons/xmlapi/state.cgi?channel_id=2361&sid=token+mit+leerzeichen"
  );
  assert.equal(
    app.__test.buildHomematicClimateUrl(
      "http://192.168.1.22/addons/xmlapi/state.cgi?sid=vorhanden&channel_id=2361",
      "neu"
    ),
    "http://192.168.1.22/addons/xmlapi/state.cgi?sid=vorhanden&channel_id=2361"
  );
});

test("Homematic-Türbefehle ergänzen den Token und normalisieren value zu new_value", () => {
  assert.deepEqual(
    app.__test.parseHomematicStateChange("http://192.168.1.22/config/xmlapi/statechange.cgi?ise_id=12990&new_value=1.0"),
    { iseId: "12990", newValue: "1.0" }
  );
  assert.equal(
    app.__test.buildHomematicCommandUrl(
      "http://192.168.1.22/config/xmlapi/statechange.cgi?sid=@DEINE_SESSION_ID@&ise_id=12990&value=0.0",
      "echter-token"
    ),
    "http://192.168.1.22/config/xmlapi/statechange.cgi?sid=echter-token&ise_id=12990&new_value=0.0"
  );
  assert.equal(
    app.__test.getHomematicCommandResponseError("<not_authenticated/>"),
    "XML-API-Token ist ungültig oder fehlt."
  );
  assert.equal(app.__test.getHomematicCommandResponseError('<device error="true"/>'), "Datenpunkt wurde von der XML-API nicht gefunden.");
  assert.equal(app.__test.getHomematicCommandResponseError('<result><changed ise_id="12990"/></result>'), "");
});

test("Homematic-Türbefehle erkennen abgelehnte und unbekannte Datenpunkte", () => {
  assert.match(app.__test.getHomematicCommandResponseError("<result><not_found /></result>"), /nicht gefunden/);
  assert.match(app.__test.getHomematicCommandResponseError('<result><changed id="12990" new_value="1.0" success="false" /></result>'), /abgelehnt/);
  assert.equal(app.__test.getHomematicCommandResponseError('<result><changed id="12990" new_value="1.0" success="true" /></result>'), "");
});

test("Stalltür-Konfiguration erzeugt Befehle nur aus ISE-ID und Wert", () => {
  const settings = {
    homematic_ccu_url: "http://192.168.1.22/addons/xmlapi/",
    homematic_door_open_datapoint_id: "12990",
    homematic_door_close_datapoint_id: "12998",
    homematic_door_open_value: "1.0",
    homematic_door_close_value: "1.0",
  };
  assert.equal(app.__test.parseHomematicStateChange(app.__test.getHomematicDoorCommand(settings, true)).iseId, "12990");
  assert.equal(app.__test.parseHomematicStateChange(app.__test.getHomematicDoorCommand(settings, true)).newValue, "1.0");
  assert.equal(app.__test.parseHomematicStateChange(app.__test.getHomematicDoorCommand(settings, false)).iseId, "12998");
  assert.equal(app.__test.parseHomematicStateChange(app.__test.getHomematicDoorCommand(settings, false)).newValue, "1.0");
});

test("Alte Stalltür-Konfiguration mit gemeinsamer ISE-ID bleibt kompatibel", () => {
  const settings = { homematic_ccu_url: "http://192.168.1.22/addons/xmlapi/", homematic_door_command_datapoint_id: "12990", homematic_door_close_value: "0.0" };
  assert.equal(app.__test.parseHomematicStateChange(app.__test.getHomematicDoorCommand(settings, false)).iseId, "12990");
});

test("Getrennte LEVEL-Richtungen setzen vor dem Schalten den Gegenkanal zurück", () => {
  const settings = {
    homematic_ccu_url: "http://192.168.1.22/addons/xmlapi/",
    homematic_door_open_datapoint_id: "12990",
    homematic_door_close_datapoint_id: "12998",
    homematic_door_open_value: "1.0",
    homematic_door_close_value: "1.0",
  };
  const openSequence = app.__test.getHomematicDoorCommandSequence(settings, true).map(app.__test.parseHomematicStateChange);
  assert.deepEqual(openSequence, [
    { iseId: "12998", newValue: "0.0" },
    { iseId: "12990", newValue: "1.0" },
  ]);
  const closeSequence = app.__test.getHomematicDoorCommandSequence(settings, false).map(app.__test.parseHomematicStateChange);
  assert.deepEqual(closeSequence, [
    { iseId: "12990", newValue: "0.0" },
    { iseId: "12998", newValue: "1.0" },
  ]);
});

test("Gemeinsamer LEVEL-Kanal schaltet beide Richtungen ohne Gegenkanal-Sequenz", () => {
  const settings = {
    homematic_ccu_url: "http://192.168.1.22/addons/xmlapi/",
    homematic_door_open_datapoint_id: "13006",
    homematic_door_close_datapoint_id: "13006",
    homematic_door_open_value: "0.0",
    homematic_door_close_value: "1.0",
  };
  assert.deepEqual(
    app.__test.getHomematicDoorCommandSequence(settings, true).map(app.__test.parseHomematicStateChange),
    [{ iseId: "13006", newValue: "0.0" }],
  );
  assert.deepEqual(
    app.__test.getHomematicDoorCommandSequence(settings, false).map(app.__test.parseHomematicStateChange),
    [{ iseId: "13006", newValue: "1.0" }],
  );
});

test("CCU-Erkennung liefert ausschließlich schreibbare Datenpunkte", () => {
  const xml = `<device name="Hühnerklappe"><channel name="Hühnerklappe:3">
    <datapoint name="LEVEL" type="LEVEL" ise_id="12983" value="0.0" operations="5" />
    <datapoint name="LEVEL" type="LEVEL" ise_id="12990" value="0.0" operations="7" />
  </channel></device>`;
  assert.deepEqual(app.__test.parseWritableHomematicDatapoints(xml).map((item) => item.id), ["12990"]);
});

test("CCU-XML wird entsprechend der ISO-8859-1-Deklaration dekodiert", () => {
  const prefix = Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><device name="H`, "ascii");
  const suffix = Buffer.from(`hnerklappe"/>`, "ascii");
  const xml = app.__test.decodeHomematicXmlBuffer(Buffer.concat([prefix, Buffer.from([0xfc]), suffix]));
  assert.match(xml, /Hühnerklappe/);
});

async function ensureSetupComplete() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0) return;
  createInitialAdmin(db, { email: "admin@test.local", password: "passwort123!" });
  db.prepare("UPDATE users SET must_change_password = 0").run();
}

async function ensureAdminAuthenticated() {
  await ensureSetupComplete();
  const response = await agent.get("/admin/benachrichtigungen");
  if (response.status === 200) return;

  const login = await agent.post("/login").type("form").send({
    email: "admin@test.local",
    password: "passwort123!",
  });
  assert.ok([302, 303].includes(login.status));
}

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

function createUserWithPassword({ name, email, password, role = "viewer", permissions = {} }) {
  const passwordHash = bcrypt.hashSync(password, 10);
  return db.prepare(`
    INSERT INTO users (
      name, email, password_hash, role, must_change_password,
      can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
      can_manage_feedings, can_manage_notes, can_manage_reminders
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    String(email || "").trim().toLowerCase(),
    passwordHash,
    role,
    0,
    permissions.can_edit_animals ? 1 : 0,
    permissions.can_manage_documents ? 1 : 0,
    permissions.can_manage_gallery ? 1 : 0,
    permissions.can_manage_health ? 1 : 0,
    permissions.can_manage_feedings ? 1 : 0,
    permissions.can_manage_notes ? 1 : 0,
    permissions.can_manage_reminders ? 1 : 0
  ).lastInsertRowid;
}

test.after(() => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test("CLI-Ersteinrichtung erzeugt einen Admin mit verpflichtendem Passwortwechsel", async () => {
  assert.throws(() => createInitialAdmin(db, { email: "admin@test.local", accessMode: "domain", appDomain: "https://tiere.test.local/pfad" }), /HTTPS-Adresse ohne Pfad/);
  const setup = createInitialAdmin(db, {
    email: "admin@test.local",
    name: "Test Admin",
    password: "einmal-passwort-123!",
    accessMode: "domain",
    appDomain: "https://tiere.test.local",
  });
  assert.equal(setup.created, true);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'access_mode'").get()?.value, "domain");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'app_domain'").get()?.value, "https://tiere.test.local");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM veterinarians").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM animals").get().count, 0);
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE email = ?").get("admin@test.local").must_change_password, 1);

  const oldSetupPage = await agent.get("/setup");
  assert.equal(oldSetupPage.status, 302);
  assert.equal(oldSetupPage.headers.location, "/login");
  const firstLogin = await agent.post("/login").type("form").send({ email: "admin@test.local", password: "einmal-passwort-123!" });
  assert.equal(firstLogin.headers.location, "/first-login/password");
  const passwordPage = await agent.get("/first-login/password");
  assert.equal(passwordPage.status, 200);
  assert.match(passwordPage.text, /Eigenes Passwort festlegen/);
  const passwordChange = await agent.post("/first-login/password").type("form").send({
    new_password: "passwort123!",
    new_password_confirm: "passwort123!",
  });
  assert.equal(passwordChange.headers.location, "/");
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE email = ?").get("admin@test.local").must_change_password, 0);

  const veterinarianId = db.prepare("INSERT INTO veterinarians (name) VALUES (?)").run("Tierarzt Test").lastInsertRowid;
  const speciesId = db.prepare("INSERT INTO species (name) VALUES (?)").run("Katze").lastInsertRowid;
  db.prepare("INSERT INTO animals (name, species_id, status, veterinarian_id) VALUES (?, ?, ?, ?)")
    .run("Minka", speciesId, "Aktiv", veterinarianId);

  const speciesRows = db.prepare("SELECT name FROM species ORDER BY name ASC").all();
  assert.deepEqual(speciesRows.map((item) => item.name), ["Katze"]);
});

test("Generierte Einmalpasswörter sind kopierbar und enthalten keine Sonderzeichen", () => {
  const password = generateInitialPassword();
  assert.match(password, /^[A-Za-z0-9]+$/);
  assert.ok(password.length >= 32);
});

test("Login erneuert die Session-ID", async () => {
  const loginAgent = request.agent(app);
  const failedLogin = await loginAgent.post("/login").type("form").send({
    email: "admin@test.local",
    password: "falsch",
  });
  const sessionBeforeLogin = failedLogin.headers["set-cookie"]?.find((value) => value.startsWith("heartpet.sid="));

  const successfulLogin = await loginAgent.post("/login").type("form").send({
    email: "admin@test.local",
    password: "passwort123!",
  });
  const sessionAfterLogin = successfulLogin.headers["set-cookie"]?.find((value) => value.startsWith("heartpet.sid="));

  assert.equal(successfulLogin.status, 302);
  assert.ok(sessionBeforeLogin);
  assert.ok(sessionAfterLogin);
  assert.notEqual(sessionAfterLogin.split(";", 1)[0], sessionBeforeLogin.split(";", 1)[0]);
});

test("Login akzeptiert Umlaute und Sonderzeichen im Passwort unverändert", async () => {
  await ensureSetupComplete();
  const specialPassword = `Ärger! "Haus" & Huhn's #1`;
  const email = "sonderzeichen@test.local";
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, must_change_password)
    VALUES (?, ?, ?, 'admin', 0)
  `).run("Sonderzeichen Admin", email, bcrypt.hashSync(specialPassword, 12));

  const response = await request.agent(app).post("/login").type("form").send({
    email,
    password: specialPassword,
  });
  db.prepare("DELETE FROM users WHERE email = ?").run(email);

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/");
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
  const migrationIds = migrationRows.map((row) => row.id);
  assert.ok(migrationIds.includes("001_initial_schema"));
  assert.ok(migrationIds.includes("002_schema_updates"));
  assert.ok(migrationIds.includes("003_user_invites"));
  assert.ok(migrationIds.includes("004_animal_status_context"));
  assert.ok(migrationIds.includes("006_user_access_tracking"));
  assert.ok(migrationIds.includes("007_animal_microchip_details"));
  assert.ok(migrationIds.includes("008_vaccination_presets"));
  assert.ok(migrationIds.includes("009_repair_vaccination_presets"));
  assert.ok(db.prepare("SELECT 1 FROM vaccination_presets WHERE species_name = ? AND name = ?").get(
    "Katze",
    "RCP (Katzenschnupfen und Katzenseuche)",
  ));
});

test("Reparaturmigration stellt eine trotz Migrationsprotokoll fehlende Impfungstabelle wieder her", () => {
  const repairDb = new Database(":memory:");
  runMigrations(repairDb);
  repairDb.exec("DROP TABLE vaccination_presets");
  repairDb.prepare("DELETE FROM schema_migrations WHERE id = ?").run("009_repair_vaccination_presets");

  runMigrations(repairDb);

  assert.ok(repairDb.prepare("SELECT 1 FROM vaccination_presets WHERE species_name = ?").get("Katze"));
  repairDb.close();
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

test("Systemlog bleibt mit älteren Audit-Daten und fehlenden optionalen Stammdaten erreichbar", async () => {
  const legacyAudit = db.prepare(`
    INSERT INTO audit_logs (actor_email, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "admin@test.local",
    "vaccination.bulk_create",
    "vaccination",
    "legacy",
    JSON.stringify({
      name: "Altbestand",
      animal_names: "Minka, Luna",
      vaccination_date: "2026-09-20",
    }),
  );

  db.exec("ALTER TABLE disposal_facilities RENAME TO disposal_facilities_systemlog_test");
  try {
    const response = await agent.get("/admin/systemlog");
    assert.equal(response.status, 200);
    assert.match(response.text, /Minka, Luna/);
  } finally {
    db.exec("ALTER TABLE disposal_facilities_systemlog_test RENAME TO disposal_facilities");
    db.prepare("DELETE FROM audit_logs WHERE id = ?").run(legacyAudit.lastInsertRowid);
  }
});

test("Health-Checks liefern einen minimalen öffentlichen und geschützten Detailstatus", async () => {
  const publicHealth = await request(app).get("/health");
  assert.equal(publicHealth.status, 200);
  assert.equal(publicHealth.body.ok, true);
  assert.equal(publicHealth.body.service, "heartpet");
  assert.equal(publicHealth.body.restartRequired, false);
  assert.equal(publicHealth.body.revision, publicHealth.body.availableRevision);

  const adminHealth = await agent.get("/admin/health");
  assert.equal(adminHealth.status, 200);
  assert.equal(adminHealth.body.ok, true);
  assert.equal(adminHealth.body.restartRequired, false);
  assert.ok(Array.isArray(adminHealth.body.checks));
  assert.equal(typeof adminHealth.body.runtime.averageDurationMs, "number");
});

test("Update-Status ist nur für Administratoren verfügbar und bleibt im Testbetrieb offline", async () => {
  const anonymous = await request(app).get("/api/update-status");
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.location, /^\/login/);

  await ensureAdminAuthenticated();
  const response = await agent.get("/api/update-status");
  assert.equal(response.status, 200);
  assert.equal(response.body.checked, false);
  assert.equal(response.body.updateAvailable, false);
  assert.equal(response.headers["cache-control"], "private, no-store");
});

test("Alle internen API- und Steuerungsrouten sind mit der vorgesehenen Methode registriert", () => {
  const routeEntries = (stack, prefix = "") => stack.flatMap((layer) => {
    if (layer.route && typeof layer.route.path === "string") {
      return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${prefix}${layer.route.path}`);
    }
    if (Array.isArray(layer.handle?.stack)) {
      return routeEntries(layer.handle.stack, layer.handle.heartpetMountPath ?? "/admin");
    }
    return [];
  });
  const registered = new Set(routeEntries(app.router.stack));
  const expected = [
    "GET /health",
    "GET /admin/health",
    "GET /api/update-status",
    "GET /api/species/search",
    "GET /api/reminders/pending",
    "GET /animals/suggest",
    "GET /admin/suggest",
    "GET /coop/cameras/:index/status",
    "GET /admin/coop/climate-status",
    "GET /admin/coop/homematic-datapoints",
    "POST /coop/door/open",
    "POST /coop/door/close",
    "POST /admin/coop/door-test/:direction",
    "POST /admin/coop/camera-preview",
    "POST /admin/systemlog/diagnose",
    "POST /animals/:id/memorial-note",
    "POST /animals/:id/profile-image",
    "POST /animals/:id/profile-image/delete",
    "POST /animals/:id/images",
    "POST /animals/:animalId/images/:entryId/update",
    "POST /animals/:animalId/images/:entryId/set-profile",
    "POST /animals/:animalId/images/:entryId/delete",
    "POST /admin/settings/app-logo/delete",
  ];

  expected.forEach((route) => assert.ok(registered.has(route), `${route} ist nicht registriert`));
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

test("Geschützte Tierseiten merken sich das Ziel für den Login", async () => {
  const anonymous = request(app);
  const response = await anonymous.get("/animals/1");
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/login?return_to=%2Fanimals%2F1");
});

test("Login führt mit return_to wieder direkt zur Tierakte zurück", async () => {
  const anonymousAgent = request.agent(app);
  const gated = await anonymousAgent.get("/animals/1");
  assert.equal(gated.status, 302);
  assert.equal(gated.headers.location, "/login?return_to=%2Fanimals%2F1");

  const loginPage = await anonymousAgent.get("/login").query({ return_to: "/animals/1" });
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /name="return_to" value="\/animals\/1"/);

  const login = await anonymousAgent.post("/login").type("form").send({
    email: "admin@test.local",
    password: "passwort123!",
    return_to: "/animals/1",
  });

  assert.equal(login.status, 302);
  assert.equal(login.headers.location, "/animals/1");
  const sessionCookie = (login.headers["set-cookie"] || []).find((cookie) => cookie.startsWith("heartpet.sid="));
  assert.ok(sessionCookie);
  const expiresMatch = sessionCookie.match(/Expires=([^;]+)/i);
  assert.ok(expiresMatch);
  assert.ok(new Date(expiresMatch[1]).getTime() - Date.now() > 20 * 24 * 60 * 60 * 1000);
});

test("Leere Login-Posts erzeugen keinen technischen Fehler", async () => {
  const loginAgent = request.agent(app);
  const response = await loginAgent.post("/login");
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/login");

  const loginPage = await loginAgent.get("/login");
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /Login fehlgeschlagen/);
  assert.doesNotMatch(loginPage.text, /Technischer Fehler|Cannot read properties/i);
});

test("Passwort-Reset verwendet einen Einmal-Link und beendet bestehende Sitzungen", async () => {
  const email = `reset-${Date.now()}@test.local`;
  const userId = createUserWithPassword({
    name: "Reset Nutzer",
    email,
    password: "altesPasswort1",
    role: "viewer",
  });
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const activeSession = request.agent(app);
  const activeLogin = await activeSession.post("/login").type("form").send({ email, password: "altesPasswort1" });
  assert.equal(activeLogin.status, 302);
  assert.equal((await activeSession.get("/")).status, 200);

  const originalCreateTransport = nodemailer.createTransport;
  let sentMail = null;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      sentMail = payload;
      return { messageId: "password-reset" };
    },
  });

  try {
    const forgotPage = await request(app).get("/password-forgot");
    assert.equal(forgotPage.status, 200);
    assert.match(forgotPage.text, /Passwort vergessen/i);

    const requestReset = await request(app).post("/password-forgot").type("form").send({ email });
    assert.equal(requestReset.status, 302);
    assert.equal(requestReset.headers.location, "/login");
    assert.equal(sentMail?.to, email);
    const token = sentMail?.text?.match(/password-reset\?token=([a-f0-9]+)/i)?.[1];
    assert.ok(token);

    const tokenPage = await request(app).get("/password-reset").query({ token });
    assert.equal(tokenPage.status, 200);
    assert.match(tokenPage.text, /Neues Passwort festlegen/i);

    const save = await request(app).post("/password-reset").type("form").send({
      token,
      new_password: "neuesPasswort2",
      new_password_confirm: "neuesPasswort2",
    });
    assert.equal(save.status, 302);
    assert.equal(save.headers.location, "/login");
    assert.equal(bcrypt.compareSync("neuesPasswort2", db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId).password_hash), true);

    const oldSessionResponse = await activeSession.get("/");
    assert.equal(oldSessionResponse.status, 302);
    assert.match(oldSessionResponse.headers.location, /^\/login/);
    assert.equal((await request(app).get("/password-reset").query({ token })).status, 400);

    const newSession = request.agent(app);
    const newLogin = await newSession.post("/login").type("form").send({ email, password: "neuesPasswort2" });
    assert.equal(newLogin.status, 302);
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    db.prepare("UPDATE settings SET value = '' WHERE key IN ('smtp_host', 'smtp_from')").run();
  }
});

test("Passwort-Reset verrät nicht, ob eine E-Mail-Adresse registriert ist", async () => {
  const unknownAgent = request.agent(app);
  const response = await unknownAgent.post("/password-forgot").type("form").send({ email: `nicht-vorhanden-${Date.now()}@test.local` });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/login");
  const loginPage = await unknownAgent.get("/login");
  assert.match(loginPage.text, /Falls ein Konto mit dieser E-Mail-Adresse existiert/);
});

test("Admin sieht Online-Status und letzten Login weiterer Nutzer", async () => {
  const email = `online-${Date.now()}@test.local`;
  createUserWithPassword({ name: "Online Nutzer", email, password: "onlinePasswort1", role: "viewer" });
  const onlineAgent = request.agent(app);
  assert.equal((await onlineAgent.post("/login").type("form").send({ email, password: "onlinePasswort1" })).status, 302);

  const usersPage = await agent.get("/admin/benutzer");
  assert.equal(usersPage.status, 200);
  assert.match(usersPage.text, /Online Nutzer/);
  assert.match(usersPage.text, /● Online/);
  assert.match(usersPage.text, /Letzter Login:/);
  assert.doesNotMatch(usersPage.text, /Online Nutzer[\s\S]{0,800}Letzter Login:\s*Noch nie/);
});

test("Importseite erklärt klar, was importiert wird und was nicht", async () => {
  const page = await agent.get("/admin/import");
  assert.equal(page.status, 200);
  assert.match(page.text, /legt daraus eine neue Akte an/i);
  assert.match(page.text, /Was übernommen wird/i);
  assert.match(page.text, /Was bewusst nicht übernommen wird/i);
  assert.match(page.text, /PDF-Dateien oder andere Formate können nicht importiert werden/i);
  assert.match(page.text, /Statuslogik beim Import/i);
});

test("Viewer darf Tiere ansehen, aber keine Bearbeitungsansichten öffnen", async () => {
  const viewerAgent = request.agent(app);
  const viewerEmail = `viewer-${Date.now()}@test.local`;
  createUserWithPassword({
    name: "Viewer",
    email: viewerEmail,
    password: "viewer123",
    role: "viewer",
  });

  const login = await viewerAgent.post("/login").type("form").send({
    email: viewerEmail,
    password: "viewer123",
  });
  assert.equal(login.status, 302);

  const animalPage = await viewerAgent.get("/animals/1");
  assert.equal(animalPage.status, 200);

  const editPage = await viewerAgent.get("/animals/1/edit");
  assert.equal(editPage.status, 302);

  const newAnimalPage = await viewerAgent.get("/animals/new");
  assert.equal(newAnimalPage.status, 302);
});

test("Benutzer ohne Adminrechte kommt nicht in den Adminbereich", async () => {
  const userAgent = request.agent(app);
  const userEmail = `user-${Date.now()}@test.local`;
  createUserWithPassword({
    name: "Fachnutzer",
    email: userEmail,
    password: "user12345",
    role: "user",
    permissions: {
      can_edit_animals: true,
      can_manage_health: true,
      can_manage_reminders: true,
    },
  });

  const login = await userAgent.post("/login").type("form").send({
    email: userEmail,
    password: "user12345",
  });
  assert.equal(login.status, 302);

  const adminPage = await userAgent.get("/admin/import");
  assert.equal(adminPage.status, 302);
  assert.equal(adminPage.headers.location, "/");
});

test("Import normalisiert unbekannte Statuswerte und schließt Erinnerungen bei inaktiven Tieren", async () => {
  const invalidStatusPayload = {
    animal: {
      name: "Import Invalid",
      species_name: "Katze",
      status: "Irgendwas",
      microchip_number: "276099200310213",
      microchip_manufacturer: "Dechra",
      microchip_registry: "TASSO",
    },
    related: {
      reminders: [],
    },
  };

  const invalidImport = await agent
    .post("/admin/import")
    .attach("import_file", Buffer.from(JSON.stringify(invalidStatusPayload), "utf8"), { filename: "invalid-status.json", contentType: "application/json" });
  assert.equal(invalidImport.status, 302);

  const importedActive = db.prepare("SELECT status, microchip_number, microchip_manufacturer, microchip_registry FROM animals WHERE name = ? ORDER BY id DESC LIMIT 1").get("Import Invalid");
  assert.equal(importedActive?.status, "Aktiv");
  assert.equal(importedActive?.microchip_number, "276099200310213");
  assert.equal(importedActive?.microchip_manufacturer, "Dechra");
  assert.equal(importedActive?.microchip_registry, "TASSO");

  const restingPayload = {
    animal: {
      name: "Import Ruhestätte",
      species_name: "Katze",
      status: "Verstorben",
    },
    related: {
      reminders: [
        {
          title: "Offene Import-Erinnerung",
          reminder_type: "Allgemein",
          due_at: dayjs().add(1, "day").format("YYYY-MM-DDTHH:mm"),
          channel_email: 1,
          channel_telegram: 0,
          repeat_interval_days: 0,
          notes: "",
          completed_at: null,
          last_notified_at: null,
          last_delivery_status: "pending",
        },
      ],
    },
  };

  const restingImport = await agent
    .post("/admin/import")
    .attach("import_file", Buffer.from(JSON.stringify(restingPayload), "utf8"), { filename: "resting.json", contentType: "application/json" });
  assert.equal(restingImport.status, 302);

  const importedResting = db.prepare("SELECT id, status FROM animals WHERE name = ? ORDER BY id DESC LIMIT 1").get("Import Ruhestätte");
  assert.equal(importedResting?.status, "Verstorben");
  const importedReminder = db.prepare("SELECT completed_at, last_delivery_status FROM reminders WHERE animal_id = ? AND title = ?").get(importedResting.id, "Offene Import-Erinnerung");
  assert.ok(importedReminder?.completed_at);
  assert.ok(["closed", "archived"].includes(importedReminder?.last_delivery_status));
});

test("Auch die Hilfeseite bleibt vollständig von Suchmaschinen ausgeschlossen", async () => {
  const response = await agent.get("/hilfe");
  assert.equal(response.status, 200);
  assert.match(response.text, /<meta name="robots" content="noindex,nofollow,noarchive,nosnippet"\s*\/?>/i);
  assert.doesNotMatch(response.text, /rel="canonical"|property="og:|name="twitter:/i);
  assert.equal(response.headers["x-robots-tag"], "noindex, nofollow, noarchive, nosnippet");
});

test("Kontaktseite ist vollständig entfernt", async () => {
  const response = await agent.get("/kontakt");
  assert.equal(response.status, 404);

  const footerPage = await agent.get("/");
  assert.equal(footerPage.status, 200);
  assert.doesNotMatch(footerPage.text, /href="\/kontakt"/);
});

test("Interne Dashboard-Seite bleibt für Suchmaschinen auf noindex", async () => {
  const response = await agent.get("/");
  assert.equal(response.status, 200);
  assert.match(response.text, /<meta name="robots" content="noindex,nofollow,noarchive,nosnippet"\s*\/?>/i);
});

test("robots.txt sperrt alles und eine Sitemap existiert nicht", async () => {
  const robots = await request(app).get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(robots.text.trim(), "User-agent: *\nDisallow: /");

  const sitemap = await request(app).get("/sitemap.xml");
  assert.equal(sitemap.status, 404);
});

test("Hochgeladene Mediendateien sind ohne Anmeldung nicht erreichbar", async () => {
  const response = await request(app).get("/media/vertrauliches-tierbild.jpg");
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^\/login/);
});

test("Login wird nach wiederholten Fehlversuchen vorübergehend gesperrt", async () => {
  const limitedAgent = request.agent(app);
  const email = `unbekannt-${Date.now()}@example.invalid`;
  for (let index = 0; index < 6; index += 1) {
    const response = await limitedAgent.post("/login").type("form").send({ email, password: "absichtlich-falsch" });
    assert.equal(response.status, 302);
  }
  const loginPage = await limitedAgent.get("/login");
  assert.match(loginPage.text, /Zu viele fehlgeschlagene Anmeldeversuche/);
});

test("favicon.ico leitet auf das aktuelle App-Logo weiter", async () => {
  const response = await agent.get("/favicon.ico");
  assert.equal(response.status, 302);
  assert.ok(response.headers.location);
  assert.match(response.headers.location, /\/app-icon\/32\.png/i);
});

test("Web-App-Manifest und Icons sind öffentlich und verwenden das App-Logo", async () => {
  const manifest = await request(app).get("/app.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers["content-type"], /^application\/manifest\+json/);
  assert.equal(manifest.body.start_url, "/");
  assert.deepEqual(manifest.body.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);

  for (const size of [32, 180, 192, 512]) {
    const icon = await request(app).get(`/app-icon/${size}.png`).buffer(true);
    assert.equal(icon.status, 200);
    assert.match(icon.headers["content-type"], /^image\/png/);
    assert.equal(icon.body.subarray(1, 4).toString("ascii"), "PNG");
  }

  const login = await request(app).get("/login");
  assert.match(login.text, /rel="manifest"/);
  assert.match(login.text, /name="mobile-web-app-capable" content="yes"/);
  assert.match(login.text, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(login.text, /\/static\/js\/app-install\.js/);
});

test("Service Worker aktiviert die Installation ohne private App-Daten zu cachen", async () => {
  const response = await request(app).get("/service-worker.js");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^application\/javascript/);
  assert.equal(response.headers["service-worker-allowed"], "/");
  assert.match(response.headers["cache-control"], /no-cache/);
  assert.match(response.text, /self\.clients\.claim/);
  assert.doesNotMatch(response.text, /caches\.open/);
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

test("Einladungs-Mail für neue Benutzer wird versendet und im Audit- sowie Benachrichtigungslog erfasst", async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const originalCreateTransport = nodemailer.createTransport;
  let sentMail = null;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      sentMail = payload;
      return { messageId: "invite-test" };
    },
  });

  try {
    const response = await agent.post("/admin/users").type("form").send({
      name: "Neuer Nutzer",
      email: "neu@test.local",
      role: "user",
      send_invite_email: "1",
    });

    assert.ok([302, 303].includes(response.status));
    assert.equal(response.headers.location, "/admin/benutzer");
    assert.equal(sentMail?.to, "neu@test.local");

    const user = db.prepare("SELECT id FROM users WHERE email = ?").get("neu@test.local");
    assert.ok(user?.id);

    const notificationLog = db.prepare(`
      SELECT channel, notification_type, recipient, status
      FROM notification_logs
      WHERE recipient = ?
      ORDER BY id DESC
      LIMIT 1
    `).get("neu@test.local");
    assert.deepEqual(notificationLog, {
      channel: "email",
      notification_type: "invite",
      recipient: "neu@test.local",
      status: "sent",
    });

    const auditLogs = db.prepare(`
      SELECT action
      FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = ?
      ORDER BY id ASC
    `).all(String(user.id));
    assert.ok(auditLogs.some((entry) => entry.action === "user.create"));
    assert.ok(auditLogs.some((entry) => entry.action === "user.invite_email_sent"));
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test("Administratoren werden bei jedem neu angelegten Benutzer per HTML-Mail informiert", async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const originalCreateTransport = nodemailer.createTransport;
  const sentMails = [];
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      sentMails.push(payload);
      return { messageId: "admin-user-created" };
    },
  });

  try {
    const response = await agent.post("/admin/users").type("form").send({
      name: "Benachrichtigter Nutzer",
      email: "admin-info-target@test.local",
      role: "viewer",
    });

    assert.ok([302, 303].includes(response.status));
    assert.equal(sentMails.length, 1);
    assert.deepEqual(sentMails[0].to, ["admin@test.local"]);
    assert.match(sentMails[0].subject, /Neuer Benutzer angelegt/);
    assert.match(sentMails[0].html, /Benachrichtigter Nutzer/);
    assert.match(sentMails[0].html, /Benutzer verwalten/);
    assert.match(sentMails[0].text, /admin-info-target@test\.local/);

    const user = db.prepare("SELECT id FROM users WHERE email = ?").get("admin-info-target@test.local");
    const notification = db.prepare(`
      SELECT notification_type, recipient, status
      FROM notification_logs
      WHERE notification_type = 'admin_user_created' AND recipient = ?
      ORDER BY id DESC LIMIT 1
    `).get("admin@test.local");
    assert.deepEqual(notification, {
      notification_type: "admin_user_created",
      recipient: "admin@test.local",
      status: "sent",
    });
    const audit = db.prepare(`
      SELECT action FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = ? AND action = 'user.admin_notification_sent'
      ORDER BY id DESC LIMIT 1
    `).get(String(user.id));
    assert.equal(audit?.action, "user.admin_notification_sent");
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test("Fehlgeschlagene Einladungs-Mail für neue Benutzer erscheint im Audit- und Benachrichtigungslog", async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      throw new Error("SMTP down");
    },
  });

  try {
    const response = await agent.post("/admin/users").type("form").send({
      name: "Fehler Nutzer",
      email: "fehler@test.local",
      role: "user",
      send_invite_email: "1",
    });

    assert.ok([302, 303].includes(response.status));
    assert.equal(response.headers.location, "/admin/benutzer");

    const user = db.prepare("SELECT id FROM users WHERE email = ?").get("fehler@test.local");
    assert.ok(user?.id);

    const notificationLog = db.prepare(`
      SELECT channel, notification_type, recipient, status, error_message
      FROM notification_logs
      WHERE recipient = ?
      ORDER BY id DESC
      LIMIT 1
    `).get("fehler@test.local");
    assert.equal(notificationLog?.channel, "email");
    assert.equal(notificationLog?.notification_type, "invite");
    assert.equal(notificationLog?.status, "error");
    assert.match(notificationLog?.error_message || "", /SMTP down/);

    const inviteRows = db.prepare("SELECT COUNT(*) AS count FROM user_invites WHERE user_id = ? AND used_at IS NULL").get(user.id);
    assert.equal(inviteRows.count, 0);

    const auditLogs = db.prepare(`
      SELECT action
      FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = ?
      ORDER BY id ASC
    `).all(String(user.id));
    assert.ok(auditLogs.some((entry) => entry.action === "user.create"));
    assert.ok(auditLogs.some((entry) => entry.action === "user.invite_email_failed"));
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test("Admin kann eine offene Einladungs-Mail erneut versenden", async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const createdUser = db.prepare(`
    INSERT INTO users (
      name, email, password_hash, role, must_change_password,
      can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
      can_manage_feedings, can_manage_notes, can_manage_reminders
    )
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
  `).run("Offene Einladung", "offen@test.local", "hash", "user", 1);

  const originalCreateTransport = nodemailer.createTransport;
  let sentMail = null;
  nodemailer.createTransport = () => ({
    sendMail: async (payload) => {
      sentMail = payload;
      return { messageId: "invite-resend" };
    },
  });

  try {
    const response = await agent.post(`/admin/users/${createdUser.lastInsertRowid}/resend-invite`).type("form").send({
      return_to: "/admin/benutzer",
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, "/admin/benutzer");
    assert.equal(sentMail?.to, "offen@test.local");

    const inviteRows = db.prepare("SELECT COUNT(*) AS count FROM user_invites WHERE user_id = ? AND used_at IS NULL").get(createdUser.lastInsertRowid);
    assert.equal(inviteRows.count, 1);

    const notificationLog = db.prepare(`
      SELECT channel, notification_type, recipient, status
      FROM notification_logs
      WHERE recipient = ?
      ORDER BY id DESC
      LIMIT 1
    `).get("offen@test.local");
    assert.deepEqual(notificationLog, {
      channel: "email",
      notification_type: "invite",
      recipient: "offen@test.local",
      status: "sent",
    });

    const auditLogs = db.prepare(`
      SELECT action
      FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = ?
      ORDER BY id ASC
    `).all(String(createdUser.lastInsertRowid));
    assert.ok(auditLogs.some((entry) => entry.action === "user.invite_email_resent"));
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }
});

test("Fehlgeschlagenes erneutes Senden einer Einladungs-Mail wird protokolliert", async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("smtp.test.local", "smtp_host");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run("noreply@test.local", "smtp_from");

  const createdUser = db.prepare(`
    INSERT INTO users (
      name, email, password_hash, role, must_change_password,
      can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
      can_manage_feedings, can_manage_notes, can_manage_reminders
    )
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
  `).run("Erneut Fehler", "resend-fehler@test.local", "hash", "user", 1);

  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => {
      throw new Error("SMTP resend down");
    },
  });

  try {
    const response = await agent.post(`/admin/users/${createdUser.lastInsertRowid}/resend-invite`).type("form").send({
      return_to: "/admin/benutzer",
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, "/admin/benutzer");

    const inviteRows = db.prepare("SELECT COUNT(*) AS count FROM user_invites WHERE user_id = ? AND used_at IS NULL").get(createdUser.lastInsertRowid);
    assert.equal(inviteRows.count, 0);

    const notificationLog = db.prepare(`
      SELECT channel, notification_type, recipient, status, error_message
      FROM notification_logs
      WHERE recipient = ?
      ORDER BY id DESC
      LIMIT 1
    `).get("resend-fehler@test.local");
    assert.equal(notificationLog?.channel, "email");
    assert.equal(notificationLog?.notification_type, "invite");
    assert.equal(notificationLog?.status, "error");
    assert.match(notificationLog?.error_message || "", /SMTP resend down/);

    const auditLogs = db.prepare(`
      SELECT action
      FROM audit_logs
      WHERE entity_type = 'user' AND entity_id = ?
      ORDER BY id ASC
    `).all(String(createdUser.lastInsertRowid));
    assert.ok(auditLogs.some((entry) => entry.action === "user.invite_email_resend_failed"));
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    db.prepare("UPDATE settings SET value = '' WHERE key IN ('smtp_host', 'smtp_from')").run();
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

test("Stammdaten-Aktivitäten erscheinen im Audit-Log", async () => {
  const createCategory = await agent.post("/admin/categories").type("form").send({
    name: "Reisepass",
    is_required: "1",
    return_to: "/admin/stammdaten",
  });
  assert.ok([302, 303].includes(createCategory.status));

  const categoryId = db.prepare("SELECT id FROM document_categories WHERE name = ?").get("Reisepass")?.id;
  assert.ok(categoryId);

  const createVet = await agent.post("/admin/veterinarians").type("form").send({
    name: "Praxis Nord",
    street: "Hauptweg 3",
    postal_code: "24568",
    city: "Kaltenkirchen",
    country: "Deutschland",
    email: "nord@example.test",
    phone: "+49 4101 12345",
    return_to: "/admin/stammdaten",
  });
  assert.ok([302, 303].includes(createVet.status));

  const vet = db.prepare("SELECT id FROM veterinarians WHERE name = ?").get("Praxis Nord");
  assert.ok(vet?.id);

  const setDefaultVet = await agent.post(`/admin/veterinarians/${vet.id}/set-default`).type("form").send({});
  assert.ok([302, 303].includes(setDefaultVet.status));

  const createSpecies = await agent.post("/admin/species").type("form").send({
    name: "Kaninchen",
    default_veterinarian_id: String(vet.id),
    notes: "Innenhaltung",
    return_to: "/admin/stammdaten",
  });
  assert.ok([302, 303].includes(createSpecies.status));

  const species = db.prepare("SELECT id FROM species WHERE name = ?").get("Kaninchen");
  assert.ok(species?.id);

  const systemlogPage = await agent.get("/admin/systemlog");
  assert.equal(systemlogPage.status, 200);
  assert.match(systemlogPage.text, /Kategorie angelegt/);
  assert.match(systemlogPage.text, /Tierarzt angelegt/);
  assert.match(systemlogPage.text, /Standardtierarzt gesetzt/);
  assert.match(systemlogPage.text, /Tierart angelegt/);

  const auditActions = db.prepare(`
    SELECT action
    FROM audit_logs
    WHERE action IN ('category.create', 'veterinarian.create', 'veterinarian.set_default', 'species.create')
    ORDER BY id ASC
  `).all();
  assert.ok(auditActions.some((entry) => entry.action === "category.create"));
  assert.ok(auditActions.some((entry) => entry.action === "veterinarian.create"));
  assert.ok(auditActions.some((entry) => entry.action === "veterinarian.set_default"));
  assert.ok(auditActions.some((entry) => entry.action === "species.create"));
});

test("Standardimpfungen sind als Stammdaten vollständig verwaltbar", async () => {
  const create = await agent.post("/admin/vaccination-presets").type("form").send({ species_name: "Katze", name: "FeLV" });
  assert.ok([302, 303].includes(create.status));
  const preset = db.prepare("SELECT * FROM vaccination_presets WHERE species_name = ? AND name = ?").get("Katze", "FeLV");
  assert.ok(preset);

  const masterdata = await agent.get("/admin/stammdaten");
  assert.equal(masterdata.status, 200);
  assert.match(masterdata.text, /FeLV/);

  const update = await agent.post(`/admin/vaccination-presets/${preset.id}/update`).type("form").send({ species_name: "Katze", name: "FeLV (Leukose)" });
  assert.ok([302, 303].includes(update.status));
  assert.equal(db.prepare("SELECT name FROM vaccination_presets WHERE id = ?").get(preset.id).name, "FeLV (Leukose)");
  const suggestions = getVaccinationSuggestionsForSpecies("Hauskatze", db.prepare("SELECT species_name, name FROM vaccination_presets").all());
  assert.ok(suggestions.suggestions.includes("FeLV (Leukose)"));

  const remove = await agent.post(`/admin/vaccination-presets/${preset.id}/delete`).type("form").send({});
  assert.ok([302, 303].includes(remove.status));
  assert.equal(db.prepare("SELECT 1 FROM vaccination_presets WHERE id = ?").get(preset.id), undefined);
});

test("Stammdaten-Kategorien sind standardmäßig eingeklappte Akkordeons", async () => {
  const page = await agent.get("/admin/stammdaten");
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/<details class="[^"]*masterdata-accordion/g) || []).length, 5);
  assert.equal((page.text.match(/<details class="[^"]*masterdata-accordion[^>]*\sopen(?:\s|>)/g) || []).length, 0);
  for (const heading of ["Tierärzte", "Tierarten", "Standardimpfungen", "Dokumentkategorien", "Tierkörperbeseitigungsanlagen"]) {
    assert.match(page.text, new RegExp(`<summary[^>]*>[\\s\\S]*?${heading}`));
  }
});

test("Formulare und Server verwenden dieselben Validierungsgrenzen", async () => {
  assert.deepEqual(htmlConstraints("categoryName"), {
    required: true,
    minlength: FIELD_SCHEMAS.categoryName.minLength,
    maxlength: FIELD_SCHEMAS.categoryName.maxLength,
    type: "text",
  });
  assert.equal(validateText("X", FIELD_SCHEMAS.categoryName, "Name"), "Name ist zu kurz.");

  const drawer = await agent.get("/admin/categories/new").set("X-Requested-With", "heartpet-drawer");
  assert.equal(drawer.status, 200);
  assert.match(drawer.text, /name="name" required minlength="2" maxlength="80"/);

  const before = db.prepare("SELECT COUNT(*) AS count FROM document_categories").get().count;
  const invalid = await agent.post("/admin/categories").type("form").send({ name: "X" });
  assert.ok([302, 303].includes(invalid.status));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_categories").get().count, before);
});

test("Deployment aktiviert Releases atomar und prüft die aktive Revision", () => {
  const scriptPath = path.join(__dirname, "..", "scripts", "deploy-release.sh");
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /git -C "\$APP_DIR" archive HEAD/);
  assert.match(script, /release_is_valid/);
  assert.match(script, /\.heartpet-release/);
  assert.match(script, /mv -Tf "\$next_link" "\$CURRENT_LINK"/);
  assert.match(script, /start_release_service && wait_for_revision/);
  assert.match(script, /run_systemctl stop heartpet/);
  assert.ok(script.includes("pgrep -f 'node .*src/app\\.js'"));
  assert.match(script, /readlink "\/proc\/\$pid\/cwd"/);
  assert.match(script, /health\.revision === process\.env\.EXPECTED_REVISION/);
  assert.match(script, /WorkingDirectory=\$release_path/);
  assert.match(script, /ExecStart=\$node_path \$release_path\/src\/app\.js/);
  assert.match(script, /Environment=HEARTPET_RUNTIME_REVISION=\$runtime_revision/);
  assert.match(script, /Letzter Health-Status/);
  assert.match(script, /Aktives Release-Ziel/);
  assert.match(script, /run_systemctl enable heartpet/);
  assert.match(script, /journalctl -u heartpet\.service/);
  assert.match(script, /activate_release "\$PREVIOUS_TARGET"/);
  assert.match(script, /write_service_override "\$PREVIOUS_TARGET"/);
  assert.match(script, /User=\$target_user/);
  assert.match(script, /Group=\$target_group/);
  assert.match(script, /"\$CURRENT_LINK" == \/root\/\*/);
  assert.match(script, /runuser -u "\$SERVICE_USER" -- test -x "\$release_path"/);
  assert.match(script, /ss -ltnp "sport = :\$PORT"/);
});

test("Interaktiver Installer erzeugt einen gehärteten und neu gestarteten systemd-Dienst", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "configure-instance.sh"), "utf8");
  const installScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "install.sh"), "utf8");
  assert.match(installer, /--mode lan\|domain/);
  assert.match(installer, /HEARTPET_SECURE_COOKIE=/);
  assert.match(installer, /Environment=HEARTPET_DATA_DIR=/);
  assert.match(installer, /ProtectSystem=full/);
  assert.match(installer, /APP_DIR" == \/root/);
  assert.match(installer, /systemctl restart heartpet/);
  assert.match(installer, /curl --max-time 2 -fsS/);
  assert.match(installer, /BIND_HOST="127\.0\.0\.1"/);
  assert.match(installer, /TRUST_PROXY="1"/);
  assert.match(installer, /COOKIE_MODE="auto"/);
  assert.match(installer, /Externer Proxy: Ziel ist <LXC-IP>/);
  assert.match(installer, /--admin-email ADRESSE/);
  assert.match(installer, /create-initial-admin\.js/);
  assert.match(installer, /initial_admin_output/);
  assert.doesNotMatch(installer, /BROWSER_FIRST/);
  assert.doesNotMatch(installer, /\/setup öffnen/);
  assert.match(installScript, /configure-instance\.sh" "\$@"/);
  assert.match(installScript, /apt-get install -y ca-certificates curl git nodejs npm build-essential python3/);
  assert.match(installScript, /deb\.nodesource\.com\/node_22\.x/);
  assert.match(installScript, /CONFIGURE_INSTANCE=1/);
  assert.match(installScript, /--dependencies-only/);
  assert.match(installScript, /HeartPet darf als Dienst nicht unter/);
  assert.match(installScript, /node_major.*-lt 20/s);
});

test("Startskript aktiviert den systemd-Dienst dauerhaft", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "start.sh"), "utf8");
  assert.match(script, /run_systemctl enable --now heartpet/);
  assert.match(script, /Environment=HEARTPET_DATA_DIR=\$APP_DIR\/data/);
});

test("Betriebsskripte verwenden die gemeinsame systemd-Bibliothek", () => {
  for (const name of ["start.sh", "stop.sh", "status.sh", "logs.sh", "update.sh", "deploy-release.sh"]) {
    const script = fs.readFileSync(path.join(__dirname, "..", "scripts", name), "utf8");
    assert.match(script, /source "\$APP_DIR\/scripts\/lib\/systemd\.sh"/);
    assert.doesNotMatch(script, /run_systemctl\(\)\s*\{/);
  }

  const systemdLib = fs.readFileSync(path.join(__dirname, "..", "scripts", "lib", "systemd.sh"), "utf8");
  assert.match(systemdLib, /systemctl cat heartpet\.service/);
  assert.match(systemdLib, /list-unit-files heartpet\.service/);
});

test("Updates behalten Laufzeitdaten und Session-Geheimnis außerhalb des Auto-Stashs", () => {
  const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^data\/\.session-secret$/m);
  assert.match(gitignore, /^data\/sessions\.sqlite$/m);

  const updateScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "update.sh"), "utf8");
  assert.match(updateScript, /git stash push --include-untracked[\s\S]*':!data'/);
  assert.match(updateScript, /Environment=HEARTPET_DATA_DIR=\$APP_DIR\/data/);
});


test("Stammdaten-Template bleibt mit einem älteren Serverstand renderbar", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "views", "pages", "admin-masterdata.ejs"), "utf8");
  assert.match(template, /typeof vaccinationPresets !== 'undefined'/);
  assert.match(template, /runtimeFeatures\.disposalFacilities/);
  assert.doesNotMatch(template, /vaccinationPresets\.length/);
  assert.doesNotMatch(template, /vaccinationPresets\.forEach/);
});

test("Neue Browser-Funktionen bleiben bei einem älteren Serverprozess deaktiviert", () => {
  const icons = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "app-icons.ejs"), "utf8");
  const bottom = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "bottom.ejs"), "utf8");
  const sidebar = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "sidebar-nav.ejs"), "utf8");
  const top = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "top.ejs"), "utf8");
  assert.match(icons, /runtimeFeatures\.webAppManifest/);
  assert.match(bottom, /runtimeFeatures\.updateStatus/);
  assert.doesNotMatch(sidebar, /Versorgung|\/versorgung|careManagement/);
  assert.match(top, /runtimeFeatures\.calendarExport/);
  assert.match(top, /runtimeFeatures\.deploymentGuard/);
  assert.match(top, /Update noch nicht vollständig aktiviert/);
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

  const conditionId = db.prepare("SELECT id FROM animal_conditions WHERE animal_id = ? AND title = ? ORDER BY id DESC LIMIT 1").get(1, "Alias Arthrose")?.id;
  const feedingId = db.prepare("SELECT id FROM animal_feedings WHERE animal_id = ? AND label = ? ORDER BY id DESC LIMIT 1").get(1, "Alias Futter")?.id;
  const noteId = db.prepare("SELECT id FROM animal_notes WHERE animal_id = ? AND title = ? ORDER BY id DESC LIMIT 1").get(1, "Alias Notiz")?.id;
  const reminderId = db.prepare("SELECT id FROM reminders WHERE animal_id = ? AND title = ? ORDER BY id DESC LIMIT 1").get(1, "Alias Erinnerung")?.id;
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
  await ensureSetupComplete();
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
  await ensureSetupComplete();
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
  await ensureSetupComplete();
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
  await ensureSetupComplete();
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
  await ensureSetupComplete();
  const previousProfileImage = db.prepare("SELECT profile_image_stored_name FROM animals WHERE id = 1").get()?.profile_image_stored_name || null;
  db.prepare("UPDATE animals SET profile_image_stored_name = ? WHERE id = 1").run("tierliste-test.jpg");
  const response = await agent.get("/animals").query({ animal_id: "1" });
  db.prepare("UPDATE animals SET profile_image_stored_name = ? WHERE id = 1").run(previousProfileImage);
  assert.equal(response.status, 200);
  assert.match(response.text, /Tiere filtern/);
  assert.match(response.text, /id="animalFilterCollapse"/);
  assert.doesNotMatch(response.text, /class="collapse show[^\"]*"[^>]*id="animalFilterCollapse"/);
  assert.match(response.text, /Tier auswählen/);
  assert.match(response.text, /id="animals-list-collapse"/);
  assert.doesNotMatch(response.text, /Zuletzt geändert/);
  assert.doesNotMatch(response.text, /Akte öffnen/);
  assert.doesNotMatch(response.text, /Tierliste anzeigen/);
  assert.match(response.text, /data-animal-workspace-link/);
  assert.match(response.text, /class="animal-choice-thumb"/);
  assert.match(response.text, /src="\/media\/tierliste-test\.jpg"/);
  assert.match(response.text, /data-animal-workspace-target/);
  assert.doesNotMatch(response.text, /Standardpasswort ist noch aktiv/);
  assert.doesNotMatch(response.text, /Administration/);
});

test("Tierfilter bleibt auch mit aktivem Filter zunächst geschlossen", async () => {
  const response = await agent.get("/animals").query({ species_id: "1" });
  assert.equal(response.status, 200);
  assert.match(response.text, /text-bg-info">aktiv</);
  assert.match(response.text, /aria-expanded="false"/);
  assert.doesNotMatch(response.text, /class="collapse show[^\"]*"[^>]*id="animalFilterCollapse"/);
});

test("Tier kann mit allen Akteneinträgen und Dateien kopiert werden", async () => {
  const uploadsDir = path.join(tempDataDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const sourceStoredName = `duplicate-source-${Date.now()}.txt`;
  fs.writeFileSync(path.join(uploadsDir, sourceStoredName), "HeartPet Kopiertest");

  const animalResult = db.prepare(`
    INSERT INTO animals (
      name, species_id, sex, birth_date, intake_date, source, microchip_number, status,
      color, breed, weight_kg, notes, profile_image_stored_name,
      profile_image_original_name, profile_image_mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Aktiv', ?, ?, ?, ?, ?, ?, ?)
  `).run("Kopierquelle", db.prepare("SELECT id FROM species ORDER BY id LIMIT 1").get().id, "Weiblich", "2022-01-02", "2022-02-03", "Test", "CHIP-123", "Braun", "Mischling", 4.5, "Notiz", sourceStoredName, "quelle.txt", "text/plain");
  const sourceAnimalId = Number(animalResult.lastInsertRowid);
  db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)").run(sourceAnimalId, "Allergie", "Testdetails");
  const medicationId = Number(db.prepare("INSERT INTO animal_medications (animal_id, name, dosage, reminder_enabled) VALUES (?, ?, ?, 1)").run(sourceAnimalId, "Mittel", "1x").lastInsertRowid);
  db.prepare("INSERT INTO animal_vaccinations (animal_id, name, vaccination_date) VALUES (?, ?, ?)").run(sourceAnimalId, "Impfung", "2026-01-01");
  db.prepare("INSERT INTO animal_appointments (animal_id, title, appointment_at) VALUES (?, ?, ?)").run(sourceAnimalId, "Kontrolle", "2026-08-01T10:00");
  db.prepare("INSERT INTO animal_feedings (animal_id, label, food) VALUES (?, ?, ?)").run(sourceAnimalId, "Morgens", "Futter");
  db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)").run(sourceAnimalId, "Beobachtung", "Alles gut");
  db.prepare("INSERT INTO documents (animal_id, title, original_name, stored_name) VALUES (?, ?, ?, ?)").run(sourceAnimalId, "Dokument", "quelle.txt", sourceStoredName);
  db.prepare("INSERT INTO animal_images (animal_id, title, original_name, stored_name) VALUES (?, ?, ?, ?)").run(sourceAnimalId, "Foto", "quelle.txt", sourceStoredName);
  db.prepare(`
    INSERT INTO reminders (
      animal_id, title, due_at, source_kind, source_id, last_notified_at, last_delivery_status
    ) VALUES (?, ?, ?, 'medication', ?, CURRENT_TIMESTAMP, 'sent')
  `).run(sourceAnimalId, "Medikament", "2026-09-01T09:00", medicationId);

  const response = await agent.post(`/animals/${sourceAnimalId}/duplicate`).type("form").send({});
  assert.equal(response.status, 302);
  assert.match(response.headers.location || "", /^\/animals\?animal_id=\d+$/);
  const copiedAnimalId = Number(new URL(`http://localhost${response.headers.location}`).searchParams.get("animal_id"));
  const copiedAnimal = db.prepare("SELECT * FROM animals WHERE id = ?").get(copiedAnimalId);
  assert.equal(copiedAnimal.name, "Kopierquelle (Kopie)");
  assert.equal(copiedAnimal.microchip_number, "CHIP-123");
  assert.notEqual(copiedAnimal.profile_image_stored_name, sourceStoredName);
  assert.equal(fs.readFileSync(path.join(uploadsDir, copiedAnimal.profile_image_stored_name), "utf8"), "HeartPet Kopiertest");

  for (const tableName of ["animal_conditions", "animal_medications", "animal_vaccinations", "animal_appointments", "animal_feedings", "animal_notes", "documents", "animal_images", "reminders"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE animal_id = ?`).get(copiedAnimalId).count, 1, tableName);
  }
  const copiedMedication = db.prepare("SELECT id FROM animal_medications WHERE animal_id = ?").get(copiedAnimalId);
  const copiedReminder = db.prepare("SELECT * FROM reminders WHERE animal_id = ?").get(copiedAnimalId);
  assert.equal(copiedReminder.source_id, copiedMedication.id);
  assert.equal(copiedReminder.last_notified_at, null);
  assert.equal(copiedReminder.last_delivery_status, null);

  db.prepare("DELETE FROM reminders WHERE animal_id IN (?, ?)").run(sourceAnimalId, copiedAnimalId);
  db.prepare("DELETE FROM animals WHERE id IN (?, ?)").run(sourceAnimalId, copiedAnimalId);
  fs.rmSync(path.join(uploadsDir, sourceStoredName), { force: true });
  fs.rmSync(path.join(uploadsDir, copiedAnimal.profile_image_stored_name), { force: true });
});

test("Gruppenimpfung wird mehreren aktiven Tieren gleichzeitig zugeordnet", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id LIMIT 1").get().id;
  const firstAnimalId = Number(db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, 'Aktiv')").run("Impfgruppe A", speciesId).lastInsertRowid);
  const secondAnimalId = Number(db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, 'Aktiv')").run("Impfgruppe B", speciesId).lastInsertRowid);

  const drawer = await agent.get("/animals/vaccinations/bulk/new").set("X-Requested-With", "heartpet-drawer").query({ species_id: speciesId });
  assert.equal(drawer.status, 200);
  assert.match(drawer.text, /Gruppenimpfung/);
  assert.match(drawer.text, /Impfgruppe A/);
  assert.match(drawer.text, /Impfgruppe B/);
  assert.match(drawer.text, /data-bulk-group/);
  assert.match(drawer.text, /data-bulk-select-group/);

  const certificatePath = path.join(tempDataDir, "impfnachweis.pdf");
  fs.writeFileSync(certificatePath, "%PDF-1.4 HeartPet Test");
  const response = await agent.post("/animals/vaccinations/bulk")
    .field("name", "Schluckimpfung")
    .field("vaccination_date", "2026-08-27")
    .field("next_due_date", "2027-08-27")
    .field("notes", "Über Trinkwasser")
    .field("animal_ids", String(firstAnimalId))
    .field("animal_ids", String(secondAnimalId))
    .field("return_to", "/animals")
    .attach("vaccination_certificate", certificatePath, { contentType: "application/pdf" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/animals");
  const vaccinations = db.prepare(`
    SELECT animal_id, name, notes, certificate_original_name, certificate_stored_name FROM animal_vaccinations
    WHERE animal_id IN (?, ?) ORDER BY animal_id
  `).all(firstAnimalId, secondAnimalId);
  assert.equal(vaccinations.length, 2);
  assert.ok(vaccinations.every((item) => item.name === "Schluckimpfung" && item.notes === "Über Trinkwasser"));
  assert.ok(vaccinations.every((item) => item.certificate_original_name === "impfnachweis.pdf"));
  assert.ok(vaccinations[0].certificate_stored_name);
  assert.equal(vaccinations[0].certificate_stored_name, vaccinations[1].certificate_stored_name);
  const certificateResponse = await agent.get(`/vaccinations/${db.prepare("SELECT id FROM animal_vaccinations WHERE animal_id = ? ORDER BY id DESC LIMIT 1").get(firstAnimalId).id}/certificate`);
  assert.equal(certificateResponse.status, 200);
  const auditEntry = db.prepare("SELECT action FROM audit_logs WHERE action = 'vaccination.bulk_create' ORDER BY id DESC LIMIT 1").get();
  assert.equal(auditEntry?.action, "vaccination.bulk_create");

  db.prepare("DELETE FROM reminders WHERE animal_id IN (?, ?)").run(firstAnimalId, secondAnimalId);
  db.prepare("DELETE FROM animals WHERE id IN (?, ?)").run(firstAnimalId, secondAnimalId);
  fs.rmSync(path.join(tempDataDir, "uploads", vaccinations[0].certificate_stored_name), { force: true });
});

test("Tiere-Arbeitsansicht öffnet ohne animal_id keine Akte automatisch", async () => {
  await ensureSetupComplete();
  const response = await agent.get("/animals");
  assert.equal(response.status, 200);
  assert.match(response.text, /id="animals-list-collapse"/);
  assert.match(response.text, /data-animal-workspace-link/);
  assert.match(response.text, /Noch kein Tier ausgewählt/);
  assert.doesNotMatch(response.text, /Tierliste anzeigen/);
  assert.doesNotMatch(response.text, /Tierliste ausblenden/);
});

test("Tiere-Arbeitsansicht kann die rechte Akte separat laden", async () => {
  const response = await agent.get("/animals/1/workspace-panel").query({ animal_id: "1" });
  assert.equal(response.status, 200);
  assert.match(response.text, /data-animal-workspace-panel/);
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

  const urgentSection = response.text.match(/<article class="[^"]*" id="dringende-erinnerungen">([\s\S]*?)<\/article>/);
  const upcomingSection = response.text.match(/<article class="[^"]*" id="naechste-erinnerungen">([\s\S]*?)<\/article>/);

  assert.ok(urgentSection?.[1]?.includes("Heute fällig"));
  assert.ok(!urgentSection?.[1]?.includes("Morgen fällig"));
  assert.ok(!upcomingSection?.[1]?.includes("Heute fällig"));
  assert.ok(upcomingSection?.[1]?.includes("Morgen fällig"));
  assert.ok(upcomingSection?.[1]?.includes("Als erledigt markieren"));
  assert.doesNotMatch(response.text, /<span class="badge text-bg-warning">\d+ (?:überfällig|offen)<\/span>/);
});

test("Dashboard zeigt unter Demnächst nur Erinnerungen der nächsten sieben Tage", async () => {
  await ensureAdminAuthenticated();
  const animalId = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)")
    .run(`Sieben-Tage-Tier ${Date.now()}`, "Aktiv").lastInsertRowid;
  const soonTitle = `Innerhalb von sieben Tagen ${Date.now()}`;
  const distantTitle = `Erst in einem Jahr ${Date.now()}`;
  const insert = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, '')
  `);
  insert.run(animalId, soonTitle, "Termin", dayjs().add(7, "day").hour(9).minute(0).format("YYYY-MM-DDTHH:mm"));
  insert.run(animalId, distantTitle, "Termin", dayjs().add(1, "year").hour(9).minute(0).format("YYYY-MM-DDTHH:mm"));

  const response = await agent.get("/");
  assert.equal(response.status, 200);
  assert.match(response.text, /In den nächsten 7 Tagen fällig\./);
  assert.match(response.text, new RegExp(soonTitle));
  assert.doesNotMatch(response.text, new RegExp(distantTitle));
});

test("Dashboard verlinkt die Tier-Karte auf die Tierübersicht und zeigt die eindeutige Tierzahl", async () => {
  const response = await agent.get("/");
  assert.equal(response.status, 200);
  const expectedAnimalCount = db.prepare("SELECT COUNT(DISTINCT id) AS count FROM animals WHERE status = 'Aktiv'").get().count;
  assert.match(
    response.text,
    new RegExp(`<a href="\\/animals" class="badge[^"]*">${expectedAnimalCount} Tiere<\\/a>`)
  );
  assert.doesNotMatch(response.text, />Gesamt<\/span>/);
  assert.match(response.text, /Tierbestand/);
  assert.match(response.text, /Aktive Tiere nach Tierart/);
});

test("Aktiver Bestand und Historie trennen die Bestände sauber", async () => {
  const speciesId = db.prepare("SELECT species_id FROM animals WHERE id = 1").get()?.species_id;
  assert.ok(speciesId);
  const vermittelteId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Luna", speciesId, "Vermittelt").lastInsertRowid;
  const verstorbenId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Max", speciesId, "Verstorben").lastInsertRowid;

  const activePage = await agent.get("/animals");
  assert.equal(activePage.status, 200);
  assert.match(activePage.text, /Meine Tiere/);
  assert.doesNotMatch(activePage.text, /data-drawer="animal-form"/);
  assert.doesNotMatch(activePage.text, />Aktualisieren<\/a>/);
  assert.doesNotMatch(activePage.text, /Luna/);
  assert.doesNotMatch(activePage.text, /Max/);

  const historyPage = await agent.get("/animals/historie");
  assert.equal(historyPage.status, 200);
  assert.match(historyPage.text, /Historie/);
  assert.match(historyPage.text, /Luna/);
  assert.match(historyPage.text, /Max/);

  const restingPage = await agent.get("/animals/ruhestaette");
  assert.equal(restingPage.status, 302);
  assert.equal(restingPage.headers.location, "/animals/historie?status=Verstorben");

  assert.equal(db.prepare("SELECT status FROM animals WHERE id = ?").get(vermittelteId)?.status, "Vermittelt");
  assert.equal(db.prepare("SELECT status FROM animals WHERE id = ?").get(verstorbenId)?.status, "Verstorben");
});

test("Historie kann gezielt nach verstorbenen Tieren filtern", async () => {
  const speciesId = db.prepare("SELECT species_id FROM animals WHERE id = 1").get()?.species_id;
  assert.ok(speciesId);
  db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Archivkater", speciesId, "Verstorben");
  db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Aktivkater", speciesId, "Aktiv");

  const filteredPage = await agent.get(`/animals/historie?status=Verstorben&species_id=${speciesId}&sort=name_asc`);
  assert.equal(filteredPage.status, 200);
  assert.match(filteredPage.text, /Historie/);
  assert.match(filteredPage.text, /Archivkater/);
  assert.doesNotMatch(filteredPage.text, /Aktivkater/);
  assert.doesNotMatch(filteredPage.text, /href="\/animals\?species_id=/);
  assert.match(filteredPage.text, /data-animal-workspace-link="true"/);
  assert.match(filteredPage.text, /status=Verstorben/);
});

test("Verstorbene Tiere zeigen Kennzeichen und Abschiedsdatum direkt in der Historienkarte", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const animalId = db.prepare(`
    INSERT INTO animals (name, species_id, status, status_context_date)
    VALUES (?, ?, \'Verstorben\', ?)
  `).run("Erinnerungstier", speciesId, "2026-09-12").lastInsertRowid;

  const page = await agent.get(`/animals/historie?animal_id=${animalId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /animal-list-item--deceased/);
  assert.match(page.text, /†[\s\S]*Verstorben[\s\S]*12\.09\.2026/);
  db.prepare("DELETE FROM animals WHERE id = ?").run(animalId);
});

test("Verstorbene Tiere öffnen als Gedenkkarte mit eingeklappter vollständiger Akte", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const animalId = db.prepare(`
    INSERT INTO animals (name, species_id, status, birth_date, status_context_date, status_context_name, memorial_note)
    VALUES (?, ?, \'Verstorben\', ?, ?, ?, ?)
  `).run("Sternentier", speciesId, "2020-03-04", "2026-09-12", "Zuhause", "Für immer unvergessen.").lastInsertRowid;

  const page = await agent.get(`/animals/historie?animal_id=${animalId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /animal-memorial-card/);
  assert.match(page.text, /In liebevoller Erinnerung/);
  assert.match(page.text, /04\.03\.2020[\s\S]*†[\s\S]*12\.09\.2026/);
  assert.doesNotMatch(page.text, new RegExp(`href="/animals/${animalId}/edit"`));
  assert.doesNotMatch(page.text, new RegExp(`id="animal-duplicate-${animalId}"`));
  assert.ok(page.text.indexOf('id="animalRecordDetails"') < page.text.indexOf('class="card border-0 shadow-sm mb-3 animal-timeline-overview"'));
  db.prepare("DELETE FROM animals WHERE id = ?").run(animalId);
});

test("Gedenkerinnerungen lassen sich ändern und leere Platzhalter bleiben unsichtbar", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const animalId = db.prepare(`
    INSERT INTO animals (name, species_id, status, status_context_date, status_context_name, memorial_note)
    VALUES (?, ?, 'Verstorben', ?, ?, ?)
  `).run("Erinnerungstest", speciesId, "2026-09-12", ',,', ',,').lastInsertRowid;

  const emptyPage = await agent.get(`/animals/historie?animal_id=${animalId}`);
  assert.equal(emptyPage.status, 200);
  assert.doesNotMatch(emptyPage.text, /<blockquote>\s*[,"„“]+\s*<\/blockquote>/);
  assert.doesNotMatch(emptyPage.text, /animal-history-context[^>]*>\s*[,"„“‚‘’]+\s*<\/span>/);
  assert.doesNotMatch(emptyPage.text, /animal-memorial-place/);
  assert.match(emptyPage.text, /Erinnerung hinzufügen/);
  assert.match(emptyPage.text, new RegExp(`action="/animals/${animalId}/memorial-note"`));

  const update = await agent.post(`/animals/${animalId}/memorial-note`).type("form").send({
    memorial_note: "Du bleibst unvergessen.",
    return_to: `/animals/historie?animal_id=${animalId}`,
  });
  assert.equal(update.status, 302);
  assert.equal(db.prepare("SELECT memorial_note FROM animals WHERE id = ?").get(animalId).memorial_note, "Du bleibst unvergessen.");
  db.prepare("DELETE FROM animals WHERE id = ?").run(animalId);
});

test("Historie behält Filter- und Listenaktionen im Historie-Bereich", async () => {
  const speciesId = db.prepare("SELECT species_id FROM animals WHERE id = 1").get()?.species_id;
  assert.ok(speciesId);
  db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("VermitteltTest", speciesId, "Vermittelt");

  const historyPage = await agent.get(`/animals/historie?species_id=${speciesId}&status=Vermittelt&sort=name_asc`);
  assert.equal(historyPage.status, 200);
  assert.match(historyPage.text, /Historie/);
  assert.match(historyPage.text, /action="\/animals\/historie"/);
  assert.match(historyPage.text, /href="\/animals\/historie\?/);
  assert.doesNotMatch(historyPage.text, /href="\/animals\?species_id=/);
});

test("Tierarten-Untermenü erscheint nur im aktiven Bestand", async () => {
  const activePage = await agent.get("/animals");
  assert.equal(activePage.status, 200);
  assert.match(activePage.text, /href="\/animals\?species_id=/);
  assert.match(activePage.text, /nav-link-archive[\s\S]*href="\/animals\/historie"/);
  assert.doesNotMatch(activePage.text, /href="\/animals\/ruhestaette"/);

  const historyPage = await agent.get("/animals/historie");
  assert.equal(historyPage.status, 200);
  assert.doesNotMatch(historyPage.text, /href="\/animals\?species_id=/);

});

test("Beim Verschieben eines verstorbenen Tieres in die Historie werden offene Erinnerungen immer abgeschlossen", async () => {
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(1, "Bestandswechsel", "Allgemein", dayjs().add(2, "day").format("YYYY-MM-DDTHH:mm"), "wird archiviert");

  const speciesName = db.prepare(`
    SELECT species.name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    WHERE animals.id = 1
  `).get()?.name || "Katze";

  const response = await agent.post("/animals/1/update").type("form").send({
    name: "Minka",
    species_name: speciesName,
    sex: "",
    birth_date: "",
    intake_date: "",
    source: "",
    microchip_number: "",
    status: "Verstorben",
    color: "",
    breed: "",
    weight_kg: "",
    veterinarian_id: "",
    notes: "",
    status_context_date: "2026-07-24",
    status_transition_confirmed: "true",
    return_to: "/animals/historie?status=Verstorben",
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/animals/historie?status=Verstorben");

  const reminderStates = db.prepare(`
    SELECT completed_at, last_delivery_status
    FROM reminders
    WHERE animal_id = ? AND title = ?
    ORDER BY id DESC
  `).all(1, "Bestandswechsel");
  assert.ok(reminderStates.length >= 1);
  assert.ok(reminderStates.every((item) => item.completed_at));
  assert.ok(reminderStates.every((item) => ["closed", "archived"].includes(item.last_delivery_status)));
});

test("Verstorbene Tiere wechseln auch vom aktiven Rückweg direkt in die Historie", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const speciesName = db.prepare("SELECT name FROM species WHERE id = ?").get(speciesId)?.name || "Katze";
  const animalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Historienwechsel", speciesId, "Aktiv").lastInsertRowid;

  const response = await agent.post(`/animals/${animalId}/update`).type("form").send({
    name: "Historienwechsel",
    species_name: speciesName,
    status: "Verstorben",
    status_context_date: "2026-09-12",
    status_transition_confirmed: "true",
    return_to: `/animals?animal_id=${animalId}`,
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `/animals/historie?animal_id=${animalId}`);
  assert.equal(db.prepare("SELECT status FROM animals WHERE id = ?").get(animalId)?.status, "Verstorben");
  const historyPage = await agent.get(response.headers.location);
  assert.equal(historyPage.status, 200);
  assert.match(historyPage.text, /Historienwechsel/);
});

test("Beim Vermitteln oder Verkaufen bleiben offene Erinnerungen ohne Checkbox erhalten", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const speciesName = db.prepare("SELECT name FROM species WHERE id = ?").get(speciesId)?.name || "Katze";
  const animalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Exporttier", speciesId, "Aktiv").lastInsertRowid;
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(animalId, "Für Käufer offen", "Allgemein", dayjs().add(2, "day").format("YYYY-MM-DDTHH:mm"), "Export relevant");

  const response = await agent.post(`/animals/${animalId}/update`).type("form").send({
    name: "Exporttier",
    species_name: speciesName,
    status: "Vermittelt",
    status_context_name: "Neue Familie",
    status_context_date: "2026-07-25",
    status_transition_confirmed: "true",
    return_to: "/animals/historie",
  });

  assert.equal(response.status, 302);
  const reminder = db.prepare("SELECT completed_at, last_delivery_status FROM reminders WHERE animal_id = ? AND title = ?").get(animalId, "Für Käufer offen");
  assert.equal(reminder.completed_at, null);
  assert.notEqual(reminder.last_delivery_status, "closed");
});

test("Beim Vermitteln oder Verkaufen koennen offene Erinnerungen per Checkbox abgeschlossen werden", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const speciesName = db.prepare("SELECT name FROM species WHERE id = ?").get(speciesId)?.name || "Katze";
  const animalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Uebergabetier", speciesId, "Aktiv").lastInsertRowid;
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(animalId, "Vor Übergabe schließen", "Allgemein", dayjs().add(2, "day").format("YYYY-MM-DDTHH:mm"), "nicht exportieren");

  const response = await agent.post(`/animals/${animalId}/update`).type("form").send({
    name: "Uebergabetier",
    species_name: speciesName,
    status: "Verkauft",
    status_context_name: "Käufer",
    status_context_date: "2026-07-25",
    status_transition_confirmed: "true",
    close_open_reminders: "true",
    return_to: "/animals/historie",
  });

  assert.equal(response.status, 302);
  const reminder = db.prepare("SELECT completed_at, last_delivery_status FROM reminders WHERE animal_id = ? AND title = ?").get(animalId, "Vor Übergabe schließen");
  assert.ok(reminder.completed_at);
  assert.equal(reminder.last_delivery_status, "closed");
});

test("Wechsel aus dem aktiven Bestand braucht eine ausdrückliche Bestätigung", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const speciesName = db.prepare("SELECT name FROM species WHERE id = ?").get(speciesId)?.name || "Katze";
  const animalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Wechseltest", speciesId, "Aktiv").lastInsertRowid;

  const response = await agent.post(`/animals/${animalId}/update`).type("form").send({
    name: "Wechseltest",
    species_name: speciesName,
    sex: "",
    birth_date: "",
    intake_date: "",
    source: "",
    microchip_number: "",
    status: "Verkauft",
    color: "",
    breed: "",
    weight_kg: "",
    veterinarian_id: "",
    notes: "",
    return_to: "/animals/historie",
  });

  assert.equal(response.status, 302);
  assert.match(response.headers.location || "", new RegExp(`^/animals/${animalId}/edit\\?`));

  const animal = db.prepare("SELECT status FROM animals WHERE id = ?").get(animalId);
  assert.equal(animal?.status, "Aktiv");
});

test("Statuswechsel speichert Abschlussdaten und zeigt alle Statuswerte in der Historie konsistent", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const speciesName = db.prepare("SELECT name FROM species WHERE id = ?").get(speciesId)?.name || "Katze";
  const historyAnimalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Milo", speciesId, "Aktiv").lastInsertRowid;
  const restingAnimalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Nala", speciesId, "Aktiv").lastInsertRowid;

  const historyMove = await agent.post(`/animals/${historyAnimalId}/update`).type("form").send({
    name: "Milo",
    species_name: speciesName,
    status: "Vermittelt",
    status_context_name: "Familie Sommer",
    status_context_date: "2026-07-20",
    memorial_note: "Sanfter Übergang mit kurzem Nachgespräch.",
    status_transition_confirmed: "true",
    return_to: "/animals/historie",
  });
  assert.equal(historyMove.status, 302);

  const restingMove = await agent.post(`/animals/${restingAnimalId}/update`).type("form").send({
    name: "Nala",
    species_name: speciesName,
    status: "Verstorben",
    status_context_name: "Zuhause im Körbchen",
    status_context_date: "2026-07-21",
    memorial_note: "Sehr geliebte Begleiterin.",
    status_transition_confirmed: "true",
    return_to: "/animals/historie?status=Verstorben",
  });
  assert.equal(restingMove.status, 302);

  const historyAnimal = db.prepare("SELECT * FROM animals WHERE id = ?").get(historyAnimalId);
  assert.equal(historyAnimal.status_context_name, "Familie Sommer");
  assert.equal(historyAnimal.status_context_date, "2026-07-20");
  assert.equal(historyAnimal.memorial_note, "Sanfter Übergang mit kurzem Nachgespräch.");
  assert.ok(historyAnimal.status_changed_at);

  const restingAnimal = db.prepare("SELECT * FROM animals WHERE id = ?").get(restingAnimalId);
  assert.equal(restingAnimal.status_context_name, "Zuhause im Körbchen");
  assert.equal(restingAnimal.status_context_date, "2026-07-21");
  assert.equal(restingAnimal.memorial_note, "Sehr geliebte Begleiterin.");
  assert.ok(restingAnimal.status_changed_at);

  const auditActions = db.prepare(`
    SELECT action, details
    FROM audit_logs
    WHERE entity_type = 'animal' AND entity_id IN (?, ?)
    ORDER BY id ASC
  `).all(String(historyAnimalId), String(restingAnimalId));
  assert.ok(auditActions.some((item) => item.action === "animal.status_change" && item.details.includes("Familie Sommer")));
  assert.ok(auditActions.some((item) => item.action === "animal.status_change" && item.details.includes("Sehr geliebte Begleiterin")));

  const historyPage = await agent.get(`/animals/historie?animal_id=${historyAnimalId}`);
  assert.equal(historyPage.status, 200);
  assert.match(historyPage.text, /Familie Sommer/);
  assert.match(historyPage.text, /20\.07\.2026/);

  const restingPage = await agent.get("/animals/historie?status=Verstorben");
  assert.equal(restingPage.status, 200);
  assert.match(restingPage.text, /Zuhause im Körbchen/);
  assert.match(restingPage.text, /Sehr geliebte Begleiterin\./);
});

test("Dashboard zeigt Tierarten und konkrete Aufmerksamkeitspunkte", async () => {
  const speciesId = db.prepare("SELECT id FROM species ORDER BY id ASC LIMIT 1").get()?.id;
  const animalId = db.prepare("INSERT INTO animals (name, species_id, status) VALUES (?, ?, ?)").run("Radar", speciesId, "Aktiv").lastInsertRowid;
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(animalId, "Bald prüfen", "Allgemein", dayjs().subtract(1, "day").format("YYYY-MM-DDTHH:mm"), "offen");
  db.prepare(`
    INSERT INTO audit_logs (actor_user_id, actor_email, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, "admin@test.local", "animal.update", "animal", String(animalId), JSON.stringify({ animal_id: animalId, name: "Radar" }));

  const response = await agent.get("/");
  assert.equal(response.status, 200);
  assert.match(response.text, /Hinweise/);
  assert.match(response.text, /Radar/);
  assert.doesNotMatch(response.text, /Profilbild von Radar/);
  assert.match(response.text, new RegExp(`href="/animals\\?animal_id=${animalId}"`));
  assert.match(response.text, /Tierarzt fehlt/);
  assert.match(response.text, /Geburtsdatum fehlt/);
  assert.doesNotMatch(response.text, /Pflichtdokumente offen/);
  assert.doesNotMatch(response.text, /Zuletzt geändert/);
  assert.doesNotMatch(response.text, /Schnell weiter/);
});

test("Dashboard enthält getrennte Bereiche für Tierbestand, Wetter und Stall", async () => {
  upsertSetting(db, "coop_camera_streams", "Testkamera|http://127.0.0.1/test.jpg");
  try {
    const response = await agent.get("/");
    assert.equal(response.status, 200);
    assert.match(response.text, /dashboard-coop-section/);
    assert.match(response.text, /dashboard-inventory-section/);
    assert.match(response.text, /dashboard-weather-section/);
  } finally {
    upsertSetting(db, "coop_camera_streams", "");
  }
});

test("Dashboard bietet Impfungen direkt in der Schnellerfassung an", async () => {
  await ensureAdminAuthenticated();
  db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)")
    .run(`Schnellerfassung ${Date.now()}`, "Aktiv");
  const response = await agent.get("/");
  assert.equal(response.status, 200);
  assert.match(response.text, /data-quick-entry-kind="vaccination"[^>]*>Impfung<\/a>/);
});

test("Kamera-Einstellungen erklären RTSP und Wansview verständlich", async () => {
  const response = await agent.get("/admin/stall");
  assert.equal(response.status, 200);
  assert.match(response.text, /rtsp:\/\/BENUTZER:PASSWORT@IP:554\/live\/ch0/);
  assert.match(response.text, /ffmpeg -version/);
  assert.match(response.text, /weather_latitude/);
  assert.match(response.text, /Open-Meteo/);
  assert.match(response.text, /Homematic XML-API/);
  assert.match(response.text, /OpenCCU/);
  assert.match(response.text, /tokenregister\.cgi/);
  assert.match(response.text, /statechange\.cgi\?ise_id=/);
  assert.match(response.text, /homematic_temperature_datapoint_id/);
  assert.match(response.text, /homematic_humidity_datapoint_id/);
  assert.match(response.text, /homematic_door_sensor_datapoint_id/);
  assert.match(response.text, /homematic_door_sensor_true_state/);
  assert.match(response.text, /homematic_door_level_datapoint_id/);
  assert.match(response.text, /homematic_door_open_datapoint_id/);
  assert.match(response.text, /homematic_door_close_datapoint_id/);
  assert.match(response.text, /Auswählen/);
  assert.match(response.text, /homematic-device-search/);
  assert.doesNotMatch(response.text, /name="homematic_door_open_url"/);
  assert.match(response.text, /Alle Stall-Einstellungen speichern/);
  assert.doesNotMatch(response.text, /name="homematic_climate_url"/);
  assert.match(response.text, /name="homematic_xmlapi_token"/);

  const generalResponse = await agent.get("/admin/allgemein");
  assert.equal(generalResponse.status, 200);
  assert.doesNotMatch(generalResponse.text, /CCU-Zugang/);
});

test("Mobile Mehr-Navigation verlinkt alle Adminbereiche direkt", async () => {
  const response = await agent.get("/admin/allgemein");
  assert.equal(response.status, 200);
  ["allgemein", "stall", "benachrichtigungen", "stammdaten", "benutzer", "import", "systemlog"].forEach((pathName) => {
    assert.match(response.text, new RegExp(`href=\\"/admin/${pathName}\\"`));
  });
  assert.match(response.text, /mobile-admin-nav/);
});

test("Erfolgreiche Änderungen werden zusätzlich zentral im Audit-Log erfasst", async () => {
  db.prepare("DELETE FROM audit_logs WHERE action = 'request.change'").run();
  const response = await agent
    .post("/admin/settings")
    .type("form")
    .send({ _fields: "ntfy_topic", ntfy_topic: "audit-test" });
  assert.equal(response.status, 302);
  await new Promise((resolve) => setImmediate(resolve));
  const entry = db.prepare("SELECT details FROM audit_logs WHERE action = 'request.change' ORDER BY id DESC LIMIT 1").get();
  assert.ok(entry);
  assert.match(entry.details, /ntfy_topic/);
});

test("Gemeinsamer Eintragsweg speichert Fütterung, Notiz und Erinnerung", async () => {
  const animalId = db.prepare("SELECT id FROM animals WHERE status = 'Aktiv' ORDER BY id ASC LIMIT 1").get()?.id;
  assert.ok(animalId);

  const feedingResponse = await agent.post(`/animals/${animalId}/events`).type("form").send({
    event_kind: "feeding",
    title: "Abendfutter",
    event_time: "18:30",
    notes: "Kleine Portion",
    return_to: `/animals/${animalId}`,
  });
  assert.equal(feedingResponse.status, 302);
  assert.ok(db.prepare("SELECT id FROM animal_feedings WHERE animal_id = ? AND label = ?").get(animalId, "Abendfutter"));

  const noteResponse = await agent.post(`/animals/${animalId}/events`).type("form").send({
    event_kind: "note",
    title: "Beobachtung",
    notes: "Heute besonders aktiv",
    return_to: `/animals/${animalId}`,
  });
  assert.equal(noteResponse.status, 302);
  const note = db.prepare("SELECT content FROM animal_notes WHERE animal_id = ? AND title = ?").get(animalId, "Beobachtung");
  assert.equal(note?.content, "Heute besonders aktiv");

  const reminderResponse = await agent.post(`/animals/${animalId}/events`).type("form").send({
    event_kind: "reminder",
    title: "Kontrolle",
    event_date: dayjs().add(2, "day").format("YYYY-MM-DD"),
    event_time: "09:30",
    notes: "Allgemeiner Kontrolltermin",
    return_to: `/animals/${animalId}`,
  });
  assert.equal(reminderResponse.status, 302);
  assert.ok(db.prepare("SELECT id FROM reminders WHERE animal_id = ? AND title = ?").get(animalId, "Kontrolle"));
});

test("Tierärztlich markierte Ereignisse benötigen serverseitig einen Tierarzt", async () => {
  const animalId = db.prepare("SELECT id FROM animals WHERE status = 'Aktiv' ORDER BY id ASC LIMIT 1").get()?.id;
  assert.ok(animalId);

  const response = await agent.post(`/animals/${animalId}/events`).type("form").send({
    event_kind: "vaccination",
    title: "Impfung ohne Tierarzt",
    event_date: "2026-09-21",
    handled_by_veterinarian: "1",
    veterinarian_id: "",
    return_to: `/animals/${animalId}`,
  });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, new RegExp(`^/animals/${animalId}/events/new\\?`));
  assert.equal(
    db.prepare("SELECT id FROM animal_vaccinations WHERE animal_id = ? AND name = ?").get(animalId, "Impfung ohne Tierarzt"),
    undefined,
  );
});

test("Tierseite zeigt Tierarzt-Kontakt und einen einfachen Haupteinstieg", async () => {
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
    microchip_number: "276099200310213",
    microchip_manufacturer: "Dechra",
    microchip_registry: "TASSO",
  });

  const response = await agent.get("/animals/1");
  assert.equal(response.status, 200);
  assert.match(response.text, /Kontaktdaten anzeigen/i);
  assert.match(response.text, /Was möchtest du tun/i);
  assert.match(response.text, /Aktion hinzufügen/i);
  assert.match(response.text, /Medikament, Impfung, Termin, Erinnerung, Fütterung oder Notiz auswählen/i);
  assert.match(response.text, /Weitere Details/i);
  assert.match(response.text, /Vorerkrankung/i);
  assert.doesNotMatch(response.text, /animal-hero-address/i);
  assert.match(response.text, /Musterweg 12/i);
  assert.match(response.text, /276099200310213/);
  assert.match(response.text, /Chip-Hersteller[\s\S]*Dechra/);
  assert.match(response.text, /Haustierregister[\s\S]*TASSO/);
  assert.match(response.text, /Bei TASSO prüfen/);
  assert.match(response.text, /Bei FINDEFIX prüfen/);
  assert.match(response.text, /Bei TASSO vermisst melden/);
  assert.doesNotMatch(response.text, /Bei FINDEFIX vermisst melden/);
});

test("Tierseite zeigt die Timeline vor den Details und begrenzt sie zunächst auf zehn Einträge", async () => {
  const animalId = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Timeline Tier", "Aktiv").lastInsertRowid;
  const insertNote = db.prepare("INSERT INTO animal_notes (animal_id, title, content, created_at) VALUES (?, ?, ?, ?)");
  for (let index = 1; index <= 12; index += 1) {
    insertNote.run(animalId, `Timeline Test ${index}`, "Testeintrag", `2026-08-${String(index).padStart(2, "0")} 10:00:00`);
  }

  const response = await agent.get(`/animals/${animalId}`);
  db.prepare("DELETE FROM animals WHERE id = ?").run(animalId);

  assert.equal(response.status, 200);
  assert.ok(response.text.indexOf('id="animal-timeline"') < response.text.indexOf("Weitere Details"));
  assert.match(response.text, /data-timeline-primary/);
  assert.match(response.text, /data-timeline-more/);
  assert.match(response.text, /Mehr anzeigen \(2\)/);
  assert.doesNotMatch(response.text, /id="animal-timeline-body"/);
});

test("Tierseite blendet den aktuellen Stand ohne offene Erinnerungen aus", async () => {
  const animalId = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Ruhige Akte", "Aktiv").lastInsertRowid;

  const emptyResponse = await agent.get(`/animals/${animalId}`);
  assert.equal(emptyResponse.status, 200);
  assert.doesNotMatch(emptyResponse.text, /animal-current-status-card/);
  assert.doesNotMatch(emptyResponse.text, /Alles erledigt/);

  db.prepare("INSERT INTO reminders (animal_id, title, reminder_type, due_at) VALUES (?, ?, ?, ?)")
    .run(animalId, "Offene Aufgabe", "Allgemein", dayjs().add(1, "day").format("YYYY-MM-DDTHH:mm"));
  const openResponse = await agent.get(`/animals/${animalId}`);
  db.prepare("DELETE FROM animals WHERE id = ?").run(animalId);

  assert.equal(openResponse.status, 200);
  assert.match(openResponse.text, /animal-current-status-card/);
  assert.match(openResponse.text, /1 offene Erinnerung/);
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
    "/animals/historie",
    "/animals/1",
    "/suche",
    "/admin/allgemein",
    "/admin/stall",
    "/admin/kommunikation",
    "/admin/benachrichtigungen",
    "/admin/stammdaten",
    "/admin/benutzer",
    "/admin/import",
    "/admin/systemlog",
    "/hilfe",
  ];

  for (const href of routes) {
    const response = await agent.get(href).redirects(3);
    assertNoTemplateError(response, href);
  }
});

test("Kalenderexport liefert globale und tierbezogene ICS-Dateien", async () => {
  const appointmentId = db.prepare(`
    INSERT INTO animal_appointments (animal_id, title, appointment_at)
    VALUES (?, ?, ?)
  `).run(1, "Kalenderkontrolle", dayjs().add(5, "day").format("YYYY-MM-DDTHH:mm")).lastInsertRowid;

  const globalCalendar = await agent.get("/calendar.ics");
  assert.equal(globalCalendar.status, 200);
  assert.match(globalCalendar.headers["content-type"], /text\/calendar/);
  assert.match(globalCalendar.text, new RegExp(`UID:appointment-${appointmentId}@heartpet\\.local`));

  const animalCalendar = await agent.get("/animals/1/calendar.ics");
  assert.equal(animalCalendar.status, 200);
  assert.match(animalCalendar.headers["content-disposition"], /attachment/);
  assert.match(animalCalendar.text, /Kalenderkontrolle/);
});

test("Versorgungsverwaltung ist vollständig entfernt", async () => {
  assert.equal((await agent.get("/versorgung")).status, 404);
  assert.equal((await agent.get("/versorgung/bestand/new")).status, 404);
  assert.equal((await agent.post("/versorgung/kosten").type("form").send({})).status, 404);

  const sidebar = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "sidebar-nav.ejs"), "utf8");
  const mobileNavigation = fs.readFileSync(path.join(__dirname, "..", "views", "partials", "top.ejs"), "utf8");
  assert.doesNotMatch(sidebar, /Versorgung|\/versorgung|careManagement/);
  assert.doesNotMatch(mobileNavigation, /Versorgung|\/versorgung|careManagement/);
});

test("Rechtstext-Seiten und Einstellungen sind vollständig entfernt", async () => {
  for (const pathname of ["/impressum", "/datenschutz", "/cookies"]) {
    assert.equal((await agent.get(pathname)).status, 404);
  }
  const adminGeneral = await agent.get("/admin/allgemein");
  assert.equal(adminGeneral.status, 200);
  assert.doesNotMatch(adminGeneral.text, /Impressum|Datenschutzerklärung|Cookie-Hinweise|Rechtliche Angaben/);
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
  assert.match(adminGeneral.text, /\/app-logo/);
  const publicLogo = await request(app).get("/app-logo");
  assert.equal(publicLogo.status, 200);
  assert.match(publicLogo.headers["content-type"], /^image\//);

  const removeLogo = await agent.post("/admin/settings/app-logo/delete").type("form").send({});
  assert.equal(removeLogo.status, 302);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'app_logo_stored_name'").get()?.value, "");
  const resetPage = await agent.get("/admin/allgemein");
  assert.doesNotMatch(resetPage.text, /Standardlogo verwenden/);
});

test("Bilder lassen sich vollständig verwalten, ohne gemeinsam verwendete Dateien zu beschädigen", async () => {
  await ensureAdminAuthenticated();
  const animal = db.prepare("SELECT id FROM animals WHERE name = ?").get("Minka");
  const imagePath = path.join(process.cwd(), "public", "images", "logo-heartpet.png");

  const createImage = await agent
    .post(`/animals/${animal.id}/images`)
    .field("title", "Erster Titel")
    .attach("image", imagePath);
  assert.equal(createImage.status, 302);

  const image = db.prepare("SELECT * FROM animal_images WHERE animal_id = ? ORDER BY id DESC").get(animal.id);
  assert.equal(image.title, "Erster Titel");
  const storedPath = path.join(tempDataDir, "uploads", image.stored_name);
  assert.equal(fs.existsSync(storedPath), true);

  const updateImage = await agent
    .post(`/animals/${animal.id}/images/${image.id}/update`)
    .type("form")
    .send({ title: "Neuer Titel" });
  assert.equal(updateImage.status, 302);
  assert.equal(db.prepare("SELECT title FROM animal_images WHERE id = ?").get(image.id).title, "Neuer Titel");

  const setProfile = await agent.post(`/animals/${animal.id}/images/${image.id}/set-profile`).type("form").send({});
  assert.equal(setProfile.status, 302);
  assert.equal(db.prepare("SELECT profile_image_stored_name FROM animals WHERE id = ?").get(animal.id).profile_image_stored_name, image.stored_name);

  const deleteGalleryEntry = await agent.post(`/animals/${animal.id}/images/${image.id}/delete`).type("form").send({});
  assert.equal(deleteGalleryEntry.status, 302);
  assert.equal(db.prepare("SELECT 1 FROM animal_images WHERE id = ?").get(image.id), undefined);
  assert.equal(fs.existsSync(storedPath), true, "Das weiterhin verwendete Profilbild muss erhalten bleiben");

  const deleteProfile = await agent.post(`/animals/${animal.id}/profile-image/delete`).type("form").send({});
  assert.equal(deleteProfile.status, 302);
  assert.equal(db.prepare("SELECT profile_image_stored_name FROM animals WHERE id = ?").get(animal.id).profile_image_stored_name, null);
  assert.equal(fs.existsSync(storedPath), false, "Eine nicht mehr referenzierte Datei wird entfernt");
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

test("Erinnerungslinks blockieren Aktionen fuer inaktive Tiere", async () => {
  const inactiveAnimal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Alte Links", "Verkauft");
  const completeInserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `).run(inactiveAnimal.lastInsertRowid, "Alter Complete-Link", "Allgemein", "2026-04-05T09:00", "inaktiv");
  const snoozeInserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `).run(inactiveAnimal.lastInsertRowid, "Alter Snooze-Link", "Allgemein", "2026-04-05T10:00", "inaktiv");

  const completeReminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(completeInserted.lastInsertRowid);
  const snoozeReminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(snoozeInserted.lastInsertRowid);
  const completeToken = buildReminderActionToken(completeReminder, "complete");
  const snoozeToken = buildReminderActionToken(snoozeReminder, "snooze", "60");

  const completeResponse = await agent.get(`/reminders/${completeReminder.id}/email-complete`).query({ token: completeToken });
  assert.equal(completeResponse.status, 200);
  assert.match(completeResponse.text, /Tier nicht mehr aktiv/);
  const unchangedComplete = db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(completeReminder.id);
  assert.equal(unchangedComplete.completed_at, null);

  const snoozeResponse = await agent.get(`/reminders/${snoozeReminder.id}/email-snooze`).query({ token: snoozeToken, value: "60" });
  assert.equal(snoozeResponse.status, 200);
  assert.match(snoozeResponse.text, /Zurückstellen ist deshalb nicht mehr möglich/);
  const unchangedSnooze = db.prepare("SELECT due_at, last_delivery_status FROM reminders WHERE id = ?").get(snoozeReminder.id);
  assert.equal(unchangedSnooze.due_at, "2026-04-05T10:00");
  assert.notEqual(unchangedSnooze.last_delivery_status, "pending");
});

test("Dashboard-Banner zaehlt nur offene Erinnerungen aktiver Tiere", async () => {
  const inactiveAnimal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Archivtier", "Verstorben");
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(1, "Aktive Erinnerung", "Allgemein", dayjs().subtract(1, "hour").format("YYYY-MM-DDTHH:mm"), "aktiv");
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 0, ?)
  `).run(inactiveAnimal.lastInsertRowid, "Archiv-Erinnerung", "Allgemein", dayjs().subtract(1, "hour").format("YYYY-MM-DDTHH:mm"), "inaktiv");

  const response = await agent.get("/api/reminders/pending");
  assert.equal(response.status, 200);
  const titles = response.body.reminders.map((item) => item.title);
  assert.ok(titles.includes("Aktive Erinnerung"));
  assert.ok(!titles.includes("Archiv-Erinnerung"));
});

test("Tageszusammenfassung ignoriert offene Erinnerungen inaktiver Tiere", async () => {
  db.prepare("UPDATE reminders SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)").run();
  db.prepare("DELETE FROM notification_logs WHERE notification_type = ?").run("daily_digest");
  ["daily_digest_enabled", "daily_digest_time", "daily_digest_only_when_open", "last_daily_digest_date", "reminder_email_enabled", "reminder_telegram_enabled"].forEach((key) => {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  });

  upsertSetting(db, "daily_digest_enabled", "true");
  upsertSetting(db, "daily_digest_time", "00:00");
  upsertSetting(db, "daily_digest_only_when_open", "true");
  upsertSetting(db, "reminder_email_enabled", "false");
  upsertSetting(db, "reminder_telegram_enabled", "false");

  const inactiveAnimal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Digest Archiv", "Verstorben");
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(inactiveAnimal.lastInsertRowid, "Archiv-Digest nicht senden", "Allgemein", dayjs().subtract(1, "day").format("YYYY-MM-DD HH:mm"), "inaktiv");

  await app.__test.maybeSendDailyDigest();

  const digestLog = db.prepare(`
    SELECT status, details
    FROM notification_logs
    WHERE notification_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get("daily_digest");
  assert.equal(digestLog.status, "skipped");
  assert.match(digestLog.details || "", /no_open_reminders/);
});

test("Tageszusammenfassung und Dashboard werten Leerzeichen-Zeitstempel gleich aus", async () => {
  db.prepare("UPDATE reminders SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)").run();
  db.prepare("DELETE FROM notification_logs WHERE notification_type = ?").run("daily_digest");
  ["daily_digest_enabled", "daily_digest_time", "daily_digest_only_when_open", "last_daily_digest_date", "reminder_email_enabled", "reminder_telegram_enabled"].forEach((key) => {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  });

  upsertSetting(db, "daily_digest_enabled", "true");
  upsertSetting(db, "daily_digest_time", "00:00");
  upsertSetting(db, "daily_digest_only_when_open", "true");
  upsertSetting(db, "reminder_email_enabled", "false");
  upsertSetting(db, "reminder_telegram_enabled", "false");

  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(1, "Digest Leerzeichen", "Allgemein", dayjs().subtract(2, "hour").format("YYYY-MM-DD HH:mm"), "aktiv");

  const dashboard = await agent.get("/");
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Digest Leerzeichen/);

  await app.__test.maybeSendDailyDigest();

  const digestLog = db.prepare(`
    SELECT status, details
    FROM notification_logs
    WHERE notification_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get("daily_digest");
  assert.equal(digestLog.status, "skipped");
  assert.match(digestLog.details || "", /"overdue":1/);
});

test("Erinnerung per Complete-Route verschwindet aus der Pending-API", async () => {
  const inserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `).run(1, "Wurmkur Abschluss", "Allgemein", dayjs().subtract(2, "hour").format("YYYY-MM-DDTHH:mm"), "offen");

  let response = await agent.get("/api/reminders/pending");
  assert.equal(response.status, 200);
  assert.ok(response.body.reminders.some((item) => Number(item.id) === Number(inserted.lastInsertRowid)));

  response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`);
  assert.equal(response.status, 302);

  const updated = db.prepare("SELECT * FROM reminders WHERE id = ?").get(inserted.lastInsertRowid);
  assert.ok(updated.completed_at);

  response = await agent.get("/api/reminders/pending");
  assert.equal(response.status, 200);
  assert.ok(!response.body.reminders.some((item) => Number(item.id) === Number(inserted.lastInsertRowid)));
});

test("Impf-Erinnerung verlangt ein tatsächliches Impfdatum", async () => {
  await ensureAdminAuthenticated();
  const animal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Impfdatum Tier", "Aktiv");
  const vaccination = db.prepare(`
    INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, notes)
    VALUES (?, ?, NULL, ?, ?)
  `).run(animal.lastInsertRowid, "Impfdatum-Test", "2026-09-20", "Test");
  const inserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, notes, source_kind, source_id)
    VALUES (?, ?, ?, ?, ?, 'vaccination', ?)
  `).run(animal.lastInsertRowid, "Nächste Impfung", "Impfung", "2026-09-20T09:00", "Test", vaccination.lastInsertRowid);

  let response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`).send({});
  assert.equal(response.status, 302);
  assert.equal(db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(inserted.lastInsertRowid).completed_at, null);
  assert.equal(db.prepare("SELECT vaccination_date FROM animal_vaccinations WHERE id = ?").get(vaccination.lastInsertRowid).vaccination_date, null);

  response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`).type("form").send({ vaccination_date: "2099-01-01" });
  assert.equal(response.status, 302);
  assert.equal(db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(inserted.lastInsertRowid).completed_at, null);

  response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`).type("form").send({ vaccination_date: "2026-09-19" });
  assert.equal(response.status, 302);
  assert.ok(db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(inserted.lastInsertRowid).completed_at);
  assert.equal(
    db.prepare("SELECT vaccination_date FROM animal_vaccinations WHERE id = ?").get(vaccination.lastInsertRowid).vaccination_date,
    "2026-09-19"
  );
});

test("Ältere Impf-Erinnerung öffnet die Datumsabfrage und kann nicht direkt erledigt werden", async () => {
  await ensureAdminAuthenticated();
  const animal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Alte Impf-Erinnerung", "Aktiv");
  const inserted = db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(animal.lastInsertRowid, "Nächste Impfung", "Allgemein", "2026-09-20T09:00", "Altbestand");

  const dashboard = await agent.get("/");
  assert.equal(dashboard.status, 200);
  assert.match(
    dashboard.text,
    new RegExp(`action="/reminders/${inserted.lastInsertRowid}/complete"[^>]*data-vaccination-completion`)
  );

  let response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`).send({});
  assert.equal(response.status, 302);
  assert.equal(db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(inserted.lastInsertRowid).completed_at, null);

  response = await agent.post(`/reminders/${inserted.lastInsertRowid}/complete`)
    .type("form")
    .send({ vaccination_date: "2026-09-19" });
  assert.equal(response.status, 302);
  assert.ok(db.prepare("SELECT completed_at FROM reminders WHERE id = ?").get(inserted.lastInsertRowid).completed_at);
});

test("Dringende Dashboard-Erinnerungen sind zur Tierakte klickbar", async () => {
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes, source_kind, source_id)
    VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
  `).run(1, "Klickbare Wurmkur", "Impfung", dayjs().subtract(1, "day").format("YYYY-MM-DDTHH:mm"), "Test", "vaccination", 123);

  const response = await agent.get("/");
  assert.equal(response.status, 200);
  assert.match(response.text, /href="\/animals\/1#animal-medizin"/);
  assert.match(response.text, /Klickbare Wurmkur/);
});

test("Resync generierter Erinnerungen behaelt Benachrichtigungsstatus bei unveraenderten Faelligkeiten", async () => {
  const vaccination = db.prepare(`
    INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes)
    VALUES (?, ?, NULL, ?, 1, ?)
  `).run(1, "Wurmkur Resync", "2026-04-17", "Test");

  await agent.post("/admin/settings").type("form").send({
    _fields: "vaccination_reminder_lead_days,vaccination_reminder_repeat_count",
    vaccination_reminder_lead_days: "30",
    vaccination_reminder_repeat_count: "1",
  });

  let reminder = db.prepare(`
    SELECT *
    FROM reminders
    WHERE source_kind = 'vaccination' AND source_id = ?
  `).get(vaccination.lastInsertRowid);
  assert.ok(reminder);

  db.prepare(`
    UPDATE reminders
    SET last_notified_at = ?, last_delivery_status = ?
    WHERE id = ?
  `).run("2026-04-01 08:00:00", "sent", reminder.id);

  await agent.post("/admin/settings").type("form").send({
    _fields: "vaccination_reminder_lead_days,vaccination_reminder_repeat_count",
    vaccination_reminder_lead_days: "30",
    vaccination_reminder_repeat_count: "1",
  });

  reminder = db.prepare(`
    SELECT *
    FROM reminders
    WHERE source_kind = 'vaccination' AND source_id = ?
  `).get(vaccination.lastInsertRowid);
  assert.ok(reminder);
  assert.equal(reminder.last_notified_at, "2026-04-01 08:00:00");
  assert.equal(reminder.last_delivery_status, "sent");
});

test("Telegram-Erinnerungen werden nicht mehr fuer inaktive Tiere versendet", async () => {
  db.prepare("UPDATE reminders SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)").run();
  const inactiveAnimal = db.prepare("INSERT INTO animals (name, status) VALUES (?, ?)").run("Kein Versand", "Verstorben");
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(inactiveAnimal.lastInsertRowid, "Nicht senden", "Allgemein", dayjs().subtract(5, "minute").format("YYYY-MM-DDTHH:mm"), "archiviert");

  const notifications = [];
  await processDueReminders(db, {
    app_name: "HeartPet",
    app_domain: "heartpet.de",
    reminder_email_enabled: "false",
    reminder_telegram_enabled: "true",
    telegram_bot_token: "123456:ABCDEF",
    telegram_chat_id: "987654",
  }, {
    onNotification(entry) {
      notifications.push(entry);
    },
  });

  assert.equal(notifications.length, 0);
  const reminder = db.prepare("SELECT last_notified_at FROM reminders WHERE title = ?").get("Nicht senden");
  assert.equal(reminder.last_notified_at, null);
});

test("Erinnerungs-Bestätigungsseite verwendet absolute Asset-Links", async () => {
  const saveSettings = await agent.post("/admin/settings").type("form").send({
    _fields: "app_domain",
    app_domain: "heartpet.de",
  });
  assert.equal(saveSettings.status, 302);

  const response = await agent.get("/reminders/999999/email-complete").query({ token: "ungueltig" });
  assert.equal(response.status, 200);
  assert.match(response.text, /https:\/\/heartpet\.de\/static\/css\/theme-foundation\.css/);
  assert.match(response.text, /https:\/\/heartpet\.de\/static\/css\/theme-layout\.css/);
  assert.match(response.text, /https:\/\/heartpet\.de\/static\/css\/theme-components\.css/);
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

test("Benachrichtigungsbereiche sind standardmäßig geschlossene Akkordeons", async () => {
  const response = await agent.get("/admin/benachrichtigungen");
  assert.equal(response.status, 200);

  assert.match(response.text, /id="communication-accordion"/);
  for (const panel of [
    "communication-panel-general",
    "communication-panel-rules",
    "communication-panel-email",
    "communication-panel-telegram",
    "communication-panel-ntfy",
  ]) {
    assert.match(response.text, new RegExp(`id="${panel}" class="accordion-collapse collapse"`));
    assert.doesNotMatch(response.text, new RegExp(`id="${panel}" class="accordion-collapse collapse show"`));
  }

  for (const heading of ["communication-heading-email", "communication-heading-telegram", "communication-heading-ntfy"]) {
    const headingIndex = response.text.indexOf(`id="${heading}"`);
    const panelIndex = response.text.indexOf("accordion-collapse", headingIndex);
    assert.ok(headingIndex >= 0, `${heading} fehlt`);
    assert.ok(panelIndex > headingIndex, `${heading} hat keinen folgenden Inhalt`);
    const headingMarkup = response.text.slice(headingIndex, panelIndex);
    assert.match(headingMarkup, /accordion-header-status/);
    assert.match(headingMarkup, /Konfiguriert|Nicht konfiguriert/);
    assert.match(headingMarkup, /Aktiviert|Deaktiviert/);
  }

  const notificationPanels = ["email", "telegram", "ntfy"];
  for (const [index, panel] of notificationPanels.entries()) {
    const panelStart = response.text.indexOf(`id="communication-panel-${panel}"`);
    const nextPanel = notificationPanels[index + 1];
    const panelEnd = nextPanel
      ? response.text.indexOf(`id="communication-heading-${nextPanel}"`, panelStart)
      : response.text.length;
    const panelMarkup = response.text.slice(panelStart, panelEnd);
    assert.doesNotMatch(panelMarkup, /class="status-chip/, `${panel} enthält eine doppelte Statusanzeige`);
    assert.match(panelMarkup, new RegExp(`${panel === "email" ? "E-Mail" : panel === "telegram" ? "Telegram" : "ntfy"}-Versand (?:ein|aus)schalten`));
  }
});

test("Instanz-Zeitzone kann ausgewählt und nur gültig gespeichert werden", async () => {
  const previousTimeZone = db.prepare("SELECT value FROM settings WHERE key = ?").get("instance_timezone")?.value || "";

  try {
    let response = await agent.get("/admin/benachrichtigungen");
    assert.equal(response.status, 200);
    assert.match(response.text, /id="instance_timezone"/);
    assert.match(response.text, /<option value="Europe\/Berlin"/);
    assert.equal(response.text.match(/id="instance_timezone"/g)?.length, 1);
    assert.ok(
      response.text.indexOf('id="instance_timezone"') < response.text.indexOf('id="communication-accordion"'),
      "Die Zeitzonen-Auswahl muss oberhalb der geschlossenen Akkordeons sichtbar sein."
    );

    response = await agent
      .post("/admin/settings")
      .set("Referer", "http://localhost/admin/benachrichtigungen")
      .type("form")
      .send({ _fields: "instance_timezone", instance_timezone: "Europe/Berlin" });
    assert.ok([302, 303].includes(response.status));
    assert.equal(response.headers.location, "/admin/benachrichtigungen");
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("instance_timezone")?.value, "Europe/Berlin");

    response = await agent
      .post("/admin/settings")
      .set("Referer", "http://localhost/admin/benachrichtigungen")
      .type("form")
      .send({ _fields: "instance_timezone", instance_timezone: "Mars/Olympus_Mons" });
    assert.ok([302, 303].includes(response.status));
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("instance_timezone")?.value, "Europe/Berlin");
  } finally {
    upsertSetting(db, "instance_timezone", previousTimeZone);
  }
});

test("Bundesland und Tierkörperbeseitigungsanlagen steuern den Hinweis in der Historie", async () => {
  const previousState = db.prepare("SELECT value FROM settings WHERE key = ?").get("federal_state")?.value || "";
  let facilityId;
  try {
    let response = await agent.get("/admin/benachrichtigungen");
    assert.equal(response.status, 200);
    assert.match(response.text, /id="federal_state"/);
    assert.match(response.text, /<option value="Bayern"/);

    response = await agent.post("/admin/settings").type("form").send({
      _fields: "federal_state",
      federal_state: "Bayern",
    });
    assert.ok([302, 303].includes(response.status));
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("federal_state")?.value, "Bayern");

    response = await agent.post("/admin/disposal-facilities").type("form").send({
      name: "VTN Testanlage",
      federal_state: "Bayern",
      street: "Am Testweg 3",
      postal_code: "91710",
      city: "Gunzenhausen",
      country: "Deutschland",
      phone: "09831 123456",
      email: "info@example.de",
      website: "https://example.de/vtn",
      opening_hours: "Montag bis Freitag",
      pricing: "Preis nach Gewicht, Stand 09/2026",
      pickup_available: "1",
      pickup_details: "Abholung gegen Aufpreis",
      notes: "Zuständigkeit vorher bestätigen",
    });
    assert.ok([302, 303].includes(response.status));
    const facility = db.prepare("SELECT * FROM disposal_facilities WHERE name = ?").get("VTN Testanlage");
    assert.ok(facility);
    facilityId = facility.id;
    assert.equal(facility.pickup_available, 1);

    response = await agent.get("/animals/historie");
    assert.equal(response.status, 200);
    assert.match(response.text, /Hinweis nach dem Tod eines Tieres/);
    assert.match(response.text, /Bayern · Entsorgung, Bestattung und zuständige Anlagen/);
    assert.match(response.text, /Auf dem eigenen Grundstück dürfen nur einzelne Heimtiere bestattet werden/);
    assert.doesNotMatch(response.text, /Die Ausnahme gilt nicht automatisch/);
    assert.match(response.text, /Ausgewähltes Bundesland:/);
    assert.match(response.text, /Für Bayern: bundesweite Regeln und örtliche Prüfung/);
    assert.match(response.text, /VTN Testanlage/);
    assert.match(response.text, /Abholung gegen Aufpreis/);

    response = await agent.post(`/admin/disposal-facilities/${facilityId}/update`).type("form").send({
      ...facility,
      name: "VTN Testanlage aktualisiert",
      pickup_available: "",
    });
    assert.ok([302, 303].includes(response.status));
    assert.equal(db.prepare("SELECT name FROM disposal_facilities WHERE id = ?").get(facilityId)?.name, "VTN Testanlage aktualisiert");

    response = await agent.post(`/admin/disposal-facilities/${facilityId}/delete`);
    assert.ok([302, 303].includes(response.status));
    assert.equal(db.prepare("SELECT id FROM disposal_facilities WHERE id = ?").get(facilityId), undefined);
    facilityId = null;
  } finally {
    if (facilityId) db.prepare("DELETE FROM disposal_facilities WHERE id = ?").run(facilityId);
    upsertSetting(db, "federal_state", previousState);
  }
});

test("Ungültige Bundesländer werden nicht gespeichert", async () => {
  const previousState = db.prepare("SELECT value FROM settings WHERE key = ?").get("federal_state")?.value || "";
  try {
    const response = await agent.post("/admin/settings").type("form").send({
      _fields: "federal_state",
      federal_state: "Phantasieland",
    });
    assert.equal(response.status, 302);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get("federal_state")?.value || "", previousState);
  } finally {
    upsertSetting(db, "federal_state", previousState);
  }
});

test("Zeitzonen-Template bleibt mit einem älteren Serverprozess auswählbar", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "views", "pages", "admin-communication.ejs"), "utf8");
  assert.match(template, /fallbackTimeZoneOptions/);
  assert.match(template, /Europe\/Berlin/);
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

test("Gespeicherte Zugangsdaten werden nicht wieder im Adminformular ausgegeben", async () => {
  await ensureAdminAuthenticated();

  const keys = ["smtp_password", "telegram_bot_token", "ntfy_access_token", "homematic_xmlapi_token"];
  const previous = require("../src/db").getSettingsObject(db);
  try {
    upsertSetting(db, "smtp_password", "smtp-nicht-ausgeben");
    upsertSetting(db, "telegram_bot_token", "telegram-nicht-ausgeben");
    upsertSetting(db, "ntfy_access_token", "ntfy-nicht-ausgeben");
    upsertSetting(db, "homematic_xmlapi_token", "ccu-nicht-ausgeben");

    const communication = await agent.get("/admin/benachrichtigungen");
    assert.equal(communication.status, 200);
    assert.doesNotMatch(communication.text, /smtp-nicht-ausgeben|telegram-nicht-ausgeben|ntfy-nicht-ausgeben/);
    const coop = await agent.get("/admin/stall");
    assert.equal(coop.status, 200);
    assert.doesNotMatch(coop.text, /ccu-nicht-ausgeben/);

    await agent.post("/admin/settings").type("form").send({
      _fields: keys.join(","),
      smtp_password: "",
      telegram_bot_token: "",
      ntfy_access_token: "",
      homematic_xmlapi_token: "",
    });
    const settings = require("../src/db").getSettingsObject(db);
    assert.equal(settings.smtp_password, "smtp-nicht-ausgeben");
    assert.equal(settings.telegram_bot_token, "telegram-nicht-ausgeben");
    assert.equal(settings.ntfy_access_token, "ntfy-nicht-ausgeben");
    assert.equal(settings.homematic_xmlapi_token, "ccu-nicht-ausgeben");
  } finally {
    keys.forEach((key) => upsertSetting(db, key, previous[key] || ""));
  }
});

test("Externe Referer werden nicht als Weiterleitungsziel verwendet", () => {
  const fakeRequest = {
    protocol: "https",
    get(name) {
      if (name === "referer") return "https://angreifer.example/phishing";
      if (name === "host") return "heartpet.de";
      return "";
    },
  };
  assert.equal(app.__test.safeRefererPath(fakeRequest, "/"), "/");
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

test("Browser-Antworten enthalten Sicherheitsheader und verraten Express nicht", async () => {
  const response = await request(app).get("/login");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-powered-by"], undefined);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
  assert.ok(response.headers.ratelimit);
  const contentSecurityPolicy = response.headers["content-security-policy"];
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
  assert.doesNotMatch(contentSecurityPolicy, /https:/);
  assert.doesNotMatch(response.text, /https:\/\/(?:cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)/);
  assert.match(response.text, /\/static\/vendor\/bootstrap\/bootstrap\.min\.css/);
});

test("Technische Diagnosen maskieren Zugangsdaten und Tokens", () => {
  const text = app.__test.redactSensitiveText("http://admin:geheim@192.168.1.80/x?sid=ABC123&token=XYZ");
  assert.equal(text, "http://***:***@192.168.1.80/x?sid=***&token=***");
  assert.equal(app.__test.redactSensitiveText("Fehler\nGefälschter Logeintrag"), "Fehler Gefälschter Logeintrag");
});

test("Gespeicherte Dateinamen bleiben im Upload-Verzeichnis", () => {
  assert.equal(app.__test.resolveStoredFilePath("../heartpet.sqlite"), null);
  assert.equal(app.__test.resolveStoredFilePath("unterordner/datei.pdf"), null);
  assert.equal(app.__test.resolveStoredFilePath("datei.pdf"), path.join(tempDataDir, "uploads", "datei.pdf"));
});

test("E-Mail-Prüfung ist begrenzt und akzeptiert normale Adressen", () => {
  assert.equal(app.__test.isValidEmail("tierarzt@example.de"), true);
  assert.equal(app.__test.isValidEmail("ungueltig"), false);
  assert.equal(app.__test.isValidEmail(`${"a".repeat(250)}@example.de`), false);
});

test("Schreibzugriffe aus einer fremden Browser-Origin werden abgelehnt", async () => {
  const response = await request(app).post("/logout").set("Origin", "https://fremde-seite.example");
  assert.equal(response.status, 403);

  const fetchMetadataResponse = await request(app).post("/logout").set("Sec-Fetch-Site", "cross-site");
  assert.equal(fetchMetadataResponse.status, 403);
});

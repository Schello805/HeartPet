const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations } = require("./migrations");

const configuredDataDir = String(process.env.HEARTPET_DATA_DIR || "").trim();
const dataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(process.cwd(), "data");
const databaseFile = path.join(dataDir, "heartpet.sqlite");

function ensureDataDirectories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "exports"), { recursive: true });
}

function initDatabase() {
  ensureDataDirectories();
  const db = new Database(databaseFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  seedDefaults(db);
  return db;
}

function seedDefaults(db) {
  const defaultSettings = {
    app_name: "HeartPet",
    app_domain: "heartpet.de",
    app_logo_stored_name: "",
    organization_name: "Mein Tierbestand",
    smtp_host: "",
    smtp_port: "587",
    smtp_secure: "false",
    smtp_user: "",
    smtp_password: "",
    smtp_from: "",
    notification_email_to: "",
    telegram_bot_token: "",
    telegram_chat_id: "",
    reminder_email_enabled: "false",
    reminder_telegram_enabled: "false",
    browser_notifications_enabled: "true",
    medication_reminder_lead_days: "0",
    medication_reminder_repeat_count: "0",
    vaccination_reminder_lead_days: "30",
    vaccination_reminder_repeat_count: "1",
    appointment_reminder_lead_days: "1",
    appointment_reminder_repeat_count: "1",
    default_veterinarian_id: "",
    daily_digest_enabled: "false",
    daily_digest_time: "07:30",
    daily_digest_only_when_open: "true",
    last_daily_digest_date: "",
    coop_camera_streams: "",
    homematic_door_open_url: "",
    homematic_door_close_url: "",
    homematic_climate_url: "",
    homematic_xmlapi_token: "",
    homematic_temperature_url: "",
    homematic_humidity_url: "",
    help_contact: "Support-Kontakt: [Name / Organisation], [E-Mail], [Telefon optional]",
    contact_text: [
      "Kontakt",
      "",
      "Bei Fragen zu HeartPet oder zum Betrieb dieser Instanz:",
      "",
      "Name / Organisation: [Bitte eintragen]",
      "E-Mail: [kontakt@beispiel.de]",
      "Telefon: [optional]",
    ].join("\n"),
  };

  const insertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO NOTHING
  `);

  const settingRows = Object.entries(defaultSettings).map(([key, value]) => ({ key, value }));
  const settingsTx = db.transaction((rows) => rows.forEach((row) => insertSetting.run(row)));
  settingsTx(settingRows);
  db.prepare(`DELETE FROM settings WHERE key IN (
    'legal_responsible_name', 'legal_content_responsible_name', 'legal_contact_street',
    'legal_contact_postal_city', 'legal_contact_country', 'legal_contact_phone',
    'legal_contact_email', 'imprint_text', 'privacy_text', 'cookies_text'
  )`).run();
  db.prepare(`
    UPDATE settings
    SET value = REPLACE(value, ?, '')
    WHERE key = 'contact_text'
  `).run("Wichtiger Hinweis: Dieser Text ist nur eine allgemeine Vorlage, nicht vollständig und nicht rechtssicher. Bitte vor produktivem Einsatz rechtlich prüfen lassen.\n\n");
  normalizeSpeciesCatalog(db);

  if (db.prepare("SELECT COUNT(*) AS count FROM document_categories").get().count === 0) {
    const categories = [
      "Impfbescheinigung",
      "Vertrag",
      "Sonstiges",
    ];
    const insertCategory = db.prepare("INSERT INTO document_categories (name) VALUES (?)");
    const tx = db.transaction((items) => items.forEach((name) => insertCategory.run(name)));
    tx(categories);
  }

  if (!db.prepare("SELECT 1 FROM settings WHERE key = ?").get("setup_complete")) {
    const hasUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0;
    upsertSetting(db, "setup_complete", hasUsers ? "true" : "false");
  }
}

function normalizeSpeciesCatalog(db) {
  const alreadyNormalized = db.prepare("SELECT value FROM settings WHERE key = ?").get("species_catalog_pruned_v1");
  if (String(alreadyNormalized?.value || "").trim() === "true") {
    return;
  }

  const usedSpecies = db.prepare(`
    SELECT
      animals.id AS animal_id,
      species.name,
      species.default_veterinarian_id,
      species.notes
    FROM animals
    INNER JOIN species ON species.id = animals.species_id
    WHERE species.name IS NOT NULL AND TRIM(species.name) <> ''
    ORDER BY species.name COLLATE NOCASE ASC, animals.id ASC
  `).all();

  const rebuildCatalog = db.transaction((items) => {
    const speciesByName = new Map();
    items.forEach((item) => {
      if (!speciesByName.has(item.name)) {
        speciesByName.set(item.name, {
          default_veterinarian_id: item.default_veterinarian_id || null,
          notes: item.notes || "",
        });
      }
    });

    db.prepare("DELETE FROM species").run();

    const insertSpecies = db.prepare(`
      INSERT INTO species (name, default_veterinarian_id, notes)
      VALUES (?, ?, ?)
    `);
    const updateAnimalSpecies = db.prepare("UPDATE animals SET species_id = ? WHERE id = ?");
    const recreatedIds = new Map();

    [...speciesByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "de"))
      .forEach(([name, meta]) => {
        const result = insertSpecies.run(name, meta.default_veterinarian_id, meta.notes);
        recreatedIds.set(name, result.lastInsertRowid);
      });

    items.forEach((item) => {
      const recreatedId = recreatedIds.get(item.name);
      if (recreatedId) {
        updateAnimalSpecies.run(recreatedId, item.animal_id);
      }
    });
  });

  rebuildCatalog(usedSpecies);
  upsertSetting(db, "species_catalog_pruned_v1", "true");
}

function getSettingsObject(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function upsertSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value ?? "");
}

module.exports = {
  initDatabase,
  getSettingsObject,
  upsertSetting,
  databaseFile,
};

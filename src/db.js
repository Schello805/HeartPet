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
    help_contact: "Support-Kontakt: [Name / Organisation], [E-Mail], [Telefon optional]",
    legal_responsible_name: "",
    legal_content_responsible_name: "",
    legal_contact_street: "",
    legal_contact_postal_city: "",
    legal_contact_country: "",
    legal_contact_phone: "",
    legal_contact_email: "",
    imprint_text: [
      "Wichtiger Hinweis: Dieser Text ist nur eine allgemeine Vorlage, nicht vollständig und nicht rechtssicher. Bitte vor produktivem Einsatz rechtlich prüfen lassen.",
      "",
      "Angaben gemäß § 5 TMG",
      "[Name der verantwortlichen Person oder Organisation]",
      "[Straße und Hausnummer]",
      "[PLZ Ort]",
      "[Land]",
      "",
      "Kontakt",
      "E-Mail: [recht@beispiel.de]",
      "Telefon: [Telefonnummer optional]",
      "",
      "Verantwortlich für den Inhalt",
      "[Name der verantwortlichen Person]",
      "[Anschrift, falls abweichend]",
      "",
      "Projekt-Hinweis",
      "HeartPet ist eine selbst gehostete Webanwendung zur Verwaltung von Tierakten. Je nach Art des Betriebs, des Angebots und der Veröffentlichung können weitere Pflichtangaben erforderlich sein.",
    ].join("\n"),
    privacy_text: [
      "Wichtiger Hinweis: Dieser Text ist nur eine allgemeine Vorlage, nicht vollständig und nicht rechtssicher. Bitte vor produktivem Einsatz rechtlich prüfen lassen.",
      "",
      "Datenschutzerklärung",
      "",
      "1. Allgemeine Hinweise",
      "Diese Webanwendung verarbeitet personenbezogene Daten nur in dem Umfang, der für den Betrieb, die Anmeldung und die Nutzung von HeartPet erforderlich ist.",
      "",
      "2. Verantwortliche Stelle",
      "[Name / Organisation]",
      "[Anschrift]",
      "E-Mail: [recht@beispiel.de]",
      "",
      "3. Verarbeitete Daten",
      "- Benutzerkonten und Anmeldedaten",
      "- Session-Daten zur Anmeldung",
      "- eingegebene Tierdaten, Dokumente und Bilder",
      "- Kommunikationsdaten für SMTP und optional Telegram",
      "- technische Server- und Protokolldaten, soweit für den Betrieb erforderlich",
      "",
      "4. Zweck der Verarbeitung",
      "Die Verarbeitung erfolgt zum Betrieb der Anwendung, zur Verwaltung von Tierakten, zur Dokumentation und für Erinnerungsfunktionen.",
      "",
      "5. Rechtsgrundlagen",
      "Je nach Nutzung kommen insbesondere Art. 6 Abs. 1 lit. b DSGVO, Art. 6 Abs. 1 lit. c DSGVO und Art. 6 Abs. 1 lit. f DSGVO in Betracht.",
      "",
      "6. Speicherort und Hosting",
      "HeartPet speichert Daten lokal auf dem eingesetzten Server. Uploads, Datenbankinhalte und Exporte verbleiben grundsätzlich in der eigenen Hosting-Umgebung.",
      "",
      "7. Empfänger / Drittanbieter",
      "Bei Nutzung der E-Mail-Funktion werden Daten an den konfigurierten SMTP-Dienst übermittelt. Bei Nutzung von Telegram werden Daten an Telegram übermittelt.",
      "",
      "8. Speicherdauer",
      "Daten werden so lange gespeichert, wie sie für die Nutzung, Dokumentation oder rechtliche Nachweise benötigt werden oder bis sie gelöscht werden.",
      "",
      "9. Betroffenenrechte",
      "Betroffene Personen haben im Rahmen der gesetzlichen Vorschriften insbesondere Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Beschwerde bei einer Aufsichtsbehörde.",
      "",
      "10. Sicherheit",
      "Es sollten geeignete technische und organisatorische Maßnahmen umgesetzt werden, insbesondere Zugriffsschutz, Backups, sichere Passwörter und ein abgesicherter Serverbetrieb.",
    ].join("\n"),
    contact_text: [
      "Wichtiger Hinweis: Dieser Text ist nur eine allgemeine Vorlage, nicht vollständig und nicht rechtssicher. Bitte vor produktivem Einsatz rechtlich prüfen lassen.",
      "",
      "Kontakt",
      "",
      "Bei Fragen zu HeartPet oder zum Betrieb dieser Instanz:",
      "",
      "Name / Organisation: [Bitte eintragen]",
      "E-Mail: [kontakt@beispiel.de]",
      "Telefon: [optional]",
      "",
      "Technischer Hinweis",
      "Bitte keine sensiblen Unterlagen unverschlüsselt per E-Mail versenden, wenn dies vermeidbar ist.",
    ].join("\n"),
    cookies_text: [
      "Wichtiger Hinweis: Dieser Text ist nur eine allgemeine Vorlage, nicht vollständig und nicht rechtssicher. Bitte vor produktivem Einsatz rechtlich prüfen lassen.",
      "",
      "Cookie- und Session-Hinweise",
      "",
      "HeartPet verwendet technisch notwendige Session-Daten, damit Anmeldungen und geschützte Bereiche funktionieren.",
      "",
      "Aktuell sind in dieser Vorlage keine Marketing-, Tracking- oder Analyse-Cookies beschrieben. Falls solche Dienste später eingesetzt werden, muss dieser Hinweis angepasst und rechtlich geprüft werden.",
      "",
      "Technisch notwendige Funktionen können insbesondere umfassen:",
      "- Anmeldung und Sitzungsverwaltung",
      "- Schutz interner Bereiche vor unbefugtem Zugriff",
      "- sichere Formular- und Benutzerinteraktion",
    ].join("\n"),
  };

  const insertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO NOTHING
  `);

  const settingRows = Object.entries(defaultSettings).map(([key, value]) => ({ key, value }));
  const settingsTx = db.transaction((rows) => rows.forEach((row) => insertSetting.run(row)));
  settingsTx(settingRows);
  normalizeLegacyPlaceholderSettings(db);
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

function normalizeLegacyPlaceholderSettings(db) {
  const placeholderSettings = {
    legal_contact_street: "[Straße und Hausnummer]",
    legal_contact_postal_city: "[PLZ Ort]",
    legal_contact_country: "[Land]",
    legal_contact_phone: "[Telefonnummer optional]",
    legal_contact_email: "[recht@beispiel.de]",
  };

  Object.entries(placeholderSettings).forEach(([key, legacyValue]) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) {
      return;
    }

    if (String(row.value || "").trim() === legacyValue) {
      upsertSetting(db, key, "");
    }
  });
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

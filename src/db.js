const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const dataDir = path.join(process.cwd(), "data");
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      must_change_password INTEGER NOT NULL DEFAULT 1,
      can_edit_animals INTEGER NOT NULL DEFAULT 1,
      can_manage_documents INTEGER NOT NULL DEFAULT 1,
      can_manage_gallery INTEGER NOT NULL DEFAULT 1,
      can_manage_health INTEGER NOT NULL DEFAULT 1,
      can_manage_feedings INTEGER NOT NULL DEFAULT 1,
      can_manage_notes INTEGER NOT NULL DEFAULT 1,
      can_manage_reminders INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS veterinarians (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS species (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      default_veterinarian_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(default_veterinarian_id) REFERENCES veterinarians(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS animals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      species_id INTEGER,
      sex TEXT,
      birth_date TEXT,
      intake_date TEXT,
      source TEXT,
      microchip_number TEXT,
      status TEXT NOT NULL DEFAULT 'Aktiv',
      color TEXT,
      breed TEXT,
      weight_kg REAL,
      veterinarian_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(species_id) REFERENCES species(id) ON DELETE SET NULL,
      FOREIGN KEY(veterinarian_id) REFERENCES veterinarians(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS animal_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS animal_medications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      dosage TEXT,
      schedule TEXT,
      start_date TEXT,
      end_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS animal_vaccinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      vaccination_date TEXT,
      next_due_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS animal_feedings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      time_of_day TEXT,
      food TEXT,
      amount TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS animal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      category_id INTEGER,
      title TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE,
      FOREIGN KEY(category_id) REFERENCES document_categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS animal_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER NOT NULL,
      title TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal_id INTEGER,
      title TEXT NOT NULL,
      reminder_type TEXT NOT NULL DEFAULT 'Allgemein',
      due_at TEXT NOT NULL,
      channel_email INTEGER NOT NULL DEFAULT 1,
      channel_telegram INTEGER NOT NULL DEFAULT 0,
      repeat_interval_days INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      completed_at TEXT,
      last_notified_at TEXT,
      last_delivery_status TEXT,
      last_delivery_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE SET NULL
    );
  `);

  ensureColumn(db, "animals", "profile_image_stored_name", "TEXT");
  ensureColumn(db, "animals", "profile_image_original_name", "TEXT");
  ensureColumn(db, "animals", "profile_image_mime_type", "TEXT");
  ensureColumn(db, "document_categories", "is_required", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "reminders", "repeat_interval_days", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "reminders", "last_delivery_status", "TEXT");
  ensureColumn(db, "reminders", "last_delivery_error", "TEXT");
  ensureColumn(db, "users", "can_edit_animals", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_documents", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_gallery", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_health", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_feedings", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_notes", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "users", "can_manage_reminders", "INTEGER NOT NULL DEFAULT 1");

  seedDefaults(db);
  return db;
}

function seedDefaults(db) {
  const defaultSettings = {
    app_name: "HeartPet",
    app_domain: "heartpet.de",
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
    help_contact: "",
    legal_contact_email: "",
    imprint_text: "Bitte Impressum im Adminbereich pflegen.",
    privacy_text: "Bitte Datenschutzerklärung im Adminbereich pflegen.",
    contact_text: "Bitte Kontaktinformationen im Adminbereich pflegen.",
    cookies_text: "Bitte Cookie-Hinweise im Adminbereich pflegen.",
  };

  const insertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO NOTHING
  `);

  const settingRows = Object.entries(defaultSettings).map(([key, value]) => ({ key, value }));
  const settingsTx = db.transaction((rows) => rows.forEach((row) => insertSetting.run(row)));
  settingsTx(settingRows);

  if (db.prepare("SELECT COUNT(*) AS count FROM document_categories").get().count === 0) {
    const categories = [
      "Impfnachweis",
      "Arztbrief",
      "Laborbefund",
      "Kaufvertrag",
      "Abgabeprotokoll",
      "Foto",
      "Sonstiges",
    ];
    const insertCategory = db.prepare("INSERT INTO document_categories (name) VALUES (?)");
    const tx = db.transaction((items) => items.forEach((name) => insertCategory.run(name)));
    tx(categories);
  }

  const species = [
    "Hund",
    "Katze",
    "Koi",
    "Goldfisch",
    "Aquariumfisch",
    "Huhn",
    "Ente",
    "Gans",
    "Kaninchen",
    "Meerschweinchen",
    "Hamster",
    "Maus",
    "Ratte",
    "Frettchen",
    "Pferd",
    "Pony",
    "Esel",
    "Ziege",
    "Schaf",
    "Schwein",
    "Minischwein",
    "Rind",
    "Alpaka",
    "Lama",
    "Wellensittich",
    "Kanarienvogel",
    "Nymphensittich",
    "Papagei",
    "Ara",
    "Sittich",
    "Taube",
    "Wachtel",
    "Truthahn",
    "Schildkröte",
    "Schlange",
    "Echse",
    "Bartagame",
    "Gecko",
    "Chamäleon",
    "Leguan",
    "Frosch",
    "Axolotl",
    "Igel",
  ];
  const insertSpecies = db.prepare("INSERT INTO species (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  const tx = db.transaction((items) => items.forEach((name) => insertSpecies.run(name)));
  tx(species);

  if (db.prepare("SELECT COUNT(*) AS count FROM veterinarians").get().count === 0) {
    db.prepare(`
      INSERT INTO veterinarians (name, email, phone, notes)
      VALUES (?, ?, ?, ?)
    `).run("Standard Tierarzt", "", "", "Kann in den Admin-Einstellungen angepasst oder ersetzt werden.");
  }

  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0) {
    const passwordHash = bcrypt.hashSync("admin123!", 10);
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role, must_change_password)
      VALUES (?, ?, ?, ?, ?)
    `).run("Administrator", "admin@heartpet.local", passwordHash, "admin", 1);
  }

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

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    if (!String(error.message || "").includes("duplicate column name")) {
      throw error;
    }
  }
}

module.exports = {
  initDatabase,
  getSettingsObject,
  upsertSetting,
  databaseFile,
};

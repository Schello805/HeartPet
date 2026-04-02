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
  id: "002_schema_updates",
  description: "Ergänzt nachträglich eingeführte Spalten und Defaults",
  up(db) {
    ensureColumn(db, "animals", "profile_image_stored_name", "TEXT");
    ensureColumn(db, "animals", "profile_image_original_name", "TEXT");
    ensureColumn(db, "animals", "profile_image_mime_type", "TEXT");
    ensureColumn(db, "document_categories", "is_required", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "reminders", "repeat_interval_days", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "reminders", "last_delivery_status", "TEXT");
    ensureColumn(db, "reminders", "last_delivery_error", "TEXT");
    ensureColumn(db, "reminders", "source_kind", "TEXT");
    ensureColumn(db, "reminders", "source_id", "INTEGER");
    ensureColumn(db, "reminders", "source_index", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "users", "can_edit_animals", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_documents", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_gallery", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_health", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_feedings", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_notes", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "users", "can_manage_reminders", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "veterinarians", "street", "TEXT");
    ensureColumn(db, "veterinarians", "postal_code", "TEXT");
    ensureColumn(db, "veterinarians", "city", "TEXT");
    ensureColumn(db, "veterinarians", "country", "TEXT");
    ensureColumn(db, "animal_medications", "reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "animal_vaccinations", "reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "animal_appointments", "reminder_enabled", "INTEGER NOT NULL DEFAULT 0");
  },
};

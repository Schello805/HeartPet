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
  id: "004_animal_status_context",
  description: "Ergänzt Abschlussdaten für Historie und Ruhestätte",
  up(db) {
    ensureColumn(db, "animals", "status_changed_at", "TEXT");
    ensureColumn(db, "animals", "status_context_name", "TEXT");
    ensureColumn(db, "animals", "status_context_date", "TEXT");
    ensureColumn(db, "animals", "memorial_note", "TEXT");
  },
};

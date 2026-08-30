function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

module.exports = {
  id: "005_vaccination_certificates",
  description: "Ergänzt optionale Impfnachweise an Impfungen",
  up(db) {
    ensureColumn(db, "animal_vaccinations", "certificate_original_name", "TEXT");
    ensureColumn(db, "animal_vaccinations", "certificate_stored_name", "TEXT");
    ensureColumn(db, "animal_vaccinations", "certificate_mime_type", "TEXT");
    ensureColumn(db, "animal_vaccinations", "certificate_file_size", "INTEGER");
  },
};

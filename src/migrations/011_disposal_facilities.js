module.exports = {
  id: "011_disposal_facilities",
  description: "Ergaenzt Bundesland und Tierkoerperbeseitigungsanlagen",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS disposal_facilities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        federal_state TEXT NOT NULL,
        street TEXT,
        postal_code TEXT,
        city TEXT,
        country TEXT NOT NULL DEFAULT 'Deutschland',
        phone TEXT,
        email TEXT,
        website TEXT,
        opening_hours TEXT,
        pricing TEXT,
        pickup_available INTEGER NOT NULL DEFAULT 0,
        pickup_details TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_disposal_facilities_state
        ON disposal_facilities(federal_state, name);
    `);
  },
};

module.exports = {
  id: "010_care_management",
  description: "Ergaenzt Bestands- und Kostenverwaltung",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Sonstiges',
        quantity REAL NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        unit TEXT NOT NULL DEFAULT 'Stück',
        minimum_quantity REAL NOT NULL DEFAULT 0 CHECK(minimum_quantity >= 0),
        expires_on TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER,
        category TEXT NOT NULL DEFAULT 'Sonstiges',
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
        expense_date TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON inventory_items(name);
      CREATE INDEX IF NOT EXISTS idx_inventory_items_expires_on ON inventory_items(expires_on);
      CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
      CREATE INDEX IF NOT EXISTS idx_expenses_animal_id ON expenses(animal_id);
    `);
  },
};

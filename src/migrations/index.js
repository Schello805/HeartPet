const migrations = [
  require("./001_initial_schema"),
  require("./002_schema_updates"),
];

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function runMigrations(db) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations ORDER BY id ASC").all().map((row) => row.id)
  );
  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (id, description)
    VALUES (?, ?)
  `);

  const applyMigration = db.transaction((migration) => {
    migration.up(db);
    insertMigration.run(migration.id, migration.description);
  });

  migrations.forEach((migration) => {
    if (!applied.has(migration.id)) {
      applyMigration(migration);
    }
  });
}

module.exports = {
  migrations,
  runMigrations,
};

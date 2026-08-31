module.exports = {
  id: "006_user_access_tracking",
  description: "Ergänzt Passwort-Reset sowie Login- und Aktivitätsstatus für Benutzer",
  up(db) {
    const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
    if (!columns.has("last_login_at")) db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
    if (!columns.has("last_seen_at")) db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
    if (!columns.has("last_logout_at")) db.exec("ALTER TABLE users ADD COLUMN last_logout_at TEXT");
    if (!columns.has("session_version")) db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");

    db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
    `);
  },
};

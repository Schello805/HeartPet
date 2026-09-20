const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { PASSWORD_HASH_ROUNDS } = require("./password-security");

function generateInitialPassword() {
  return `${crypto.randomBytes(18).toString("base64url")}!9aA`;
}

function createInitialAdmin(db, options = {}) {
  const email = String(options.email || "").trim().toLowerCase();
  const name = String(options.name || "Administrator").trim() || "Administrator";
  const accessMode = options.accessMode === "domain" ? "domain" : "lan";
  const appDomain = accessMode === "domain" ? String(options.appDomain || "").trim().replace(/\/+$/, "") : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Ungültige Admin-E-Mail-Adresse.");
  if (accessMode === "domain" && !/^https:\/\/[^/]+$/i.test(appDomain)) {
    throw new Error("Für den Domainbetrieb ist eine HTTPS-Adresse ohne Pfad erforderlich.");
  }

  const existingUser = db.prepare("SELECT id, email FROM users ORDER BY id ASC LIMIT 1").get();
  if (existingUser) return { created: false, email: existingUser.email, password: "" };

  const password = String(options.password || generateInitialPassword());
  const result = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO users (
        name, email, password_hash, role, must_change_password,
        can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
        can_manage_feedings, can_manage_notes, can_manage_reminders
      ) VALUES (?, ?, ?, 'admin', 1, 1, 1, 1, 1, 1, 1, 1)
    `).run(name, email, bcrypt.hashSync(password, PASSWORD_HASH_ROUNDS));
    const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    upsert.run("access_mode", accessMode);
    upsert.run("app_domain", appDomain);
    upsert.run("setup_complete", "true");
    return inserted.lastInsertRowid;
  })();

  return { created: true, userId: result, email, password };
}

module.exports = { createInitialAdmin, generateInitialPassword };

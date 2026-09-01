const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const session = require("express-session");

class BetterSqliteSessionStore extends session.Store {
  constructor(filename, maxAgeMs) {
    super();
    this.db = new Database(filename);
    this.maxAgeMs = maxAgeMs;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);
    this.getStatement = this.db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expired > ?");
    this.setStatement = this.db.prepare(`INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired`);
    this.destroyStatement = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.cleanupStatement = this.db.prepare("DELETE FROM sessions WHERE expired <= ?");
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.maxAgeMs;
      this.setStatement.run(sid, JSON.stringify(value), expiresAt);
      if (Math.random() < 0.01) this.cleanupStatement.run(Date.now());
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) { callback(error); }
  }
}

function resolveSessionSecret(dataDir) {
  const configured = String(process.env.HEARTPET_SESSION_SECRET || "").trim();
  if (configured) return configured;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = path.join(dataDir, ".session-secret");
  if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(48).toString("base64url"), { mode: 0o600 });
  return fs.readFileSync(secretPath, "utf8").trim();
}

function createSessionMiddleware(dataDir) {
  const useMemorySessionStore = shouldUseMemorySessionStore(process.env);
  const configuredSessionDays = Number.parseInt(String(process.env.HEARTPET_SESSION_DAYS || "30"), 10);
  const sessionDays = Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? configuredSessionDays : 30;
  const sessionMaxAgeMs = sessionDays * 24 * 60 * 60 * 1000;
  return session({
    name: "heartpet.sid",
    secret: resolveSessionSecret(dataDir),
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: sessionMaxAgeMs,
      sameSite: "lax",
      secure: String(process.env.HEARTPET_SECURE_COOKIE || "").toLowerCase() === "true",
    },
    store: useMemorySessionStore
      ? undefined
      : new BetterSqliteSessionStore(path.join(dataDir, "sessions.sqlite"), sessionMaxAgeMs),
  });
}

function shouldUseMemorySessionStore(environment) {
  const requestedMemoryStore = String(environment.HEARTPET_SESSION_STORE || "").trim().toLowerCase() === "memory";
  return requestedMemoryStore && String(environment.NODE_ENV || "").trim().toLowerCase() === "test";
}

module.exports = {
  BetterSqliteSessionStore,
  createSessionMiddleware,
  resolveSessionSecret,
  shouldUseMemorySessionStore,
};

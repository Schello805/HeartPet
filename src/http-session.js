const path = require("path");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const sqlite3 = require("sqlite3");

const SQLiteStore = SQLiteStoreFactory(session);

function createSessionMiddleware(dataDir) {
  const useMemorySessionStore = String(process.env.HEARTPET_SESSION_STORE || "").trim().toLowerCase() === "memory";
  const configuredSessionDays = Number.parseInt(String(process.env.HEARTPET_SESSION_DAYS || "30"), 10);
  const sessionDays = Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? configuredSessionDays : 30;
  const sessionMaxAgeMs = sessionDays * 24 * 60 * 60 * 1000;
  const sessionDb = useMemorySessionStore
    ? null
    : new sqlite3.Database(path.join(dataDir, "sessions.sqlite"));

  return session({
    name: "heartpet.sid",
    secret: process.env.HEARTPET_SESSION_SECRET || "heartpet-session-secret",
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: sessionMaxAgeMs,
      sameSite: "lax",
    },
    store: useMemorySessionStore
      ? undefined
      : new SQLiteStore({
          db: sessionDb,
          concurrentDb: true,
        }),
  });
}

module.exports = {
  createSessionMiddleware,
};

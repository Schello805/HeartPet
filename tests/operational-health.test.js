const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { buildCoreOperationalChecks, summarizeOperationalChecks } = require("../src/operational-health");

test("Betriebsdiagnose unterscheidet kritische Fehler und Warnungen", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-health-check-"));
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE animals (id INTEGER PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY);
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE vaccination_presets (id INTEGER PRIMARY KEY);
      CREATE TABLE notification_logs (status TEXT, created_at TEXT);
    `);
    const checks = buildCoreOperationalChecks({ db, dataDir });
    const summary = summarizeOperationalChecks(checks);
    assert.equal(summary.ok, true);
    assert.equal(summary.status, "degraded");
    assert.ok(checks.some((check) => check.name === "Backup" && !check.ok));

    db.exec("DROP TABLE vaccination_presets");
    const missingSchema = buildCoreOperationalChecks({ db, dataDir });
    assert.ok(missingSchema.some((check) => check.name === "Datenbank" && !check.ok && check.critical));
    assert.equal(summarizeOperationalChecks(missingSchema).status, "unhealthy");

    const unhealthy = summarizeOperationalChecks([{ name: "Datenbank", ok: false, critical: true }]);
    assert.equal(unhealthy.ok, false);
    assert.equal(unhealthy.status, "unhealthy");
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

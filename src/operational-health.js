const fs = require("node:fs");
const path = require("node:path");

function buildCoreOperationalChecks({ db, dataDir, now = Date.now() }) {
  const checks = [checkDatabase(db), checkDataDirectory(dataDir), checkDiskSpace(dataDir), checkBackupFreshness(dataDir, now)];
  return checks.concat(checkNotificationFailures(db));
}

function summarizeOperationalChecks(checks) {
  const criticalFailures = checks.filter((check) => check.critical && !check.ok);
  const warnings = checks.filter((check) => !check.ok && !check.critical);
  return {
    ok: criticalFailures.length === 0,
    status: criticalFailures.length ? "unhealthy" : warnings.length ? "degraded" : "healthy",
    criticalFailures: criticalFailures.length,
    warnings: warnings.length,
  };
}

function checkDatabase(db) {
  try {
    return { name: "Datenbank", ok: Boolean(db.prepare("SELECT 1 AS ok").get()?.ok), critical: true, detail: "SQLite erreichbar" };
  } catch {
    return { name: "Datenbank", ok: false, critical: true, detail: "SQLite nicht erreichbar" };
  }
}

function checkDataDirectory(dataDir) {
  try {
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    return { name: "Datenablage", ok: true, critical: true, detail: "Lesen und Schreiben möglich" };
  } catch {
    return { name: "Datenablage", ok: false, critical: true, detail: "Nicht beschreibbar" };
  }
}

function checkDiskSpace(dataDir) {
  try {
    const stats = fs.statfsSync(dataDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freePercent = totalBytes ? (freeBytes / totalBytes) * 100 : 0;
    const ok = freeBytes >= 512 * 1024 * 1024 && freePercent >= 5;
    return { name: "Speicherplatz", ok, critical: true, detail: `${formatBytes(freeBytes)} frei (${freePercent.toFixed(1)} %)` };
  } catch {
    return { name: "Speicherplatz", ok: false, critical: true, detail: "Nicht ermittelbar" };
  }
}

function checkBackupFreshness(dataDir, now) {
  const backupRoot = path.join(dataDir, "backups");
  try {
    const latest = fs.readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(backupRoot, entry.name, "heartpet.sqlite"))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.statSync(file).mtimeMs)
      .sort((left, right) => right - left)[0];
    if (!latest) return { name: "Backup", ok: false, critical: false, detail: "Noch kein geprüftes Backup vorhanden" };
    const ageHours = Math.max(0, (now - latest) / 3_600_000);
    return { name: "Backup", ok: ageHours <= 48, critical: false, detail: `Letztes Backup vor ${Math.round(ageHours)} Std.` };
  } catch {
    return { name: "Backup", ok: false, critical: false, detail: "Backup-Status nicht lesbar" };
  }
}

function checkNotificationFailures(db) {
  try {
    const count = db.prepare(`
      SELECT COUNT(*) AS count FROM notification_logs
      WHERE status = 'error' AND datetime(created_at) >= datetime('now', '-1 day')
    `).get().count;
    return [{ name: "Versandfehler", ok: count === 0, critical: false, detail: count ? `${count} Fehler in 24 Std.` : "Keine Fehler in 24 Std." }];
  } catch {
    return [];
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

module.exports = { buildCoreOperationalChecks, summarizeOperationalChecks };

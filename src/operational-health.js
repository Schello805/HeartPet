const fs = require("node:fs");
const path = require("node:path");
const { normalizeAppBaseUrl } = require("./app-url");

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

function buildInstallationChecks({
  settings = {},
  requestBaseUrl = "",
  runtimeRevision = "",
  availableRevision = "",
  dataDirectoryConfigured = false,
  secureCookie = "auto",
  notificationChannels = {},
} = {}) {
  const accessMode = settings.access_mode === "domain" ? "domain" : "lan";
  const configuredUrl = normalizeAppBaseUrl(settings.app_domain || process.env.HEARTPET_APP_URL);
  const currentUrl = normalizeAppBaseUrl(requestBaseUrl);
  const checks = [{
    name: "Betriebsart",
    ok: true,
    critical: false,
    detail: accessMode === "domain" ? "HTTPS-Domain" : "Nur Heimnetz",
    action: accessMode === "domain" ? "DNS, TLS und Reverse Proxy regelmäßig prüfen." : "Kein öffentlicher Zugriff vorgesehen.",
  }];

  if (accessMode === "domain") {
    const validDomain = Boolean(configuredUrl?.startsWith("https://"));
    checks.push({
      name: "Öffentliche Adresse",
      ok: validDomain,
      critical: true,
      detail: validDomain ? configuredUrl : "Keine gültige HTTPS-Adresse konfiguriert",
      action: validDomain ? "" : "Unter Verwaltung > Allgemein eine HTTPS-Adresse speichern.",
    });
    checks.push({
      name: "Aktueller Aufruf",
      ok: validDomain && Boolean(currentUrl) && configuredUrl === currentUrl,
      critical: false,
      detail: currentUrl || "Adresse nicht ermittelbar",
      action: validDomain && configuredUrl !== currentUrl ? `HeartPet über ${configuredUrl} öffnen und Proxy-Header prüfen.` : "",
    });
    checks.push({
      name: "Sicheres Session-Cookie",
      ok: secureCookie !== "false",
      critical: true,
      detail: secureCookie === "false" ? "Für Domainbetrieb deaktiviert" : "Aktiv oder automatisch",
      action: secureCookie === "false" ? "HEARTPET_SECURE_COOKIE=true setzen und den Dienst neu starten." : "",
    });
  }

  checks.push({
    name: "Datenpfad",
    ok: dataDirectoryConfigured,
    critical: false,
    detail: dataDirectoryConfigured ? "Dauerhaft über HEARTPET_DATA_DIR festgelegt" : "Projektverzeichnis wird verwendet",
    action: dataDirectoryConfigured ? "" : "Für Updates HEARTPET_DATA_DIR im systemd-Dienst festlegen.",
  });

  const revisionMatches = !runtimeRevision || !availableRevision || runtimeRevision === availableRevision;
  checks.push({
    name: "Aktive Revision",
    ok: revisionMatches,
    critical: true,
    detail: revisionMatches ? (runtimeRevision || "Nicht ermittelbar") : `${runtimeRevision} aktiv, ${availableRevision} installiert`,
    action: revisionMatches ? "" : "HeartPet-Dienst neu starten und /health erneut prüfen.",
  });

  for (const [name, channel] of Object.entries(notificationChannels)) {
    if (!channel.enabled) continue;
    checks.push({
      name: `${name} aktiviert`,
      ok: Boolean(channel.configured),
      critical: false,
      detail: channel.configured ? "Vollständig konfiguriert" : "Zugangsdaten unvollständig",
      action: channel.configured ? "" : "Kanal vervollständigen oder deaktivieren.",
    });
  }

  return checks;
}

function checkDatabase(db) {
  try {
    const requiredTables = ["animals", "settings", "users", "vaccination_presets"];
    const availableTables = new Set(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(", ")})
    `).all(...requiredTables).map((row) => row.name));
    const missingTables = requiredTables.filter((name) => !availableTables.has(name));
    return missingTables.length === 0
      ? { name: "Datenbank", ok: true, critical: true, detail: "SQLite und Pflichtschema erreichbar" }
      : { name: "Datenbank", ok: false, critical: true, detail: `Pflichttabellen fehlen: ${missingTables.join(", ")}` };
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

module.exports = { buildCoreOperationalChecks, buildInstallationChecks, summarizeOperationalChecks };

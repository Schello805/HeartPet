#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

async function createBackup({ dataDir, backupRoot, timestamp = formatTimestamp(new Date()) }) {
  const sourceDir = path.resolve(dataDir);
  const sourceDatabase = path.join(sourceDir, "heartpet.sqlite");
  if (!fs.existsSync(sourceDatabase)) throw new Error(`Datenbank nicht gefunden: ${sourceDatabase}`);

  const destinationDir = path.join(path.resolve(backupRoot), timestamp);
  fs.mkdirSync(destinationDir, { recursive: true });

  const database = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
  try {
    await database.backup(path.join(destinationDir, "heartpet.sqlite"));
  } finally {
    database.close();
  }

  copyIfPresent(path.join(sourceDir, "sessions.sqlite"), path.join(destinationDir, "sessions.sqlite"));
  copyIfPresent(path.join(sourceDir, ".session-secret"), path.join(destinationDir, ".session-secret"));
  copyDirectoryIfPresent(path.join(sourceDir, "uploads"), path.join(destinationDir, "uploads"));
  copyDirectoryIfPresent(path.join(sourceDir, "exports"), path.join(destinationDir, "exports"));

  const verification = verifyBackup(destinationDir);
  fs.writeFileSync(path.join(destinationDir, "backup-manifest.json"), JSON.stringify({
    createdAt: new Date().toISOString(),
    database: "heartpet.sqlite",
    integrity: verification.integrity,
  }, null, 2));
  return { destinationDir, ...verification };
}

function verifyBackup(backupDir) {
  const databasePath = path.join(path.resolve(backupDir), "heartpet.sqlite");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`SQLite-Integritätsprüfung fehlgeschlagen: ${integrity}`);
    return { integrity };
  } finally {
    database.close();
  }
}

function copyIfPresent(source, destination) {
  if (fs.existsSync(source)) fs.copyFileSync(source, destination);
}

function copyDirectoryIfPresent(source, destination) {
  if (fs.existsSync(source)) fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function main() {
  const appDir = path.resolve(__dirname, "..");
  const dataDir = path.resolve(process.env.HEARTPET_DATA_DIR || path.join(appDir, "data"));
  const backupRoot = path.resolve(process.env.HEARTPET_BACKUP_DIR || path.join(dataDir, "backups"));
  const result = await createBackup({ dataDir, backupRoot });
  console.log(`Backup geprüft und erstellt: ${result.destinationDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Backup fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createBackup, verifyBackup };

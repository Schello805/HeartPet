#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createBackup, verifyBackup } = require("./backup");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-backup-check-"));
  try {
    const dataDir = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });

    const source = new Database(path.join(dataDir, "heartpet.sqlite"));
    source.exec("CREATE TABLE restore_probe (value TEXT NOT NULL)");
    source.prepare("INSERT INTO restore_probe (value) VALUES (?)").run("heartpet-restore-ok");
    source.close();
    fs.writeFileSync(path.join(dataDir, "uploads", "restore-probe.txt"), "upload-ok");

    const backup = await createBackup({ dataDir, backupRoot, timestamp: "test-backup" });
    verifyBackup(backup.destinationDir);

    const restored = new Database(path.join(backup.destinationDir, "heartpet.sqlite"), { readonly: true });
    assert.equal(restored.prepare("SELECT value FROM restore_probe").get().value, "heartpet-restore-ok");
    restored.close();
    assert.equal(fs.readFileSync(path.join(backup.destinationDir, "uploads", "restore-probe.txt"), "utf8"), "upload-ok");
    console.log("backup-restore-ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

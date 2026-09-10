const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Erinnerungs-Aktionslinks verwenden ohne Konfiguration ein installationsbezogenes Geheimnis", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-reminder-secret-"));
  const previousDataDir = process.env.HEARTPET_DATA_DIR;
  const previousSecret = process.env.HEARTPET_SESSION_SECRET;
  process.env.HEARTPET_DATA_DIR = dataDir;
  delete process.env.HEARTPET_SESSION_SECRET;

  try {
    const { buildReminderActionToken } = require("../src/reminders");
    const reminder = { id: 7, due_at: "2026-09-10T12:00", title: "Kontrolle", animal_id: 3 };
    const token = buildReminderActionToken(reminder, "complete");
    const secret = fs.readFileSync(path.join(dataDir, ".session-secret"), "utf8").trim();
    const payload = "7|complete||2026-09-10T12:00|Kontrolle|3||";

    assert.equal(token, crypto.createHmac("sha256", secret).update(payload).digest("hex"));
    assert.notEqual(token, crypto.createHmac("sha256", "heartpet-session-secret").update(payload).digest("hex"));
  } finally {
    if (previousDataDir === undefined) delete process.env.HEARTPET_DATA_DIR;
    else process.env.HEARTPET_DATA_DIR = previousDataDir;
    if (previousSecret === undefined) delete process.env.HEARTPET_SESSION_SECRET;
    else process.env.HEARTPET_SESSION_SECRET = previousSecret;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { PASSWORD_HASH_ROUNDS } = require("../src/password-security");

const projectRoot = path.resolve(__dirname, "..");
const dataDir = String(process.env.HEARTPET_DATA_DIR || "").trim()
  ? path.resolve(process.env.HEARTPET_DATA_DIR)
  : path.join(projectRoot, "data");
const databasePath = path.join(dataDir, "heartpet.sqlite");
const email = String(process.argv[2] || "").trim().toLowerCase();

if (!email || !email.includes("@")) {
  console.error("Aufruf: node scripts/reset-admin-password.js admin@example.de");
  process.exit(1);
}

if (!fs.existsSync(databasePath)) {
  console.error(`HeartPet-Datenbank nicht gefunden: ${databasePath}`);
  process.exit(1);
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("Die Passworteingabe benötigt ein interaktives Terminal."));
      return;
    }

    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Abgebrochen."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const password = await readHidden("Neues Passwort: ");
  const confirmation = await readHidden("Passwort wiederholen: ");

  if (password !== confirmation) throw new Error("Die Passwörter stimmen nicht überein.");
  if (password.length < 8) throw new Error("Das Passwort muss mindestens 8 Zeichen lang sein.");

  const db = new Database(databasePath);
  try {
    const user = db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email);
    if (!user) throw new Error(`Kein Benutzerkonto für ${email} gefunden.`);

    const passwordHash = bcrypt.hashSync(password, PASSWORD_HASH_ROUNDS);
    db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 0,
          session_version = COALESCE(session_version, 0) + 1
      WHERE id = ?
    `).run(passwordHash, user.id);

    const savedHash = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id)?.password_hash;
    if (!savedHash || !bcrypt.compareSync(password, savedHash)) {
      throw new Error("Das neue Passwort konnte nicht verifiziert werden.");
    }
  } finally {
    db.close();
  }

  console.log(`Passwort für ${email} wurde geändert und erfolgreich verifiziert.`);
  console.log("Bestehende Anmeldesitzungen wurden ungültig gemacht.");
}

main().catch((error) => {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
});

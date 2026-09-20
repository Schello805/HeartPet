#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");
const dataDir = String(process.env.HEARTPET_DATA_DIR || "").trim()
  ? path.resolve(process.env.HEARTPET_DATA_DIR)
  : path.join(projectRoot, "data");
const databasePath = path.join(dataDir, "heartpet.sqlite");
const email = String(process.argv[2] || "").trim().toLowerCase();
const portOptionIndex = process.argv.indexOf("--port");
const portValue = portOptionIndex >= 0 ? process.argv[portOptionIndex + 1] : process.env.PORT || 3000;
const port = Number(portValue);

if (!email || !email.includes("@") || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Aufruf: node scripts/check-admin-login.js admin@example.de [--port 3000]");
  process.exit(1);
}

if (!fs.existsSync(databasePath)) {
  console.error(`HeartPet-Datenbank nicht gefunden: ${databasePath}`);
  process.exit(1);
}

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("Die Passwortprüfung benötigt ein interaktives Terminal."));
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
        if (character === "\u0003") return finish(new Error("Abgebrochen."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
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
  const password = await readHidden("Zu prüfendes Passwort: ");
  const db = new Database(databasePath, { readonly: true });
  let user;
  try {
    user = db.prepare(`
      SELECT id, email, password_hash, must_change_password
      FROM users
      WHERE email = ?
    `).get(email);
  } finally {
    db.close();
  }

  console.log(`Datenbank: ${databasePath}`);
  if (!user) {
    console.log(`Konto exakt gefunden: nein (${email})`);
    process.exitCode = 2;
    return;
  }

  const passwordMatches = bcrypt.compareSync(password, user.password_hash);
  console.log(`Konto exakt gefunden: ja (${user.email})`);
  console.log(`Passwort-Hash stimmt: ${passwordMatches ? "ja" : "nein"}`);
  console.log(`Passwortwechsel erforderlich: ${user.must_change_password ? "ja" : "nein"}`);
  if (!passwordMatches) {
    process.exitCode = 2;
    return;
  }

  const response = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });
  const location = response.headers.get("location") || "";
  const cookieCreated = Boolean(response.headers.get("set-cookie"));
  console.log(`Lokaler Login: HTTP ${response.status}, Ziel ${location || "(keines)"}`);
  console.log(`Sitzung erzeugt: ${cookieCreated ? "ja" : "nein"}`);

  const accepted = response.status === 302 && ["/", "/first-login/password"].includes(location) && cookieCreated;
  if (!accepted) {
    console.log("Ergebnis: Die laufende App lehnt den lokal gültigen Zugang ab. Prüfe Anmeldesperre und HEARTPET_DATA_DIR.");
    process.exitCode = 3;
    return;
  }
  console.log("Ergebnis: Passwort und lokaler Login funktionieren. Der verbleibende Fehler liegt bei Browser-Cookie oder Reverse-Proxy.");
}

main().catch((error) => {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
});

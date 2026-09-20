#!/usr/bin/env node

const { initDatabase } = require("../src/db");
const { createInitialAdmin } = require("../src/initial-admin");

function readOption(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

try {
  const db = initDatabase();
  const result = createInitialAdmin(db, {
    email: readOption("--email"),
    name: readOption("--name", "Administrator"),
    accessMode: readOption("--mode", "lan"),
    appDomain: readOption("--domain"),
  });
  db.close();

  if (!result.created) {
    console.log(`Ein Benutzerkonto (${result.email}) ist bereits vorhanden; der Zugang wurde nicht verändert.`);
  } else {
    console.log("HeartPet-Administrator wurde angelegt.");
    console.log(`E-Mail: ${result.email}`);
    console.log(`Einmalpasswort: ${result.password}`);
    console.log("Dieses Passwort muss beim ersten Login geändert werden.");
  }
} catch (error) {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
}

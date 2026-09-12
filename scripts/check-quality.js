#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const limits = new Map([
  ["src/app.js", 7150],
  ["public/js/app.js", 1700],
]);

for (const directory of ["src/routes", "src/repositories", "src/services", "src/middleware"]) {
  for (const name of fs.readdirSync(path.join(root, directory))) {
    if (name.endsWith(".js")) limits.set(`${directory}/${name}`, 500);
  }
}

const failures = [];
for (const [relativePath, maximum] of limits) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  const lines = content.split(/\r?\n/).length;
  if (lines > maximum) failures.push(`${relativePath}: ${lines} Zeilen, erlaubt sind höchstens ${maximum}`);
}

const systemlogRouter = fs.readFileSync(path.join(root, "src/routes/systemlog.js"), "utf8");
if (/\bdb\.prepare\s*\(/.test(systemlogRouter)) failures.push("src/routes/systemlog.js enthält direkten SQL-Zugriff");

if (failures.length) {
  console.error(`Qualitätsgrenzen verletzt:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Qualitätsgrenzen erfüllt (${limits.size} Dateien geprüft).`);

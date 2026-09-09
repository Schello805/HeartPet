#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appDir = path.resolve(__dirname, "..");
const revisionPath = path.join(appDir, "REVISION");

const current = fs.existsSync(revisionPath)
  ? fs.readFileSync(revisionPath, "utf8").trim()
  : "0.0.0";
const versionMatch = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
const next = versionMatch
  ? `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}`
  : "0.10.1";
fs.writeFileSync(revisionPath, `${next}\n`, "utf8");

const addResult = spawnSync("git", ["add", "REVISION"], {
  cwd: appDir,
  stdio: "inherit",
});

if (addResult.status !== 0) {
  process.exit(addResult.status || 1);
}

console.log(`HeartPet Revision: ${next}`);

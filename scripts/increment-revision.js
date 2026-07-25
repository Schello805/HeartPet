#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appDir = path.resolve(__dirname, "..");
const revisionPath = path.join(appDir, "REVISION");

const current = fs.existsSync(revisionPath)
  ? Number.parseInt(fs.readFileSync(revisionPath, "utf8").trim(), 10)
  : 0;

const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1;
fs.writeFileSync(revisionPath, `${next}\n`, "utf8");

const addResult = spawnSync("git", ["add", "REVISION"], {
  cwd: appDir,
  stdio: "inherit",
});

if (addResult.status !== 0) {
  process.exit(addResult.status || 1);
}

console.log(`HeartPet Revision: ${next}`);

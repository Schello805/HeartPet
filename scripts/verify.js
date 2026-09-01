#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");
const childEnv = { ...process.env };

delete childEnv.NODE_CHANNEL_FD;
delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
delete childEnv.NODE_UNIQUE_ID;
delete childEnv.npm_config_loglevel;
delete childEnv.npm_lifecycle_event;
delete childEnv.npm_lifecycle_script;

const syntaxFiles = ["src", "public/js"]
  .flatMap((directory) => listJavaScriptFiles(path.join(appDir, directory)))
  .map((filePath) => path.relative(appDir, filePath));

const steps = [
  { label: "1/5 Tests", command: "npm", args: ["test"] },
  { label: "2/5 Browser-E2E", command: "npm", args: ["run", "test:e2e"] },
  { label: "3/5 Tierakten-Ansicht", command: "node", args: ["scripts/render-animal-show-check.js"] },
  ...syntaxFiles.map((filePath, index) => ({
    label: `Syntax ${index + 1}/${syntaxFiles.length}: ${filePath}`,
    command: "node",
    args: ["--check", filePath],
  })),
];

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

for (const step of steps) {
  console.log(step.label);
  const result = spawnSync(step.command, step.args, {
    cwd: appDir,
    stdio: "inherit",
    env: childEnv,
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
}

console.log("HeartPet Verify: alles gruen.");

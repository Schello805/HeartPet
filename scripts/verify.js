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

const syntaxFiles = ["src", "public/js", "scripts"]
  .flatMap((directory) => listJavaScriptFiles(path.join(appDir, directory)))
  .map((filePath) => path.relative(appDir, filePath));
const shellFiles = listFilesByExtension(path.join(appDir, "scripts"), ".sh")
  .map((filePath) => path.relative(appDir, filePath));

const steps = [
  { label: "1/7 Qualitätsgrenzen", command: "npm", args: ["run", "check:quality"] },
  { label: "2/7 Tests", command: "npm", args: ["test"] },
  { label: "3/7 Browser-E2E", command: "npm", args: ["run", "test:e2e"] },
  { label: "4/7 Tierakten-Ansicht", command: "node", args: ["scripts/render-animal-show-check.js"] },
  { label: "5/7 Backup-Wiederherstellung", command: "node", args: ["scripts/check-backup-restore.js"] },
  { label: "6/7 Shell-Syntax", command: "bash", args: ["-n", ...shellFiles] },
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

function listFilesByExtension(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listFilesByExtension(entryPath, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
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

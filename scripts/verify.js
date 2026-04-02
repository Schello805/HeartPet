#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");
const childEnv = { ...process.env };

delete childEnv.NODE_CHANNEL_FD;
delete childEnv.NODE_CHANNEL_SERIALIZATION_MODE;
delete childEnv.NODE_UNIQUE_ID;
delete childEnv.npm_config_loglevel;
delete childEnv.npm_lifecycle_event;
delete childEnv.npm_lifecycle_script;

const steps = [
  { label: "1/5 Tests", command: "node", args: ["--test", "tests/app-routes.test.js"] },
  { label: "2/5 Browser-E2E", command: "npx", args: ["playwright", "test"] },
  { label: "3/5 Tierakten-Ansicht", command: "node", args: ["scripts/render-animal-show-check.js"] },
  { label: "4/5 Syntax src/app.js", command: "node", args: ["--check", "src/app.js"] },
  { label: "5/5 Syntax public/js/app.js", command: "node", args: ["--check", "public/js/app.js"] },
];

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

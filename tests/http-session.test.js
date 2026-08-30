const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveSessionSecret } = require("../src/http-session");

test("Session-Geheimnis wird installationsbezogen erzeugt und dauerhaft wiederverwendet", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-session-"));
  const previous = process.env.HEARTPET_SESSION_SECRET;
  delete process.env.HEARTPET_SESSION_SECRET;
  try {
    const first = resolveSessionSecret(directory);
    const second = resolveSessionSecret(directory);
    assert.equal(first, second);
    assert.ok(first.length >= 48);
    assert.equal(fs.statSync(path.join(directory, ".session-secret")).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.HEARTPET_SESSION_SECRET;
    else process.env.HEARTPET_SESSION_SECRET = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

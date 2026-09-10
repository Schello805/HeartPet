const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveStoredFilePath } = require("../src/storage-paths");

test("Gespeicherte Dateien können das Upload-Verzeichnis nicht verlassen", () => {
  const uploadsDir = path.resolve("/tmp/heartpet-uploads");
  assert.equal(resolveStoredFilePath(uploadsDir, "datei.pdf"), path.join(uploadsDir, "datei.pdf"));
  assert.equal(resolveStoredFilePath(uploadsDir, "../heartpet.sqlite"), null);
  assert.equal(resolveStoredFilePath(uploadsDir, "/etc/passwd"), null);
  assert.equal(resolveStoredFilePath(uploadsDir, "unterordner/datei.pdf"), null);
  assert.equal(resolveStoredFilePath(uploadsDir, ""), null);
});

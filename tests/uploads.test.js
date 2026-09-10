const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { createStoredUploadName, createUploadMiddleware, normalizeMimeType } = require("../src/uploads");

test("Uploads erhalten eine serverseitig festgelegte, nicht ausführbare Dateiendung", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-upload-"));
  const app = express();
  const upload = createUploadMiddleware(dataDir);
  app.post("/upload", upload.single("document"), (req, res) => res.json({ filename: req.file?.filename }));

  try {
    const response = await request(app)
      .post("/upload")
      .attach("document", Buffer.from("<script>alert(1)</script>"), { filename: "angriff.html", contentType: "image/jpeg" });

    assert.equal(response.status, 200);
    assert.match(response.body.filename, /^[0-9a-f-]+\.jpg$/);
    assert.doesNotMatch(response.body.filename, /angriff|\.html/i);
    assert.equal(fs.existsSync(path.join(dataDir, "uploads", response.body.filename)), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MIME-Typen werden ohne optionale Parameter verglichen", () => {
  assert.equal(normalizeMimeType("Image/JPEG; charset=binary"), "image/jpeg");
  assert.match(createStoredUploadName("text/html"), /^[0-9a-f-]+\.bin$/);
});

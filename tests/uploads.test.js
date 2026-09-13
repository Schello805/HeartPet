const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const sharp = require("sharp");
const { createStoredUploadName, createUploadMiddleware, normalizeMimeType } = require("../src/uploads");
const { optimizeAnimalImageUpload } = require("../src/services/image-optimizer");

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

test("Tierbilder werden fuer die Web-App verkleinert und als WebP gespeichert", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartpet-image-"));
  const uploadPath = path.join(dataDir, "tierfoto.jpg");

  try {
    await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        background: { r: 48, g: 96, b: 128 },
      },
    }).jpeg({ quality: 95 }).toFile(uploadPath);

    const file = {
      filename: "tierfoto.jpg",
      path: uploadPath,
      mimetype: "image/jpeg",
      size: fs.statSync(uploadPath).size,
    };

    const result = await optimizeAnimalImageUpload(file, { maxEdge: 800, quality: 80 });
    const metadata = await sharp(file.path).metadata();

    assert.equal(result.optimized, true);
    assert.equal(file.filename, "tierfoto.webp");
    assert.equal(file.mimetype, "image/webp");
    assert.equal(fs.existsSync(uploadPath), false);
    assert.equal(path.extname(file.path), ".webp");
    assert.equal(Math.max(metadata.width, metadata.height), 800);
    assert.equal(file.size, fs.statSync(file.path).size);
    assert.ok(file.size < result.originalSize);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

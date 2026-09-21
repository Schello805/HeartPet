const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const sharp = require("sharp");
const { buildWebAppManifest, createAppIconPng } = require("../src/services/app-icons");

test("Web-App-Manifest verwendet App-Namen und installierbare Icon-Größen", () => {
  const manifest = buildWebAppManifest({ app_name: "Danielas Tiere" }, "logo-123");
  assert.equal(manifest.name, "Danielas Tiere");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.ok(manifest.icons.every((icon) => icon.src.includes("logo-123")));
});

test("App-Icons werden aus dem Logo in den benötigten PNG-Größen erzeugt", async () => {
  const logoPath = path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  for (const size of [32, 180, 192, 512]) {
    const buffer = await createAppIconPng(logoPath, size);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }
});

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { initDatabase } = require("../src/db");
const { optimizeImageFile } = require("../src/services/image-optimizer");
const { resolveStoredFilePath } = require("../src/storage-paths");

const projectRoot = path.join(__dirname, "..");
const dataDir = path.resolve(process.env.HEARTPET_DATA_DIR || path.join(projectRoot, "data"));
const uploadsDir = path.join(dataDir, "uploads");
const apply = process.argv.includes("--apply");

async function main() {
  const db = initDatabase();
  const references = collectAnimalImageReferences(db);
  let candidates = 0;
  let optimized = 0;
  let beforeBytes = 0;
  let afterBytes = 0;

  for (const [storedName, reference] of references.entries()) {
    const filePath = resolveStoredFilePath(uploadsDir, storedName);
    if (!filePath || !fs.existsSync(filePath)) {
      console.warn(`Fehlt: ${storedName}`);
      continue;
    }

    const size = fs.statSync(filePath).size;
    const metadata = await sharp(filePath, { failOn: "none" }).metadata();
    const maxEdge = Math.max(Number(metadata.width || 0), Number(metadata.height || 0));
    if (size < 512 * 1024 && maxEdge <= 1600) {
      continue;
    }

    candidates += 1;
    beforeBytes += size;

    if (!apply) {
      console.log(`Kandidat: ${storedName} (${formatBytes(size)}, ${metadata.width || "?"}x${metadata.height || "?"})`);
      continue;
    }

    const result = await optimizeImageFile({
      sourcePath: filePath,
      filename: storedName,
      mimeType: reference.mimeType || `image/${String(metadata.format || "").toLowerCase()}`,
    });

    if (!result.optimized) {
      console.log(`Uebersprungen: ${storedName} (${result.reason})`);
      continue;
    }

    updateReferences(db, storedName, result);
    optimized += 1;
    afterBytes += result.optimizedSize;
    console.log(`Optimiert: ${storedName} -> ${result.filename} (${formatBytes(result.originalSize)} -> ${formatBytes(result.optimizedSize)})`);
  }

  if (!apply) {
    console.log(`${candidates} Tierbild(er) koennen wahrscheinlich optimiert werden. Mit --apply anwenden.`);
  } else {
    console.log(`${optimized}/${candidates} Tierbild(er) optimiert. Ersparnis: ${formatBytes(beforeBytes - afterBytes)}.`);
  }
}

function collectAnimalImageReferences(db) {
  const references = new Map();
  for (const animal of db.prepare(`
    SELECT id, profile_image_stored_name AS stored_name, profile_image_mime_type AS mime_type
    FROM animals
    WHERE profile_image_stored_name IS NOT NULL AND profile_image_stored_name != ''
  `).all()) {
    const ref = getReference(references, animal.stored_name, animal.mime_type);
    ref.profileAnimalIds.push(animal.id);
  }

  for (const image of db.prepare(`
    SELECT id, stored_name, mime_type
    FROM animal_images
    WHERE stored_name IS NOT NULL AND stored_name != ''
  `).all()) {
    const ref = getReference(references, image.stored_name, image.mime_type);
    ref.galleryImageIds.push(image.id);
  }

  return references;
}

function getReference(references, storedName, mimeType) {
  const existing = references.get(storedName);
  if (existing) return existing;
  const next = { mimeType, profileAnimalIds: [], galleryImageIds: [] };
  references.set(storedName, next);
  return next;
}

function updateReferences(db, previousName, result) {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE animals
      SET profile_image_stored_name = ?, profile_image_mime_type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE profile_image_stored_name = ?
    `).run(result.filename, result.mimeType, previousName);
    db.prepare(`
      UPDATE animal_images
      SET stored_name = ?, mime_type = ?, file_size = ?
      WHERE stored_name = ?
    `).run(result.filename, result.mimeType, result.optimizedSize, previousName);
  });
  tx();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

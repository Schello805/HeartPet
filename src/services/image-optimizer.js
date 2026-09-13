const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_WEBP_QUALITY = 82;

async function optimizeAnimalImageUpload(file, options = {}) {
  if (!isOptimizableImageUpload(file)) {
    return { optimized: false, reason: "not_image" };
  }

  const result = await optimizeImageFile({
    sourcePath: file.path,
    filename: file.filename,
    mimeType: file.mimetype,
    ...options,
  });
  if (!result.optimized) {
    return result;
  }

  file.filename = result.filename;
  file.path = result.filePath;
  file.mimetype = result.mimeType;
  file.size = result.optimizedSize;

  return result;
}

async function optimizeImageFile({ sourcePath, filename, mimeType, maxEdge = DEFAULT_MAX_EDGE, quality = DEFAULT_WEBP_QUALITY } = {}) {
  if (!sourcePath || !filename || !String(mimeType || "").toLowerCase().startsWith("image/") || !fs.existsSync(sourcePath)) {
    return { optimized: false, reason: "not_image" };
  }

  const resolvedMaxEdge = Number(maxEdge || DEFAULT_MAX_EDGE);
  const resolvedQuality = Number(quality || DEFAULT_WEBP_QUALITY);
  const { targetPath, targetFilename } = resolveTargetPaths(sourcePath, filename);
  const tempPath = `${targetPath}.tmp`;

  try {
    await sharp(sourcePath, { failOn: "none" })
      .rotate()
      .resize({
        width: resolvedMaxEdge,
        height: resolvedMaxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: resolvedQuality, effort: 4 })
      .toFile(tempPath);

    const originalSize = fs.statSync(sourcePath).size;
    const optimizedSize = fs.statSync(tempPath).size;
    if (optimizedSize >= originalSize) {
      fs.rmSync(tempPath, { force: true });
      return { optimized: false, reason: "not_smaller", originalSize, optimizedSize };
    }

    fs.rmSync(sourcePath, { force: true });
    fs.renameSync(tempPath, targetPath);

    return {
      optimized: true,
      originalSize,
      optimizedSize,
      filename: targetFilename,
      filePath: targetPath,
      mimeType: "image/webp",
    };
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    return { optimized: false, reason: "error", error };
  }
}

function isOptimizableImageUpload(file) {
  return Boolean(
    file?.path
    && file?.filename
    && fs.existsSync(file.path)
    && String(file.mimetype || "").toLowerCase().startsWith("image/")
  );
}

function replaceExtension(value, extension) {
  const parsed = path.parse(String(value || ""));
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function resolveTargetPaths(sourcePath, filename) {
  let targetPath = replaceExtension(sourcePath, ".webp");
  let targetFilename = replaceExtension(filename, ".webp");
  if (!fs.existsSync(targetPath) || path.resolve(targetPath) === path.resolve(sourcePath)) {
    return { targetPath, targetFilename };
  }

  const suffix = crypto.randomUUID();
  const source = path.parse(sourcePath);
  const stored = path.parse(filename);
  targetPath = path.join(source.dir, `${source.name}-${suffix}.webp`);
  targetFilename = path.join(stored.dir, `${stored.name}-${suffix}.webp`);
  return { targetPath, targetFilename };
}

module.exports = {
  DEFAULT_MAX_EDGE,
  DEFAULT_WEBP_QUALITY,
  optimizeAnimalImageUpload,
  optimizeImageFile,
};

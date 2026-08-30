const fs = require("fs");
const path = require("path");
const multer = require("multer");

function createUploadMiddleware(projectRoot) {
  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const targetDir = path.join(projectRoot, "data", "uploads");
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    },
  });

  const allowedMimeTypes = new Set([
    "image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/csv",
    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  return multer({
    storage: uploadStorage,
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 100 },
    fileFilter: (req, file, cb) => cb(null, allowedMimeTypes.has(String(file.mimetype || "").toLowerCase())),
  });
}

function createImportUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => cb(null, ["application/json", "text/json", "text/plain"].includes(String(file.mimetype || "").toLowerCase())),
  });
}

module.exports = {
  createImportUploadMiddleware,
  createUploadMiddleware,
};

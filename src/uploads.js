const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const allowedUploadTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
]);

function createUploadMiddleware(projectRoot) {
  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const targetDir = path.join(projectRoot, "data", "uploads");
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const extension = allowedUploadTypes.get(normalizeMimeType(file.mimetype));
      cb(null, `${crypto.randomUUID()}${extension || ".bin"}`);
    },
  });

  return multer({
    storage: uploadStorage,
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 100 },
    fileFilter: (req, file, cb) => cb(null, allowedUploadTypes.has(normalizeMimeType(file.mimetype))),
  });
}

function createImportUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => cb(null, ["application/json", "text/json", "text/plain"].includes(normalizeMimeType(file.mimetype))),
  });
}

function normalizeMimeType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

module.exports = {
  createImportUploadMiddleware,
  createUploadMiddleware,
  normalizeMimeType,
};

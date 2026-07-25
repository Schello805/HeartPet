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

  return multer({ storage: uploadStorage });
}

function createImportUploadMiddleware() {
  return multer({ storage: multer.memoryStorage() });
}

module.exports = {
  createImportUploadMiddleware,
  createUploadMiddleware,
};

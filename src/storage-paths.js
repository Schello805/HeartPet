const path = require("node:path");

function resolveStoredFilePath(directory, storedName) {
  const root = path.resolve(String(directory || ""));
  const fileName = String(storedName || "").trim();
  if (!fileName || fileName !== path.basename(fileName) || fileName === "." || fileName === "..") {
    return null;
  }

  const fullPath = path.resolve(root, fileName);
  return path.dirname(fullPath) === root ? fullPath : null;
}

module.exports = { resolveStoredFilePath };

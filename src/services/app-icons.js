const sharp = require("sharp");

const APP_ICON_SIZES = new Set([32, 180, 192, 512]);
const ICON_BACKGROUND = { r: 242, g: 250, b: 246, alpha: 1 };

function buildWebAppManifest(settings = {}, version = "dev") {
  const name = String(settings.app_name || "HeartPet").trim() || "HeartPet";
  const iconVersion = encodeURIComponent(String(version || "dev"));
  return {
    id: "/",
    name,
    short_name: name.slice(0, 24),
    description: `${name} bündelt Tierakten, Dokumente und Erinnerungen.`,
    lang: "de",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f2faf6",
    theme_color: "#e6f6f6",
    icons: [
      { src: `/app-icon/192.png?v=${iconVersion}`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/app-icon/512.png?v=${iconVersion}`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}

async function createAppIconPng(sourcePath, size) {
  const resolvedSize = Number(size);
  if (!APP_ICON_SIZES.has(resolvedSize)) {
    throw new Error("Nicht unterstützte App-Icon-Größe.");
  }

  return sharp(sourcePath, { failOn: "none" })
    .rotate()
    .resize(resolvedSize, resolvedSize, {
      fit: "contain",
      background: ICON_BACKGROUND,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

module.exports = {
  APP_ICON_SIZES,
  buildWebAppManifest,
  createAppIconPng,
};

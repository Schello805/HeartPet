function normalizeAppBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    if (url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function resolveAppBaseUrl(settings, { configuredUrl = process.env.HEARTPET_APP_URL, fallbackUrl = "" } = {}) {
  return normalizeAppBaseUrl(settings?.app_domain)
    || normalizeAppBaseUrl(configuredUrl)
    || normalizeAppBaseUrl(fallbackUrl);
}

module.exports = {
  normalizeAppBaseUrl,
  resolveAppBaseUrl,
};

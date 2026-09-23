const DEFAULT_REVISION_URL = "https://raw.githubusercontent.com/Schello805/HeartPet/main/REVISION";

function normalizeRevision(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number).join(".") : "";
}

function compareRevisions(left, right) {
  const leftParts = normalizeRevision(left).split(".").map(Number);
  const rightParts = normalizeRevision(right).split(".").map(Number);
  if (leftParts.length !== 3 || rightParts.length !== 3) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function createUpdateChecker({
  currentRevision,
  revisionUrl = process.env.HEARTPET_UPDATE_REVISION_URL || DEFAULT_REVISION_URL,
  fetchImpl = global.fetch,
  cacheTtlMs = 6 * 60 * 60 * 1000,
  timeoutMs = 3_000,
  disabled = process.env.NODE_ENV === "test" && !process.env.HEARTPET_UPDATE_REVISION_URL,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let pending = null;

  async function fetchStatus() {
    const checkedAt = new Date(now()).toISOString();
    if (disabled || typeof fetchImpl !== "function") {
      return { checked: false, updateAvailable: false, currentRevision, latestRevision: currentRevision, checkedAt };
    }

    try {
      const response = await fetchImpl(revisionUrl, {
        headers: { Accept: "text/plain", "User-Agent": "HeartPet-Update-Check" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const latestRevision = normalizeRevision((await response.text()).slice(0, 32));
      const normalizedCurrent = normalizeRevision(currentRevision);
      if (!latestRevision || !normalizedCurrent) throw new Error("Ungültige Revision");
      return {
        checked: true,
        updateAvailable: compareRevisions(latestRevision, normalizedCurrent) > 0,
        currentRevision: normalizedCurrent,
        latestRevision,
        checkedAt,
      };
    } catch {
      return { checked: false, updateAvailable: false, currentRevision, latestRevision: "", checkedAt };
    }
  }

  async function check() {
    if (cached && now() - cached.cachedAt < cacheTtlMs) return cached.value;
    if (pending) return pending;
    pending = fetchStatus().then((value) => {
      cached = { value, cachedAt: now() };
      pending = null;
      return value;
    });
    return pending;
  }

  return { check };
}

module.exports = { DEFAULT_REVISION_URL, compareRevisions, createUpdateChecker, normalizeRevision };

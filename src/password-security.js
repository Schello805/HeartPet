const crypto = require("node:crypto");

const PWNED_PASSWORDS_RANGE_URL = "https://api.pwnedpasswords.com/range";

async function getPwnedPasswordCount(password, options = {}) {
  const value = String(password || "");
  const hash = crypto.createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${PWNED_PASSWORDS_RANGE_URL}/${prefix}`, {
      headers: {
        "Add-Padding": "true",
        "User-Agent": "HeartPet password security check",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const matchingLine = String(await response.text())
      .split(/\r?\n/)
      .find((line) => line.toUpperCase().startsWith(`${suffix}:`));
    if (!matchingLine) return 0;
    return Number.parseInt(matchingLine.split(":")[1], 10) || 0;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateNewPassword(password, options = {}) {
  const value = String(password || "");
  if (value.length < 8) return "Das Passwort muss mindestens 8 Zeichen lang sein.";
  if (process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK === "true") return "";

  try {
    const count = await getPwnedPasswordCount(value, options);
    if (count > 0) {
      return "Dieses Passwort ist aus bekannten Datenlecks bekannt. Bitte wähle ein anderes Passwort.";
    }
    return "";
  } catch (error) {
    console.warn(`[HeartPet][Passwortprüfung] Have I Been Pwned ist nicht erreichbar: ${error.message}`);
    return "Die sichere Passwortprüfung ist gerade nicht erreichbar. Bitte versuche es später erneut.";
  }
}

module.exports = { getPwnedPasswordCount, validateNewPassword };

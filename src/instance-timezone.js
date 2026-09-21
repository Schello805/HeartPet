const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const COMMON_TIME_ZONES = [
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function isValidTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function getSystemTimeZone() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";
  return isValidTimeZone(detected) ? detected : "UTC";
}

function resolveInstanceTimeZone(settings = {}) {
  const configured = String(settings.instance_timezone || "").trim();
  return isValidTimeZone(configured) ? configured : getSystemTimeZone();
}

function getInstanceDateTime(settings = {}, value) {
  const dateTime = value === undefined ? dayjs() : dayjs(value);
  return dateTime.tz(resolveInstanceTimeZone(settings));
}

function listTimeZones(supportedValuesOf = Intl.supportedValuesOf) {
  let supported = [];
  if (typeof supportedValuesOf === "function") {
    try {
      supported = supportedValuesOf("timeZone");
    } catch {
      supported = [];
    }
  }

  return [
    "UTC",
    ...[...new Set([...COMMON_TIME_ZONES, ...supported])]
      .filter((value) => value !== "UTC" && isValidTimeZone(value)),
  ];
}

module.exports = {
  getInstanceDateTime,
  getSystemTimeZone,
  isValidTimeZone,
  listTimeZones,
  resolveInstanceTimeZone,
};

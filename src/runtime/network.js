const os = require("os");

function resolveBindHost(value) {
  const host = String(value || "").trim();
  return host || "0.0.0.0";
}

function listLocalAccessUrls({ port, bindHost = "0.0.0.0", interfaces = os.networkInterfaces() } = {}) {
  const normalizedPort = Number(port || 3000);
  const host = resolveBindHost(bindHost);
  if (!isWildcardHost(host)) {
    return [`http://${formatUrlHost(host)}:${normalizedPort}`];
  }

  const addresses = collectPrivateIpv4Addresses(interfaces);
  const urls = [`http://127.0.0.1:${normalizedPort}`];
  for (const address of addresses) {
    urls.push(`http://${address}:${normalizedPort}`);
  }
  return [...new Set(urls)];
}

function getDefaultAppBaseUrl(options = {}) {
  return listLocalAccessUrls(options)[0] || "http://127.0.0.1:3000";
}

function isWildcardHost(host) {
  return ["", "0.0.0.0", "::", "[::]"].includes(String(host || "").trim());
}

function collectPrivateIpv4Addresses(interfaces) {
  const addresses = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family !== "IPv4" || entry.internal) continue;
      if (isPrivateIpv4(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function formatUrlHost(host) {
  const value = String(host || "").trim();
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

module.exports = {
  collectPrivateIpv4Addresses,
  getDefaultAppBaseUrl,
  isPrivateIpv4,
  listLocalAccessUrls,
  resolveBindHost,
};

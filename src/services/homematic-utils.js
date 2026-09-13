function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isRtspUrl(value) {
  try {
    return new URL(String(value || "").trim()).protocol === "rtsp:";
  } catch {
    return false;
  }
}

function isCameraUrl(value) {
  return isHttpUrl(value) || isRtspUrl(value);
}

function normalizeConfiguredUrl(value) {
  const input = String(value || "").trim().replace(/\\([_?&=])/g, "$1");
  if (isHttpUrl(input)) return input;
  const match = input.match(/https?:\/\/[^\s\])]+/i);
  return match && isHttpUrl(match[0]) ? match[0] : input;
}

function buildHomematicClimateUrl(value, token) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return normalizedUrl;
  const url = new URL(normalizedUrl);
  const normalizedToken = String(token || "").trim();
  if (normalizedToken && !url.searchParams.has("sid")) url.searchParams.set("sid", normalizedToken);
  return url.toString().replace(/%2C/gi, ",");
}

function buildHomematicCommandUrl(value, token) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return normalizedUrl;
  const url = new URL(normalizedUrl);
  const normalizedToken = String(token || "").trim();
  const currentSid = String(url.searchParams.get("sid") || "").trim();
  const sidIsPlaceholder = !currentSid || /^(?:@.*@|\[.*\]|.*DEINE.*)$/i.test(currentSid);
  if (normalizedToken && sidIsPlaceholder) url.searchParams.set("sid", normalizedToken);
  if (/\/statechange\.cgi$/i.test(url.pathname) && !url.searchParams.has("new_value") && url.searchParams.has("value")) {
    url.searchParams.set("new_value", url.searchParams.get("value"));
    url.searchParams.delete("value");
  }
  return url.toString();
}

function parseHomematicStateChange(value) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return null;
  const url = new URL(normalizedUrl);
  const iseId = String(url.searchParams.get("ise_id") || "").trim();
  const newValue = String(url.searchParams.get("new_value") || url.searchParams.get("value") || "").trim();
  if (!/^\d+$/.test(iseId) || !/^-?\d+(?:\.\d+)?$/.test(newValue)) return null;
  return { iseId, newValue };
}

function normalizeHomematicXmlApiToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalizedUrl = normalizeConfiguredUrl(raw);
  if (isHttpUrl(normalizedUrl)) return String(new URL(normalizedUrl).searchParams.get("sid") || "").trim();
  return raw.replace(/^[?&]?sid=/i, "").trim();
}

function getHomematicXmlApiConfig(settings) {
  const configured = normalizeConfiguredUrl(settings?.homematic_ccu_url);
  if (!isHttpUrl(configured)) return null;
  const url = new URL(configured);
  const configuredPath = url.pathname.match(/\/(?:addons|config)\/xmlapi\/?/i)?.[0];
  const basePath = (configuredPath || "/addons/xmlapi/").replace(/\/?$/, "/");
  const token = normalizeHomematicXmlApiToken(url.searchParams.get("sid") || settings?.homematic_xmlapi_token);
  return { url, basePath, token };
}

function buildHomematicXmlApiUrl(settings, endpoint, params = {}) {
  const config = getHomematicXmlApiConfig(settings);
  if (!config || !config.token) return "";
  const url = new URL(config.url.origin);
  url.pathname = `${config.basePath}${endpoint}`;
  url.searchParams.set("sid", config.token);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url.toString().replace(/%2C/gi, ",");
}

function getHomematicApiUrl(settings) {
  const configured = normalizeConfiguredUrl(settings?.homematic_ccu_url);
  if (isHttpUrl(configured)) {
    const url = new URL(configured);
    if (!/\/api\/homematic\.cgi$/i.test(url.pathname)) url.pathname = "/api/homematic.cgi";
    return url.toString();
  }
  const source = normalizeConfiguredUrl(settings?.homematic_climate_url || settings?.homematic_door_open_url);
  if (!isHttpUrl(source)) return "";
  const url = new URL(source);
  url.pathname = "/api/homematic.cgi";
  url.search = "";
  return url.toString();
}

function getHomematicClimateDatapointIds(settings) {
  const temperatureId = String(settings?.homematic_temperature_datapoint_id || settings?.homematic_climate_channel_id || "").trim();
  const humidityId = String(settings?.homematic_humidity_datapoint_id || "").trim();
  if (!/^\d+$/.test(temperatureId) || !/^\d+$/.test(humidityId)) return null;
  return { temperatureId, humidityId };
}

function getHomematicDoorCommand(settings, open) {
  const directionalKey = open ? "homematic_door_open_datapoint_id" : "homematic_door_close_datapoint_id";
  const datapointId = String(settings?.[directionalKey] || settings?.homematic_door_command_datapoint_id || "").trim();
  const configuredValue = String((open ? settings?.homematic_door_open_value : settings?.homematic_door_close_value) || "").trim();
  const value = configuredValue || (open ? "0.0" : "1.0");
  if (/^\d+$/.test(datapointId) && /^-?\d+(?:[.,]\d+)?$/.test(value)) {
    const config = getHomematicXmlApiConfig(settings);
    if (!config) return "";
    const url = new URL(config.url.origin);
    url.pathname = `${config.basePath}statechange.cgi`;
    url.searchParams.set("ise_id", datapointId);
    url.searchParams.set("new_value", value.replace(",", "."));
    return url.toString();
  }
  return normalizeConfiguredUrl(open ? settings?.homematic_door_open_url : settings?.homematic_door_close_url);
}

function getHomematicDoorCommandSequence(settings, open) {
  const targetCommand = getHomematicDoorCommand(settings, open);
  const oppositeCommand = getHomematicDoorCommand(settings, !open);
  const targetState = parseHomematicStateChange(targetCommand);
  const oppositeState = parseHomematicStateChange(oppositeCommand);
  if (!targetState || !oppositeState || targetState.iseId === oppositeState.iseId) return [targetCommand].filter(Boolean);
  if (Number(targetState.newValue) !== 1 || Number(oppositeState.newValue) !== 1) return [targetCommand].filter(Boolean);
  const resetUrl = new URL(oppositeCommand);
  resetUrl.searchParams.set("new_value", "0.0");
  return [resetUrl.toString(), targetCommand];
}

function parseHomematicDatapoints(xml) {
  const readAttributes = (tag) => Object.fromEntries(Array.from(String(tag).matchAll(/([\w:-]+)=["']([^"']*)["']/g), (match) => [match[1], match[2]]));
  const results = [];
  for (const deviceMatch of String(xml || "").matchAll(/<device\b([^>]*)>([\s\S]*?)<\/device>/gi)) {
    const device = readAttributes(deviceMatch[1]);
    for (const channelMatch of deviceMatch[2].matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi)) {
      const channel = readAttributes(channelMatch[1]);
      for (const datapointMatch of channelMatch[2].matchAll(/<datapoint\b([^>]*)\/?\s*>/gi)) {
        const datapoint = readAttributes(datapointMatch[1]);
        const operations = Number.parseInt(datapoint.operations || "0", 10);
        if (!/^\d+$/.test(datapoint.ise_id || "")) continue;
        results.push({
          id: datapoint.ise_id,
          device: device.name || "Unbenanntes Gerät",
          channel: channel.name || "Unbenannter Kanal",
          name: datapoint.name || datapoint.type || "Datenpunkt",
          type: datapoint.type || "",
          value: datapoint.value || "",
          writable: (operations & 2) === 2,
        });
      }
    }
  }
  return results.sort((left, right) => `${left.device} ${left.channel} ${left.type}`.localeCompare(`${right.device} ${right.channel} ${right.type}`, "de"));
}

function parseWritableHomematicDatapoints(xml) {
  return parseHomematicDatapoints(xml).filter((datapoint) => datapoint.writable);
}

function decodeHomematicXmlBuffer(buffer, contentType = "") {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const declaration = new TextDecoder("ascii").decode(bytes.slice(0, 180));
  const declaredEncoding = `${contentType} ${declaration}`.match(/charset\s*=\s*["']?([^\s;"']+)|encoding\s*=\s*["']([^"']+)/i);
  const encoding = String(declaredEncoding?.[1] || declaredEncoding?.[2] || "utf-8").toLowerCase();
  const decoderEncoding = /^(?:iso-8859-1|latin-?1)$/i.test(encoding) ? "windows-1252" : encoding;
  try {
    return new TextDecoder(decoderEncoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function findHomematicValue(value, preferredKeys) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = value.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value);
  for (const preferredKey of preferredKeys) {
    const match = entries.find(([key]) => key.toLowerCase().includes(preferredKey));
    const result = match ? findHomematicValue(match[1], preferredKeys) : null;
    if (result !== null) return result;
  }
  const genericValue = entries.find(([key]) => ["value", "val", "wert"].includes(key.toLowerCase()));
  if (genericValue) return findHomematicValue(genericValue[1], preferredKeys);
  for (const [, nested] of entries.filter(([, item]) => item && typeof item === "object")) {
    const result = findHomematicValue(nested, preferredKeys);
    if (result !== null) return result;
  }
  return null;
}

function findHomematicXmlDatapoint(xml, preferredKeys) {
  const tags = String(xml || "").match(/<datapoint\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = {};
    tag.replace(/([\w:-]+)\s*=\s*["']([^"']*)["']/g, (match, key, value) => {
      attributes[key.toLowerCase()] = value;
      return match;
    });
    const descriptor = [attributes.name, attributes.type, attributes.paramset_key].filter(Boolean).join(" ").toLowerCase();
    if (!preferredKeys.some((key) => descriptor.includes(key))) continue;
    const parsed = Number(String(attributes.value || "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseHomematicTextValue(text, preferredKeys) {
  const normalized = String(text || "").replace(/,/g, ".");
  const datapointValue = findHomematicXmlDatapoint(normalized, preferredKeys);
  if (datapointValue !== null) return datapointValue;
  const escapedKeys = preferredKeys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const namedMatch = normalized.match(new RegExp(`(?:${escapedKeys.join("|")})[^-\\d]{0,40}(-?\\d+(?:\\.\\d+)?)`, "i"));
  if (namedMatch) return Number(namedMatch[1]);
  const valueAttribute = normalized.match(/\b(?:value|val|wert)\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i);
  if (valueAttribute) return Number(valueAttribute[1]);
  const plainNumber = normalized.trim().match(/^-?\d+(?:\.\d+)?$/);
  return plainNumber ? Number(plainNumber[0]) : null;
}

function getHomematicCommandResponseError(text) {
  const responseText = String(text || "");
  if (/<not_authenticated\b/i.test(responseText)) return "XML-API-Token ist ungültig oder fehlt.";
  if (/<not_found\s*\/>/i.test(responseText)) return "Der Tür-Datenpunkt wurde auf der CCU nicht gefunden. Bitte die ise_id prüfen.";
  if (/<changed\b[^>]*\bsuccess=["']false["']/i.test(responseText)) return "Die CCU hat den Tür-Datenpunkt gefunden, den Schaltwert aber abgelehnt.";
  if (/\berror=["']true["']/i.test(responseText)) return "Datenpunkt wurde von der XML-API nicht gefunden.";
  if (/<result>\s*<\/result>/i.test(responseText)) return "Die CCU hat keine Bestätigung für den Türbefehl geliefert.";
  return "";
}

async function callHomematicJsonRpc(apiUrl, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.1", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CCU antwortet mit HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error.message || `CCU-Fehler ${payload.error.code || "unbekannt"}.`);
    return payload?.result;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildHomematicClimateUrl,
  buildHomematicCommandUrl,
  buildHomematicXmlApiUrl,
  callHomematicJsonRpc,
  decodeHomematicXmlBuffer,
  findHomematicValue,
  findHomematicXmlDatapoint,
  getHomematicApiUrl,
  getHomematicClimateDatapointIds,
  getHomematicCommandResponseError,
  getHomematicDoorCommand,
  getHomematicDoorCommandSequence,
  getHomematicXmlApiConfig,
  isCameraUrl,
  isHttpUrl,
  isRtspUrl,
  normalizeConfiguredUrl,
  normalizeHomematicXmlApiToken,
  parseHomematicDatapoints,
  parseHomematicStateChange,
  parseHomematicTextValue,
  parseWritableHomematicDatapoints,
};

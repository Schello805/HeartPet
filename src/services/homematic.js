const {
  buildHomematicCommandUrl,
  buildHomematicXmlApiUrl,
  decodeHomematicXmlBuffer,
  getHomematicApiUrl,
  getHomematicClimateDatapointIds,
  getHomematicCommandResponseError,
  getHomematicDoorCommand,
  getHomematicDoorCommandSequence,
  getHomematicXmlApiConfig,
  isHttpUrl,
  normalizeConfiguredUrl,
  parseHomematicDatapoints,
  parseHomematicStateChange,
  parseHomematicTextValue,
} = require("./homematic-utils");

function createHomematicService({ callJsonRpc, describeFetchError, fetchWithTimeout, login }) {
  async function readDatapoint(settings, datapointId) {
    const statusUrl = buildHomematicXmlApiUrl(settings, "state.cgi", { datapoint_id: datapointId });
    if (!statusUrl) return null;
    const response = await fetchWithTimeout(statusUrl, 7000);
    if (!response.ok) return null;
    const text = await response.text();
    if (/<not_authenticated\b/i.test(text)) return null;
    const tag = (text.match(new RegExp(`<datapoint\\b[^>]*\\bise_id=["']${datapointId}["'][^>]*>`, "i")) || [])[0] || "";
    const value = tag.match(/\bvalue=["'](true|false|-?\d+(?:[.,]\d+)?)["']/i)?.[1];
    if (value === undefined) return null;
    if (/^true$/i.test(value)) return 1;
    if (/^false$/i.test(value)) return 0;
    return Number(value.replace(",", "."));
  }

  async function waitForDoorSensor(settings, expectedDoorOpen, commandId = "status") {
    const sensorId = String(settings?.homematic_door_sensor_datapoint_id || "").trim();
    if (!/^\d+$/.test(sensorId) || typeof expectedDoorOpen !== "boolean") {
      return { changed: true, sensorConfigured: false, sensorConfirmed: false, sensorValue: null, expectedSensorValue: null, previousSensorValue: null, attempts: 0 };
    }
    const trueMeansOpen = settings?.homematic_door_sensor_true_state !== "closed";
    const expectedValue = expectedDoorOpen === trueMeansOpen ? 1 : 0;
    const previousValue = await readDatapoint(settings, sensorId);
    console.info(`[HeartPet][CCU][door-command][${commandId}] Türsensor ${sensorId}: vorher ${previousValue}, erwartet ${expectedValue}.`);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      const sensorValue = await readDatapoint(settings, sensorId);
      if (attempt === 0 || sensorValue === expectedValue || attempt === 11) {
        console.info(`[HeartPet][CCU][door-command][${commandId}] Türsensor ${sensorId}: Versuch ${attempt + 1}/12, Wert ${sensorValue}.`);
      }
      if (sensorValue === expectedValue) {
        return { changed: previousValue !== expectedValue, sensorConfigured: true, sensorConfirmed: true, sensorValue, expectedSensorValue: expectedValue, previousSensorValue: previousValue, attempts: attempt + 1 };
      }
    }
    const sensorValue = await readDatapoint(settings, sensorId);
    return { changed: false, sensorConfigured: true, sensorConfirmed: false, sensorValue, expectedSensorValue: expectedValue, previousSensorValue: previousValue, attempts: 12 };
  }

  async function resolveSessionId(settings) {
    const token = String(settings?.homematic_xmlapi_token || "").trim();
    if (token) return token;
    return (await login(settings)).sid;
  }

  async function executeCommand(settings, configuredUrl, { expectedDoorOpen = null } = {}) {
    const stateChange = parseHomematicStateChange(configuredUrl);
    const commandId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const xmlApiUrl = stateChange ? buildHomematicXmlApiUrl(settings, "statechange.cgi", {
      ise_id: stateChange.iseId,
      new_value: stateChange.newValue,
    }) : "";
    if (xmlApiUrl) {
      const targetValue = Number(stateChange.newValue);
      console.info(`[HeartPet][CCU][door-command][${commandId}] Sende XML-API-Datenpunkt ${stateChange.iseId} mit Sollwert ${targetValue} über ${new URL(xmlApiUrl).origin}${new URL(xmlApiUrl).pathname}.`);
      const response = await fetchWithTimeout(xmlApiUrl, 5000);
      if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
      const responseText = await response.text();
      console.info(`[HeartPet][CCU][door-command][${commandId}] CCU-Antwort: ${responseText.replace(/\s+/g, " ").trim().slice(0, 500)}`);
      const responseError = getHomematicCommandResponseError(responseText);
      if (responseError) throw new Error(responseError);
      const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
      return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue, ...sensorResult };
    }

    const apiUrl = getHomematicApiUrl(settings);
    if (stateChange && apiUrl && String(settings?.homematic_ccu_username || "").trim()) {
      const session = await login(settings);
      if (!session.ok) throw new Error(`CCU-Anmeldung fehlgeschlagen: ${session.error}`);
      const script = `dom.GetObject(${stateChange.iseId}).State(${stateChange.newValue});`;
      try {
        await callJsonRpc(apiUrl, "ReGa.runScript", { _session_id_: session.sid, script });
      } catch (error) {
        console.error(`[HeartPet][CCU][door-command] Datenpunkt ${stateChange.iseId}, Wert ${stateChange.newValue}: ${error.message}`);
        throw new Error(`CCU-Schaltbefehl fehlgeschlagen: ${error.message}`);
      }
      const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
      return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue: Number(stateChange.newValue), ...sensorResult };
    }

    const commandUrl = buildHomematicCommandUrl(configuredUrl, await resolveSessionId(settings));
    if (!isHttpUrl(commandUrl)) throw new Error("Ungültige Homematic-Befehls-URL.");
    const response = await fetchWithTimeout(commandUrl, 5000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const responseText = await response.text();
    const responseError = getHomematicCommandResponseError(responseText);
    if (responseError) throw new Error(responseError);
    const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
    return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue: stateChange ? Number(stateChange.newValue) : null, ...sensorResult };
  }

  async function executeDoorDirection(settings, open) {
    const commands = getHomematicDoorCommandSequence(settings, open);
    if (!commands.length) throw new Error("Für diese Richtung ist kein gültiger Homematic-Befehl hinterlegt.");
    if (commands.length > 1) {
      const resetState = parseHomematicStateChange(commands[0]);
      console.info(`[HeartPet][CCU][door-direction] Setze Gegenkanal ${resetState?.iseId || "unbekannt"} vor dem ${open ? "Öffnen" : "Schließen"} zurück.`);
      await executeCommand(settings, commands[0]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return executeCommand(settings, commands.at(-1), { expectedDoorOpen: open });
  }

  async function readClimateFromXmlApi(settings, datapointIds) {
    const climateUrl = buildHomematicXmlApiUrl(settings, "state.cgi", { datapoint_id: `${datapointIds.temperatureId},${datapointIds.humidityId}` });
    if (!climateUrl) return { temperature: null, humidity: null, loginOk: false, stage: "configuration", error: "XML-API-Adresse oder Token fehlt." };
    try {
      const response = await fetchWithTimeout(climateUrl, 7000);
      if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
      const text = await response.text();
      if (/<not_authenticated\b/i.test(text)) throw new Error("XML-API-Token ist ungültig oder fehlt.");
      const readValue = (id) => {
        const tag = (text.match(new RegExp(`<datapoint\\b[^>]*\\bise_id=["']${id}["'][^>]*>`, "i")) || [])[0] || "";
        const value = tag.match(/\bvalue=["'](-?\d+(?:[.,]\d+)?)["']/i)?.[1];
        return value === undefined ? null : Number(value.replace(",", "."));
      };
      const temperature = readValue(datapointIds.temperatureId);
      const humidity = readValue(datapointIds.humidityId);
      return { temperature, humidity, loginOk: true, stage: temperature === null && humidity === null ? "parse" : "success", error: temperature === null && humidity === null ? "XML-API erreichbar, aber die angegebenen Datenpunkte wurden nicht gefunden." : "" };
    } catch (error) {
      console.error(`[HeartPet][CCU][xml-api-climate] Datenpunkte ${datapointIds.temperatureId}/${datapointIds.humidityId}: ${error.message}`);
      return { temperature: null, humidity: null, loginOk: false, stage: "climate-read", error: error.message };
    }
  }

  async function readClimate(settings) {
    const datapointIds = getHomematicClimateDatapointIds(settings);
    if (!datapointIds) return { temperature: null, humidity: null, loginOk: false, stage: "configuration", error: "Temperatur- und Luftfeuchte-Datenpunkt müssen hinterlegt sein." };
    if (getHomematicXmlApiConfig(settings)?.token) return readClimateFromXmlApi(settings, datapointIds);
    const session = await login(settings);
    if (!session.ok) return { temperature: null, humidity: null, loginOk: false, stage: "login", error: session.error };
    try {
      const script = `WriteLine("temperature=" # dom.GetObject(${datapointIds.temperatureId}).Value()); WriteLine("humidity=" # dom.GetObject(${datapointIds.humidityId}).Value());`;
      const result = await callJsonRpc(getHomematicApiUrl(settings), "ReGa.runScript", { _session_id_: session.sid, script });
      const text = typeof result === "string" ? result : JSON.stringify(result || "");
      const temperature = parseHomematicTextValue(text, ["actual_temperature", "temperature", "temperatur", "temp"]);
      const humidity = parseHomematicTextValue(text, ["humidity", "luftfeuchte", "feuchte", "hum"]);
      return { temperature, humidity, loginOk: true, stage: temperature === null && humidity === null ? "parse" : "success", error: temperature === null && humidity === null ? "CCU erreichbar, aber im Kanal wurden keine Klima-Werte gefunden." : "" };
    } catch (error) {
      console.error(`[HeartPet][CCU][climate-read] Datenpunkte ${datapointIds.temperatureId}/${datapointIds.humidityId}: ${error.message}`);
      return { temperature: null, humidity: null, loginOk: true, stage: "climate-read", error: error.message };
    }
  }

  async function readClimateUrl(url) {
    const normalizedUrl = normalizeConfiguredUrl(url);
    if (!isHttpUrl(normalizedUrl)) return { temperature: null, humidity: null, error: "Ungültige XML-API-URL." };
    try {
      const response = await fetchWithTimeout(normalizedUrl);
      if (!response.ok) return { temperature: null, humidity: null, error: `XML-API antwortet mit HTTP ${response.status}.` };
      const text = await response.text();
      if (/<not_authenticated\b/i.test(text)) return { temperature: null, humidity: null, error: "XML-API verlangt ein gültiges sid-Token." };
      if (/\berror=["']true["']/i.test(text)) return { temperature: null, humidity: null, error: "Geräte- oder Kanal-ID wurde von der XML-API nicht gefunden." };
      const temperature = parseHomematicTextValue(text, ["actual_temperature", "temperature", "temperatur", "temp"]);
      const humidity = parseHomematicTextValue(text, ["humidity", "luftfeuchte", "feuchte", "hum"]);
      return { temperature, humidity, error: temperature === null && humidity === null ? "XML empfangen, aber keine Datenpunkte für Temperatur oder Luftfeuchte gefunden." : "" };
    } catch (error) {
      return { temperature: null, humidity: null, error: describeFetchError(error) };
    }
  }

  async function discoverDatapoints(settings) {
    const url = buildHomematicXmlApiUrl(settings, "statelist.cgi");
    if (!url) throw new Error("Bitte zuerst XML-API-Adresse und Token speichern.");
    const response = await fetchWithTimeout(url, 15000);
    if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
    const xml = decodeHomematicXmlBuffer(await response.arrayBuffer(), response.headers.get("content-type"));
    if (/<not_authenticated\b/i.test(xml)) throw new Error("XML-API-Token ist ungültig oder fehlt.");
    return parseHomematicDatapoints(xml);
  }

  return {
    discoverDatapoints,
    executeDoorDirection,
    getClimateDatapointIds: getHomematicClimateDatapointIds,
    getDoorCommand: getHomematicDoorCommand,
    getXmlApiConfig: getHomematicXmlApiConfig,
    parseStateChange: parseHomematicStateChange,
    readClimate,
    readClimateUrl,
    readDatapoint,
  };
}

module.exports = { createHomematicService };

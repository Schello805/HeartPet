const { Readable } = require("stream");
const express = require("express");

function createCoopRouter({
  db, getSettingsObject, getHomematicDoorCommand, executeHomematicDoorDirection,
  createAuditLog, parseHomematicStateChange, setFlash, parseCoopCameras, streamRtspCamera,
  fetchCameraStream, redactSensitiveText, cameraFrameCache, readCameraFrameCache,
  captureCameraFrame, writeCameraFrameCache, describeFetchError, buildCameraPlaceholderSvg,
  checkRtspCamera, requireAdmin, readHomematicClimateFromCcu, getHomematicClimateDatapointIds,
  buildHomematicXmlApiUrl, fetchWithTimeout, decodeHomematicXmlBuffer, parseHomematicDatapoints,
}) {
  const router = express.Router();

  router.post("/coop/door/open", async (req, res) => {
    const settings = getSettingsObject(db);
    const command = getHomematicDoorCommand(settings, true);
    console.info(`[HeartPet][CCU][door-open] Bedienung durch Benutzer ${req.user?.id || "unbekannt"} angefordert.`);
    if (!command) {
      setFlash(req, "error", "Für die Stalltür ist noch kein gültiger Homematic-Befehl hinterlegt.");
      return res.redirect("/#coop-control");
    }
  
    try {
      const result = await executeHomematicDoorDirection(settings, true);
      createAuditLog(req, "coop.door_open", result, { entityType: "coop" });
      if (result.sensorConfigured && !result.sensorConfirmed) {
        setFlash(req, "error", "Der Öffnungsbefehl wurde von der CCU angenommen, der Türsensor hat die offene Endlage aber nicht bestätigt.");
      } else {
        setFlash(req, "success", result.changed === false
          ? "Der Öffnungsbefehl wurde gesendet. Der Türsensor meldete bereits offen."
          : "Die offene Endlage wurde vom Türsensor bestätigt.");
      }
    } catch (error) {
      console.error(`[HeartPet][CCU][door-open] Fehlgeschlagen: ${error.message}`);
      createAuditLog(req, "coop.door_open_failed", {
        error: error.message,
        state_change: parseHomematicStateChange(command),
      }, { entityType: "coop" });
      setFlash(req, "error", `Die Stalltür konnte nicht geöffnet werden: ${error.message}`);
    }
    return res.redirect("/#coop-control");
  });
  
  router.post("/coop/door/close", async (req, res) => {
    const settings = getSettingsObject(db);
    const command = getHomematicDoorCommand(settings, false);
    console.info(`[HeartPet][CCU][door-close] Bedienung durch Benutzer ${req.user?.id || "unbekannt"} angefordert.`);
    if (!command) {
      setFlash(req, "error", "Für das Schließen der Stalltür ist noch kein gültiger Homematic-Befehl hinterlegt.");
      return res.redirect("/#coop-control");
    }
  
    try {
      const result = await executeHomematicDoorDirection(settings, false);
      createAuditLog(req, "coop.door_close", result, { entityType: "coop" });
      if (result.sensorConfigured && !result.sensorConfirmed) {
        setFlash(req, "error", "Der Schließbefehl wurde von der CCU angenommen, der Türsensor hat die geschlossene Endlage aber nicht bestätigt.");
      } else {
        setFlash(req, "success", result.changed === false
          ? "Der Schließbefehl wurde gesendet. Der Türsensor meldete bereits geschlossen."
          : "Die geschlossene Endlage wurde vom Türsensor bestätigt.");
      }
    } catch (error) {
      console.error(`[HeartPet][CCU][door-close] Fehlgeschlagen: ${error.message}`);
      createAuditLog(req, "coop.door_close_failed", {
        error: error.message,
        state_change: parseHomematicStateChange(command),
      }, { entityType: "coop" });
      setFlash(req, "error", `Die Stalltür konnte nicht geschlossen werden: ${error.message}`);
    }
    return res.redirect("/#coop-control");
  });
  
  router.get("/coop/cameras/:index/stream", async (req, res) => {
    const cameras = parseCoopCameras(getSettingsObject(db).coop_camera_streams);
    const camera = cameras[Number.parseInt(req.params.index, 10)];
    if (!camera) return res.sendStatus(404);
  
    if (camera.protocol === "rtsp") {
      return streamRtspCamera(camera, req, res);
    }
  
    try {
      const response = await fetchCameraStream(camera.streamUrl);
      if (!response.ok || !response.body) {
        console.error(`[HeartPet] Kamera „${camera.name}“ antwortet mit HTTP ${response.status}.`);
        return res.sendStatus(502);
      }
      res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
      res.set("Cache-Control", "no-store");
      return Readable.fromWeb(response.body).pipe(res);
    } catch (error) {
      console.error(`[HeartPet] Kamera „${camera.name}“ nicht erreichbar:`, redactSensitiveText(error.message));
      return res.sendStatus(502);
    }
  });
  
  router.get("/coop/cameras/:index/frame", async (req, res) => {
    const cameraIndex = Number.parseInt(req.params.index, 10);
    const cameras = parseCoopCameras(getSettingsObject(db).coop_camera_streams);
    const camera = cameras[cameraIndex];
    if (!camera) return res.sendStatus(404);
  
    const cached = cameraFrameCache.get(cameraIndex) || readCameraFrameCache(cameraIndex, camera.snapshotUrl);
    if (cached) cameraFrameCache.set(cameraIndex, cached);
    if (cached?.cameraUrl === camera.snapshotUrl && Date.now() - cached.createdAt < 1000) {
      res.set("Content-Type", cached.contentType || "image/jpeg");
      res.set("Cache-Control", "no-store");
      res.set("X-HeartPet-Camera-Cache", "fresh");
      res.set("X-HeartPet-Camera-Captured-At", new Date(cached.createdAt).toISOString());
      return res.send(cached.buffer);
    }
  
    try {
      const snapshotCamera = {
        ...camera,
        url: camera.snapshotUrl,
        protocol: camera.snapshotProtocol,
      };
      const buffer = await captureCameraFrame(snapshotCamera);
      const cacheEntry = {
        cameraUrl: camera.snapshotUrl,
        createdAt: Date.now(),
        buffer,
        contentType: "image/jpeg",
        failedAttempts: 0,
      };
      cameraFrameCache.set(cameraIndex, cacheEntry);
      writeCameraFrameCache(cameraIndex, cacheEntry);
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "no-store");
      res.set("X-HeartPet-Camera-Cache", "refreshed");
      res.set("X-HeartPet-Camera-Captured-At", new Date(cacheEntry.createdAt).toISOString());
      return res.send(buffer);
    } catch (error) {
      const errorMessage = redactSensitiveText(describeFetchError(error));
      const failedAttempts = cached?.cameraUrl === camera.snapshotUrl ? Number(cached.failedAttempts || 0) + 1 : 1;
      console.error(`[HeartPet] Einzelbild von Kamera „${camera.name}“ fehlgeschlagen (${failedAttempts}/2): ${errorMessage}`);
      if (cached?.cameraUrl === camera.snapshotUrl && cached.buffer && Date.now() - cached.createdAt < 24 * 60 * 60 * 1000) {
        cameraFrameCache.set(cameraIndex, { ...cached, failedAttempts });
        res.set("Content-Type", cached.contentType || "image/jpeg");
        res.set("Cache-Control", "no-store");
        res.set("X-HeartPet-Camera-Cache", "stale");
        res.set("X-HeartPet-Camera-Captured-At", new Date(cached.createdAt).toISOString());
        res.set("X-HeartPet-Camera-Warning", failedAttempts < 2 ? "retrying" : "offline");
        return res.send(cached.buffer);
      }
  
      cameraFrameCache.set(cameraIndex, {
        ...(cached?.cameraUrl === camera.snapshotUrl ? cached : {}),
        cameraUrl: camera.snapshotUrl,
        createdAt: 0,
        failedAttempts,
      });
      const statusCode = error?.name === "AbortError" ? "TIMEOUT" : String(error?.cause?.code || error?.code || "CAMERA_OFFLINE");
      res.set("Content-Type", "image/svg+xml; charset=utf-8");
      res.set("Cache-Control", "no-store");
      res.set("X-HeartPet-Camera-Cache", failedAttempts < 2 ? "waiting" : "error");
      return res.status(200).send(buildCameraPlaceholderSvg({
        cameraName: camera.name,
        statusCode: failedAttempts < 2 ? "NEUER VERSUCH" : statusCode,
        message: failedAttempts < 2 ? "Kamerabild wird erneut geladen." : errorMessage,
      }));
    }
  });
  
  router.get("/coop/cameras/:index/status", async (req, res) => {
    const cameras = parseCoopCameras(getSettingsObject(db).coop_camera_streams);
    const camera = cameras[Number.parseInt(req.params.index, 10)];
    if (!camera) return res.status(404).json({ ok: false, error: "Kamera nicht konfiguriert." });
  
    if (camera.protocol === "rtsp") {
      return checkRtspCamera(camera, res);
    }
  
    try {
      const response = await fetchCameraStream(camera.snapshotUrl, 7000);
      const contentType = response.headers.get("content-type") || "";
      await response.body?.cancel();
      if (!response.ok) {
        return res.status(502).json({ ok: false, error: `Kamera antwortet mit HTTP ${response.status}.` });
      }
      if (!/^(?:image\/(?:jpeg|jpg|png|webp)|multipart\/x-mixed-replace)/i.test(contentType)) {
        return res.status(502).json({ ok: false, error: `Kein Bildstream empfangen (${contentType || "Content-Type fehlt"}).` });
      }
      const cachedFrame = cameraFrameCache.get(Number.parseInt(req.params.index, 10)) || readCameraFrameCache(Number.parseInt(req.params.index, 10), camera.snapshotUrl);
      return res.json({ ok: true, contentType, lastFrameAt: cachedFrame?.createdAt ? new Date(cachedFrame.createdAt).toISOString() : null });
    } catch (error) {
      return res.status(502).json({ ok: false, error: redactSensitiveText(describeFetchError(error)) });
    }
  });
  
  router.get("/admin/coop/climate-status", requireAdmin, async (req, res) => {
    const settings = getSettingsObject(db);
    const climate = await readHomematicClimateFromCcu(settings);
    if (climate.error) {
      createAuditLog(req, "coop.climate_check_failed", {
        stage: climate.stage,
        error: climate.error,
        datapoints: getHomematicClimateDatapointIds(settings),
      }, { entityType: "coop" });
      return res.status(502).json({
        ok: false,
        loginOk: climate.loginOk,
        stage: climate.stage,
        error: climate.error,
        logUrl: "/admin/systemlog",
      });
    }
    createAuditLog(req, "coop.climate_check", {
      temperature: climate.temperature,
      humidity: climate.humidity,
    }, { entityType: "coop" });
    return res.json({
      ok: true,
      loginOk: true,
      temperature: climate.temperature,
      humidity: climate.humidity,
    });
  });
  
  router.get("/admin/coop/homematic-datapoints", requireAdmin, async (req, res) => {
    const settings = getSettingsObject(db);
    const url = buildHomematicXmlApiUrl(settings, "statelist.cgi");
    if (!url) return res.status(400).json({ ok: false, error: "Bitte zuerst XML-API-Adresse und Token speichern." });
    try {
      const response = await fetchWithTimeout(url, 15000);
      if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
      const xml = decodeHomematicXmlBuffer(await response.arrayBuffer(), response.headers.get("content-type"));
      if (/<not_authenticated\b/i.test(xml)) throw new Error("XML-API-Token ist ungültig oder fehlt.");
      const datapoints = parseHomematicDatapoints(xml);
      console.info(`[HeartPet][CCU][discovery] ${datapoints.length} Datenpunkte geladen.`);
      return res.json({ ok: true, datapoints });
    } catch (error) {
      console.error(`[HeartPet][CCU][discovery] Fehlgeschlagen: ${error.message}`);
      return res.status(502).json({ ok: false, error: redactSensitiveText(describeFetchError(error)) });
    }
  });
  
  router.post("/admin/coop/door-test/:direction", requireAdmin, async (req, res) => {
    const open = req.params.direction === "open";
    if (!open && req.params.direction !== "close") return res.status(404).json({ ok: false, error: "Unbekannte Türrichtung." });
    const settings = getSettingsObject(db);
    const command = getHomematicDoorCommand(settings, open);
    if (!command) return res.status(400).json({ ok: false, error: "Tür-Datenpunkt und Schaltwerte zuerst speichern." });
    try {
      const result = await executeHomematicDoorDirection(settings, open);
      createAuditLog(req, open ? "coop.door_open_test" : "coop.door_close_test", result, { entityType: "coop" });
      return res.json({
        ok: true,
        commandId: result.commandId,
        sensorConfigured: result.sensorConfigured,
        sensorConfirmed: result.sensorConfirmed,
        sensorValue: result.sensorValue,
        expectedSensorValue: result.expectedSensorValue,
        attempts: result.attempts,
        operationStatus: result.operationStatus,
        message: result.sensorConfigured
          ? (result.sensorConfirmed ? "CCU-Befehl und Türsensor bestätigen die Endlage." : "CCU hat den Befehl angenommen, der Türsensor bestätigt die Endlage nicht.")
          : "CCU hat den Befehl angenommen. Kein Türsensor zur Endlagenprüfung konfiguriert.",
      });
    } catch (error) {
      console.error(`[HeartPet][CCU][door-test] ${open ? "Öffnen" : "Schließen"}: ${error.message}`);
      return res.status(502).json({ ok: false, error: error.message });
    }
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createCoopRouter };

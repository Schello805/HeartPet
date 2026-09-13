const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function createCameraService({ cameraCacheDir, normalizeConfiguredUrl, isCameraUrl, isRtspUrl }) {
  function parseCoopCameraLines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((source, index) => {
        const parts = source.split("|").map((part) => part.trim());
        const hasName = parts.length > 1;
        const name = hasName ? parts.shift() : `Kamera ${index + 1}`;
        const snapshotUrl = normalizeConfiguredUrl(parts[0] || source);
        const streamUrl = normalizeConfiguredUrl(parts[1] || snapshotUrl);
        const group = String(parts[2] || "Kameras").trim() || "Kameras";
        return {
          source,
          name: name || `Kamera ${index + 1}`,
          url: streamUrl,
          snapshotUrl,
          streamUrl,
          group,
          snapshotProtocol: isRtspUrl(snapshotUrl) ? "rtsp" : "http",
          protocol: isRtspUrl(streamUrl) ? "rtsp" : "http",
          valid: isCameraUrl(snapshotUrl) && isCameraUrl(streamUrl),
        };
      });
  }
  
  function parseCoopCameras(value) {
    return parseCoopCameraLines(value)
      .filter((camera) => camera.valid)
      .map(({ name, url, snapshotUrl, streamUrl, group, snapshotProtocol, protocol }) => ({
        name,
        url,
        snapshotUrl,
        streamUrl,
        group,
        snapshotProtocol,
        protocol,
      }));
  }
  
  function getCameraCachePaths(cameraIndex) {
    return {
      image: path.join(cameraCacheDir, `${cameraIndex}.jpg`),
      metadata: path.join(cameraCacheDir, `${cameraIndex}.json`),
    };
  }
  
  function readCameraFrameCache(cameraIndex, cameraUrl) {
    try {
      const paths = getCameraCachePaths(cameraIndex);
      const metadata = JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
      if (metadata.cameraUrlHash !== crypto.createHash("sha256").update(cameraUrl).digest("hex")) return null;
      return {
        cameraUrl,
        createdAt: Number(metadata.createdAt),
        contentType: "image/jpeg",
        failedAttempts: 0,
        buffer: fs.readFileSync(paths.image),
      };
    } catch {
      return null;
    }
  }
  
  function writeCameraFrameCache(cameraIndex, entry) {
    try {
      fs.mkdirSync(cameraCacheDir, { recursive: true, mode: 0o700 });
      const paths = getCameraCachePaths(cameraIndex);
      fs.writeFileSync(paths.image, entry.buffer, { mode: 0o600 });
      fs.writeFileSync(paths.metadata, JSON.stringify({
        cameraUrlHash: crypto.createHash("sha256").update(entry.cameraUrl).digest("hex"),
        createdAt: entry.createdAt,
      }), { mode: 0o600 });
    } catch (error) {
      console.warn(`[HeartPet][Kamera] Cache konnte nicht gespeichert werden: ${redactSensitiveText(error.message)}`);
    }
  }
  
  function streamRtspCamera(camera, req, res) {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
      "-i", camera.url, "-an", "-vf", "fps=5,scale=960:-2",
      "-q:v", "6", "-f", "mpjpeg", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let started = false;
    let stderr = "";
  
    ffmpeg.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    ffmpeg.stdout.once("data", (chunk) => {
      started = true;
      res.status(200);
      res.set("Content-Type", "multipart/x-mixed-replace; boundary=ffmpeg");
      res.set("Cache-Control", "no-store");
      res.write(chunk);
      ffmpeg.stdout.pipe(res);
    });
    ffmpeg.on("error", (error) => {
      if (!res.headersSent) res.status(503).send(error.code === "ENOENT" ? "ffmpeg ist auf dem HeartPet-Server nicht installiert." : error.message);
    });
    ffmpeg.on("close", () => {
      if (!started && !res.headersSent) res.status(502).send(stderr.trim() || "RTSP-Stream konnte nicht geöffnet werden.");
      else if (!res.writableEnded) res.end();
    });
    const stop = () => { if (!ffmpeg.killed) ffmpeg.kill("SIGTERM"); };
    res.on("close", stop);
  }
  
  function captureCameraFrame(camera) {
    return new Promise((resolve, reject) => {
      const protocolArgs = camera.protocol === "rtsp" ? ["-rtsp_transport", "tcp"] : [];
      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", ...protocolArgs,
        "-i", camera.url, "-an", "-frames:v", "1", "-vf", "scale=960:-2",
        "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      let size = 0;
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
        finish(() => reject(new Error("Kamera hat innerhalb von 10 Sekunden kein Einzelbild geliefert.")));
      }, 10000);
      ffmpeg.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 10 * 1024 * 1024) chunks.push(chunk);
        else if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
      });
      ffmpeg.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
      ffmpeg.on("error", (error) => finish(() => reject(new Error(error.code === "ENOENT" ? "ffmpeg fehlt auf dem HeartPet-Server." : error.message))));
      ffmpeg.on("close", (code) => finish(() => {
        if (code === 0 && chunks.length) return resolve(Buffer.concat(chunks));
        reject(new Error(size > 10 * 1024 * 1024 ? "Kamera-Einzelbild ist zu groß." : stderr.trim() || "Kamera-Einzelbild konnte nicht gelesen werden."));
      }));
    });
  }
  
  function checkRtspCamera(camera, res) {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
      "-i", camera.url, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let received = false;
    let stderr = "";
    const timeout = setTimeout(() => ffmpeg.kill("SIGTERM"), 10000);
    ffmpeg.stdout.on("data", () => { received = true; });
    ffmpeg.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    ffmpeg.on("error", (error) => {
      clearTimeout(timeout);
      if (!res.headersSent) res.status(503).json({ ok: false, error: error.code === "ENOENT" ? "ffmpeg fehlt auf dem HeartPet-Server." : error.message });
    });
    ffmpeg.on("close", () => {
      clearTimeout(timeout);
      if (res.headersSent) return;
      if (received) return res.json({ ok: true, contentType: "video/rtsp via ffmpeg" });
      return res.status(502).json({ ok: false, error: stderr.trim() || "Kein Bild vom RTSP-Stream empfangen." });
    });
  }
  
  async function fetchWithTimeout(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const target = createAuthenticatedFetchTarget(normalizeConfiguredUrl(url));
      return await fetch(target.url, { headers: target.headers, signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timeout);
    }
  }
  
  function createAuthenticatedFetchTarget(value) {
    const url = new URL(String(value || "").trim());
    const headers = {};
    let username = "";
    let password = "";
    if (url.username || url.password) {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
      url.username = "";
      url.password = "";
    }
    return { url: url.toString(), headers, username, password };
  }
  
  function redactSensitiveText(value) {
    return sanitizeLogText(value)
      .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1***:***@")
      .replace(/([?&](?:sid|token|password|passwort)=)[^&\s]+/gi, "$1***")
      .replace(/("(?:password|token|sid)"\s*:\s*")[^"]+/gi, "$1***");
  }
  
  function sanitizeLogText(value) {
    return String(value || "").replace(/[\r\n\u2028\u2029]+/g, " ");
  }
  
  function parseDigestChallenge(value) {
    const challenge = {};
    String(value || "").replace(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g, (match, key, quoted, plain) => {
      challenge[key.toLowerCase()] = quoted ?? plain;
      return match;
    });
    return challenge;
  }
  
  function md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }
  
  function buildDigestAuthorization({ username, password, method, requestUrl, challengeHeader }) {
    const challenge = parseDigestChallenge(challengeHeader);
    if (!username || !challenge.realm || !challenge.nonce) return "";
    const url = new URL(requestUrl);
    const uri = `${url.pathname}${url.search}`;
    const qop = String(challenge.qop || "").split(",").map((item) => item.trim()).find((item) => item === "auth") || "";
    const nc = "00000001";
    const cnonce = crypto.randomBytes(8).toString("hex");
    const ha1 = md5(`${username}:${challenge.realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = qop
      ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${challenge.nonce}:${ha2}`);
    const parts = [
      `username="${username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
    ];
    if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
    if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    return `Digest ${parts.join(", ")}`;
  }
  
  async function fetchCameraStream(value, timeoutMs = 10000) {
    const target = createAuthenticatedFetchTarget(normalizeConfiguredUrl(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(target.url, { headers: target.headers, redirect: "follow", signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
    const challengeHeader = response.headers.get("www-authenticate") || "";
    if (response.status === 401 && /^digest\s/i.test(challengeHeader) && target.username) {
      await response.body?.cancel();
      const authorization = buildDigestAuthorization({
        username: target.username,
        password: target.password,
        method: "GET",
        requestUrl: target.url,
        challengeHeader,
      });
      response = await fetch(target.url, { headers: { Authorization: authorization }, redirect: "follow", signal: controller.signal });
    }
    clearTimeout(timeout);
    return response;
  }
  
  function describeFetchError(error) {
    if (error?.name === "AbortError") return "Zeitüberschreitung beim Verbindungsaufbau.";
    const causeCode = error?.cause?.code || error?.code;
    if (causeCode === "ECONNREFUSED") return "Verbindung wurde vom Zielgerät abgelehnt.";
    if (causeCode === "EHOSTUNREACH" || causeCode === "ENETUNREACH") return "Zielgerät ist aus dem Servernetz nicht erreichbar.";
    return String(error?.message || "Verbindung fehlgeschlagen.");
  }
  
  function buildCameraPlaceholderSvg({ cameraName, statusCode, message }) {
    const escapeXml = (value) => String(value || "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    })[character]);
    return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(cameraName)}: ${escapeXml(message)}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e9f5f7"/><stop offset="1" stop-color="#d8ece8"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#bg)"/>
    <rect x="478" y="180" width="324" height="220" rx="34" fill="none" stroke="#527680" stroke-width="24"/>
    <circle cx="640" cy="290" r="62" fill="none" stroke="#527680" stroke-width="24"/>
    <path d="M802 238l92-58v220l-92-58" fill="none" stroke="#527680" stroke-width="24" stroke-linejoin="round"/>
    <text x="640" y="490" text-anchor="middle" fill="#173943" font-family="sans-serif" font-size="42" font-weight="700">${escapeXml(cameraName)}</text>
    <text x="640" y="548" text-anchor="middle" fill="#527680" font-family="sans-serif" font-size="30">${escapeXml(message)}</text>
    <text x="640" y="600" text-anchor="middle" fill="#267389" font-family="monospace" font-size="26" font-weight="700">${escapeXml(statusCode)}</text>
  </svg>`;
  }

  return { parseCoopCameraLines, parseCoopCameras, readCameraFrameCache, writeCameraFrameCache, streamRtspCamera, captureCameraFrame, checkRtspCamera, fetchWithTimeout, createAuthenticatedFetchTarget, redactSensitiveText, sanitizeLogText, buildDigestAuthorization, fetchCameraStream, describeFetchError, buildCameraPlaceholderSvg };
}

module.exports = { createCameraService };

function shouldReplaceSessionAfterRenewError(error) {
  const message = String(error?.message || error || "");
  return /session[^\n]*(?:invalid|expired|unknown)|(?:invalid|expired|unknown)[^\n]*session|verlängerung der sitzung abgelehnt/i.test(message);
}

function getLoginRetryDelay(error) {
  const message = String(error?.message || error || "");
  return /invalid credentials|too many sessions|sitzungslimit/i.test(message) ? 30 * 60 * 1000 : 5 * 60 * 1000;
}

function resolveRenewedSessionId(result, existingSid) {
  if (result === true) return String(existingSid || "").trim();
  if (!result) return "";
  if (typeof result === "object") return String(result._session_id_ || "").trim();
  const value = String(result).trim();
  if (/^false$/i.test(value)) return "";
  return /^true$/i.test(value) ? String(existingSid || "").trim() : value;
}

function createHomematicSessionService({
  callJsonRpc,
  describeError,
  getApiUrl,
  persistSessionId,
  request = fetch,
  now = Date.now,
}) {
  const sessions = new Map();
  const pendingLogins = new Map();
  const failures = new Map();

  const cacheFailure = (cacheKey, result, error) => {
    failures.set(cacheKey, { result, createdAt: now(), retryAfterMs: getLoginRetryDelay(error) });
  };

  async function loginOnce(settings) {
    const username = String(settings?.homematic_ccu_username || "").trim();
    const password = String(settings?.homematic_ccu_password || "");
    const apiUrl = getApiUrl(settings);
    if (!apiUrl || !username) return { ok: false, sid: "", error: "Keine CCU-Zugangsdaten hinterlegt." };
    const cacheKey = `${apiUrl}|${username}`;
    const cached = sessions.get(cacheKey);
    if (cached && now() - cached.createdAt < 20 * 60 * 1000) return { ok: true, sid: cached.sid, error: "" };

    try {
      const storedSid = String(cached?.sid || settings?.homematic_ccu_session_id || "").trim();
      if (storedSid) {
        try {
          const renewed = await callJsonRpc(apiUrl, "Session.renew", { _session_id_: storedSid });
          const renewedSid = resolveRenewedSessionId(renewed, storedSid);
          if (!renewedSid) throw new Error("Die CCU hat die Verlängerung der Sitzung abgelehnt.");
          sessions.set(cacheKey, { sid: renewedSid, createdAt: now() });
          failures.delete(cacheKey);
          if (renewedSid !== storedSid) persistSessionId(renewedSid);
          return { ok: true, sid: renewedSid, error: "" };
        } catch (error) {
          console.warn(`[HeartPet][CCU][session-renew] Gespeicherte Sitzung konnte nicht erneuert werden: ${error.message}`);
          if (!shouldReplaceSessionAfterRenewError(error)) {
            const result = {
              ok: false,
              sid: "",
              error: `Die bestehende CCU-Sitzung konnte nicht verlängert werden: ${describeError(error)} HeartPet öffnet vorsorglich keine weitere Sitzung.`,
            };
            cacheFailure(cacheKey, result, error);
            return result;
          }
          persistSessionId("");
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      let response;
      try {
        response = await request(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "1.1", id: 1, method: "Session.login", params: { username, password } }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const error = `CCU-Anmeldung antwortet mit HTTP ${response.status}.`;
        const result = { ok: false, sid: "", error };
        cacheFailure(cacheKey, result, error);
        return result;
      }
      const payload = await response.json();
      const sid = String(payload?.result?._session_id_ || payload?.result || "").trim();
      if (!sid || payload?.error) {
        const message = payload?.error?.message || "CCU-Benutzername oder Passwort wurde abgelehnt.";
        const error = /invalid credentials|too many sessions/i.test(message)
          ? "Die CCU-Anmeldung wurde abgelehnt. Die CCU meldet mehrdeutig: Zugangsdaten ungültig oder Sitzungslimit erreicht. HeartPet unternimmt 30 Minuten lang keinen weiteren Anmeldeversuch."
          : message;
        const result = { ok: false, sid: "", error };
        cacheFailure(cacheKey, result, message);
        return result;
      }
      sessions.set(cacheKey, { sid, createdAt: now() });
      failures.delete(cacheKey);
      persistSessionId(sid);
      return { ok: true, sid, error: "" };
    } catch (error) {
      const message = describeError(error);
      const result = { ok: false, sid: "", error: message };
      cacheFailure(cacheKey, result, error);
      return result;
    }
  }

  async function login(settings) {
    const cacheKey = `${getApiUrl(settings)}|${String(settings?.homematic_ccu_username || "").trim()}`;
    const recentFailure = failures.get(cacheKey);
    if (recentFailure && now() - recentFailure.createdAt < (recentFailure.retryAfterMs || 5 * 60 * 1000)) return recentFailure.result;
    failures.delete(cacheKey);
    if (pendingLogins.has(cacheKey)) return pendingLogins.get(cacheKey);
    const promise = loginOnce(settings);
    pendingLogins.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (pendingLogins.get(cacheKey) === promise) pendingLogins.delete(cacheKey);
    }
  }

  function reset() {
    sessions.clear();
    pendingLogins.clear();
    failures.clear();
  }

  return { login, reset };
}

module.exports = {
  createHomematicSessionService,
  getLoginRetryDelay,
  resolveRenewedSessionId,
  shouldReplaceSessionAfterRenewError,
};

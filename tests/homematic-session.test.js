const test = require("node:test");
const assert = require("node:assert/strict");

const { createHomematicSessionService } = require("../src/services/homematic-session");

const settings = {
  homematic_ccu_url: "http://openccu.local/addons/xmlapi/",
  homematic_ccu_username: "heartpet",
  homematic_ccu_password: "secret",
  homematic_ccu_session_id: "OLD-SID",
};

function createService({ callJsonRpc, request, persisted }) {
  return createHomematicSessionService({
    callJsonRpc,
    describeError: (error) => error.message,
    getApiUrl: () => "http://openccu.local/api/homematic.cgi",
    persistSessionId: (sid) => persisted.push(sid),
    request,
  });
}

test("CCU-Renew wird durch einen authentifizierten Aufruf validiert", async () => {
  const calls = [];
  const persisted = [];
  const service = createService({
    callJsonRpc: async (_url, method) => {
      calls.push(method);
      if (method === "Session.renew") return true;
      if (method === "ReGa.runScript") return "heartpet-session-ok";
      throw new Error(`Unerwarteter Aufruf: ${method}`);
    },
    request: async () => { throw new Error("Neuer Login darf nicht erfolgen"); },
    persisted,
  });

  const result = await service.login(settings);
  assert.deepEqual(result, { ok: true, sid: "OLD-SID", error: "" });
  assert.deepEqual(calls, ["Session.renew", "ReGa.runScript"]);
  assert.deepEqual(persisted, []);
});

test("Ungültige erneuerte CCU-Sitzung wird geschlossen und einmal ersetzt", async () => {
  const calls = [];
  const persisted = [];
  let loginRequests = 0;
  const service = createService({
    callJsonRpc: async (_url, method) => {
      calls.push(method);
      if (method === "Session.renew") return true;
      if (method === "ReGa.runScript") throw new Error("access denied");
      if (method === "Session.logout") return true;
      throw new Error(`Unerwarteter Aufruf: ${method}`);
    },
    request: async () => {
      loginRequests += 1;
      return { ok: true, json: async () => ({ result: { _session_id_: "NEW-SID" } }) };
    },
    persisted,
  });

  const result = await service.login(settings);
  assert.deepEqual(result, { ok: true, sid: "NEW-SID", error: "" });
  assert.equal(loginRequests, 1);
  assert.deepEqual(calls, ["Session.renew", "ReGa.runScript", "Session.logout"]);
  assert.deepEqual(persisted, ["", "NEW-SID"]);
});

test("CCU-Reset meldet die bekannte Sitzung aktiv ab", async () => {
  const calls = [];
  const persisted = [];
  const service = createService({
    callJsonRpc: async (_url, method, params) => {
      calls.push({ method, sid: params._session_id_ });
      return true;
    },
    request: async () => { throw new Error("Kein Login erwartet"); },
    persisted,
  });

  await service.reset(settings);
  assert.deepEqual(calls, [{ method: "Session.logout", sid: "OLD-SID" }]);
  assert.deepEqual(persisted, [""]);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldUseMemorySessionStore } = require("../src/http-session");

test("Flüchtige Sessions sind ausschließlich im Testbetrieb erlaubt", () => {
  assert.equal(shouldUseMemorySessionStore({ HEARTPET_SESSION_STORE: "memory", NODE_ENV: "test" }), true);
  assert.equal(shouldUseMemorySessionStore({ HEARTPET_SESSION_STORE: "memory", NODE_ENV: "production" }), false);
  assert.equal(shouldUseMemorySessionStore({ HEARTPET_SESSION_STORE: "memory" }), false);
  assert.equal(shouldUseMemorySessionStore({ NODE_ENV: "test" }), false);
});

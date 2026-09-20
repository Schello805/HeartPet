const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeAppBaseUrl, resolveAppBaseUrl } = require("../src/app-url");

test("App-Domains werden als eindeutige Basis-URL normalisiert", () => {
  assert.equal(normalizeAppBaseUrl("tiere.example.de"), "https://tiere.example.de");
  assert.equal(normalizeAppBaseUrl("https://tiere.example.de/"), "https://tiere.example.de");
  assert.equal(normalizeAppBaseUrl("https://user:secret@tiere.example.de"), "");
  assert.equal(normalizeAppBaseUrl("https://tiere.example.de/unterpfad"), "");
});

test("Gespeicherte Domain, Umgebung und lokaler Fallback haben eine klare Priorität", () => {
  assert.equal(resolveAppBaseUrl(
    { app_domain: "https://gespeichert.example.de" },
    { configuredUrl: "https://umgebung.example.de", fallbackUrl: "http://127.0.0.1:3000" },
  ), "https://gespeichert.example.de");
  assert.equal(resolveAppBaseUrl(
    { app_domain: "" },
    { configuredUrl: "https://umgebung.example.de", fallbackUrl: "http://127.0.0.1:3000" },
  ), "https://umgebung.example.de");
  assert.equal(resolveAppBaseUrl(
    {},
    { configuredUrl: "", fallbackUrl: "http://127.0.0.1:3000" },
  ), "http://127.0.0.1:3000");
});

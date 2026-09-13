const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectPrivateIpv4Addresses,
  getDefaultAppBaseUrl,
  isPrivateIpv4,
  listLocalAccessUrls,
  resolveBindHost,
} = require("../src/runtime/network");

test("Heimnetz-Adressen werden fuer den lokalen App-Start gesammelt", () => {
  const interfaces = {
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.178.40" }],
    vpn: [{ family: "IPv4", internal: false, address: "100.64.1.20" }],
  };

  assert.equal(resolveBindHost(""), "0.0.0.0");
  assert.deepEqual(collectPrivateIpv4Addresses(interfaces), ["192.168.178.40"]);
  assert.deepEqual(listLocalAccessUrls({ port: 3000, interfaces }), [
    "http://127.0.0.1:3000",
    "http://192.168.178.40:3000",
  ]);
});

test("Explizite Bind-Adresse bleibt eindeutig und absolute Links haben einen lokalen Fallback", () => {
  assert.equal(isPrivateIpv4("10.0.0.5"), true);
  assert.equal(isPrivateIpv4("172.20.0.5"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.deepEqual(listLocalAccessUrls({ port: 4000, bindHost: "127.0.0.1" }), ["http://127.0.0.1:4000"]);
  assert.equal(getDefaultAppBaseUrl({ port: 4000, bindHost: "127.0.0.1" }), "http://127.0.0.1:4000");
});

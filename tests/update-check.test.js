const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRevisions, createUpdateChecker, normalizeRevision } = require("../src/services/update-check");

test("Revisionen werden strikt normalisiert und numerisch verglichen", () => {
  assert.equal(normalizeRevision("v0.10.82\n"), "0.10.82");
  assert.equal(normalizeRevision("0.10.x"), "");
  assert.ok(compareRevisions("0.11.0", "0.10.99") > 0);
  assert.ok(compareRevisions("0.10.9", "0.10.81") < 0);
  assert.equal(compareRevisions("0.10.81", "0.10.81"), 0);
});

test("Updateprüfung erkennt neue Versionen und verwendet den Cache", async () => {
  let calls = 0;
  const checker = createUpdateChecker({
    currentRevision: "0.10.81",
    disabled: false,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, text: async () => "0.10.82\n" };
    },
  });

  const first = await checker.check();
  const second = await checker.check();
  assert.equal(first.updateAvailable, true);
  assert.equal(first.latestRevision, "0.10.82");
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("Fehler bei der Updateprüfung beeinträchtigen die App nicht", async () => {
  const checker = createUpdateChecker({
    currentRevision: "0.10.81",
    disabled: false,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const result = await checker.check();
  assert.equal(result.checked, false);
  assert.equal(result.updateAvailable, false);
});

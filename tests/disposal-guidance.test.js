const test = require("node:test");
const assert = require("node:assert/strict");

const { FEDERAL_STATES, getDisposalGuidance, isValidFederalState } = require("../src/disposal-guidance");

test("Entsorgungshinweise unterstützen alle deutschen Bundesländer", () => {
  assert.equal(FEDERAL_STATES.length, 16);
  assert.equal(new Set(FEDERAL_STATES).size, 16);
  assert.equal(isValidFederalState("Bayern"), true);
  assert.equal(isValidFederalState("Nicht vorhanden"), false);
});

test("Entsorgungshinweise verweisen ausschließlich auf amtliche Quellen", () => {
  const guidance = getDisposalGuidance("Bayern");
  assert.equal(guidance.federalState, "Bayern");
  assert.ok(guidance.officialSources.length >= 3);
  guidance.officialSources.forEach((source) => {
    const hostname = new URL(source.url).hostname;
    assert.ok(["www.gesetze-im-internet.de", "verwaltung.bund.de"].includes(hostname));
  });
});

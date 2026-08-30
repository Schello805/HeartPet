const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { getPwnedPasswordCount, validateNewPassword } = require("../src/password-security");

test("Passwortprüfung überträgt nur den fünfstelligen Hash-Präfix und verwendet Padding", async () => {
  const password = "ein-eigenes-sicheres-passwort";
  const hash = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  let requestUrl = "";
  let requestOptions;
  const count = await getPwnedPasswordCount(password, {
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return new Response(`${hash.slice(5)}:7\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0`, { status: 200 });
    },
  });

  assert.equal(count, 7);
  assert.equal(requestUrl, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
  assert.equal(requestOptions.headers["Add-Padding"], "true");
  assert.doesNotMatch(requestUrl, new RegExp(password));
  assert.doesNotMatch(requestUrl, new RegExp(hash));
});

test("Passwörter unter acht Zeichen und bekannte Passwörter werden abgelehnt", async () => {
  const previous = process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK;
  delete process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK;
  try {
    assert.match(await validateNewPassword("kurz"), /mindestens 8 Zeichen/);
    assert.match(await validateNewPassword("achtlang", {
      fetchImpl: async () => {
        const hash = crypto.createHash("sha1").update("achtlang").digest("hex").toUpperCase();
        return new Response(`${hash.slice(5)}:42`, { status: 200 });
      },
    }), /Datenlecks/);
  } finally {
    if (previous === undefined) delete process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK;
    else process.env.HEARTPET_DISABLE_PWNED_PASSWORD_CHECK = previous;
  }
});

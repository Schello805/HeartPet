const PROVIDERS = {
  hund: "dogapi",
  dog: "dogapi",
  katze: "thecatapi",
  cat: "thecatapi",
  huhn: "chickenapi",
  hühner: "chickenapi",
  chicken: "chickenapi",
};

function providerForSpecies(name) {
  return PROVIDERS[String(name || "").trim().toLocaleLowerCase("de-DE")] || null;
}

function imageUrl(value, host) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === host ? url.href : "";
  } catch {
    return "";
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Rassenquelle antwortet mit HTTP ${response.status}`);
  return response.json();
}

async function loadBreeds(provider, options = {}) {
  if (provider === "dogapi") {
    const payload = await fetchJson("https://dogapi.dog/api/v2/breeds?page%5Bsize%5D=1000");
    if (!Array.isArray(payload.data)) throw new Error("Ungültige Antwort der Dog API");
    return payload.data.map(({ attributes = {} }) => {
      const picture = attributes.images?.[0] || {};
      const credit = picture.attribution || {};
      return {
        name: attributes.name,
        description: attributes.description || "",
        origin: attributes.origin?.country || "",
        image_url: imageUrl(picture.medium || picture.thumb, "images.dogapi.dog"),
        image_credit: [credit.author, credit.license].filter(Boolean).join(" · "),
        image_source_url: httpsUrl(credit.source_url),
      };
    });
  }
  if (provider === "thecatapi") {
    const key = String(options.catApiKey || process.env.HEARTPET_CAT_API_KEY || "").trim();
    if (!key) throw new Error("Bitte unter Verwaltung > Allgemein einen kostenlosen Schlüssel von The Cat API hinterlegen.");
    const payload = await fetchJson("https://api.thecatapi.com/v1/breeds?limit=1000&lang=de", { "x-api-key": key });
    if (!Array.isArray(payload)) throw new Error("Ungültige Antwort der Cat API");
    return payload.map((breed) => ({
      name: breed.name,
      description: breed.description || "",
      origin: breed.origin || "",
      image_url: imageUrl(breed.image?.url, "cdn2.thecatapi.com"),
      image_credit: "The Cat API",
      image_source_url: httpsUrl(breed.wikipedia_url) || "https://thecatapi.com/",
    }));
  }
  if (provider === "chickenapi") {
    const payload = await fetchJson("https://chickenapi.com/api/v1/breeds/");
    if (!Array.isArray(payload)) throw new Error("Ungültige Antwort der Chicken API");
    return payload.map((breed) => ({
      name: breed.name,
      description: breed.description || "",
      origin: breed.origin || "",
      image_url: imageUrl(breed.imageUrl, "qwex.co"),
      image_credit: "Chicken API",
      image_source_url: "https://chickenapi.com/breeds",
    }));
  }
  throw new Error("Für diese Tierart ist keine Rassenquelle hinterlegt.");
}

function importBreeds(db, speciesId, provider, breeds) {
  const insert = db.prepare(`
    INSERT INTO species_breeds (species_id, name, description, origin, image_url, image_credit, image_source_url, source)
    VALUES (@species_id, @name, @description, @origin, @image_url, @image_credit, @image_source_url, @source)
    ON CONFLICT(species_id, name) DO UPDATE SET
      description = excluded.description, origin = excluded.origin, image_url = excluded.image_url,
      image_credit = excluded.image_credit, image_source_url = excluded.image_source_url,
      source = excluded.source
  `);
  return db.transaction(() => {
    let count = 0;
    for (const breed of breeds) {
      if (!breed.name || breed.name.length > 120) continue;
      insert.run({
        species_id: speciesId,
        name: breed.name,
        description: String(breed.description || "").slice(0, 2000),
        origin: String(breed.origin || "").slice(0, 120),
        image_url: String(breed.image_url || "").slice(0, 500),
        image_credit: String(breed.image_credit || "").slice(0, 250),
        image_source_url: String(breed.image_source_url || "").slice(0, 500),
        source: provider,
      });
      count += 1;
    }
    return count;
  })();
}

module.exports = { providerForSpecies, loadBreeds, importBreeds };

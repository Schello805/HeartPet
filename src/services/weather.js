function createWeatherService({ cache, fetchWithTimeout, describeFetchError, getTimeZone }) {
  async function readOutdoorWeather(settings) {
    const latitude = Number(settings.weather_latitude);
    const longitude = Number(settings.weather_longitude);
    const location = String(settings.weather_location_name || "Standort").trim() || "Standort";
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { configured: false, location, error: "Wetterstandort noch nicht vollständig konfiguriert." };
    }
    if (process.env.HEARTPET_DISABLE_EXTERNAL_WEATHER === "true") {
      return { configured: true, location, error: "" };
    }

    const cacheKey = `${latitude},${longitude},${getTimeZone()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) return cached.value;

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day");
    url.searchParams.set("daily", "sunrise,sunset");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", getTimeZone());

    try {
      const response = await fetchWithTimeout(url.toString(), 6000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const weatherMeta = getWeatherCodeMeta(payload.current?.weather_code, payload.current?.is_day);
      const value = {
        configured: true,
        location,
        temperature: toFiniteNumber(payload.current?.temperature_2m),
        apparentTemperature: toFiniteNumber(payload.current?.apparent_temperature),
        humidity: toFiniteNumber(payload.current?.relative_humidity_2m),
        precipitation: toFiniteNumber(payload.current?.precipitation),
        windSpeed: toFiniteNumber(payload.current?.wind_speed_10m),
        sunrise: payload.daily?.sunrise?.[0] || "",
        sunset: payload.daily?.sunset?.[0] || "",
        label: weatherMeta.label,
        icon: weatherMeta.icon,
        retrievedAt: new Date().toISOString(),
        error: "",
      };
      cache.set(cacheKey, { createdAt: Date.now(), value });
      return value;
    } catch (error) {
      return { configured: true, location, error: `Wetterdaten nicht erreichbar: ${describeFetchError(error)}` };
    }
  }

  return { readOutdoorWeather };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getWeatherCodeMeta(code, isDay = 1) {
  const value = Number(code);
  if (value === 0) return { label: "Klar", icon: isDay ? "☀️" : "🌙" };
  if ([1, 2].includes(value)) return { label: "Leicht bewölkt", icon: isDay ? "🌤️" : "☁️" };
  if (value === 3) return { label: "Bewölkt", icon: "☁️" };
  if ([45, 48].includes(value)) return { label: "Nebel", icon: "🌫️" };
  if ([51, 53, 55, 56, 57].includes(value)) return { label: "Nieselregen", icon: "🌦️" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { label: "Regen", icon: "🌧️" };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { label: "Schnee", icon: "🌨️" };
  if ([95, 96, 99].includes(value)) return { label: "Gewitter", icon: "⛈️" };
  return { label: "Wechselhaft", icon: "🌤️" };
}

module.exports = { createWeatherService, getWeatherCodeMeta };

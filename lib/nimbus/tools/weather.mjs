// get_weather: current conditions and a short forecast from Open-Meteo
// (https://open-meteo.com — free, no API key). Web-search snippets rarely
// contain the live temperature, so weather questions use this instead.
import { fetchJson } from "../net.mjs";

const WMO = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};

const US_STATES = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut",
  de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

/** "Coyle, OK" → { name: "Coyle", region: "oklahoma" }; "Paris" → { name: "Paris", region: null } */
export function parseLocation(raw) {
  const parts = String(raw ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? "";
  let region = parts.slice(1).join(" ").toLowerCase().replace(/\b(usa|us|united states)\b/g, "").trim() || null;
  if (region && US_STATES[region]) region = US_STATES[region];
  return { name, region };
}

function pickPlace(results, region) {
  if (!results?.length) return null;
  if (!region) return results[0];
  const r = region.toLowerCase();
  return results.find((p) => [p.admin1, p.country, p.country_code].some((v) => v && String(v).toLowerCase() === r))
    ?? results.find((p) => [p.admin1, p.admin2, p.country].some((v) => v && String(v).toLowerCase().includes(r)))
    ?? null;
}

export const getWeatherTool = {
  name: "get_weather",
  description:
    "Get the CURRENT weather (temperature, feels-like, conditions, humidity, wind) and a 3-day forecast for a place. Always use this for weather or temperature questions instead of web_search.",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City, optionally with state/country, e.g. \"Coyle, Oklahoma\"", minLength: 2, maxLength: 120 },
      units: { type: "string", enum: ["fahrenheit", "celsius"], description: "Default: fahrenheit in the US, celsius elsewhere" },
    },
    required: ["location"],
    additionalProperties: false,
  },
  permissionGroup: "weather",
  describePermission: (args) => `Check the weather for ${args.location}`,
  timeoutMs: 12000,
  async run(args, ctx) {
    const net = { fetchImpl: ctx.fetchImpl, lookup: ctx.lookup, signal: ctx.signal, timeoutMs: 8000 };
    const { name, region } = parseLocation(args.location);
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: "10", language: "en", format: "json" })}`,
      net
    );
    const place = pickPlace(geo?.results, region);
    if (!place) throw new Error(`Couldn't find a place called "${args.location}". Ask the user for a nearby city or the state.`);

    const units = args.units ?? (place.country_code === "US" ? "fahrenheit" : "celsius");
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
      temperature_unit: units,
      wind_speed_unit: units === "fahrenheit" ? "mph" : "kmh",
      precipitation_unit: units === "fahrenheit" ? "inch" : "mm",
      timezone: "auto",
      forecast_days: "3",
    });
    const wx = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, net);
    const c = wx?.current;
    if (!c || c.temperature_2m == null) throw new Error("The weather service returned no current conditions");
    const deg = units === "fahrenheit" ? "°F" : "°C";
    const d = wx.daily ?? {};

    return {
      source: "Open-Meteo",
      sourceUrl: "https://open-meteo.com/",
      place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      observedAt: c.time ? `${c.time} (${wx.timezone_abbreviation ?? wx.timezone ?? "local"})` : null,
      current: {
        temperature: `${Math.round(c.temperature_2m)}${deg}`,
        feelsLike: c.apparent_temperature != null ? `${Math.round(c.apparent_temperature)}${deg}` : null,
        conditions: WMO[c.weather_code] ?? "Unknown",
        humidity: c.relative_humidity_2m != null ? `${c.relative_humidity_2m}%` : null,
        wind: c.wind_speed_10m != null ? `${Math.round(c.wind_speed_10m)} ${units === "fahrenheit" ? "mph" : "km/h"}` : null,
      },
      forecast: (d.time ?? []).map((date, i) => ({
        date,
        high: `${Math.round(d.temperature_2m_max[i])}${deg}`,
        low: `${Math.round(d.temperature_2m_min[i])}${deg}`,
        conditions: WMO[d.weather_code?.[i]] ?? "Unknown",
        chanceOfRain: d.precipitation_probability_max?.[i] != null ? `${d.precipitation_probability_max[i]}%` : null,
      })),
    };
  },
  summarize(result) {
    return `${result.current.temperature}, ${result.current.conditions.toLowerCase()} in ${result.place}`;
  },
};

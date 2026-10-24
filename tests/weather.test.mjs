import { test } from "node:test";
import assert from "node:assert/strict";
import { getWeatherTool, parseLocation } from "../lib/nimbus/tools/weather.mjs";
import { classifyIntent } from "../lib/nimbus/intent.mjs";
import { mockFetch, fakeLookup } from "./helpers.mjs";

const GEO = { results: [
  { name: "Coyle", admin1: "Oklahoma", country: "United States", country_code: "US", latitude: 35.95, longitude: -97.23 },
  { name: "Coyle", admin1: "Texas", country: "United States", country_code: "US", latitude: 31.0, longitude: -95.0 },
] };
const WX = {
  timezone: "America/Chicago", timezone_abbreviation: "CDT",
  current: { time: "2026-10-24T17:45", temperature_2m: 71.6, apparent_temperature: 70.2, relative_humidity_2m: 48, weather_code: 2, wind_speed_10m: 9.4 },
  daily: { time: ["2026-10-24", "2026-10-25"], temperature_2m_max: [75.1, 69.8], temperature_2m_min: [52.3, 49.9], weather_code: [2, 61], precipitation_probability_max: [5, 60] },
};

test("weather intent catches temperature questions (typos too), not CSS/temp files", () => {
  for (const t of ["whats the tempature for coyle oklahoma", "current weather then", "will it rain tomorrow in okc", "how hot is it in Dallas"]) {
    assert.equal(classifyIntent(t).intent, "weather", t);
    assert.equal(classifyIntent(t).forcedTool, "get_weather");
  }
  assert.notEqual(classifyIntent("fix this tailwind template").intent, "weather");
});

test("parseLocation expands state abbreviations", () => {
  assert.deepEqual(parseLocation("Coyle, OK"), { name: "Coyle", region: "oklahoma" });
  assert.deepEqual(parseLocation("Paris"), { name: "Paris", region: null });
});

test("get_weather: picks the right state, reports live temp in °F with source and time", async () => {
  let forecastUrl = "";
  const f = mockFetch({
    "geocoding-api.open-meteo.com": GEO,
    "api.open-meteo.com/v1/forecast": (url) => { forecastUrl = String(url); return WX; },
  });
  const r = await getWeatherTool.run({ location: "Coyle, Oklahoma" }, { fetchImpl: f, lookup: fakeLookup() });
  assert.equal(r.place, "Coyle, Oklahoma, United States");
  assert.equal(r.current.temperature, "72°F");
  assert.equal(r.current.conditions, "Partly cloudy");
  assert.equal(r.forecast[1].chanceOfRain, "60%");
  assert.match(r.observedAt, /17:45 \(CDT\)/);
  assert.match(forecastUrl, /latitude=35\.95/);
  assert.match(forecastUrl, /temperature_unit=fahrenheit/);
});

test("get_weather: unknown place is an honest error, not a guess", async () => {
  const f = mockFetch({ "geocoding-api.open-meteo.com": { results: [] } });
  await assert.rejects(getWeatherTool.run({ location: "Nowhereville, ZZ" }, { fetchImpl: f, lookup: fakeLookup() }), /Couldn't find/);
  const f2 = mockFetch({ "geocoding-api.open-meteo.com": GEO });
  await assert.rejects(getWeatherTool.run({ location: "Coyle, Maine" }, { fetchImpl: f2, lookup: fakeLookup() }), /Couldn't find/);
});

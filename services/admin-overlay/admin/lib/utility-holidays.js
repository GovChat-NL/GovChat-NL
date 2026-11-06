"use strict";

const { ToolError, invalid, text } = require("./utility-common");
const { currentDate, dateDetails } = require("./utility-time");
const BASE = "https://openholidaysapi.org";
const NOTICE = "Officiële feestdagen; geen schoolvakanties. Een feestdag geeft niet automatisch recht op verlof. Controleer werkgever/cao en regionale toepasselijkheid.";
function apiURL(endpoint, params = {}, language = "NL") {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("languageIsoCode", language);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
function allowedAPI(url) {
  return url.origin === BASE && !url.username && !url.password && ["/Countries", "/Subdivisions", "/PublicHolidays"].includes(url.pathname);
}
function localizedName(names) {
  if (!Array.isArray(names)) return "";
  return names.find((name) => name.language === "NL")?.text || names.find((name) => name.language === "EN")?.text || names[0]?.text || "";
}
async function api(client, endpoint, params, language) {
  const result = await client.get(apiURL(endpoint, params, language), { ttl: 3600000, allowed: allowedAPI });
  if (!Array.isArray(result.data) || result.data.length > 2000) throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid OpenHolidays response", 502);
  return result;
}
function metadata(result) { return { source: result.source, fetched_at: result.fetched_at, cache: result.cache }; }
function validateCountries(data) {
  if (data.some((item) => !item || !/^[A-Z]{2}$/.test(item.isoCode) || !Array.isArray(item.name) || !localizedName(item.name))) {
    throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid OpenHolidays countries", 502);
  }
}
function allSubdivisions(data) {
  return data.flatMap((item) => [item, ...allSubdivisions(Array.isArray(item.children) ? item.children : [])]);
}
async function holidaysTool(body, config, client, { now = () => Date.now() } = {}) {
  const action = body.action ?? "holidays";
  if (!["holidays", "countries", "subdivisions"].includes(action)) invalid("Unsupported holidays action");
  // Validate request before contacting the source.
  const year = body.year ?? currentDate(config.default_timezone, now).year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) invalid("year must be an integer from 2000 to 2100; source coverage varies by country");
  const requested = body.country === undefined ? "nl" : text(body.country, "country", 100).toLocaleLowerCase("nl");
  const requestedSubdivision = body.subdivision === undefined ? undefined : text(body.subdivision, "subdivision", 100);
  const countries = await api(client, "Countries");
  validateCountries(countries.data);
  if (action === "countries") return { ok: true, action, countries: countries.data.map((item) => ({ ...item, display_name: localizedName(item.name) })), ...metadata(countries) };
  const aliases = { nederland: "NL", netherlands: "NL", dutch: "NL", "belgië": "BE", belgie: "BE", belgium: "BE" };
  function findCountry(data) {
    return data.find((item) => item.isoCode === (aliases[requested] || requested.toUpperCase()) || item.name.some((name) => String(name.text).toLocaleLowerCase("nl") === requested));
  }
  let country = findCountry(countries.data);
  if (!country && !/^[a-z]{2}$/.test(requested)) {
    const english = await api(client, "Countries", {}, "EN");
    validateCountries(english.data);
    const match = findCountry(english.data);
    if (match) country = countries.data.find((item) => item.isoCode === match.isoCode);
  }
  if (!country) throw new ToolError("UNSUPPORTED_COUNTRY", "Country is not supported by OpenHolidays");
  let subdivision;
  if (action === "subdivisions" || requestedSubdivision) {
    const regions = await api(client, "Subdivisions", { countryIsoCode: country.isoCode });
    if (allSubdivisions(regions.data).some((item) => !item || typeof item.code !== "string" || !Array.isArray(item.name))) throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid subdivisions", 502);
    if (action === "subdivisions") return { ok: true, action, country: country.isoCode, subdivisions: regions.data, ...metadata(regions) };
    subdivision = allSubdivisions(regions.data).find((item) => item.code.toLowerCase() === requestedSubdivision.toLowerCase() || item.shortName?.toLowerCase() === requestedSubdivision.toLowerCase() || localizedName(item.name).toLocaleLowerCase("nl") === requestedSubdivision.toLocaleLowerCase("nl"));
    if (!subdivision) throw new ToolError("INVALID_SUBDIVISION", "Subdivision is not valid for this country");
  }
  const result = await api(client, "PublicHolidays", { countryIsoCode: country.isoCode, validFrom: `${year}-01-01`, validTo: `${year}-12-31` });
  if (!result.data.length) throw new ToolError("UNSUPPORTED_YEAR", "No public holiday data is available for this country/year; no local fallback", 422);
  let holidays;
  try {
    holidays = result.data.map((item) => {
      if (!item || typeof item.id !== "string" || item.type !== "Public" || typeof item.nationwide !== "boolean" || !localizedName(item.name)) throw new Error("Invalid holiday");
      const start = dateDetails(item.startDate);
      const end = dateDetails(item.endDate);
      if (start.date > end.date || end.date < `${year}-01-01` || start.date > `${year}-12-31`) throw new Error("Invalid date range");
      return { ...item, display_name: localizedName(item.name), date: start.date, weekday: start.weekday, end_weekday: end.weekday, regional: !item.nationwide };
    }).filter((item) => !subdivision || item.nationwide || item.subdivisions?.some((region) => region.code === subdivision.code || (subdivision.shortName && region.shortName === subdivision.shortName)))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.display_name.localeCompare(b.display_name, "nl"));
  } catch { throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid OpenHolidays holiday data", 502); }
  return { ok: true, action, country: country.isoCode, year, subdivision: subdivision?.code || null, holidays, notice: NOTICE, ...metadata(result) };
}

module.exports = { holidaysTool, apiURL, allowedAPI, NOTICE };

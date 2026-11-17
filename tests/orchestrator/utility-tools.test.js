"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const lib = "../../services/admin-overlay/admin/lib/";
const { environmentDefaults, normalizeConfig, mergeConfig, atomicWriteJSON } = require(lib + "orchestrator-config");
const { timeTool, currentDate } = require(lib + "utility-time");
const { newsTool, parseFeed, CATEGORIES, allowedFeed } = require(lib + "utility-news");
const { holidaysTool, allowedAPI } = require(lib + "utility-holidays");
const { createSourceClient } = require(lib + "utility-common");
const { createUtilityHandler, safeTokenEqual } = require(lib + "utility-tools");
const config = environmentDefaults({});
const now = () => Date.parse("2027-12-31T23:30:00Z");
const response = (data, status = 200, headers = {}) => new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers });
const invalid = (fn, code = "INVALID_INPUT") => assert.throws(fn, (error) => error.code === code);

test("config: legacy fields, environment defaults and partial saves do not reset image settings or tool choices", () => {
  const defaults = environmentDefaults({ N8N_ORCHESTRATOR_ENABLE_TIME: "false", N8N_ORCHESTRATOR_DEFAULT_TIMEZONE: "UTC" });
  const legacy = normalizeConfig({ image_data_url_max_chars: 900000, image_max_resolution_px: 2048 }, defaults);
  assert.equal(legacy.tools.time, false);
  assert.equal(legacy.default_timezone, "UTC");
  const changed = mergeConfig({ tools: { nos_news: false } }, legacy, defaults);
  assert.equal(changed.image_data_url_max_chars, 900000);
  assert.equal(changed.image_max_resolution_px, 2048);
  assert.equal(changed.tools.time, false);
  assert.equal(mergeConfig({ image_max_resolution_px: 1024 }, changed, defaults).tools.nos_news, false);
  assert.equal(mergeConfig({}, changed, defaults).tools.calculator, true);
});

test("config rejects non-booleans, malformed tools/objects and invalid IANA timezones", () => {
  for (const value of ["false", 0, 1, null, [], {}]) assert.throws(() => mergeConfig({ tools: { time: value } }, config));
  for (const value of [[], null, "x"]) assert.throws(() => mergeConfig(value, config));
  for (const tools of [[], null, { unknown: true }]) assert.throws(() => mergeConfig({ tools }, config));
  for (const timezone of ["Mars/Base", "+01:00", "", 12, null]) assert.throws(() => mergeConfig({ default_timezone: timezone }, config));
  assert.throws(() => environmentDefaults({ N8N_ORCHESTRATOR_ENABLE_TIME: "yes" }));
  assert.throws(() => normalizeConfig({ tools: { time: "true" } }));
});

test("document limits have higher defaults and validated partial admin saves preserve every other setting", () => {
  assert.equal(config.documents.max_chars, 1000000);
  assert.equal(config.documents.timeout_ms, 60000);
  const legacy = normalizeConfig({ tools: { time: false }, image_data_url_max_chars: 900000 });
  const changed = mergeConfig({ documents: { max_chars: 2000000, max_count: 20 } }, legacy);
  assert.equal(changed.documents.max_chars, 2000000);
  assert.equal(changed.documents.max_bytes, 10485760);
  assert.equal(changed.documents.max_count, 20);
  assert.equal(changed.tools.time, false);
  assert.equal(changed.image_data_url_max_chars, 900000);
  assert.equal(mergeConfig({ tools: { calculator: false } }, changed).documents.max_chars, 2000000);
  for (const documents of [null, [], { max_chars: null }, { max_chars: "1000000" }, { max_chars: 4000001 },
    { max_bytes: 20971521 }, { max_count: 0 }, { timeout_ms: 120001 }, { unknown: 1 }]) {
    assert.throws(() => mergeConfig({ documents }, changed));
  }
  assert.equal(environmentDefaults({ N8N_DOCUMENT_MAX_CHARS: "2500000" }).documents.max_chars, 2500000);
  assert.throws(() => environmentDefaults({ N8N_DOCUMENT_MAX_CHARS: "unlimited" }));
});

test("policy publication replaces a full document atomically without leftover temporary files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govchat-policy-test-"));
  try {
    atomicWriteJSON(directory, "orchestrator-config.json", config);
    const next = mergeConfig({ tools: { calculator: false } }, config);
    atomicWriteJSON(directory, "orchestrator-config.json", next);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "orchestrator-config.json"))), next);
    assert.deepEqual(fs.readdirSync(directory), ["orchestrator-config.json"]);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("time now and default holiday year use Amsterdam at UTC new year boundary", () => {
  const result = timeTool({ action: "now" }, config, { now });
  assert.equal(result.datetime, "2028-01-01T00:30:00+01:00");
  assert.equal(result.utc, "2027-12-31T23:30:00Z");
  assert.equal(result.weekday, "zaterdag");
  assert.equal(currentDate(config.default_timezone, now).year, 2028);
});

test("time rejects ambiguous/nonexistent Amsterdam DST unless earlier/later or explicit offset", () => {
  for (const datetime of ["2026-03-29T02:30", "2026-10-25T02:30"]) {
    invalid(() => timeTool({ action: "convert", datetime, target_timezone: "UTC" }, config));
    const earlier = timeTool({ action: "convert", datetime, target_timezone: "UTC", disambiguation: "earlier" }, config);
    const later = timeTool({ action: "convert", datetime, target_timezone: "UTC", disambiguation: "later" }, config);
    assert.equal(later.epoch_milliseconds - earlier.epoch_milliseconds, 3600000);
  }
  assert.equal(timeTool({ action: "convert", datetime: "2026-10-25T02:30:00+02:00", target_timezone: "UTC" }, config).datetime, "2026-10-25T00:30:00+00:00");
});

test("time elapsed hours differ from calendar days across DST, negative durations and millisecond differences", () => {
  const base = { action: "add", datetime: "2026-03-28T12:00:00", amount: 1 };
  const day = timeTool({ ...base, unit: "days" }, config);
  const hours = timeTool({ ...base, amount: 24, unit: "hours" }, config);
  assert.equal(day.datetime, "2026-03-29T12:00:00+02:00");
  assert.equal(hours.datetime, "2026-03-29T13:00:00+02:00");
  assert.equal(timeTool({ ...base, amount: -1, unit: "days" }, config).date, "2026-03-27");
  assert.equal(timeTool({ ...base, amount: 1.5, unit: "hours" }, config).datetime, "2026-03-28T13:30:00+01:00");
  assert.equal(timeTool({ ...base, amount: -0.5, unit: "hours" }, config).datetime, "2026-03-28T11:30:00+01:00");
  assert.equal(timeTool({ ...base, amount: 0.001, unit: "seconds" }, config).datetime, "2026-03-28T12:00:00.001+01:00");
  const difference = timeTool({ action: "difference", datetime: "2026-03-28T12:00", end_datetime: "2026-03-29T12:00" }, config);
  assert.equal(difference.hours, 23);
  assert.equal(difference.milliseconds, 82800000);
  assert.equal(timeTool({ action: "difference", datetime: "2026-01-01T00:00:00.001Z", end_datetime: "2026-01-01T00:00:00Z" }, config).milliseconds, -1);
  invalid(() => timeTool({ ...base, datetime: "2026-03-28T02:30", unit: "days" }, config));
});

test("time invalid input is explicit, never normalized to a fabricated date", () => {
  for (const datetime of ["2026-02-30T12:00", "2026-13-01T12:00", "yesterday", "2026-01-01", "2026-01-01T25:00"]) invalid(() => timeTool({ action: "add", datetime, amount: 1, unit: "hours" }, config));
  for (const amount of [NaN, Infinity, "1", 1000001]) invalid(() => timeTool({ action: "add", datetime: "2026-01-01T00:00", amount, unit: "hours" }, config));
  invalid(() => timeTool({ action: "add", datetime: "2026-01-01T00:00", amount: 1.5, unit: "days" }, config));
  invalid(() => timeTool({ action: "add", datetime: "2026-01-01T00:00", amount: 0.0001, unit: "seconds" }, config));
  invalid(() => timeTool({ timezone: "Invalid/Timezone" }, config));
  invalid(() => timeTool({ disambiguation: "compatible" }, config));
  invalid(() => timeTool({ action: "add", datetime: "2026-01-31T12:00", amount: 1, unit: "months" }, config));
});

const rss = fs.readFileSync(path.join(__dirname, "../fixtures/utility-tools/news.xml"), "utf8");
test("RSS parses real XML, strips HTML/entities/scripts and returns dated articles newest first", () => {
  const result = parseFeed(rss);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "Nieuw & veilig");
  assert.equal(result[0].snippet, "Sterk nieuws & tekst");
  assert.equal(result[0].published_at, "2026-11-06T08:00:00.000Z");
  assert.equal(result[1].title, "Ouder bericht");
});

test("RSS rejects DTD/external entities, malformed XML and non-RSS response", () => {
  for (const xml of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel>&x;</channel></rss>', "<rss><channel></rss>", "<html>no feed</html>"]) invalid(() => parseFeed(xml), "SOURCE_INVALID_RESPONSE");
});

test("RSS categories never fetch, official aliases resolve, query stays local and limits are bounded", async () => {
  const calls = [];
  const client = createSourceClient({ fetchImpl: async (url) => { calls.push(url); return response(rss); }, now });
  const categories = await newsTool("nos_news", { action: "categories" }, client);
  assert.equal(categories.categories.length, 18);
  assert.equal(calls.length, 0);
  const result = await newsTool("nos_news", { category: "cultuur en media", query: "STERK", limit: 1 }, client);
  assert.equal(result.items.length, 1);
  assert.equal(calls[0], "https://feeds.nos.nl/nosnieuwscultuurenmedia");
  assert.equal(result.cache.hit, false);
  assert.equal((await newsTool("nos_news", { category: "cultuur" }, client)).cache.hit, true);
  assert.equal((await newsTool("nos_news", { category: "cultuur", query: "" }, client)).items.length, 2);
  await newsTool("l1_news", { category: "incidenten" }, client);
  assert.equal(calls[1], "https://www.l1nieuws.nl/rss/112.xml");
  for (const limit of [0, 51, "5", 1.5]) await assert.rejects(newsTool("nos_news", { limit }, client), { code: "INVALID_INPUT" });
  await assert.rejects(newsTool("nos_news", { category: "https://evil.test" }, client), { code: "INVALID_INPUT" });
  assert.equal(allowedFeed(new URL("https://feeds.nos.nl/nosnieuwsalgemeen?query=secret")), false);
  assert.equal(CATEGORIES.l1_news.length, 4);
});

test("source client rejects arbitrary hosts, unsafe redirects, oversize, bad JSON and HTTP errors", async () => {
  const run = (fetchImpl, extra = {}) => createSourceClient({ fetchImpl, now, ...extra }).get("https://feeds.nos.nl/nosnieuwsalgemeen", { ttl: 300000, allowed: allowedFeed, format: "xml" });
  await assert.rejects(run(async () => response("", 302, { location: "http://127.0.0.1/private" })), { code: "SOURCE_REDIRECT_REJECTED" });
  await assert.rejects(run(async () => response("", 302, { location: "https://feeds.nos.nl/unknown" })), { code: "SOURCE_REDIRECT_REJECTED" });
  await assert.rejects(run(async () => response("x".repeat(100)), { maxBytes: 50 }), { code: "SOURCE_TOO_LARGE" });
  await assert.rejects(run(async () => response("x", 200, { "content-length": "1000" }), { maxBytes: 50 }), { code: "SOURCE_TOO_LARGE" });
  await assert.rejects(run(async () => response("unavailable", 503)), { code: "SOURCE_HTTP_ERROR" });
  const client = createSourceClient({ fetchImpl: async () => response("not json"), now });
  await assert.rejects(client.get("https://openholidaysapi.org/Countries", { ttl: 1, allowed: allowedAPI }), { code: "SOURCE_INVALID_RESPONSE" });
  await assert.rejects(client.get("https://evil.test/", { ttl: 1, allowed: allowedAPI }), { code: "SOURCE_URL_REJECTED" });
});

test("source client enforces total timeout, safe redirects and bounded cache expiry/eviction", async () => {
  const timeout = createSourceClient({ timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
  await assert.rejects(timeout.get(CATEGORIES.nos_news[0].url, { ttl: 1, allowed: allowedFeed, format: "xml" }), { code: "SOURCE_TIMEOUT" });
  let clock = 0;
  let calls = 0;
  const client = createSourceClient({ maxEntries: 1, now: () => clock, fetchImpl: async () => { calls++; return response(rss); } });
  const options = { ttl: 100, allowed: allowedFeed, format: "xml" };
  await client.get(CATEGORIES.nos_news[0].url, options);
  assert.equal((await client.get(CATEGORIES.nos_news[0].url, options)).cache.hit, true);
  clock = 101;
  assert.equal((await client.get(CATEGORIES.nos_news[0].url, options)).cache.hit, false);
  await client.get(CATEGORIES.nos_news[1].url, options);
  await client.get(CATEGORIES.nos_news[0].url, options);
  assert.equal(calls, 4);
  let redirects = 0;
  const safe = createSourceClient({ fetchImpl: async () => ++redirects === 1 ? response("", 302, { location: CATEGORIES.nos_news[1].url }) : response(rss) });
  assert.equal((await safe.get(CATEGORIES.nos_news[0].url, options)).source, CATEGORIES.nos_news[1].url);
});

function holidayClient() {
  const calls = [];
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/utility-tools", name)));
  const client = createSourceClient({ now, fetchImpl: async (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname === "/Countries") return response(fixture(url.searchParams.get("languageIsoCode") === "EN" ? "countries-en.json" : "countries-nl.json"));
    if (url.pathname === "/Subdivisions") return response(fixture("subdivisions-be.json"));
    const country = url.searchParams.get("countryIsoCode");
    const year = url.searchParams.get("validFrom").slice(0, 4);
    if (country === "NL" && year === "2028") return response(fixture("holidays-nl-2028.json"));
    if (country === "BE" && year === "2026") return response(fixture("holidays-be-2026.json"));
    return response([]);
  } });
  return { client, calls };
}
test("OpenHolidays NL 2028 verified-schema fixture: eleven dates, Dutch weekdays and API provenance", async () => {
  const { client, calls } = holidayClient();
  const result = await holidaysTool({ country: "Netherlands" }, config, client, { now });
  assert.equal(result.year, 2028);
  assert.equal(result.holidays.length, 11);
  assert.equal(result.holidays[0].display_name, "Nieuwjaarsdag");
  assert.equal(result.holidays[0].weekday, "zaterdag");
  assert.equal(result.holidays[0].nationwide, true);
  assert.equal(result.holidays[0].regional, false);
  assert.equal(result.holidays[0].temporalScope, "FullDay");
  assert.match(result.source, /validFrom=2028-01-01&validTo=2028-12-31/);
  assert.match(result.notice, /niet automatisch recht/);
  assert.equal((await holidaysTool({ country: "Dutch", year: 2028 }, config, client, { now })).cache.hit, true);
  assert.ok(calls.every((url) => !url.includes("Dutch") && !url.includes("Netherlands")));
});

test("OpenHolidays BE 2026 real fixture has twelve nationwide holidays and no API subdivisions", async () => {
  const { client } = holidayClient();
  const result = await holidaysTool({ country: "België", year: 2026 }, config, client, { now });
  assert.equal(result.holidays.length, 12);
  assert.ok(result.holidays.every((item) => item.nationwide && !item.regional));
  const subdivisions = await holidaysTool({ action: "subdivisions", country: "BE" }, config, client, { now });
  assert.equal(subdivisions.subdivisions.length, 0);
  await assert.rejects(holidaysTool({ country: "BE", subdivision: "invalid" }, config, client, { now }), { code: "INVALID_SUBDIVISION" });
});

test("OpenHolidays dynamic country names with English fallback; unsupported year/country are explicit", async () => {
  const { client, calls } = holidayClient();
  const countries = await holidaysTool({ action: "countries" }, config, client, { now });
  assert.equal(countries.countries.find((item) => item.isoCode === "DE").display_name, "Germany");
  await assert.rejects(holidaysTool({ country: "Germany", year: 2028 }, config, client, { now }), { code: "UNSUPPORTED_YEAR" });
  assert.ok(calls.some((url) => url.includes("countryIsoCode=DE")));
  await assert.rejects(holidaysTool({ country: "XX" }, config, client, { now }), { code: "UNSUPPORTED_COUNTRY" });
  await assert.rejects(holidaysTool({ country: "NL", year: 1999 }, config, client, { now }), { code: "INVALID_INPUT" });
  await assert.rejects(holidaysTool({ country: "NL", year: "2028" }, config, client, { now }), { code: "INVALID_INPUT" });
});

test("OpenHolidays English country-name fallback is fetched only when the NL list does not resolve a name", async () => {
  const calls = [];
  const client = createSourceClient({ now, fetchImpl: async (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname === "/Countries") return response([{ isoCode: "DE", name: [{ language: url.searchParams.get("languageIsoCode"), text: url.searchParams.get("languageIsoCode") === "EN" ? "Germany" : "Duitsland" }], officialLanguages: ["DE"] }]);
    return response([]);
  } });
  await assert.rejects(holidaysTool({ country: "Germany", year: 2028 }, config, client, { now }), { code: "UNSUPPORTED_YEAR" });
  assert.ok(calls.some((url) => url.includes("languageIsoCode=EN")));
  assert.ok(calls.some((url) => url.includes("countryIsoCode=DE")));
});

test("OpenHolidays synthetic regional response preserves scope and only accepts API-listed subdivisions", async () => {
  const national = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/utility-tools/holidays-nl-2028.json")))[0];
  const regions = [{ code: "NL-TEST-A", shortName: "A", name: [{ language: "NL", text: "Testregio A" }] }, { code: "NL-TEST-B", shortName: "B", name: [{ language: "NL", text: "Testregio B" }] }];
  const client = createSourceClient({ now, fetchImpl: async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/Countries") return response([{ isoCode: "NL", name: [{ language: "NL", text: "Nederland" }], officialLanguages: ["NL"] }]);
    if (url.pathname === "/Subdivisions") return response(regions);
    return response([national, { ...national, id: "synthetic-region-a", nationwide: false, regionalScope: "Regional", subdivisions: [regions[0]] }, { ...national, id: "synthetic-region-b", nationwide: false, regionalScope: "Regional", subdivisions: [regions[1]] }]);
  } });
  const all = await holidaysTool({ year: 2028 }, config, client, { now });
  assert.equal(all.holidays.length, 3);
  assert.equal(all.holidays.find((item) => !item.nationwide).regionalScope, "Regional");
  const selected = await holidaysTool({ year: 2028, subdivision: "Testregio A" }, config, client, { now });
  assert.equal(selected.subdivision, "NL-TEST-A");
  assert.equal(selected.holidays.length, 2);
  assert.ok(selected.holidays.every((item) => item.nationwide || item.subdivisions[0].code === "NL-TEST-A"));
});

test("OpenHolidays errors/invalid source data are explicit and never replaced with local holidays", async () => {
  const countries = [{ isoCode: "NL", name: [{ language: "NL", text: "Nederland" }], officialLanguages: ["NL"] }];
  for (const broken of [{}, [{ id: "bad", type: "Public", nationwide: true, name: [{ language: "NL", text: "Ongeldige datum" }], startDate: "2028-02-30", endDate: "2028-02-30" }]]) {
    const client = createSourceClient({ now, fetchImpl: async (raw) => response(new URL(raw).pathname === "/Countries" ? countries : broken) });
    await assert.rejects(holidaysTool({ country: "NL", year: 2028 }, config, client, { now }), { code: "SOURCE_INVALID_RESPONSE" });
  }
  const unavailable = createSourceClient({ now, fetchImpl: async () => response("unavailable", 503) });
  await assert.rejects(holidaysTool({ country: "NL", year: 2028 }, config, unavailable, { now }), { code: "SOURCE_HTTP_ERROR" });
});

test("repository default JSON stays image-only and admin compose/env/build carry utility settings", () => {
  const root = path.resolve(__dirname, "../..");
  for (const file of ["overlay/defaults/orchestrator-config.json", "services/admin-overlay/admin/defaults/orchestrator-config.json"]) {
    const defaults = JSON.parse(fs.readFileSync(path.join(root, file)));
    assert.equal(defaults.tools, undefined);
    assert.equal(defaults.default_timezone, undefined);
  }
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8").split("  govchat-overlay-admin:")[1].split("  pgadmin:")[0];
  const env = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  for (const name of Object.keys(config.tools)) {
    assert.ok(compose.includes(`N8N_ORCHESTRATOR_ENABLE_${name.toUpperCase()}`));
    assert.ok(env.includes(`N8N_ORCHESTRATOR_ENABLE_${name.toUpperCase()}=true`));
  }
  assert.ok(compose.includes("N8N_ORCHESTRATOR_DEFAULT_TIMEZONE"));
  assert.ok(env.includes("N8N_ORCHESTRATOR_DEFAULT_TIMEZONE=Europe/Amsterdam"));
  const dockerfile = fs.readFileSync(path.join(root, "services/admin-overlay/admin/Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("COPY lib/ ./lib/"));
  assert.ok(dockerfile.includes("npm ci --omit=dev"));
});

test("authenticated handler rejects missing/bad token, disabled policy and calculator without any fetch", async () => {
  let fetches = 0;
  let current = config;
  const client = createSourceClient({ fetchImpl: async () => { fetches++; return response(rss); } });
  const invoke = async (token, supplied, tool, body = {}) => {
    const result = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return this; } };
    const handler = createUtilityHandler({ token, extractToken: () => supplied, readConfig: () => current, client, now });
    await handler({ params: { tool }, body }, result);
    return result;
  };
  assert.equal((await invoke("", "", "time")).value.error.code, "AUTH_NOT_CONFIGURED");
  assert.equal((await invoke("secret", "bad", "time")).statusCode, 401);
  assert.equal((await invoke("secret", "secret", "calculator")).statusCode, 404);
  for (const tool of ["nos_news", "l1_news", "holidays", "time"]) {
    current = mergeConfig({ tools: { [tool]: false } }, config);
    const result = await invoke("secret", "secret", tool);
    assert.equal(result.statusCode, 403);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, "TOOL_DISABLED");
  }
  assert.equal(fetches, 0);
  current = config;
  assert.equal((await invoke("secret", "secret", "time")).value.ok, true);
  assert.equal(safeTokenEqual("secret", "secret"), true);
  assert.equal(safeTokenEqual("secret-more", "secret"), false);
});

test("editor renders/persists all five booleans and timezone without losing image settings", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../services/admin-overlay/admin/views/orchestrator-editor.html"), "utf8");
  const elements = new Map();
  for (const id of ["displayName", "nameSave", "nameReset", "nameStatus", "masterPrompt", "promptSave", "promptReset", "promptPreview", "promptStatus", "masterPromptPreview", "orchestrator-seed", "orchestratorImageDataUrlMaxChars", "orchestratorImageMaxResolutionPx", "orchestratorDefaultTimezone", "documentMaxChars", "documentMaxBytes", "documentMaxCount", "documentTimeoutMs", ...Object.keys(config.tools).map((tool) => "tool-" + tool)]) {
    let value = "";
    elements.set(id, { get value() { return value; }, set value(next) { value = String(next); }, checked: false,
      checkValidity: () => Number.isSafeInteger(Number(value)) && Number(value) > 0,
      textContent: id === "orchestrator-seed" ? JSON.stringify({ ...config, tools: { ...config.tools, time: false } }) : "" });
  }
  const document = { getElementById: (id) => elements.get(id) };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n");
  const context = vm.createContext({ document, fetch: async url => ({ ok: true, json: async () => url.endsWith('/name') ? { display_name: 'Testnaam', source: 'default' } : ({ prompt: "Testprompt", source: "default" }) }) });
  vm.runInContext(scripts, context);
  await vm.runInContext("loadPrompt()", context);
  assert.equal(elements.get("tool-time").checked, false);
  assert.equal(elements.get("tool-calculator").checked, true);
  elements.get("tool-nos_news").checked = false;
  elements.get("orchestratorDefaultTimezone").value = "UTC";
  elements.get("documentMaxChars").value = "2000000";
  vm.runInContext("readForm()", context);
  const saved = JSON.parse(vm.runInContext("JSON.stringify(orchestratorData)", context));
  assert.equal(saved.tools.nos_news, false);
  assert.equal(saved.tools.time, false);
  assert.equal(saved.default_timezone, "UTC");
  assert.equal(saved.image_data_url_max_chars, config.image_data_url_max_chars);
  assert.equal(saved.documents.max_chars, 2000000);
  assert.equal(saved.documents.max_count, 10);
});

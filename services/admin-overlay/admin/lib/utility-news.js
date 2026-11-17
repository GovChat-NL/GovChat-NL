"use strict";

const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { Parser } = require("htmlparser2");
const { ToolError, invalid, text } = require("./utility-common");

const NOS = [
  ["algemeen", "nosnieuwsalgemeen", ["nieuws", "general"]],
  ["binnenland", "nosnieuwsbinnenland", ["nederland", "domestic"]],
  ["buitenland", "nosnieuwsbuitenland", ["internationaal", "world"]],
  ["politiek", "nosnieuwspolitiek", []], ["economie", "nosnieuwseconomie", ["economisch"]],
  ["opmerkelijk", "nosnieuwsopmerkelijk", []], ["koningshuis", "nosnieuwskoningshuis", ["royalty"]],
  ["cultuur_en_media", "nosnieuwscultuurenmedia", ["cultuur", "cultuur en media", "media"]],
  ["tech", "nosnieuwstech", ["technologie", "techniek"]],
  ["sport", "nossportalgemeen", ["sport algemeen"]], ["voetbal", "nosvoetbal", []],
  ["wielrennen", "nossportwielrennen", []], ["schaatsen", "nossportschaatsen", []],
  ["tennis", "nossporttennis", []], ["formule1", "nossportformule1", ["formule 1", "f1"]],
  ["nieuwsuur", "nieuwsuuralgemeen", []], ["nosop3", "nosop3", ["nos op 3", "op3"]],
  ["jeugdjournaal", "jeugdjournaal", ["jeugd"]],
];
const L1 = [
  ["nieuws", "index.xml", ["algemeen", "limburg"]], ["sport", "sport.xml", []],
  ["112", "112.xml", ["incidenten", "politie", "nooddiensten"]],
  ["cultuur_en_media", "cultuurenmedia.xml", ["cultuur", "cultuur en media", "media"]],
];
const CATEGORIES = Object.freeze({
  nos_news: NOS.map(([category, path, aliases]) => ({ category, aliases, url: `https://feeds.nos.nl/${path}` })),
  l1_news: L1.map(([category, path, aliases]) => ({ category, aliases, url: `https://www.l1nieuws.nl/rss/${path}` })),
});
const urls = new Set(Object.values(CATEGORIES).flat().map((entry) => entry.url));
function allowedFeed(url) { return urls.has(url.href) && !url.username && !url.password; }

function plainText(value, maximum = 1500) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let output = "";
  let hidden = 0;
  const parser = new Parser({
    onopentag(name) { if (["script", "style"].includes(name)) hidden++; else if (!hidden) output += " "; },
    ontext(chunk) { if (!hidden) output += chunk; },
    onclosetag(name) { if (["script", "style"].includes(name) && hidden) hidden--; else if (!hidden) output += " "; },
  }, { decodeEntities: true });
  parser.end(String(value));
  return output.replace(/[\s\u0000-\u001f]+/g, " ").trim().slice(0, maximum);
}
function safeLink(value) {
  try {
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function parseFeed(xml) {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid RSS XML or forbidden DTD/entities", 502);
  }
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, parseTagValue: false, trimValues: true, isArray: (name) => name === "item" });
  let parsed;
  try { parsed = parser.parse(xml); } catch { throw new ToolError("SOURCE_INVALID_RESPONSE", "Invalid RSS XML", 502); }
  if (!parsed?.rss?.channel || typeof parsed.rss.channel !== "object") throw new ToolError("SOURCE_INVALID_RESPONSE", "Source is not an RSS feed", 502);
  const items = parsed.rss.channel.item || [];
  return items.slice(0, 500).map((item) => {
    const timestamp = Date.parse(item.pubDate);
    return {
      title: plainText(item.title, 300), link: safeLink(item.link),
      published_at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      snippet: plainText(item.description || item["content:encoded"] || ""),
    };
  }).filter((item) => item.title && item.link)
    .sort((a, b) => (b.published_at || "").localeCompare(a.published_at || "") || a.link.localeCompare(b.link));
}
async function newsTool(tool, body, client) {
  const categories = CATEGORIES[tool];
  const action = body.action ?? "headlines";
  if (action === "categories") return { ok: true, action, tool, categories, source: tool === "nos_news" ? "https://nos.nl/feeds" : "https://www.l1nieuws.nl/rss/index.xml" };
  if (!["headlines", "search", "news"].includes(action)) invalid("Unsupported news action");
  const category = body.category === undefined ? categories[0].category : text(body.category, "category", 80).toLocaleLowerCase("nl");
  const selected = categories.find((entry) => entry.category === category || entry.aliases.includes(category));
  if (!selected) invalid("Unknown category; request categories for supported values");
  const limit = body.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid("limit must be an integer from 1 to 50");
  if (body.query !== undefined && (typeof body.query !== "string" || body.query.length > 200)) invalid("query must be a string of at most 200 characters");
  const query = (body.query || "").trim().toLocaleLowerCase("nl");
  if (action === "search" && !query) invalid("search requires query");
  const result = await client.get(selected.url, { ttl: 300000, allowed: allowedFeed, format: "xml" });
  const items = parseFeed(result.data).filter((item) => !query || `${item.title} ${item.snippet}`.toLocaleLowerCase("nl").includes(query)).slice(0, limit);
  return { ok: true, tool, action, category: selected.category, items, order: "newest_first", source: result.source, fetched_at: result.fetched_at, cache: result.cache };
}

module.exports = { CATEGORIES, allowedFeed, plainText, parseFeed, newsTool };

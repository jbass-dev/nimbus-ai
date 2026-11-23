// Pure helpers for Research Mode: URL de-duplication, publication dates,
// rule-based credibility scoring, relevant-passage selection and rank fusion.
// No network, no state, so every rule here is unit-tested.
//
// Credibility is an ESTIMATE from the domain and a few page signals. It says
// "how much scrutiny does this source deserve", not "is this claim true". The
// research tool says so in its output, and the synthesis prompt repeats it.
import { jaccard, scoreRelevance, tokenSet } from "./text.mjs";

const TRACKING_PARAM = /^(utm_|mc_|fbclid$|gclid$|msclkid$|ref$|ref_src$|igshid$|cmpid$|ocid$)/i;

/** A stable key for "the same page": no www, fragment, tracking params, trailing slash or scheme. */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const pathname = u.pathname.replace(/\/amp\/?$/i, "").replace(/\/+$/, "") || "";
  return `${host}${pathname}${query}`;
}

export function domainOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---- Publication dates -------------------------------------------------------

const META_DATE_KEYS = [
  "article:published_time", "og:article:published_time", "datepublished", "date", "pubdate", "publishdate",
  "publish-date", "dc.date.issued", "dc.date", "parsely-pub-date", "sailthru.date", "citation_publication_date", "citation_date",
];
const META_MODIFIED_KEYS = ["article:modified_time", "og:updated_time", "datemodified", "last-modified", "dc.date.modified"];

export function toIsoDate(value, now = Date.now()) {
  if (!value) return null;
  const d = new Date(String(value).trim());
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const year = d.getUTCFullYear();
  if (year < 1990 || t > now + 86_400_000) return null; // before the web, or in the future
  return d.toISOString().slice(0, 10);
}

function metaContent(html, keys) {
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!name || !keys.includes(name)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) return content;
  }
  return null;
}

/** Publication and last-updated dates (YYYY-MM-DD or null) from meta tags, JSON-LD, <time> or the URL path. */
export function extractDates(html, url = "", now = Date.now()) {
  const src = String(html ?? "");
  const head = src.slice(0, 200_000);
  let published = toIsoDate(metaContent(head, META_DATE_KEYS), now);
  let updated = toIsoDate(metaContent(head, META_MODIFIED_KEYS), now);
  if (!published) published = toIsoDate(head.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1], now);
  if (!updated) updated = toIsoDate(head.match(/"dateModified"\s*:\s*"([^"]+)"/i)?.[1], now);
  if (!published) published = toIsoDate(head.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i)?.[1], now);
  if (!published) {
    const p = String(url).match(/\/((?:19|20)\d{2})\/(0?[1-9]|1[0-2])(?:\/(0?[1-9]|[12]\d|3[01]))?(?:\/|$)/);
    if (p) published = toIsoDate(`${p[1]}-${p[2].padStart(2, "0")}-${(p[3] ?? "01").padStart(2, "0")}`, now);
  }
  return { published, updated };
}

/** Whole days between an ISO date and `now`, or null. */
export function ageDays(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 86_400_000));
}

export function isTimeSensitive(question) {
  return /\b(latest|current(ly)?|newest|recent(ly)?|today|this (week|month|year)|now|upcoming|new|202\d|price|pricing|release[ds]?|version)\b/i.test(String(question ?? ""));
}

// ---- Credibility -------------------------------------------------------------

const HIGH_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "npr.org", "nature.com", "science.org", "arxiv.org", "who.int",
  "w3.org", "ietf.org", "mozilla.org", "developer.mozilla.org", "nytimes.com", "wsj.com", "ft.com", "bloomberg.com",
  "theguardian.com", "economist.com", "washingtonpost.com", "pewresearch.org", "acm.org", "ieee.org", "nist.gov",
];
const TECH_PRESS = ["arstechnica.com", "theverge.com", "wired.com", "techcrunch.com", "infoq.com", "zdnet.com", "venturebeat.com", "tomshardware.com", "anandtech.com"];
const PRIMARY_HOSTS = ["github.com", "gitlab.com", "docs.github.com", "stackoverflow.com"];
const USER_GENERATED = ["reddit.com", "quora.com", "pinterest.com", "facebook.com", "x.com", "twitter.com", "tiktok.com", "youtube.com", "answers.yahoo.com"];
const SELF_PUBLISHED = ["medium.com", "substack.com", "blogspot.com", "wordpress.com", "dev.to", "hashnode.dev", "linkedin.com"];
const hostIs = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * @returns {{score: number, tier: "high"|"medium"|"low", reasons: string[]}}
 * score is 0.05–0.95. Reasons are plain language so the report can show them.
 */
export function credibility(url, { title = "", published = null } = {}) {
  const host = domainOf(url);
  const reasons = [];
  let score = 0.5;
  const add = (delta, why) => { score += delta; reasons.push(why); };

  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) add(0.35, "government site");
  else if (/\.edu(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host)) add(0.3, "academic institution");
  else if (hostIs(host, HIGH_DOMAINS)) add(0.3, "established news, standards or research outlet");
  else if (hostIs(host, TECH_PRESS)) add(0.2, "established technology press");
  else if (hostIs(host, PRIMARY_HOSTS)) add(0.15, "primary source or developer community");
  else if (host.startsWith("docs.") || host.startsWith("developer.") || host.startsWith("developers.") || /(^|\.)documentation\./.test(host)) add(0.2, "official documentation");
  else if (host.endsWith("wikipedia.org")) add(0.1, "reference work (check its own citations)");
  else if (hostIs(host, USER_GENERATED)) add(-0.2, "user-generated content");
  else if (hostIs(host, SELF_PUBLISHED)) add(-0.05, "self-published platform");

  if (/\b(top \d+|best \d+|\d+ best|ultimate guide|you won'?t believe|sponsored|deals?)\b/i.test(title)) add(-0.1, "listicle or promotional-style title");
  if (/^http:\/\//i.test(String(url))) add(-0.1, "not served over HTTPS");
  if (!published) add(-0.05, "no publication date found");

  score = Math.min(0.95, Math.max(0.05, Math.round(score * 100) / 100));
  return { score, tier: score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low", reasons };
}

// ---- Passages, duplicates, ranking ---------------------------------------------

/** The sentences of `text` most relevant to the question (best first), each trimmed. */
export function bestPassages(text, question, { k = 3, maxChars = 330 } = {}) {
  const sentences = String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 700);
  const scored = sentences
    .map((s, i) => ({ s, i, score: scoreRelevance(question, s) + (/\d/.test(s) ? 0.03 : 0) }))
    .filter((x) => x.score > 0.03)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k);
  const picked = scored.length ? scored.map((x) => x.s) : sentences.slice(0, 2);
  return picked.map((s) => (s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s));
}

/** Near-identical content (syndicated or copied articles): index of the earlier match, or -1. */
export function findDuplicate(text, earlierTexts, threshold = 0.8) {
  const mine = tokenSet(String(text).slice(0, 1500));
  if (mine.size < 12) return -1;
  for (let i = 0; i < earlierTexts.length; i++) {
    if (jaccard(mine, tokenSet(String(earlierTexts[i]).slice(0, 1500))) >= threshold) return i;
  }
  return -1;
}

/** Reciprocal-rank fusion over several ranked URL lists: pages that rank well for more queries rise. */
export function fuseRankings(lists) {
  const byKey = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = normalizeUrl(item.url);
      if (!key) return;
      const cur = byKey.get(key) ?? { key, item, rrf: 0, hits: 0 };
      cur.rrf += 1 / (60 + rank);
      cur.hits++;
      // Prefer the entry that carries a publication date or a longer snippet.
      if (!cur.item.published && item.published) cur.item = { ...cur.item, published: item.published };
      if ((item.snippet ?? "").length > (cur.item.snippet ?? "").length) cur.item = { ...cur.item, snippet: item.snippet };
      byKey.set(key, cur);
    });
  }
  return [...byKey.values()].sort((a, b) => b.rrf - a.rrf);
}

/** Pick the sources worth reading: relevance across queries + credibility + (for time-sensitive questions) recency, max 2 per domain. */
export function selectSources(fused, { question, limit = 6, now = Date.now(), maxPerDomain = 2 } = {}) {
  const sensitive = isTimeSensitive(question);
  const top = fused[0]?.rrf || 1;
  const scored = fused.map((f) => {
    const cred = credibility(f.item.url, { title: f.item.title, published: f.item.published });
    const age = ageDays(f.item.published && toIsoDate(f.item.published, now), now);
    const recency = sensitive && age != null ? 0.15 * Math.exp(-age / 180) : 0;
    return { ...f, score: 0.5 * (f.rrf / top) + 0.35 * cred.score + recency };
  });
  scored.sort((a, b) => b.score - a.score);
  const perDomain = new Map();
  const out = [];
  for (const s of scored) {
    const d = domainOf(s.item.url);
    if ((perDomain.get(d) ?? 0) >= maxPerDomain) continue;
    perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

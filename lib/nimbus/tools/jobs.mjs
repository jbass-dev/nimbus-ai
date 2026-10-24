// search_jobs: real openings from free, key-less public job APIs.
//
//   Remotive  https://remotive.com/api/remote-jobs   (asks for ≤ a few calls/day, >2/min blocked)
//   RemoteOK  https://remoteok.com/api               (attribution + link back required)
//   Jobicy    https://jobicy.com/api/v2/remote-jobs
//   Arbeitnow https://www.arbeitnow.com/api/job-board-api
//
// Every listing returned comes from a provider response — nothing is
// generated. Salaries are only reported when the provider lists one; jobs
// without a salary are separated out instead of being guessed. Provider
// responses are cached (default 2h) to respect their rate limits.
import { fetchJson } from "../net.mjs";
import { htmlToText, truncate } from "../util.mjs";
import { tokenize } from "../text.mjs";

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const cache = new Map(); // url -> { at, data }

export function clearJobCache() {
  cache.clear();
}

async function cachedJson(url, net, now) {
  const hit = cache.get(url);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await fetchJson(url, net);
  cache.set(url, { at: now(), data });
  return data;
}

// ---- Salary parsing -------------------------------------------------------

const CURRENCY = { $: "USD", "€": "EUR", "£": "GBP", usd: "USD", eur: "EUR", gbp: "GBP", cad: "CAD", aud: "AUD" };

/**
 * Parse free-text salaries like "$60k - $80k", "USD 120,000–140,000/yr",
 * "$45/hr", "€50K". Returns { min, max, currency, period, annualMin, annualMax } or null.
 */
export function parseSalary(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/,/g, "").trim();
  if (!s || /competitive|negotiable|doe|tbd|n\/a/.test(s) && !/\d/.test(s)) return null;
  const curMatch = s.match(/[$€£]|\b(usd|eur|gbp|cad|aud)\b/);
  const currency = curMatch ? CURRENCY[curMatch[0]] : null;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(k|m)?/g)]
    .map((m) => Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1))
    .filter((n) => n >= 5);
  if (!nums.length) return null;
  let period = "year";
  if (/(\/|per |an? )\s*(hr|hour)|hourly/.test(s)) period = "hour";
  else if (/(\/|per |a )\s*(mo|month)|monthly/.test(s)) period = "month";
  else if (nums.every((n) => n < 300)) period = "hour";
  const min = Math.min(...nums.slice(0, 2));
  const max = Math.max(...nums.slice(0, 2));
  const factor = period === "hour" ? 2080 : period === "month" ? 12 : 1;
  return { min, max, currency: currency ?? "USD", currencyAssumed: !currency, period, annualMin: min * factor, annualMax: max * factor };
}

function fromNumbers(min, max, currency = "USD") {
  const a = Number(min) || 0;
  const b = Number(max) || 0;
  if (!a && !b) return null;
  const lo = a || b;
  const hi = b || a;
  return { min: lo, max: hi, currency: currency || "USD", currencyAssumed: !currency, period: "year", annualMin: lo, annualMax: hi };
}

// ---- Providers → normalised listings -------------------------------------

function norm(job) {
  return {
    title: String(job.title ?? "").trim(),
    company: String(job.company ?? "").trim(),
    location: job.location ? String(job.location).trim() : null,
    remote: job.remote ?? null,
    salary: job.salary ?? null,
    url: job.url,
    applyUrl: job.applyUrl ?? null,
    source: job.source,
    postedAt: job.postedAt ? new Date(job.postedAt).toISOString() : null,
    tags: (job.tags ?? []).map(String).slice(0, 12),
    excerpt: truncate(htmlToText(job.description ?? ""), 280),
    _haystack: `${job.title} ${(job.tags ?? []).join(" ")} ${htmlToText(job.description ?? "").slice(0, 3000)}`,
  };
}

const PROVIDERS = {
  async remotive(q, net, now) {
    const term = q.terms.slice(0, 3).join(" ") || "developer";
    const data = await cachedJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=100`, net, now);
    if (!Array.isArray(data?.jobs)) throw new Error("Malformed response (no jobs array)");
    return data.jobs.map((j) =>
      norm({
        title: j.title, company: j.company_name, location: j.candidate_required_location, remote: true,
        salary: parseSalary(j.salary), url: j.url, source: "Remotive", postedAt: j.publication_date,
        tags: [j.category, j.job_type, ...(j.tags ?? [])].filter(Boolean), description: j.description,
      })
    );
  },
  async remoteok(q, net, now) {
    const data = await cachedJson("https://remoteok.com/api", net, now);
    if (!Array.isArray(data)) throw new Error("Malformed response (expected array)");
    return data
      .filter((j) => j && j.position && j.url)
      .map((j) =>
        norm({
          title: j.position, company: j.company, location: j.location || "Remote", remote: true,
          salary: fromNumbers(j.salary_min, j.salary_max, "USD"),
          url: j.url, applyUrl: j.apply_url && /^https?:/.test(j.apply_url) ? j.apply_url : null,
          source: "RemoteOK", postedAt: j.date ?? (j.epoch ? j.epoch * 1000 : null), tags: j.tags, description: j.description,
        })
      );
  },
  async jobicy(q, net, now) {
    const tag = q.terms[0] ? `&tag=${encodeURIComponent(q.terms[0])}` : "";
    const data = await cachedJson(`https://jobicy.com/api/v2/remote-jobs?count=50${tag}`, net, now);
    if (!Array.isArray(data?.jobs)) throw new Error("Malformed response (no jobs array)");
    return data.jobs.map((j) =>
      norm({
        title: j.jobTitle, company: j.companyName, location: j.jobGeo, remote: true,
        salary: fromNumbers(j.annualSalaryMin ?? j.salaryMin, j.annualSalaryMax ?? j.salaryMax, j.salaryCurrency),
        url: j.url, source: "Jobicy", postedAt: j.pubDate,
        tags: [...(j.jobIndustry ?? []), ...(j.jobType ?? []), j.jobLevel].filter(Boolean),
        description: j.jobExcerpt ?? j.jobDescription,
      })
    );
  },
  async arbeitnow(q, net, now) {
    const data = await cachedJson("https://www.arbeitnow.com/api/job-board-api", net, now);
    if (!Array.isArray(data?.data)) throw new Error("Malformed response (no data array)");
    return data.data.map((j) =>
      norm({
        title: j.title, company: j.company_name, location: j.location, remote: Boolean(j.remote),
        salary: null, url: j.url, source: "Arbeitnow", postedAt: j.created_at ? j.created_at * 1000 : null,
        tags: [...(j.tags ?? []), ...(j.job_types ?? [])], description: j.description,
      })
    );
  },
};

const GENERIC = new Set(["job", "remote", "salary", "search", "openings", "work", "hire", "hiring", "position", "new", "entry", "level", "paying", "least", "minimum", "min", "plus", "year", "annual"]);

// Role nouns are soft: "react developer" should match "React Engineer".
const SOFT = new Set(["developer", "engineer", "dev", "programmer", "software", "coder", "specialist"]);

export function buildQuery(args) {
  const all = tokenize(args.query).filter((t) => !GENERIC.has(t) && !/^\$?\d+k?$/.test(t));
  const hard = all.filter((t) => !SOFT.has(t));
  return { terms: hard.length ? hard : all };
}

function matchesTerms(job, terms) {
  if (!terms.length) return true;
  const hay = new Set(tokenize(job._haystack));
  const titleTokens = new Set(tokenize(`${job.title} ${job.tags.join(" ")}`));
  // Every term must appear somewhere; at least one must be in title/tags.
  return terms.every((t) => hay.has(t)) && terms.some((t) => titleTokens.has(t));
}

function locationOk(job, location) {
  if (!location) return true;
  const loc = String(job.location ?? "").toLowerCase();
  const want = String(location).toLowerCase();
  if (!loc || /worldwide|anywhere|global/.test(loc)) return true;
  if (/^(us|usa|united states|america)$/.test(want)) return /\b(us|usa|united states|america|north america|americas)\b/.test(loc);
  return loc.includes(want);
}

export const searchJobsTool = {
  name: "search_jobs",
  description:
    "Search CURRENT real job openings from public job boards (Remotive, RemoteOK, Jobicy, Arbeitnow). Use whenever the user wants to find/see/search jobs, including a bare 'job search' — fill unspecified fields from the user's saved preferences. Returns real listings with links; never add listings that are not in the results.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Role/skills keywords, e.g. 'react developer' or 'frontend engineer'", minLength: 2, maxLength: 120 },
      remote_only: { type: "boolean", description: "Only remote jobs (default true)" },
      min_salary: { type: "integer", minimum: 0, maximum: 1000000, description: "Minimum annual salary in USD, e.g. 60000" },
      location: { type: "string", maxLength: 60, description: "Candidate location restriction to honour, e.g. 'US'" },
      max_results: { type: "integer", minimum: 1, maximum: 15, description: "Default 8" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  untrustedOutput: true,
  permissionGroup: "jobs",
  describePermission: (args) => `Search job boards for “${args.query}”${args.remote_only !== false ? " (remote only)" : ""}${args.min_salary ? ` paying ≥ $${Number(args.min_salary).toLocaleString("en-US")}` : ""}`,
  timeoutMs: 20000,
  async run(args, ctx) {
    const now = ctx.now ?? (() => Date.now());
    const net = { fetchImpl: ctx.fetchImpl, lookup: ctx.lookup, signal: ctx.signal, timeoutMs: 12000 };
    const q = buildQuery(args);
    const remoteOnly = args.remote_only !== false;
    const max = Math.min(15, Math.max(1, args.max_results ?? 8));
    const minSalary = args.min_salary ?? null;

    const names = Object.keys(PROVIDERS);
    const settled = await Promise.allSettled(names.map((n) => PROVIDERS[n](q, net, now)));
    const providerStatus = [];
    let all = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        providerStatus.push({ source: names[i], ok: true, fetched: r.value.length });
        all.push(...r.value);
      } else {
        providerStatus.push({ source: names[i], ok: false, error: r.reason?.message ?? String(r.reason) });
      }
    });
    if (!providerStatus.some((p) => p.ok)) {
      const e = new Error(`All job sources failed: ${providerStatus.map((p) => `${p.source}: ${p.error}`).join("; ")}`);
      e.details = providerStatus;
      throw e;
    }

    const seen = new Set();
    all = all.filter((j) => {
      if (!j.title || !j.url || !/^https?:\/\//.test(j.url)) return false;
      const k = `${j.company.toLowerCase()}|${j.title.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const matched = all.filter((j) => (!remoteOnly || j.remote !== false) && matchesTerms(j, q.terms) && locationOk(j, args.location));
    const byDate = (a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? "");
    let meets = matched;
    let salaryUnlisted = [];
    let belowMin = 0;
    if (minSalary) {
      meets = matched.filter((j) => j.salary && j.salary.annualMax >= minSalary);
      salaryUnlisted = matched.filter((j) => !j.salary);
      belowMin = matched.filter((j) => j.salary && j.salary.annualMax < minSalary).length;
    }
    meets.sort(byDate);
    salaryUnlisted.sort(byDate);

    const strip = (j) => {
      const copy = { ...j };
      delete copy._haystack;
      return copy;
    };
    const results = meets.slice(0, max).map(strip);
    const unlisted = salaryUnlisted.slice(0, Math.max(0, Math.min(5, max - results.length))).map(strip);
    return {
      query: args.query,
      filters: { remote_only: remoteOnly, min_salary: minSalary, location: args.location ?? null, keywords: q.terms },
      results,
      salary_not_listed: minSalary ? unlisted : undefined,
      counts: { scanned: all.length, matched_keywords: matched.length, meets_salary: minSalary ? meets.length : undefined, below_min_salary: minSalary ? belowMin : undefined },
      providers: providerStatus,
      notes: [
        "url = the job board listing; applyUrl (when present) = the application link the provider supplied.",
        "Salary appears only when the employer listed one. Do not estimate salaries for listings without one.",
        results.length + unlisted.length === 0 ? "No matching openings were found. Tell the user and suggest broadening the search; do not invent listings." : null,
      ].filter(Boolean),
    };
  },
  summarize(result) {
    const n = result.results.length;
    const extra = result.salary_not_listed?.length ? ` (+${result.salary_not_listed.length} without listed salary)` : "";
    const okSources = result.providers.filter((p) => p.ok).length;
    return `${n} matching opening${n === 1 ? "" : "s"}${extra} from ${okSources}/${result.providers.length} job boards`;
  },
};

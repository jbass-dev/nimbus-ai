import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { searchJobsTool, parseSalary, clearJobCache } from "../lib/nimbus/tools/jobs.mjs";
import { webSearchTool, fetchUrlTool, parseDuckDuckGoHtml } from "../lib/nimbus/tools/web.mjs";
import { assertPublicUrl, isPrivateAddress } from "../lib/nimbus/net.mjs";
import { validateArgs } from "../lib/nimbus/tools/index.mjs";
import { mockFetch, fakeLookup } from "./helpers.mjs";

// Fixtures shaped like the real provider payloads (field names from each API's docs).
const REMOTIVE = {
  "0-legal-notice": "…",
  "job-count": 3,
  jobs: [
    { id: 1, url: "https://remotive.com/remote-jobs/software-dev/senior-react-engineer-1", title: "Senior React Engineer", company_name: "Acme", category: "Software Development", tags: ["react", "typescript"], job_type: "full_time", publication_date: "2026-10-20T10:00:00", candidate_required_location: "USA", salary: "$90k - $120k", description: "<p>Build React apps</p>" },
    { id: 2, url: "https://remotive.com/remote-jobs/software-dev/react-dev-2", title: "React Developer", company_name: "LowPay Co", category: "Software Development", tags: ["react"], publication_date: "2026-10-19T10:00:00", candidate_required_location: "Worldwide", salary: "$40,000 - $50,000", description: "React" },
    { id: 3, url: "https://remotive.com/remote-jobs/software-dev/frontend-3", title: "Frontend Engineer (React)", company_name: "NoSalary Inc", category: "Software Development", tags: ["react"], publication_date: "2026-10-21T10:00:00", candidate_required_location: "Worldwide", salary: "", description: "React + Next.js" },
  ],
};
const REMOTEOK = [
  { legal: "API terms" },
  { id: "9", position: "Full Stack React Developer", company: "Globex", location: "Remote", tags: ["react", "node"], salary_min: 70000, salary_max: 95000, url: "https://remoteok.com/remote-jobs/9", apply_url: "https://globex.example/careers/9", date: "2026-10-22T08:00:00Z", description: "React and Node" },
  { id: "10", position: "Python Data Engineer", company: "Initech", location: "Remote", tags: ["python"], salary_min: 100000, salary_max: 130000, url: "https://remoteok.com/remote-jobs/10", date: "2026-10-22T08:00:00Z", description: "Python" },
];
const JOBICY = { jobs: [{ id: 5, url: "https://jobicy.com/jobs/5-react", jobTitle: "React Native Developer", companyName: "Umbrella", jobGeo: "USA", jobIndustry: ["Dev"], jobType: ["full-time"], pubDate: "2026-10-18 09:00:00", annualSalaryMin: 65000, annualSalaryMax: 85000, salaryCurrency: "USD", jobExcerpt: "React Native mobile" }] };
const ARBEITNOW = { data: [{ slug: "x", company_name: "Berlin GmbH", title: "React Developer (onsite)", remote: false, url: "https://www.arbeitnow.com/jobs/x", tags: ["react"], location: "Berlin", created_at: 1792000000, description: "React" }] };

const ALL_OK = { "remotive.com/api": REMOTIVE, "remoteok.com/api": REMOTEOK, "jobicy.com/api": JOBICY, "arbeitnow.com/api": ARBEITNOW };
const ctx = (fetchImpl) => ({ fetchImpl, lookup: fakeLookup() });

beforeEach(() => clearJobCache());

test("search_jobs: real listings, salary floor honoured, unknown salaries separated (not guessed)", async () => {
  const r = await searchJobsTool.run({ query: "react developer", min_salary: 60000 }, ctx(mockFetch(ALL_OK)));
  const titles = r.results.map((j) => j.title);
  assert.ok(titles.includes("Senior React Engineer"));
  assert.ok(titles.includes("Full Stack React Developer"));
  assert.ok(titles.includes("React Native Developer"));
  assert.ok(!titles.includes("React Developer"), "below-floor job excluded");
  assert.ok(!titles.some((t) => /Python/.test(t)), "keyword filter");
  assert.ok(!titles.some((t) => /onsite/.test(t)), "remote filter");
  assert.deepEqual(r.salary_not_listed.map((j) => j.title), ["Frontend Engineer (React)"]);
  assert.equal(r.salary_not_listed[0].salary, null);
  // every link is one the provider returned
  const urls = new Set([...REMOTIVE.jobs.map((j) => j.url), ...REMOTEOK.slice(1).map((j) => j.url), JOBICY.jobs[0].url]);
  for (const j of [...r.results, ...r.salary_not_listed]) assert.ok(urls.has(j.url), j.url);
  assert.equal(r.results.find((j) => j.company === "Globex").applyUrl, "https://globex.example/careers/9");
  assert.equal(r.counts.below_min_salary, 1);
  // newest first
  assert.equal(r.results[0].title, "Full Stack React Developer");
});

test("search_jobs: partial provider failure is reported, results still returned", async () => {
  const f = mockFetch({ ...ALL_OK, "remoteok.com/api": { __status: 503 }, "jobicy.com/api": "<html>oops</html>" });
  const r = await searchJobsTool.run({ query: "react" }, ctx(f));
  const status = Object.fromEntries(r.providers.map((p) => [p.source, p.ok]));
  assert.deepEqual(status, { remotive: true, remoteok: false, jobicy: false, arbeitnow: true });
  assert.ok(r.results.length > 0);
  assert.match(searchJobsTool.summarize(r), /2\/4 job boards/);
});

test("search_jobs: all providers failing throws an honest error", async () => {
  const f = mockFetch({ "remotive.com": new Error("ECONNRESET"), "remoteok.com": { __status: 500 }, "jobicy.com": { __status: 429 }, "arbeitnow.com": { __status: 502 } });
  await assert.rejects(searchJobsTool.run({ query: "react" }, ctx(f)), /All job sources failed/);
});

test("search_jobs: no matches → empty results with explicit no-invention note", async () => {
  const r = await searchJobsTool.run({ query: "cobol mainframe" }, ctx(mockFetch(ALL_OK)));
  assert.equal(r.results.length, 0);
  assert.ok(r.notes.some((n) => /do not invent/.test(n)));
});

test("search_jobs: provider responses are cached (rate-limit friendly)", async () => {
  const f = mockFetch(ALL_OK);
  await searchJobsTool.run({ query: "react" }, ctx(f));
  const n = f.calls.length;
  await searchJobsTool.run({ query: "react", min_salary: 50000 }, ctx(f));
  assert.equal(f.calls.length, n);
});

test("parseSalary handles common formats", () => {
  assert.deepEqual([parseSalary("$60k - $80k").annualMin, parseSalary("$60k - $80k").annualMax], [60000, 80000]);
  assert.equal(parseSalary("USD 120,000–140,000/yr").annualMax, 140000);
  const hr = parseSalary("$45/hr");
  assert.equal(hr.period, "hour");
  assert.equal(hr.annualMin, 45 * 2080);
  assert.equal(parseSalary("€50K").currency, "EUR");
  assert.equal(parseSalary("Competitive"), null);
  assert.equal(parseSalary(""), null);
});

test("web_search: DuckDuckGo fallback parses real result markup and unwraps redirect links", async () => {
  const html = `<div class="result results_links web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnextjs.org%2Fblog%2Fnext-16&amp;rut=x">Next.js 16 | Next.js</a></h2><a class="result__snippet" href="#">Next.js 16 is <b>here</b>.</a></div>
    <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad">Ad</a></div>`;
  assert.deepEqual(parseDuckDuckGoHtml(html), [{ title: "Next.js 16 | Next.js", url: "https://nextjs.org/blog/next-16", snippet: "Next.js 16 is here.", published: null }]);
  const r = await webSearchTool.run({ query: "next.js 16" }, { ...ctx(mockFetch({ "html.duckduckgo.com": html })), env: {} });
  assert.equal(r.provider, "duckduckgo");
  assert.equal(r.results[0].url, "https://nextjs.org/blog/next-16");
});

test("web_search: prefers Brave when keyed, falls back on failure and reports it", async () => {
  const html = `<div class="result"><a class="result__a" href="https://example.org/a">A</a><a class="result__snippet">s</a></div>`;
  const f = mockFetch({ "api.search.brave.com": { __status: 401 }, "html.duckduckgo.com": html });
  const r = await webSearchTool.run({ query: "x y" }, { ...ctx(f), env: { BRAVE_API_KEY: "k" } });
  assert.equal(r.provider, "duckduckgo");
  assert.equal(r.failedProviders[0].provider, "brave");
});

test("web_search: bot-check page is a failure, not 'no results'", async () => {
  const f = mockFetch({ "html.duckduckgo.com": "<html>Unfortunately, bots use DuckDuckGo too. anomaly</html>" });
  await assert.rejects(webSearchTool.run({ query: "x" }, { ...ctx(f), env: {} }), /bot check/);
});

test("fetch_url: extracts readable text and title", async () => {
  const f = mockFetch({ "example.com": "<html><head><title>Hello &amp; bye</title><script>evil()</script></head><body><h1>Head</h1><p>Para one.</p></body></html>" });
  const r = await fetchUrlTool.run({ url: "https://example.com/x" }, ctx(f));
  assert.equal(r.title, "Hello & bye");
  assert.match(r.text, /Head\nPara one\./);
  assert.doesNotMatch(r.text, /evil/);
});

test("SSRF guard blocks localhost, private ranges, odd schemes and private redirects", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress("93.184.216.34"));
  await assert.rejects(assertPublicUrl("http://localhost:3000/api/memory"), /Local/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /Only http/);
  await assert.rejects(assertPublicUrl("http://internal.corp/", { lookup: fakeLookup({ "internal.corp": "10.1.2.3" }) }), /private/);
  const f = mockFetch({ "evil.example": { __status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } } });
  await assert.rejects(fetchUrlTool.run({ url: "https://evil.example/" }, ctx(f)), /private|Local/);
});

test("argument validation coerces sane input and rejects bad input", () => {
  const schema = searchJobsTool.parameters;
  assert.deepEqual(validateArgs(schema, { query: "react", min_salary: "$60,000", remote_only: "true", bogus: 1 }), {
    ok: true, value: { query: "react", min_salary: 60000, remote_only: true },
  });
  assert.equal(validateArgs(schema, { query: "react", min_salary: "60k" }).value.min_salary, 60000);
  assert.match(validateArgs(schema, {}).error, /Missing required argument "query"/);
  assert.match(validateArgs(schema, { query: "r", min_salary: -5 }).error, /too short|≥ 0/);
  assert.match(validateArgs(schema, []).error, /JSON object/);
});

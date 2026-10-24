import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { normalizePermissions } from "../lib/nimbus/permissions.mjs";
import { webSearchTool, parseDomains, searchFilters } from "../lib/nimbus/tools/web.mjs";
import { searchChatsTool, searchChatArchive } from "../lib/nimbus/tools/chats.mjs";
import { validateArgs } from "../lib/nimbus/tools/index.mjs";
import { freshStore, userKey, scriptedLlm, mockFetch, fakeLookup, collector } from "./helpers.mjs";

const DDG = `<div class="result"><a class="result__a" href="https://github.com/a">A</a><a class="result__snippet">s</a></div>
  <div class="result"><a class="result__a" href="https://medium.com/b">B</a><a class="result__snippet">s</a></div>`;

test("web_search filters: domains parse, values clamp, schema accepts the new params", () => {
  assert.deepEqual(parseDomains("https://www.GitHub.com/x, stackoverflow.com  not a domain"), ["github.com", "stackoverflow.com"]);
  const f = searchFilters({ max_results: 50, time_range: "week", region: "US" });
  assert.equal(f.count, 20);
  assert.equal(f.timeRange, "week");
  assert.equal(f.region, "us");
  const v = validateArgs(webSearchTool.parameters, { query: "react 19", time_range: "month", sites: "github.com", region: "gb", max_results: "15" });
  assert.equal(v.ok, true);
  assert.match(validateArgs(webSearchTool.parameters, { query: "x y", time_range: "decade" }).error, /one of/);
  assert.match(validateArgs(webSearchTool.parameters, { query: "x y", region: "usa" }).error, /invalid format/);
});

test("web_search: Brave gets freshness, country, count and site operators", async () => {
  let seen = "";
  const f = mockFetch({ "api.search.brave.com": (url) => { seen = String(url); return { web: { results: [{ title: "A", url: "https://github.com/a", description: "d" }] } }; } });
  const r = await webSearchTool.run(
    { query: "react hooks", time_range: "week", region: "us", max_results: 15, sites: "github.com", exclude_sites: "medium.com" },
    { fetchImpl: f, lookup: fakeLookup(), env: { BRAVE_API_KEY: "k" } }
  );
  const u = new URL(seen);
  assert.equal(u.searchParams.get("freshness"), "pw");
  assert.equal(u.searchParams.get("country"), "US");
  assert.equal(u.searchParams.get("count"), "15");
  assert.match(u.searchParams.get("q"), /site:github\.com/);
  assert.match(u.searchParams.get("q"), /-site:medium\.com/);
  assert.equal(r.filters.time_range, "week");
});

test("web_search: Tavily gets time_range and domain lists; region it can't apply is reported", async () => {
  let body = null;
  const f = mockFetch({ "api.tavily.com": (_u, init) => { body = JSON.parse(init.body); return { results: [{ title: "A", url: "https://github.com/a", content: "c" }] }; } });
  const r = await webSearchTool.run(
    { query: "react hooks", time_range: "day", sites: "github.com", exclude_sites: "medium.com", region: "us" },
    { fetchImpl: f, lookup: fakeLookup(), env: { TAVILY_API_KEY: "k" } }
  );
  assert.equal(body.time_range, "day");
  assert.deepEqual(body.include_domains, ["github.com"]);
  assert.deepEqual(body.exclude_domains, ["medium.com"]);
  assert.match(r.filters.region_note, /tavily/);
});

test("web_search: DuckDuckGo gets df/kl, and site filters are enforced on results", async () => {
  let seen = "";
  const f = mockFetch({ "html.duckduckgo.com": (url) => { seen = String(url); return DDG; } });
  const r = await webSearchTool.run({ query: "hooks", time_range: "month", region: "de", sites: "github.com" }, { fetchImpl: f, lookup: fakeLookup(), env: {} });
  const u = new URL(seen);
  assert.equal(u.searchParams.get("df"), "m");
  assert.equal(u.searchParams.get("kl"), "de-de");
  assert.deepEqual(r.results.map((x) => x.url), ["https://github.com/a"], "off-site result dropped");
});

const ARCHIVE = [
  { id: "c1", title: "Resume for Affirm", messages: [{ role: "user", content: "Tailor my resume for the Affirm search team role" }, { role: "assistant", content: "Here is a version that leads with Nimbus and StoryForge." }] },
  { id: "c2", title: "Pasta recipe", messages: [{ role: "user", content: "How long do I boil penne?" }] },
];

test("search_chats: finds the matching past chat, nothing for unrelated queries", async () => {
  const hits = searchChatArchive(ARCHIVE, "affirm resume");
  assert.equal(hits[0].chatId, "c1");
  assert.equal(hits.length, 1);
  assert.deepEqual(searchChatArchive(ARCHIVE, "kubernetes helm"), []);
  const r = await searchChatsTool.run({ query: "penne" }, { chatArchive: ARCHIVE });
  assert.equal(r.results[0].title, "Pasta recipe");
  await assert.rejects(searchChatsTool.run({ query: "penne" }, {}), /weren't shared/);
});

test("permissions: normalize keeps only known groups", () => {
  const p = normalizePermissions({ always: ["web", "nope"], once: ["chats"] });
  assert.deepEqual(p.always, ["web"]);
  assert.ok(p.granted("web") && p.granted("chats") && !p.granted("jobs"));
  assert.equal(normalizePermissions(undefined), null);
});

async function setup(script) {
  const { store } = await freshStore();
  const emit = collector();
  const fetchImpl = mockFetch({ "html.duckduckgo.com": DDG });
  const llm = scriptedLlm(script);
  const run = (permissions, extra = {}) =>
    runAgent({ messages: [{ role: "user", content: "search the web for react hooks" }], model: "m", userKey: userKey(), store, llm, emit, fetchImpl, lookup: fakeLookup(), env: {}, permissions, ...extra });
  return { emit, fetchImpl, run };
}

test("ask every time: a search without permission is not run and a permission prompt is emitted", async () => {
  const { emit, fetchImpl, run } = await setup([
    { toolCalls: [{ name: "web_search", args: { query: "react hooks", time_range: "week" } }] },
    { content: "should not be reached" },
  ]);
  const out = await run(normalizePermissions({}));
  assert.equal(fetchImpl.calls.length, 0, "no network call before permission");
  const [perm] = emit.of("permission");
  assert.equal(perm.requests[0].group, "web");
  assert.match(perm.requests[0].description, /react hooks.*past week/);
  assert.match(out.text, /permission/);
  assert.doesNotMatch(out.text, /should not be reached/);
});

test("allow once / always allow: the search runs", async () => {
  for (const perms of [{ once: ["web"] }, { always: ["web"] }]) {
    const { emit, fetchImpl, run } = await setup([
      { toolCalls: [{ name: "web_search", args: { query: "react hooks" } }] },
      { content: "Found it: https://github.com/a" },
    ]);
    const out = await run(normalizePermissions(perms));
    assert.ok(fetchImpl.calls.length > 0);
    assert.equal(emit.of("permission").length, 0);
    assert.match(out.text, /Found it/);
  }
});

test("a grant for one group doesn't cover another (web allowed, chats still asks)", async () => {
  const { emit, run } = await setup([
    { toolCalls: [{ name: "search_chats", args: { query: "affirm" } }] },
    { content: "x" },
  ]);
  await run(normalizePermissions({ always: ["web"] }), { chatArchive: ARCHIVE });
  assert.equal(emit.of("permission")[0].requests[0].group, "chats");
});

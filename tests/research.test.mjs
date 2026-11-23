// Research Mode: helpers, the research tool against a mocked web, history, and the agent loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { DEFAULT_TOOLS } from "../lib/nimbus/tools/index.mjs";
import { researchTool } from "../lib/nimbus/tools/research.mjs";
import { createResearchStore } from "../lib/nimbus/research-store.mjs";
import { classifyIntent } from "../lib/nimbus/intent.mjs";
import { citationStats } from "../lib/nimbus/evalchecks.mjs";
import {
  normalizeUrl, extractDates, credibility, bestPassages, findDuplicate, fuseRankings, selectSources, isTimeSensitive, ageDays,
} from "../lib/nimbus/research.mjs";
import { freshStore, userKey, tempDir, scriptedLlm, mockFetch, fakeLookup, collector } from "./helpers.mjs";

// ---- helpers ----------------------------------------------------------------
test("normalizeUrl treats tracking variants as the same page and ignores non-web URLs", () => {
  const a = normalizeUrl("https://www.Example.com/post/?utm_source=x&id=7#top");
  assert.equal(a, normalizeUrl("http://example.com/post?id=7&fbclid=abc"));
  assert.equal(normalizeUrl("https://example.com/post?id=8") === a, false, "real query params still distinguish pages");
  assert.equal(normalizeUrl("https://example.com/post/amp/"), normalizeUrl("https://example.com/post"));
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("extractDates reads meta tags, JSON-LD, <time> and URL paths, and rejects nonsense", () => {
  const now = Date.parse("2026-11-23");
  const d = (html, url) => extractDates(html, url, now);
  assert.deepEqual(d('<meta property="article:published_time" content="2026-10-01T09:00:00Z"><meta property="article:modified_time" content="2026-11-02">', ""), { published: "2026-10-01", updated: "2026-11-02" });
  assert.equal(d('<script type="application/ld+json">{"datePublished":"2025-02-03T00:00:00+00:00"}</script>', "").published, "2025-02-03");
  assert.equal(d('<time datetime="2024-07-04">July</time>', "").published, "2024-07-04");
  assert.equal(d("<html></html>", "https://x.com/2021/03/05/post").published, "2021-03-05");
  assert.equal(d('<meta name="date" content="2031-01-01">', "").published, null, "future dates are rejected");
  assert.equal(d('<meta name="date" content="garbage">', "").published, null);
  assert.equal(ageDays("2026-11-13", now), 10);
});

test("credibility is higher for primary and established sources, lower for user-generated and listicles", () => {
  const c = (url, opts = { published: "2026-01-01" }) => credibility(url, opts);
  assert.equal(c("https://www.reuters.com/a").tier, "high");
  assert.equal(c("https://www.cdc.gov/a").tier, "high");
  assert.equal(c("https://docs.python.org/3/").tier, "medium", "official docs are above neutral");
  assert.ok(c("https://docs.python.org/3/").score > c("https://random-blog.example.com/a").score);
  assert.equal(c("https://www.reddit.com/r/x").tier, "low");
  assert.ok(c("https://blog.example.com/a", { title: "Top 10 best tools you won't believe", published: "2026-01-01" }).score < c("https://blog.example.com/a").score);
  assert.ok(c("http://blog.example.com/a").reasons.includes("not served over HTTPS"));
  assert.ok(c("https://blog.example.com/a", { published: null }).reasons.includes("no publication date found"));
  for (const u of ["https://www.cdc.gov/a", "https://www.reddit.com/r/x"]) {
    const { score } = c(u);
    assert.ok(score >= 0.05 && score <= 0.95);
  }
});

test("bestPassages returns the sentences that answer the question", () => {
  const text = "The company was founded in a garage in 2009 by two friends. Pricing starts at $20 per month for the Pro plan, with a free tier. Their offices are in several countries around the world. The Pro plan price includes unlimited completions and chat.";
  const p = bestPassages(text, "what does the Pro plan cost per month", { k: 2 });
  assert.equal(p.length, 2);
  assert.ok(p.every((s) => /Pro plan/.test(s)));
  assert.ok(bestPassages("Short.", "anything").length === 0);
});

test("findDuplicate spots copied content but not different articles", () => {
  const a = "AI coding assistants have become a standard part of developer workflows in 2026 and pricing varies widely between vendors and tiers for teams";
  const b = "Pricing for vector databases depends on storage, index type and query volume, and managed offerings add per-hour costs for dedicated clusters";
  assert.equal(findDuplicate(a, [b, a]), 1);
  assert.equal(findDuplicate(a, [b]), -1);
});

test("fuseRankings lifts pages that rank for several queries and merges URL variants", () => {
  const l1 = [{ url: "https://a.com/x", title: "A" }, { url: "https://b.com/y", title: "B" }];
  const l2 = [{ url: "https://www.b.com/y?utm_source=z", title: "B", published: "2026-05-01" }, { url: "https://c.com/z", title: "C" }];
  const fused = fuseRankings([l1, l2]);
  assert.equal(fused.length, 3);
  assert.equal(fused[0].key, "b.com/y");
  assert.equal(fused[0].hits, 2);
  assert.equal(fused[0].item.published, "2026-05-01", "keeps the date from whichever list had it");
});

test("selectSources caps results per domain and prefers credible sources", () => {
  const fused = fuseRankings([[
    { url: "https://blog.example.com/1", title: "one" }, { url: "https://blog.example.com/2", title: "two" }, { url: "https://blog.example.com/3", title: "three" },
    { url: "https://www.reuters.com/x", title: "reuters" },
  ]]);
  const picked = selectSources(fused, { question: "anything", limit: 4 });
  assert.equal(picked.filter((p) => p.item.url.includes("blog.example.com")).length, 2);
  assert.ok(picked.some((p) => p.item.url.includes("reuters")));
});

test("time-sensitive questions are recognised", () => {
  assert.equal(isTimeSensitive("What is the latest version of Next.js?"), true);
  assert.equal(isTimeSensitive("How do closures work?"), false);
});

// ---- the tool against a mocked web ---------------------------------------------
const NOW = Date.parse("2026-11-23T12:00:00Z");
const ddg = (rows) => rows.map(([url, title, snippet]) => `<div class="result results_links"><h2><a class="result__a" href="${url}">${title}</a></h2><a class="result__snippet" href="${url}">${snippet}</a></div>`).join("");
const page = (title, published, body) => `<html><head><title>${title}</title>${published ? `<meta property="article:published_time" content="${published}">` : ""}</head><body><p>${body}</p></body></html>`;

const REUTERS_BODY = "AI coding assistants now cost about $20 per month for individual developers in 2026. Several vendors offer free tiers with limited completions each month. Team plans add admin controls and usage analytics for engineering managers. Independent benchmarks show the leading assistants solve a similar share of tasks.";
const BLOG_BODY = "Our hands-on week with three coding assistants found that the cheapest option saved time on boilerplate. Context window size mattered more than raw model quality for large repositories. Enterprise buyers should negotiate seat pricing separately because list prices rarely apply.";
const OLD_BODY = "Back in 2021 autocomplete tools were new and expensive for most developers. Few teams trusted generated code without careful review at the time. Pricing was mostly flat and there were almost no free tiers available anywhere.";

function web({ failBroken = true } = {}) {
  return mockFetch({
    "html.duckduckgo.com": (url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      return /pricing/i.test(q)
        ? ddg([["https://www.reuters.com/tech/ai-coding-2026/?utm_source=feed", "AI coding prices", "about $20 per month"], ["https://copycat.example.org/same-story", "Copied story", "about $20 per month"]])
        : ddg([
            ["https://www.reuters.com/tech/ai-coding-2026/", "AI coding assistants compared", "assistants compared"],
            ["https://techblog.example.com/week-with-assistants", "A week with coding assistants", "hands-on"],
            ["https://oldblog.example.com/2021/03/05/autocomplete", "Autocomplete in 2021", "old"],
            ["https://brokenpage.example.net/assistants", "Broken page", "snippet text about assistants and pricing tiers"],
          ]);
    },
    "reuters.com/tech/ai-coding-2026": page("AI coding assistants compared", "2026-10-01T09:00:00Z", REUTERS_BODY),
    "copycat.example.org": page("Copied story", null, REUTERS_BODY),
    "techblog.example.com": page("A week with coding assistants", "2026-09-12", BLOG_BODY),
    "oldblog.example.com": page("Autocomplete in 2021", null, OLD_BODY),
    "brokenpage.example.net": failBroken ? { __status: 500, body: "boom" } : page("Fixed", null, BLOG_BODY),
  });
}

async function toolCtx(extra = {}) {
  const dir = await tempDir();
  const researchStore = createResearchStore({ dataDir: dir });
  return { ctx: { fetchImpl: web(), lookup: fakeLookup(), now: () => NOW, userKey: userKey(), researchStore, researchIds: [], ...extra }, researchStore };
}
const QUESTION = "Compare the latest AI coding assistants and which offers the best value";

test("research reads distinct sources, removes duplicates, dates and scores them", async () => {
  const { ctx } = await toolCtx();
  const r = await researchTool.run({ question: QUESTION, extra_queries: "AI coding assistant pricing | AI coding assistant pricing" }, ctx);

  assert.equal(r.queries_run.length, 2, "repeated angle is dropped");
  const byDomain = Object.fromEntries(r.sources.map((s) => [s.domain, s]));
  assert.deepEqual(Object.keys(byDomain).sort(), ["brokenpage.example.net", "oldblog.example.com", "reuters.com", "techblog.example.com"]);
  assert.equal(r.duplicate_pages_removed.length, 1, "the copied article is dropped");
  assert.match(r.duplicate_pages_removed[0].url, /copycat/);

  assert.equal(byDomain["reuters.com"].published, "2026-10-01");
  assert.equal(byDomain["reuters.com"].credibility.tier, "high");
  assert.ok(byDomain["reuters.com"].passages.some((p) => /\$20 per month/.test(p)));
  assert.equal(byDomain["techblog.example.com"].published, "2026-09-12");

  assert.equal(byDomain["oldblog.example.com"].published, "2021-03-05", "date recovered from the URL path");
  assert.equal(byDomain["oldblog.example.com"].stale_for_this_topic, true);
  assert.equal(byDomain["reuters.com"].stale_for_this_topic, undefined);

  assert.match(byDomain["brokenpage.example.net"].read, /snippet only/);
  assert.match(byDomain["brokenpage.example.net"].passages[0], /snippet text/);
  assert.equal(r.unreadable.length, 1);

  assert.deepEqual(r.sources.map((s) => s.id), [1, 2, 3, 4]);
  assert.equal(r.coverage.distinct_domains, 4);
  assert.equal(r.coverage.read_in_full, 3);
  assert.equal(r.coverage.thin, false);
  assert.match(r.credibility_note, /not whether a claim is true/);
});

test("research records the run in history, without page text", async () => {
  const { ctx, researchStore } = await toolCtx();
  await researchTool.run({ question: QUESTION }, ctx);
  const [entry] = await researchStore.list(ctx.userKey);
  assert.equal(entry.question, QUESTION);
  assert.ok(entry.sources.length >= 3);
  assert.ok(entry.sources.every((s) => s.url && s.title && "tier" in s));
  assert.ok(!JSON.stringify(entry).includes("per month for individual developers"), "no page text stored");
  assert.equal(ctx.researchIds[0], entry.id);
});

test("research works when one search angle fails, and fails clearly when all do", async () => {
  const flaky = mockFetch({
    "html.duckduckgo.com": (url) => (/pricing/.test(url) ? new Error("network down") : ddg([["https://techblog.example.com/week-with-assistants", "A week", "hands-on"]])),
    "techblog.example.com": page("A week", "2026-09-12", BLOG_BODY),
  });
  const { ctx } = await toolCtx({ fetchImpl: flaky });
  const r = await researchTool.run({ question: QUESTION, extra_queries: "AI coding assistant pricing" }, ctx);
  assert.equal(r.sources.length, 1);
  assert.equal(r.coverage.thin, true);
  assert.equal(r.search_errors.length, 1);

  const { ctx: dead } = await toolCtx({ fetchImpl: mockFetch({ "html.duckduckgo.com": new Error("network down") }) });
  await assert.rejects(() => researchTool.run({ question: QUESTION }, dead), /could not search the web/);
});

test("pages on private addresses are never fetched (SSRF guard applies to research too)", async () => {
  const f = mockFetch({
    "html.duckduckgo.com": ddg([["http://169.254.169.254/latest/meta-data", "metadata", "creds"], ["https://techblog.example.com/week-with-assistants", "A week", "hands-on"]]),
    "techblog.example.com": page("A week", "2026-09-12", BLOG_BODY),
  });
  const { ctx } = await toolCtx({ fetchImpl: f });
  const r = await researchTool.run({ question: QUESTION }, ctx);
  assert.ok(!f.calls.some((u) => u.includes("169.254")), "metadata endpoint never requested");
  assert.ok(r.unreadable?.some((u) => u.url.includes("169.254")));
});

// ---- history store ------------------------------------------------------------
test("research history: attach summary, search by topic, isolation, caps and clear", async () => {
  const dir = await tempDir();
  const store = createResearchStore({ dataDir: dir });
  const u = userKey("a");
  const id = await store.add(u, { question: "Which vector database is best for small apps?", queries: ["q"], sources: [{ id: 1, url: "https://x.com/a", title: "Vector DB guide", published: "2026-01-01", tier: "medium" }] });
  assert.ok(id.startsWith("res_"));
  assert.equal(await store.attachSummary(u, id, "Use SQLite with a vector extension [1]."), true);
  assert.equal((await store.search(u, "vector database"))[0].summary, "Use SQLite with a vector extension [1].");
  assert.equal((await store.search(u, "kubernetes networking")).length, 0);
  assert.equal((await store.search(userKey("b"), "vector database")).length, 0, "other users see nothing");
  assert.equal(await store.add(u, { question: "my password is hunter2 and card 4111 1111 1111 1111", sources: [] }), null, "sensitive questions are not recorded");
  for (let i = 0; i < 55; i++) await store.add(u, { question: `question number ${i} about topics`, sources: [] });
  assert.equal((await store.list(u)).length, 50);
  assert.ok((await store.clear(u)) > 0);
  assert.equal((await store.list(u)).length, 0);
});

// ---- the agent loop -----------------------------------------------------------
test("deep-research questions are routed to the research tool, normal lookups are not", () => {
  for (const t of [
    "Compare the latest AI coding assistants and determine which offers the best value.",
    "Do deep research on vector databases for a small app",
    "Give me a comprehensive report on Next.js hosting providers",
  ]) assert.deepEqual([classifyIntent(t).intent, classifyIntent(t).forcedTool], ["deep_research", "research"], t);
  assert.equal(classifyIntent("What's the latest stable version of Next.js?").intent, "research");
  assert.equal(classifyIntent("Compare Postgres and SQLite trade-offs for a small desktop app").intent, "chat");
  assert.equal(classifyIntent("fix this error, compare the best options in my code").intent, "code_fix", "code questions never become deep research");
});

test("agent: research once, cited report is kept in history and can be recalled later", async () => {
  const { store } = await freshStore();
  const dir = await tempDir();
  const researchStore = createResearchStore({ dataDir: dir });
  const u = userKey();
  const report = "Pricing is about $20 per month [1], and a hands-on test favours the cheapest tier [2].\n\n[1] AI coding assistants compared (reuters.com) https://www.reuters.com/tech/ai-coding-2026/\n[2] A week with coding assistants (techblog.example.com) https://techblog.example.com/week-with-assistants";
  const llm = scriptedLlm([
    { toolCalls: [{ name: "research", args: { question: QUESTION } }] },
    { content: report },
  ]);
  const emit = collector();
  const base = { model: "m", userKey: u, store, researchStore, fetchImpl: web(), lookup: fakeLookup(), now: () => NOW, tools: DEFAULT_TOOLS, emit };
  const { text, metrics } = await runAgent({ ...base, llm, messages: [{ role: "user", content: `${QUESTION}.` }] });

  assert.deepEqual(llm.requests[0].toolChoice, { type: "function", function: { name: "research" } });
  assert.match(llm.requests[0].messages[0].content, /Call `research` ONCE/);
  assert.deepEqual(metrics.toolCalls.map((c) => c.name), ["research"], "one research call, no search pile-up");
  assert.equal(text, report);
  const toolPayload = JSON.parse(llm.requests[1].messages.find((m) => m.role === "tool").content);
  assert.equal(toolPayload.untrusted_external_data, true, "web evidence is marked untrusted");
  const stats = citationStats(text);
  assert.ok(stats.markers >= 2 && stats.domains >= 2);

  const [saved] = await researchStore.list(u);
  assert.equal(saved.summary, report, "the written report is stored with its run");

  // A later chat can find it.
  const llm2 = scriptedLlm([{ toolCalls: [{ name: "research_history", args: { query: "AI coding assistants" } }] }, { content: "Here is what we found earlier." }]);
  await runAgent({ ...base, llm: llm2, messages: [{ role: "user", content: "What did we find out earlier about AI coding assistants?" }] });
  const recalled = JSON.parse(llm2.requests[1].messages.find((m) => m.role === "tool").content);
  assert.equal(recalled.result.entries[0].summary, report);
  assert.match(recalled.result.note, /out of date/);
});

test("a long-running tool may exceed the default tool timeout, others may not", async () => {
  const { store } = await freshStore();
  const make = (longRunning) => ({ name: "slow", description: "slow", parameters: { type: "object", properties: {} }, longRunning, timeoutMs: 600, run: () => new Promise((r) => setTimeout(() => r({ ok: 1 }), 150)) });
  const runWith = async (tool) => {
    const llm = scriptedLlm([{ toolCalls: [{ name: "slow", args: {} }] }, { content: "done" }]);
    const { toolRuns } = await runAgent({ messages: [{ role: "user", content: "go" }], model: "m", userKey: userKey(), store, llm, tools: [tool], limits: { toolTimeoutMs: 50, maxToolTimeoutMs: 1000 } });
    return toolRuns[0];
  };
  assert.equal((await runWith(make(true))).ok, true);
  assert.equal((await runWith(make(false))).ok, false);
});

test("citationStats counts distinct markers and linked domains", () => {
  assert.deepEqual(citationStats("A [1] and B [2], again [1]. [1] x https://a.com/p, [2] y https://www.b.com/q. [link](https://c.com)"), { markers: 2, domains: 3 });
});

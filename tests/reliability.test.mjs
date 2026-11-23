// Agent reliability: tool-call syntax written as text, stalled tools, rewording loops, blank replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { createLeakFilter, extractTextToolCalls } from "../lib/nimbus/toolmarkup.mjs";
import { freshStore, userKey, scriptedLlm, collector } from "./helpers.mjs";

const searchTool = (runs, result = (q) => ({ results: [{ title: q, url: "https://example.com" }] })) => ({
  name: "web_search",
  description: "search",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  run: async (args) => {
    runs.push(args.query);
    return result(args.query);
  },
});

async function go(script, { tools, limits, content = "what were the NFL scores" } = {}) {
  const { store } = await freshStore();
  const llm = scriptedLlm(script);
  const emit = collector();
  const out = await runAgent({ messages: [{ role: "user", content }], model: "m", userKey: userKey(), store, llm, emit, tools, limits });
  const streamed = emit.of("token").map((e) => e.text).join("");
  return { llm, emit, streamed, ...out };
}

test("a tool call written as text is recovered and run, and the markup never reaches the chat", async () => {
  const runs = [];
  const { streamed, text, metrics } = await go(
    [
      { content: 'Let me check.\n<tool_call>{"name":"web_search","arguments":{"query":"nfl scores sunday"}}</tool_call>' },
      { content: "The Bills won." },
    ],
    { tools: [searchTool(runs)] }
  );
  assert.deepEqual(runs, ["nfl scores sunday"]);
  assert.ok(!/tool_call|"name"/.test(streamed), `leaked: ${streamed}`);
  assert.ok(!/tool_call/.test(text));
  assert.match(text, /The Bills won/);
  assert.equal(metrics.leakedToolSyntax, 1);
});

test("a bare JSON tool call as the whole reply is recovered and not shown", async () => {
  const runs = [];
  const { streamed } = await go(
    [{ content: '{"name":"web_search","parameters":{"query":"nfl scores"}}' }, { content: "Here you go." }],
    { tools: [searchTool(runs)] }
  );
  assert.deepEqual(runs, ["nfl scores"]);
  assert.ok(!streamed.includes('"name"'), streamed);
});

test("tool markup on the forced final step is not executed or shown; the user gets an honest message", async () => {
  const runs = [];
  const { text, streamed } = await go(
    [{ content: '<function=web_search>{"query":"nfl"}</function>' }],
    { tools: [searchTool(runs)], limits: { maxSteps: 1 } }
  );
  assert.equal(runs.length, 0);
  assert.ok(!/function=/.test(streamed + text));
  assert.match(text, /couldn't produce a reply/);
});

test("reworded repeat searches are skipped, then the model is made to answer", async () => {
  const runs = [];
  const { llm, text } = await go(
    [
      { toolCalls: [{ name: "web_search", args: { query: "nfl scores week 12" } }] },
      { toolCalls: [{ name: "web_search", args: { query: "nfl scores week 12 results" } }] },
      { toolCalls: [{ name: "web_search", args: { query: "week 12 nfl scores" } }] },
      { content: "I couldn't find final scores." },
    ],
    { tools: [searchTool(runs)] }
  );
  assert.equal(runs.length, 1, "only the first search ran");
  assert.equal(llm.requests[3].tools, undefined, "tools are withdrawn after the loop stalls");
  assert.match(text, /couldn't find final scores/);
});

test("a search with different filters is not treated as a duplicate", async () => {
  const runs = [];
  const tool = searchTool(runs);
  tool.parameters.properties.time_range = { type: "string" };
  await go(
    [
      { toolCalls: [{ name: "web_search", args: { query: "nfl scores", time_range: "day" } }] },
      { toolCalls: [{ name: "web_search", args: { query: "nfl scores", time_range: "week" } }] },
      { content: "done" },
    ],
    { tools: [tool] }
  );
  assert.equal(runs.length, 2);
});

test("a tool that keeps returning nothing is cut off after three tries", async () => {
  const runs = [];
  const empty = { ...searchTool(runs, () => ({ results: [] })), name: "lookup" };
  const queries = ["alpha one", "beta two", "gamma three", "delta four"];
  const { llm, metrics } = await go(
    [...queries.map((q) => ({ toolCalls: [{ name: "lookup", args: { query: q } }] })), { content: "Nothing found." }],
    { tools: [empty] }
  );
  assert.equal(runs.length, 3);
  assert.equal(llm.requests[3].tools, undefined);
  assert.equal(metrics.stalled, true);
});

test("an empty model reply after tools becomes an honest message, not a blank bubble", async () => {
  const runs = [];
  const { text, emit } = await go(
    [{ toolCalls: [{ name: "web_search", args: { query: "nfl scores" } }] }, { content: "" }],
    { tools: [searchTool(runs)] }
  );
  assert.match(text, /rather not guess/);
  assert.ok(emit.of("token").some((e) => /rather not guess/.test(e.text)));
});

test("extractTextToolCalls handles common formats and leaves normal text alone", () => {
  const names = ["web_search"];
  const q = (s) => JSON.parse(extractTextToolCalls(s, names).calls[0].arguments).query;
  assert.equal(q('<function=web_search>{"query":"a"}</function>'), "a");
  assert.equal(q('[TOOL_CALLS][{"name":"web_search","arguments":{"query":"b"}}]'), "b");
  assert.equal(q('<invoke name="web_search"><parameter name="query">c</parameter></invoke>'), "c");
  assert.equal(q('<|python_tag|>{"name":"web_search","parameters":{"query":"d"}}'), "d");
  const plain = extractTextToolCalls("Use {braces} and [links](http://x) freely, a < b.", names);
  assert.equal(plain.hadMarkup, false);
  assert.equal(extractTextToolCalls('<tool_call>{"name":"nope","arguments":{}}</tool_call>', names).calls.length, 0);
});

test("the leak filter holds a split marker but doesn't swallow ordinary '<'", () => {
  let out = "";
  const f = createLeakFilter((t) => (out += t));
  for (const c of ["Hi <to", "ol_c", 'all>{"name"']) f.push(c);
  f.flush();
  assert.equal(out, "Hi ");
  out = "";
  const g = createLeakFilter((t) => (out += t));
  for (const c of ["a < b and ", "x<", "y"]) g.push(c);
  g.flush();
  assert.equal(out, "a < b and x<y");
});

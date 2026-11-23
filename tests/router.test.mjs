// Smart model routing and agent failover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, routeTask, describeRequest } from "../lib/nimbus/router.mjs";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { LlmError } from "../lib/nimbus/llm.mjs";
import { MODELS } from "../app/config/models.js";
import { freshStore, userKey, scriptedLlm, collector } from "./helpers.mjs";

test("tasks are classified from the request", () => {
  const cases = [
    [{ text: "what is this?", hasImages: true }, "vision"],
    [{ text: "summarize this", attachedChars: 50_000 }, "document"],
    [{ text: "Fix this bug: TypeError: undefined is not a function" }, "code"],
    [{ text: "Explain JavaScript closures with a short example" }, "code"],
    [{ text: "Find remote React jobs paying at least $60k" }, "research"],
    [{ text: "What's the latest stable version of Next.js?" }, "research"],
    [{ text: "What's the weather in Tulsa?" }, "light_tools"],
    [{ text: "Remember that I prefer remote jobs" }, "light_tools"],
    [{ text: "Compare Postgres and SQLite trade-offs for a small desktop app" }, "reasoning"],
    [{ text: "What's the capital of France?" }, "simple"],
    [{ text: `${"Tell me a bit about how people usually spend a quiet Sunday at home with family. ".repeat(3)}` }, "chat"],
  ];
  for (const [req, want] of cases) assert.equal(classifyTask(req), want, JSON.stringify(req).slice(0, 80));
});

test("describeRequest separates attached files from the question and spots images", () => {
  const d = describeRequest([
    { role: "user", content: "old" },
    { role: "assistant", content: "ok" },
    { role: "user", content: `Summarize <attached_file name="a.txt">${"x".repeat(100)}</attached_file> please`, images: ["data:image/png;base64,AA"] },
  ]);
  assert.equal(d.hasImages, true);
  assert.ok(d.attachedChars > 100);
  assert.equal(d.text.replace(/\s+/g, " "), "Summarize please");
});

test("chains respect each task's needs, using the real model config", () => {
  const r = (text, extra = {}, opts) => routeTask({ text, ...extra }, MODELS, opts);
  assert.equal(r("find remote react jobs").chain[0], "deepseek-v3.2", "research gets the strong tool-caller first");
  assert.equal(r("capital of France?").chain[0], "free-router", "simple questions stay free");
  const vision = r("what is this", { hasImages: true });
  assert.ok(vision.chain.every((s) => MODELS[s].vision), `vision chain: ${vision.chain}`);
  const doc = r("summarize", { attachedChars: 90_000 });
  assert.ok(doc.chain.every((s) => MODELS[s].longContext), `document chain: ${doc.chain}`);
  assert.equal(r("fix this bug: crash on startup").chain.at(-1), "free-router", "free router is the last resort");
});

test("allowPaid=false never routes to a paid model", () => {
  for (const text of ["fix this bug: crash", "find remote react jobs", "capital of France?", "compare these trade-offs"]) {
    const { chain } = routeTask({ text }, MODELS, { allowPaid: false });
    assert.ok(chain.length > 0);
    assert.ok(chain.every((s) => !MODELS[s].paid), `${text}: ${chain}`);
  }
  const doc = routeTask({ text: "summarize", attachedChars: 90_000 }, MODELS, { allowPaid: false });
  assert.deepEqual(doc.chain, ["llama-3.3-70b-free"]);
});

test("every slug the router can pick exists and has an upstream id", () => {
  const tasks = [{ text: "x", hasImages: true }, { text: "x", attachedChars: 99_999 }, { text: "fix this bug" }, { text: "latest news" }, { text: "weather in Tulsa" }, { text: "compare trade-offs" }, { text: "hi" }, { text: "y".repeat(300) }];
  for (const t of tasks) for (const paid of [true, false]) {
    const { chain } = routeTask(t, MODELS, { allowPaid: paid });
    for (const slug of chain) assert.ok(MODELS[slug]?.upstream, `${slug} for ${JSON.stringify(t).slice(0, 40)}`);
  }
});

test("with a bare config the router still returns something usable", () => {
  const { chain } = routeTask({ text: "fix this bug" }, { "free-router": { label: "Auto", upstream: "openrouter/free" } });
  assert.deepEqual(chain, ["free-router"]);
});

// ---- Failover in the agent loop ----
async function go(script, opts = {}) {
  const { store } = await freshStore();
  const llm = scriptedLlm(script);
  const emit = collector();
  const run = () => runAgent({ messages: [{ role: "user", content: "capital of France?" }], model: "primary", userKey: userKey(), store, llm, emit, ...opts });
  return { llm, emit, run };
}
const down = (status, body = "") => new LlmError(`provider ${status}`, { status, body, retryable: status === 429 || status >= 500 });
const FALLBACKS = [{ upstream: "second", label: "Second Model" }, { upstream: "third", label: "Third Model" }];

test("out-of-credit (402) fails over to the next model at once and says so", async () => {
  const { llm, emit, run } = await go([down(402), { content: "Paris." }], { fallbackModels: FALLBACKS });
  const { text, metrics } = await run();
  assert.equal(text, "Paris.");
  assert.deepEqual(llm.requests.map((r) => r.model), ["primary", "second"]);
  assert.equal(metrics.failovers, 1);
  assert.equal(metrics.modelUsed, "second");
  assert.ok(emit.of("notice").some((n) => /Second Model answered/.test(n.text)));
});

test("a persistent 5xx is retried on the same model, then fails over", async () => {
  const { llm, run } = await go([down(503), down(503), down(503), { content: "Paris." }], { fallbackModels: FALLBACKS });
  const { text } = await run();
  assert.equal(text, "Paris.");
  assert.deepEqual(llm.requests.map((r) => r.model), ["primary", "primary", "primary", "second"]);
});

test("it walks the whole chain, then surfaces the last error", async () => {
  const { llm, run } = await go([down(404), down(402), down(404)], { fallbackModels: FALLBACKS });
  await assert.rejects(run, (e) => e instanceof LlmError);
  assert.deepEqual(llm.requests.map((r) => r.model), ["primary", "second", "third"]);
});

test("a rejected API key (401) is not failed over: no other model would help", async () => {
  const { llm, run } = await go([down(401), { content: "never reached" }], { fallbackModels: FALLBACKS });
  await assert.rejects(run);
  assert.equal(llm.requests.length, 1);
});

test("a context-length rejection (400) fails over; other 400s don't", async () => {
  const ctx = await go([down(400, "maximum context length exceeded"), { content: "ok" }], { fallbackModels: FALLBACKS });
  assert.equal((await ctx.run()).text, "ok");
  const bad = await go([down(400, "invalid parameter"), { content: "never" }], { fallbackModels: FALLBACKS });
  await assert.rejects(bad.run);
});

test("without fallbacks, behaviour is unchanged: the error surfaces", async () => {
  const { run } = await go([down(402)]);
  await assert.rejects(run, (e) => e.status === 402);
});

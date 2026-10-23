// LIVE end-to-end evaluation: real OpenRouter model, real job boards, real
// web search. Nothing is mocked. Costs a few cents of OpenRouter credit.
//
//   npm run eval                       (uses OPENROUTER_KEY from .env.local)
//   npm run eval -- --model llama-3.3-70b
//   npm run eval -- --only job
//
// For each scenario it measures: did the expected tool run, did the task
// complete, is every link in the answer grounded in a tool result, did the
// model ask an unnecessary clarifying question, latency. Memory scenarios run
// as multi-turn sequences against a throwaway store.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { createOpenRouterClient } from "../lib/nimbus/llm.mjs";
import { createMemoryStore } from "../lib/nimbus/memory-store.mjs";
import { DEFAULT_TOOLS } from "../lib/nimbus/tools/index.mjs";

// app/config/models.js is ESM in a CommonJS package; Node ≥ 22 detects that.
let MODELS = { "deepseek-v3.2": { upstream: "deepseek/deepseek-v3.2" } };
let DEFAULT_MODEL = "deepseek-v3.2";
try {
  ({ MODELS, DEFAULT_MODEL } = await import("../app/config/models.js"));
} catch {
  // older Node: fall back to the default model id above (or pass --model <openrouter id>)
}

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : null);
const modelSlug = arg("model") ?? DEFAULT_MODEL;
const only = arg("only");

if (!process.env.OPENROUTER_KEY) {
  console.error("OPENROUTER_KEY is not set (put it in .env.local).");
  process.exit(1);
}

// Capture every URL that tools actually returned, for grounding checks.
const seenUrls = new Set();
const tools = DEFAULT_TOOLS.map((t) => ({
  ...t,
  async run(args, ctx) {
    const out = await t.run(args, ctx);
    for (const m of JSON.stringify(out).matchAll(/https?:\/\/[^\s"\\)]+/g)) seenUrls.add(m[0].replace(/[.,]+$/, ""));
    return out;
  },
}));

const SCENARIOS = [
  { id: "job-bare", group: "job", turns: ["job search"], expectTool: "search_jobs", expectLinks: true },
  { id: "job-react-60k", group: "job", turns: ["Find remote React jobs paying at least $60k"], expectTool: "search_jobs", expectLinks: true, check: (r) => r.toolArgs.search_jobs?.min_salary >= 60000 },
  { id: "research-company", group: "research", turns: ["Research the company Vercel — what do they do and who is the CEO?"], expectTool: "web_search", expectLinks: true },
  { id: "research-current", group: "research", turns: ["What's the latest stable version of Next.js?"], expectTool: "web_search", expectLinks: true },
  { id: "chat-knowledge", group: "chat", turns: ["Explain JavaScript closures with a short example"], expectTool: null },
  { id: "code-fix", group: "chat", turns: ["Fix this bug: `const total = items.reduce((a, b) => a + b.price)` returns '[object Object]10' "], expectTool: null },
  { id: "unsupported", group: "chat", turns: ["Submit my application to the Acme frontend job for me"], expectTool: null, check: (r) => !/\b(i('ve| have) (submitted|applied))\b/i.test(r.text) },
  {
    id: "memory-roundtrip", group: "memory",
    turns: ["Remember that I prefer remote jobs and my minimum salary is $65k", "NEW_CHAT", "job search"],
    expectTool: "search_jobs", expectLinks: true,
    check: (r, all) => all[0].tools.includes("save_memory") && r.toolArgs.search_jobs?.remote_only !== false && (r.toolArgs.search_jobs?.min_salary ?? 0) >= 60000,
  },
  {
    id: "memory-correction", group: "memory",
    turns: ["Remember that I prefer remote jobs", "Actually I'm open to hybrid roles too now — update that", "NEW_CHAT", "What do you remember about my job preferences?"],
    expectTool: "search_memories",
    check: (r, _all, store) => store.snapshot.some((m) => /hybrid/i.test(m.content)) && store.snapshot.filter((m) => /remote|hybrid/i.test(m.content)).length === 1 && /hybrid/i.test(r.text),
  },
  {
    id: "memory-forget", group: "memory",
    turns: ["Remember that my current employer is Dollar General", "NEW_CHAT", "Forget where I work and don't remember it again", "NEW_CHAT", "Where do I work?"],
    expectTool: null,
    check: (r, _all, store) => !store.snapshot.some((m) => /dollar general/i.test(m.content)) && !/dollar general/i.test(r.text),
  },
  { id: "memory-none", group: "memory", turns: ["What did we decide about the database for Nimbus?"], expectTool: "search_memories", check: (r) => /(don'?t|do not|no) (have|record|saved|memory)|nothing (saved|stored|recorded)|not (sure|aware)/i.test(r.text) },
];

const llm = createOpenRouterClient({ apiKey: process.env.OPENROUTER_KEY });
const upstream = MODELS[modelSlug]?.upstream ?? modelSlug;
const results = [];

for (const sc of SCENARIOS.filter((s) => !only || s.group === only || s.id === only)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-eval-"));
  const store = createMemoryStore({ dataDir: dir });
  const userKey = crypto.randomBytes(32).toString("hex");
  let history = [];
  const turnResults = [];
  process.stdout.write(`▶ ${sc.id} … `);
  try {
    for (const turn of sc.turns) {
      if (turn === "NEW_CHAT") {
        history = [];
        continue;
      }
      history.push({ role: "user", content: turn });
      const events = [];
      const t0 = Date.now();
      seenUrls.clear();
      const { text, metrics } = await runAgent({ messages: history, model: upstream, userKey, store, llm, tools, emit: (e) => events.push(e), env: process.env });
      const toolArgs = Object.fromEntries(events.filter((e) => e.type === "tool_start").map((e) => [e.name, e.args]));
      const links = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s)>\]]+)/g)].map((m) => (m[1] ?? m[2]).replace(/[.,]+$/, ""));
      const ungrounded = links.filter((u) => ![...seenUrls].some((s) => s === u || s.startsWith(u) || u.startsWith(s)));
      turnResults.push({ text, metrics, toolArgs, tools: metrics.toolCalls.filter((c) => c.ok).map((c) => c.name), links, ungrounded, ms: Date.now() - t0 });
      history.push({ role: "assistant", content: text });
    }
    const last = turnResults.at(-1);
    store.snapshot = (await store.list(userKey)).memories;
    const toolOk = sc.expectTool === null ? true : last.tools.includes(sc.expectTool);
    const linksOk = !sc.expectLinks || last.links.length > 0;
    const grounded = last.ungrounded.length === 0;
    const extraOk = sc.check ? Boolean(sc.check(last, turnResults, store)) : true;
    const clarifiedNeedlessly = sc.expectTool && last.tools.length === 0 && /\?\s*$/.test(last.text.trim());
    const pass = toolOk && linksOk && grounded && extraOk;
    results.push({ id: sc.id, group: sc.group, pass, toolOk, linksOk, grounded, extraOk, clarifiedNeedlessly, ms: turnResults.reduce((a, t) => a + t.ms, 0), ungrounded: last.ungrounded, tools: turnResults.map((t) => t.tools), preview: last.text.slice(0, 400) });
    console.log(pass ? "PASS" : "FAIL", `(${(results.at(-1).ms / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ id: sc.id, group: sc.group, pass: false, error: err.message });
    console.log("ERROR", err.message);
  }
}

const n = results.length;
const pct = (k) => `${((results.filter((r) => r[k]).length / n) * 100).toFixed(0)}%`;
console.log(`\nModel: ${modelSlug} (${upstream})`);
console.log(`Task completion:      ${pct("pass")}  (${results.filter((r) => r.pass).length}/${n})`);
console.log(`Tool selection:       ${pct("toolOk")}`);
console.log(`Factual grounding:    ${pct("grounded")}  (every link came from a tool result)`);
console.log(`Needless clarifying:  ${results.filter((r) => r.clarifiedNeedlessly).length}`);
console.log(`Median latency:       ${(results.map((r) => r.ms ?? 0).sort((a, b) => a - b)[Math.floor(n / 2)] / 1000).toFixed(1)}s`);
for (const r of results.filter((x) => !x.pass)) console.log(`\n✗ ${r.id}: ${JSON.stringify({ ...r, preview: undefined })}\n  ${r.preview ?? ""}`);

const out = path.join(process.cwd(), ".nimbus-data", "eval");
await fs.mkdir(out, { recursive: true });
const file = path.join(out, `eval-${modelSlug}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await fs.writeFile(file, JSON.stringify({ model: modelSlug, at: new Date().toISOString(), results }, null, 2));
console.log(`\nSaved: ${file}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);

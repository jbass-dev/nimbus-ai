// Checks every model in app/config/models.js against OpenRouter the same way
// Nimbus calls it, and prints exactly what fails. Costs a fraction of a cent.
//
//   node --env-file=.env.local scripts/check-models.mjs
import { MODELS } from "../app/config/models.js";
import { createOpenRouterClient } from "../lib/nimbus/llm.mjs";
import { DEFAULT_TOOLS, toOpenAiTools } from "../lib/nimbus/tools/index.mjs";

const key = process.env.OPENROUTER_KEY;
if (!key) {
  console.error("OPENROUTER_KEY is not set. Run: node --env-file=.env.local scripts/check-models.mjs");
  process.exit(1);
}

// Account status first: credits and limits explain most "only one model works" cases.
try {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
  const { data } = await res.json();
  console.log(`Key: ${res.status} | free tier: ${data?.is_free_tier} | usage: $${data?.usage} | limit: ${data?.limit ?? "none"} | remaining: ${data?.limit_remaining ?? "n/a"}`);
} catch (err) {
  console.log(`Key check failed: ${err.message}`);
}

const llm = createOpenRouterClient({ apiKey: key });
const tools = toOpenAiTools(DEFAULT_TOOLS);
const ask = (content) => [{ role: "user", content }];

const checks = [
  { name: "plain chat", run: (model) => llm.chat({ model, messages: ask("Reply with the word OK.") }) },
  { name: "with tools", run: (model) => llm.chat({ model, messages: ask("Reply with the word OK."), tools, toolChoice: "auto" }) },
  {
    name: "forced tool",
    run: (model) => llm.chat({ model, messages: ask("Weather in Tulsa?"), tools, toolChoice: { type: "function", function: { name: "get_weather" } } }),
  },
];

for (const cfg of Object.values(MODELS)) {
  console.log(`\n${cfg.label}  (${cfg.upstream})`);
  for (const check of checks) {
    const t0 = Date.now();
    try {
      const r = await check.run(cfg.upstream);
      const ms = Date.now() - t0;
      const out = r.toolCalls.length ? `tool call: ${r.toolCalls.map((c) => c.name).join(", ")}` : `text: ${JSON.stringify(r.content.slice(0, 60))}`;
      const empty = !r.content.trim() && !r.toolCalls.length;
      console.log(`  ${empty ? "EMPTY" : "OK   "} ${check.name.padEnd(12)} ${ms}ms  finish=${r.finishReason}  ${out}`);
    } catch (err) {
      console.log(`  FAIL  ${check.name.padEnd(12)} ${err.status ?? ""} ${err.message}`);
      if (err.body) console.log(`        ${String(err.body).slice(0, 400)}`);
    }
  }
}
console.log(`\n${Object.keys(MODELS).length} models checked.`);

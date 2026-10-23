// Summarise .nimbus-data/metrics/turns.jsonl (content-free per-turn metrics
// logged by the API route): intents, tool usage/failure rates, latency.
//   npm run metrics
import fs from "node:fs/promises";
import path from "node:path";

const dir = process.env.NIMBUS_DATA_DIR || path.join(process.cwd(), ".nimbus-data");
let lines;
try {
  lines = (await fs.readFile(path.join(dir, "metrics", "turns.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch {
  console.log("No metrics yet — chat with Nimbus first.");
  process.exit(0);
}
const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const lat = lines.map((l) => l.latencyMs).sort((a, b) => a - b);
const calls = lines.flatMap((l) => l.toolCalls ?? []);
const toolStats = {};
for (const c of calls) {
  const s = (toolStats[c.name] ??= { calls: 0, failed: 0 });
  s.calls++;
  if (!c.ok) s.failed++;
}
const forcedHonoured = lines.filter((l) => l.forcedTool).filter((l) => (l.toolCalls ?? []).some((c) => c.name === l.forcedTool && c.ok)).length;
console.log(`Turns: ${lines.length}`);
console.log("Intents:", by(lines, (l) => l.intent));
console.log("Tools:", toolStats);
console.log(`Forced-tool turns that ran the tool: ${forcedHonoured}/${lines.filter((l) => l.forcedTool).length}`);
console.log(`Turns with unbacked claims flagged: ${lines.filter((l) => l.unbackedClaims?.length).length}`);
console.log(`Memory unavailable: ${lines.filter((l) => l.memoryStatus !== "ok").length}`);
console.log(`Latency p50 ${(lat[Math.floor(lat.length / 2)] / 1000).toFixed(1)}s · p90 ${(lat[Math.floor(lat.length * 0.9)] / 1000).toFixed(1)}s`);

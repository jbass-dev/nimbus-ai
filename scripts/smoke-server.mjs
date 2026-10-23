// HTTP-level smoke test of the BUILT app against a mock model provider.
// Verifies the real route wiring: NDJSON events, identity cookies,
// memory persistence across a full server restart, per-user isolation,
// and the memory management API.
//
//   npm run build && node scripts/smoke-server.mjs
//
// Simulated: the LLM (a local mock that follows a fixed policy).
// Real: Next.js server, routes, cookies, filesystem storage.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_PORT = 4610;
const MOCK_PORT = 4611;
const root = process.cwd();
const serverEntry = path.join(root, ".next/standalone/server.js");

// ---- mock OpenRouter ------------------------------------------------------
function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const { messages, tools } = JSON.parse(body);
  const lastUser = [...messages].reverse().find((m) => m.role === "user").content;
  const lastTool = messages.at(-1).role === "tool" ? messages.at(-1).content : null;
  if (lastTool) return sse(res, [{ choices: [{ delta: { content: `Tool said: ${lastTool.slice(0, 300)}` } }] }]);
  if (tools && /remember that/i.test(lastUser)) {
    const content = lastUser.replace(/^.*remember that\s*/i, "");
    return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "save_memory", arguments: JSON.stringify({ content, category: "preference", key: "test.pref", user_stated: true }) } }] } }] }]);
  }
  if (tools && /what do you remember/i.test(lastUser)) {
    return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "t2", function: { name: "search_memories", arguments: "{}" } }] } }] }]);
  }
  const sys = messages[0].content;
  return sse(res, [{ choices: [{ delta: { content: sys.includes("<<<MEMORY") ? `Memory in prompt: ${sys.split("<<<MEMORY")[1].split("MEMORY>>>")[0].trim()}` : "No memory in prompt." } }] }]);
});

// ---- app server -------------------------------------------------------------
let dataDir;
let app;
async function startApp() {
  app = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(APP_PORT), HOSTNAME: "127.0.0.1", OPENROUTER_KEY: "sk-mock", OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, NIMBUS_DATA_DIR: dataDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/api/memory`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("app did not start");
}
async function stopApp() {
  app.kill();
  await new Promise((r) => app.once("exit", r));
}

function client() {
  let cookie = "";
  return async (p, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
}
async function chat(c, text) {
  const res = await c("/api/OpenRouter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-v3.2", messages: [{ role: "user", content: text }] }) });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  return { events, text: events.filter((e) => e.type === "token").map((e) => e.text).join("") };
}

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) failures++;
}

try {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-smoke-"));
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  await startApp();
  const alice = client();
  const bob = client();

  const save = await chat(alice, "Remember that I prefer remote jobs");
  check("save_memory tool ran via real route", save.events.some((e) => e.type === "tool_end" && e.name === "save_memory" && e.ok), JSON.stringify(save.events));
  check("NDJSON done event with metrics", save.events.at(-1)?.type === "done" && save.events.at(-1).metrics.intent === "memory_save");

  const newChat = await chat(alice, "find me react roles");
  check("memory injected in a new conversation", /prefer remote jobs/i.test(newChat.text), newChat.text);

  const unrelated = await chat(alice, "explain closures");
  check("irrelevant turn gets no memory", unrelated.text === "No memory in prompt.", unrelated.text);

  await stopApp();
  await startApp();
  const afterRestart = await chat(alice, "What do you remember about me?");
  check("memory survives server restart", /prefer remote jobs/i.test(afterRestart.text), afterRestart.text);

  const bobView = await chat(bob, "What do you remember about me?");
  check("other user sees nothing", !/remote/i.test(bobView.text), bobView.text);

  const list = await (await alice("/api/memory")).json();
  check("memory API lists the item", list.memories?.length === 1 && list.memories[0].source === "user_explicit", JSON.stringify(list));
  const bobList = await (await bob("/api/memory")).json();
  check("memory API is per-user", bobList.memories?.length === 0, JSON.stringify(bobList));

  const id = list.memories[0].id;
  const patched = await (await alice("/api/memory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, content: "Prefers hybrid jobs" }) })).json();
  check("edit via API", patched.content === "Prefers hybrid jobs", JSON.stringify(patched));
  const bobDelete = await bob(`/api/memory?id=${id}`, { method: "DELETE" });
  check("other user cannot delete it", bobDelete.status === 404);
  const secret = await alice("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "my password is hunter22", category: "profile" }) });
  check("secrets rejected by API", secret.status === 400);
  const xsite = await alice("/api/memory?all=1", { method: "DELETE", headers: { Origin: "https://evil.example" } });
  check("cross-site delete refused", xsite.status === 403);
  const del = await alice(`/api/memory?id=${id}`, { method: "DELETE" });
  check("delete via API", del.status === 200 && (await (await alice("/api/memory")).json()).memories.length === 0);
  const raw = await fs.readdir(path.join(dataDir, "memory"));
  check("store files are hashed ids only", raw.every((f) => /^[a-f0-9]{64}\.json$/.test(f)), raw.join(","));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  if (app && app.exitCode === null) await stopApp();
  mock.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed (mocked LLM, real server)");
process.exit(failures ? 1 : 0);

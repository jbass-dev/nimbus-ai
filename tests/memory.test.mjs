// Persistent-memory verification (the 10 required behaviours).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "../lib/nimbus/memory-store.mjs";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { freshStore, userKey, scriptedLlm, collector } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1. a memory can be saved (and is on disk, not just in RAM)", async () => {
  const { dir, store } = await freshStore();
  const u = userKey("alice");
  const r = await store.save(u, { content: "Prefers remote jobs only", category: "preference", key: "jobs.remote", source: "user_explicit" });
  assert.equal(r.action, "created");
  const raw = JSON.parse(await fs.readFile(path.join(dir, "memory", `${u}.json`), "utf8"));
  assert.equal(raw.memories[0].content, "Prefers remote jobs only");
});

test("2. memory survives a new conversation (injected into an unrelated, fresh chat)", async () => {
  const { store } = await freshStore();
  const u = userKey("alice");
  await store.save(u, { content: "Prefers remote jobs only", category: "preference", key: "jobs.remote" });
  const llm = scriptedLlm([{ content: "ok" }]);
  // Brand-new conversation: no history mentions remote work.
  await runAgent({ messages: [{ role: "user", content: "Help me find a new job" }], model: "m", userKey: u, store, llm, supportsTools: false });
  assert.match(llm.requests[0].messages[0].content, /Prefers remote jobs only/);
});

test("3. memory survives an application restart (separate Node process)", async () => {
  const { dir, store } = await freshStore();
  const u = userKey("alice");
  await store.save(u, { content: "Working on Nimbus, an AI assistant app", category: "project", project: "nimbus" });
  const script = `
    import { createMemoryStore } from ${JSON.stringify(path.join(ROOT, "lib/nimbus/memory-store.mjs"))};
    const s = createMemoryStore({ dataDir: process.argv[1] });
    const { memories } = await s.list(process.argv[2]);
    console.log(JSON.stringify(memories.map(m => m.content)));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, dir, u], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim()), ["Working on Nimbus, an AI assistant app"]);
});

test("4. memories are retrieved when relevant (synonyms: roles → jobs)", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Prefers remote jobs only", category: "preference" });
  const hits = await store.retrieve(u, "find me frontend roles");
  assert.equal(hits.length, 1);
  const decision = await store.save(u, { content: "Decided to use file-based JSON storage for Nimbus memory instead of a hosted database", category: "decision", project: "nimbus" });
  const d = await store.retrieve(u, "What did we decide about the database for Nimbus?");
  assert.equal(d[0].id, decision.memory.id);
});

test("5. irrelevant memories are not injected into the prompt", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Prefers remote jobs only", category: "preference", key: "jobs.remote" });
  await store.save(u, { content: "Favorite pizza topping is pepperoni", category: "preference" });
  await store.save(u, { content: "Has a dog named Biscuit", category: "profile" });
  const llm = scriptedLlm([{ content: "ok" }]);
  await runAgent({ messages: [{ role: "user", content: "Find remote React jobs" }], model: "m", userKey: u, store, llm, supportsTools: false });
  const sys = llm.requests[0].messages[0].content;
  assert.match(sys, /Prefers remote jobs only/);
  assert.doesNotMatch(sys, /pepperoni|Biscuit/);

  const llm2 = scriptedLlm([{ content: "ok" }]);
  await runAgent({ messages: [{ role: "user", content: "Explain JavaScript closures" }], model: "m", userKey: u, store, llm: llm2, supportsTools: false });
  assert.doesNotMatch(llm2.requests[0].messages[0].content, /pepperoni|Biscuit|remote jobs/);
});

test("6. corrections update the existing entry instead of duplicating it", async () => {
  const { store } = await freshStore();
  const u = userKey();
  const a = await store.save(u, { content: "Minimum salary is $60k", category: "preference", key: "jobs.min_salary" });
  const b = await store.save(u, { content: "Minimum salary is $75k", category: "preference", key: "jobs.min_salary", source: "user_explicit" });
  assert.equal(b.action, "updated");
  assert.equal(b.memory.id, a.memory.id);
  const { memories } = await store.list(u);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, "Minimum salary is $75k");
  assert.deepEqual(memories[0].previousValues, ["Minimum salary is $60k"]);
  // explicit edit by id
  const c = await store.update(u, a.memory.id, { content: "Minimum salary is $80k" });
  assert.equal(c.content, "Minimum salary is $80k");
  // Old values never reach the prompt
  const hits = await store.retrieve(u, "salary");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "Minimum salary is $80k");
});

test("7. forget requests delete, and 'don't remember X' blocks future saves", async () => {
  const { dir, store } = await freshStore();
  const u = userKey();
  const m = await store.save(u, { content: "Current salary at Dollar General is $15/hr", category: "profile" });
  await store.save(u, { content: "Prefers remote jobs only", category: "preference" });
  const r = await store.forget(u, { query: "salary", block: true });
  assert.deepEqual(r.removed.map((x) => x.id), [m.memory.id]);
  assert.equal(r.blockedTopic, "salary");
  // gone from disk entirely, not just hidden
  const raw = await fs.readFile(path.join(dir, "memory", `${u}.json`), "utf8");
  assert.doesNotMatch(raw, /Dollar General/);
  await assert.rejects(store.save(u, { content: "Salary expectation is $70k", category: "preference" }), /not to remember/);
  // unrelated saves still work; unblock restores
  await store.save(u, { content: "Likes TypeScript", category: "preference" });
  await store.unblock(u, "salary");
  await store.save(u, { content: "Salary expectation is $70k", category: "preference" });
});

test("8. conflicting information resolves to the newest statement (near-duplicate, no key)", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Prefers remote jobs in the US", category: "preference" });
  const r = await store.save(u, { content: "Prefers hybrid jobs in the US", category: "preference" });
  assert.equal(r.action, "updated");
  const { memories } = await store.list(u);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, "Prefers hybrid jobs in the US");
  // an unrelated preference is NOT merged
  await store.save(u, { content: "Wants to learn Rust", category: "preference" });
  assert.equal((await store.list(u)).memories.length, 2);
});

test("9. one user's memories never leak into another user's session", async () => {
  const { store } = await freshStore();
  const alice = userKey("alice");
  const bob = userKey("bob");
  await store.save(alice, { content: "Prefers remote React jobs", category: "preference" });
  assert.equal((await store.list(bob)).memories.length, 0);
  assert.equal((await store.retrieve(bob, "remote React jobs")).length, 0);
  const llm = scriptedLlm([{ toolCalls: [{ name: "search_memories", args: { query: "" } }] }, { content: "nothing saved" }]);
  await runAgent({ messages: [{ role: "user", content: "What do you remember about me?" }], model: "m", userKey: bob, store, llm });
  const toolMsg = llm.requests[1].messages.find((m) => m.role === "tool");
  assert.doesNotMatch(toolMsg.content, /React/);
  // malformed identities are rejected (no path traversal)
  await assert.rejects(store.list("../alice"), /Invalid user identity/);
});

test("10. memory failure → model is told memory is unavailable; nothing is invented", async () => {
  const broken = {
    retrieve: async () => { throw new Error("disk on fire"); },
    save: async () => { throw new Error("disk on fire"); },
    list: async () => { throw new Error("disk on fire"); },
  };
  const llm = scriptedLlm([{ toolCalls: [{ name: "search_memories", args: { query: "job preferences" } }] }, { content: "I can't access saved memory right now." }]);
  const emit = collector();
  const { metrics } = await runAgent({ messages: [{ role: "user", content: "What do you remember about my job preferences?" }], model: "m", userKey: userKey(), store: broken, llm, emit });
  const sys = llm.requests[0].messages[0].content;
  assert.match(sys, /Long-term memory is unavailable/);
  assert.doesNotMatch(sys, /SAVED MEMORY \(/);
  assert.equal(metrics.memoryStatus, "unavailable");
  const toolMsg = llm.requests[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /Tool failed: disk on fire/);
  assert.ok(emit.of("notice").some((e) => /unavailable/.test(e.text)));
});

test("secrets and identifiers are never stored", async () => {
  const { store } = await freshStore();
  const u = userKey();
  for (const content of [
    "My OpenRouter key is sk-or-v1-abcdef1234567890abcdef",
    "password: hunter22",
    "My SSN is 123-45-6789",
    "Card 4111 1111 1111 1111",
  ]) {
    await assert.rejects(store.save(u, { content, category: "profile" }), /never stores|Refused/, content);
  }
  // but ordinary text mentioning the words is fine
  await store.save(u, { content: "Prefers using a password manager", category: "preference" });
});

test("corrupt memory file is quarantined, not fatal", async () => {
  const { dir, store } = await freshStore();
  const u = userKey();
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.writeFile(path.join(dir, "memory", `${u}.json`), "{not json");
  assert.deepEqual((await store.list(u)).memories, []);
  const files = await fs.readdir(path.join(dir, "memory"));
  assert.ok(files.some((f) => f.includes(".corrupt-")));
});

test("concurrent saves don't lose writes", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(u, { content: `Uses tool${i} daily for project${i} work${i}`, category: "other" })));
  assert.equal((await store.list(u)).memories.length, 20);
});

test("fresh store instance on same dir sees same data (in-process restart)", async () => {
  const { dir, store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Lives in Coyle, OK", category: "profile" });
  const reopened = createMemoryStore({ dataDir: dir });
  assert.equal((await reopened.list(u)).memories[0].content, "Lives in Coyle, OK");
});

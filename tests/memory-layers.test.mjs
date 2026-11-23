// Layered memory: project-aware recall, IDF ranking, layer caps, optional embeddings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryStore, layerOf } from "../lib/nimbus/memory-store.mjs";
import { cosine, createOpenRouterEmbedder } from "../lib/nimbus/embeddings.mjs";
import { freshStore, userKey, tempDir, mockFetch } from "./helpers.mjs";

test("categories map to the three layers and the layer is exposed", async () => {
  assert.deepEqual(["preference", "profile", "project", "decision", "task", "conversation"].map(layerOf), ["personal", "personal", "project", "project", "project", "conversation"]);
  const { store } = await freshStore();
  const u = userKey();
  const { memory } = await store.save(u, { content: "Decided to use Zustand for state", category: "decision", project: "storyforge" });
  assert.equal(memory.layer, "project");
});

test("naming a project recalls its decisions and tasks even without shared wording", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Chose Expo Router with a tab layout", category: "decision", project: "storyforge", key: "nav" });
  await store.save(u, { content: "Still need to add offline caching for chapters", category: "task", project: "storyforge", key: "cache" });
  await store.save(u, { content: "Using Supabase for auth in the budgeting app", category: "decision", project: "pennywise", key: "auth" });
  const hits = await store.retrieve(u, "Make improvements to StoryForge");
  const ids = hits.map((h) => h.content);
  assert.ok(ids.some((c) => /Expo Router/.test(c)), "decision recalled");
  assert.ok(ids.some((c) => /offline caching/.test(c)), "open task recalled");
  assert.ok(!ids.some((c) => /Supabase/.test(c)), "other project stays out");
  assert.ok(hits.every((h) => h.project === "storyforge"));
});

test("a project name written differently still matches (story-forge vs StoryForge)", async () => {
  const { store } = await freshStore();
  const u = userKey();
  await store.save(u, { content: "Backend is a Hono server on Cloudflare", category: "project", project: "story-forge" });
  const hits = await store.retrieve(u, "what's next for storyforge?");
  assert.equal(hits.length, 1);
});

test("no single layer fills every slot when another layer also matches", async () => {
  const { store } = await freshStore();
  const u = userKey();
  const personal = ["Likes React hooks over classes", "Prefers React Native for mobile apps", "Wants to learn React Server Components", "Follows React conference talks weekly"];
  for (const [i, c] of personal.entries()) await store.save(u, { content: c, category: "preference", key: `react.${i}`, source: "user_explicit" });
  await store.save(u, { content: "Agreed to memoize list rows after React profiling", category: "conversation", key: "react.profiling" });
  const hits = await store.retrieve(u, "react", { limit: 3 });
  assert.equal(hits.length, 3);
  assert.ok(hits.some((h) => h.layer === "conversation"), `got ${hits.map((h) => h.layer)}`);
});

test("rare words outweigh words most memories share", async () => {
  const { store } = await freshStore();
  const u = userKey();
  const cats = ["preference", "profile", "task", "decision", "project", "conversation"];
  const common = ["Prefers remote roles at startups", "Needs remote hours flexible around school", "Open to remote contract gigs", "Remote salary floor is sixty thousand", "Wants remote work with async teams", "Remote only for React positions"];
  for (const [i, c] of common.entries()) await store.save(u, { content: c, category: cats[i], key: `r${i}` });
  await store.save(u, { content: "Sister lives in Tulsa", category: "profile", key: "sister" });
  const hits = await store.retrieve(u, "remote Tulsa", { limit: 3 });
  assert.match(hits[0].content, /Tulsa/);
});

// ---- Embeddings (fake embedder: meaning = which topic the text is about) ----
const topicVec = (t) => (/dog|puppy|pet/i.test(t) ? [1, 0, 0] : /job|hire|role/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
const fakeEmbed = async (texts) => texts.map(topicVec);

test("with an embedder, a memory with different wording is still found", async () => {
  const dir = await tempDir();
  const u = userKey();
  const withEmbed = createMemoryStore({ dataDir: dir, embed: fakeEmbed });
  await withEmbed.save(u, { content: "My puppy is named Biscuit", category: "profile", key: "puppy" });
  const hits = await withEmbed.retrieve(u, "tell me about my dog");
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /Biscuit/);
  const lexicalOnly = createMemoryStore({ dataDir: dir });
  assert.equal((await lexicalOnly.retrieve(u, "tell me about my dog")).length, 0, "without embeddings this is a miss");
});

test("vectors are stored on disk but never returned to callers", async () => {
  const dir = await tempDir();
  const u = userKey();
  const store = createMemoryStore({ dataDir: dir, embed: fakeEmbed });
  await store.save(u, { content: "My puppy is named Biscuit", category: "profile", key: "puppy" });
  assert.match(await fs.readFile(path.join(dir, "memory", `${u}.json`), "utf8"), /"embedding"/);
  const listed = (await store.list(u)).memories[0];
  const hit = (await store.retrieve(u, "puppy"))[0];
  assert.equal("embedding" in listed, false);
  assert.equal("embedding" in hit, false);
});

test("if the embedder fails, saving and lexical recall keep working", async () => {
  const dir = await tempDir();
  const u = userKey();
  const store = createMemoryStore({ dataDir: dir, embed: async () => { throw new Error("provider down"); } });
  await store.save(u, { content: "Prefers remote jobs only", category: "preference", key: "remote" });
  const hits = await store.retrieve(u, "find me remote jobs");
  assert.equal(hits.length, 1);
});

test("editing a memory drops its stale vector, and reindex backfills it", async () => {
  const dir = await tempDir();
  const u = userKey();
  const plain = createMemoryStore({ dataDir: dir });
  const { memory } = await plain.save(u, { content: "My puppy is named Biscuit", category: "profile", key: "puppy" });
  const store = createMemoryStore({ dataDir: dir, embed: fakeEmbed });
  assert.equal(await store.reindex(u), 1);
  assert.equal(await store.reindex(u), 0, "nothing left to backfill");
  await store.update(u, memory.id, { content: "Looking for a new job in React" });
  const raw = JSON.parse(await fs.readFile(path.join(dir, "memory", `${u}.json`), "utf8"));
  assert.deepEqual(raw.memories[0].embedding, [0, 1, 0], "re-embedded for the new text");
});

test("cosine and the OpenRouter embedder behave", async () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 0]), 0);
  const fetchImpl = mockFetch({ "/embeddings": { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } });
  const embed = createOpenRouterEmbedder({ apiKey: "k", model: "m", fetchImpl });
  assert.deepEqual(await embed(["a", "b"]), [[1, 0], [0, 1]], "reordered by index");
  const bad = createOpenRouterEmbedder({ apiKey: "k", model: "m", fetchImpl: mockFetch({ "/embeddings": { data: [] } }) });
  await assert.rejects(() => bad(["a"]));
});

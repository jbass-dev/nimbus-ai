// Persistent, per-user memory.
//
// Storage: one JSON file per user under `<dataDir>/memory/<userKey>.json`,
// written atomically (temp file + rename) and serialised through a
// per-file queue so concurrent requests can't clobber each other. This is
// deliberately dependency-free: it works in `next dev`, the standalone
// server Electron spawns, and tests. Swap the read/write functions for a
// database adapter if Nimbus ever runs multi-instance.
//
// Model: memories are distinct from conversation history. Each memory has
// a category, an optional stable `key` (topic slug, e.g.
// "job.location_preference") and optional `project`. Saving a memory with a
// key that already exists — or near-duplicate content in the same
// category/project — *supersedes* the old value instead of piling up
// contradictions; the old value is kept in `history` for reference only and
// is never injected into prompts.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { detectSensitive } from "./sensitive.mjs";
import { jaccard, scoreRelevance, tokenSet } from "./text.mjs";
import { cosine } from "./embeddings.mjs";
import { nowIso } from "./util.mjs";

export const CATEGORIES = ["preference", "profile", "project", "decision", "task", "conversation", "other"];

// Three layers of memory, derived from the category so existing data needs no migration:
//   personal      who the user is and what they like        (preference, profile)
//   project       ongoing work: facts, decisions, open tasks (project, decision, task)
//   conversation  takeaways worth carrying out of past chats (conversation)
export const LAYERS = ["personal", "project", "conversation"];
export function layerOf(category) {
  if (category === "preference" || category === "profile") return "personal";
  if (category === "project" || category === "decision" || category === "task") return "project";
  if (category === "conversation") return "conversation";
  return "personal";
}
const MAX_MEMORIES = 500;
const MAX_CONTENT = 500;
const MAX_HISTORY = 5;
const USER_KEY_RE = /^[a-f0-9]{64}$/;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function normaliseKey(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return k || null;
}

function normaliseProject(project) {
  if (!project) return null;
  const p = String(project).toLowerCase().trim().replace(/\s+/g, "-").slice(0, 60);
  return p || null;
}

const flat = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const roundVec = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);

/** Like scoreRelevance, but tokens that are rare across this user's memories count for more. */
function weightedRelevance(q, m, idf) {
  let hitW = 0, mW = 0, hits = 0;
  for (const t of m) {
    const w = idf(t);
    mW += w;
    if (q.has(t)) { hitW += w; hits++; }
  }
  if (!hits) return 0;
  let qW = 0;
  for (const t of q) qW += idf(t);
  return (hitW / Math.min(qW, mW)) * (0.6 + 0.4 * (hitW / Math.max(qW, mW)));
}

function emptyDoc() {
  return { version: 1, memories: [], blocked: [] };
}

/**
 * embed (optional): async (texts) => number[][]. When given, memories also get a
 * vector and retrieval blends semantic similarity with the lexical score.
 */
export function createMemoryStore({ dataDir, now = () => Date.now(), embed = null } = {}) {
  if (!dataDir) throw new Error("createMemoryStore requires dataDir");
  const dir = path.join(dataDir, "memory");
  const queues = new Map();

  function fileFor(userKey) {
    if (!USER_KEY_RE.test(String(userKey))) throw new MemoryError("bad_user", "Invalid user identity");
    return path.join(dir, `${userKey}.json`);
  }

  async function load(userKey) {
    const file = fileFor(userKey);
    try {
      const raw = await fs.readFile(file, "utf8");
      const doc = JSON.parse(raw);
      if (!Array.isArray(doc.memories)) return emptyDoc();
      doc.blocked ??= [];
      return doc;
    } catch (err) {
      if (err.code === "ENOENT") return emptyDoc();
      if (err instanceof SyntaxError) {
        // Corrupt file: keep a copy for manual recovery, start clean.
        await fs.rename(file, `${file}.corrupt-${now()}`).catch(() => {});
        return emptyDoc();
      }
      throw err;
    }
  }

  async function save(userKey, doc) {
    const file = fileFor(userKey);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  }

  /** Serialise read-modify-write per user. */
  function mutate(userKey, fn) {
    const prev = queues.get(userKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const doc = await load(userKey);
      const result = await fn(doc);
      await save(userKey, doc);
      return result;
    });
    queues.set(userKey, next.catch(() => {}));
    return next;
  }

  function active(doc) {
    return doc.memories.filter((m) => m.status === "active");
  }

  function isBlocked(doc, content) {
    const tokens = tokenSet(content);
    return doc.blocked.find((b) => {
      const bt = [...tokenSet(b.topic)];
      return bt.length > 0 && bt.every((t) => tokens.has(t));
    });
  }

  function publicView(m) {
    const rest = { ...m };
    delete rest.history;
    delete rest.embedding; // vectors stay on disk, never go to the UI or the model
    return { ...rest, layer: layerOf(m.category), previousValues: (m.history ?? []).map((h) => h.content) };
  }

  /** Vectors for texts, or null when no embedder is set or it fails. Never throws. */
  async function safeEmbed(texts) {
    if (!embed || !texts.length) return null;
    try {
      const v = await embed(texts);
      return Array.isArray(v) && v.length === texts.length && v.every(Array.isArray) ? v.map(roundVec) : null;
    } catch {
      return null;
    }
  }

  return {
    dataDir,

    async list(userKey, { includeSuperseded = false } = {}) {
      const doc = await load(userKey);
      const items = includeSuperseded ? doc.memories : active(doc);
      return {
        memories: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicView),
        blocked: doc.blocked,
      };
    },

    /**
     * Upsert a memory. Returns { action: "created"|"updated"|"unchanged", memory }.
     * Throws MemoryError for sensitive/blocked/invalid content.
     */
    async save(userKey, input) {
      const content = String(input?.content ?? "").trim().replace(/\s+/g, " ");
      if (!content) throw new MemoryError("invalid", "Memory content is empty");
      if (content.length > MAX_CONTENT) throw new MemoryError("invalid", `Memory content is too long (max ${MAX_CONTENT} chars)`);
      const sensitive = detectSensitive(content);
      if (sensitive) throw new MemoryError("sensitive", `Refused: looks like a ${sensitive}. Nimbus never stores secrets or identifiers.`);
      const category = CATEGORIES.includes(input?.category) ? input.category : "other";
      const key = normaliseKey(input?.key);
      const project = normaliseProject(input?.project);
      const source = input?.source === "user_explicit" ? "user_explicit" : input?.source === "user_edit" ? "user_edit" : "inferred";
      const vec = (await safeEmbed([content]))?.[0] ?? null;

      return mutate(userKey, (doc) => {
        const blocked = isBlocked(doc, content);
        if (blocked) throw new MemoryError("blocked", `Refused: you asked Nimbus not to remember "${blocked.topic}".`);

        const ts = nowIso(now());
        const pool = active(doc);
        const contentTokens = tokenSet(content);
        let existing = key ? pool.find((m) => m.key === key && (m.project ?? null) === project) : null;
        if (!existing) {
          existing = pool.find(
            (m) => m.category === category && (m.project ?? null) === project && jaccard(contentTokens, tokenSet(m.content)) >= 0.5
          );
        }

        if (existing) {
          if (existing.content.toLowerCase() === content.toLowerCase()) {
            existing.updatedAt = ts;
            return { action: "unchanged", memory: publicView(existing) };
          }
          existing.history = [{ content: existing.content, replacedAt: ts }, ...(existing.history ?? [])].slice(0, MAX_HISTORY);
          existing.content = content;
          existing.updatedAt = ts;
          existing.category = category;
          if (vec) existing.embedding = vec;
          else delete existing.embedding; // stale for the new text
          if (key) existing.key = key;
          // An explicit statement from the user outranks an inference.
          if (source !== "inferred" || existing.source === "inferred") existing.source = source;
          return { action: "updated", memory: publicView(existing) };
        }

        if (pool.length >= MAX_MEMORIES) throw new MemoryError("full", `Memory is full (${MAX_MEMORIES} items). Remove some first.`);
        const memory = {
          id: `mem_${crypto.randomBytes(6).toString("hex")}`,
          content,
          category,
          key,
          project,
          source,
          status: "active",
          createdAt: ts,
          updatedAt: ts,
          history: [],
          ...(vec ? { embedding: vec } : {}),
        };
        doc.memories.push(memory);
        return { action: "created", memory: publicView(memory) };
      });
    },

    async update(userKey, id, patch) {
      const content = patch?.content != null ? String(patch.content).trim().replace(/\s+/g, " ") : null;
      if (content !== null) {
        if (!content) throw new MemoryError("invalid", "Memory content is empty");
        if (content.length > MAX_CONTENT) throw new MemoryError("invalid", "Memory content is too long");
        const sensitive = detectSensitive(content);
        if (sensitive) throw new MemoryError("sensitive", `Refused: looks like a ${sensitive}.`);
      }
      const vec = content !== null ? (await safeEmbed([content]))?.[0] ?? null : null;
      return mutate(userKey, (doc) => {
        const m = active(doc).find((x) => x.id === id);
        if (!m) throw new MemoryError("not_found", `No memory with id ${id}`);
        const ts = nowIso(now());
        if (content !== null && content !== m.content) {
          if (isBlocked(doc, content)) throw new MemoryError("blocked", "That topic is on your do-not-remember list.");
          m.history = [{ content: m.content, replacedAt: ts }, ...(m.history ?? [])].slice(0, MAX_HISTORY);
          m.content = content;
          if (vec) m.embedding = vec;
          else delete m.embedding;
        }
        if (patch?.category && CATEGORIES.includes(patch.category)) m.category = patch.category;
        if (patch?.project !== undefined) m.project = normaliseProject(patch.project);
        m.source = patch?.source === "inferred" ? m.source : "user_edit";
        m.updatedAt = ts;
        return publicView(m);
      });
    },

    /** Hard-deletes matching memories (no tombstone keeps the content). */
    async forget(userKey, { id, query, block = false } = {}) {
      return mutate(userKey, (doc) => {
        let removed = [];
        if (id) {
          removed = doc.memories.filter((m) => m.id === id);
        } else if (query) {
          removed = doc.memories.filter((m) => scoreRelevance(query, m.content) >= 0.5);
        }
        const ids = new Set(removed.map((m) => m.id));
        doc.memories = doc.memories.filter((m) => !ids.has(m.id));
        let blockedTopic = null;
        if (block && query) {
          const topic = String(query).trim().slice(0, 80);
          if (!doc.blocked.some((b) => b.topic.toLowerCase() === topic.toLowerCase())) {
            doc.blocked.push({ topic, createdAt: nowIso(now()) });
          }
          blockedTopic = topic;
        }
        return { removed: removed.map((m) => ({ id: m.id, content: m.content })), blockedTopic };
      });
    },

    async unblock(userKey, topic) {
      return mutate(userKey, (doc) => {
        const before = doc.blocked.length;
        doc.blocked = doc.blocked.filter((b) => b.topic.toLowerCase() !== String(topic).toLowerCase());
        return { removed: before - doc.blocked.length };
      });
    },

    async clear(userKey) {
      return mutate(userKey, (doc) => {
        const count = doc.memories.length;
        doc.memories = [];
        return { removed: count };
      });
    },

    /** Backfill vectors for memories saved before embeddings were enabled. Returns how many were added. */
    async reindex(userKey) {
      if (!embed) return 0;
      const doc = await load(userKey);
      const todo = active(doc).filter((m) => !m.embedding);
      if (!todo.length) return 0;
      const vecs = await safeEmbed(todo.map((m) => m.content));
      if (!vecs) return 0;
      const byId = new Map(todo.map((m, i) => [m.id, vecs[i]]));
      return mutate(userKey, (d) => {
        let n = 0;
        for (const m of active(d)) {
          if (!m.embedding && byId.has(m.id)) { m.embedding = byId.get(m.id); n++; }
        }
        return n;
      });
    },

    /**
     * Relevance-ranked retrieval across all three layers. Only memories that
     * actually relate to the query come back, never the whole store.
     *   • rare words weigh more than words most of your memories share (IDF)
     *   • naming a project ("improve StoryForge") pulls in that project's
     *     facts, decisions and open tasks even if the wording doesn't overlap
     *   • no single layer takes every slot when another layer has a match
     *   • with an embedder, meaning-based matches count too
     * Explicit user statements and recent updates break ties.
     */
    async retrieve(userKey, query, { limit = 6, minScore = 0.34, project = null, category = null, alwaysInclude = null, semanticMin = 0.42 } = {}) {
      const doc = await load(userKey);
      const proj = normaliseProject(project);
      const t = now();
      const pool = active(doc).filter((m) => (!category || m.category === category) && (!proj || m.project === proj));
      if (!pool.length) return [];

      // Corpus statistics for IDF.
      const texts = pool.map((m) => `${m.content} ${(m.key ?? "").replace(/[._]/g, " ")} ${m.project ?? ""} ${m.category}`);
      const sets = texts.map(tokenSet);
      const df = new Map();
      for (const set of sets) for (const tok of set) df.set(tok, (df.get(tok) ?? 0) + 1);
      const N = pool.length;
      // A word no memory contains weighs like an ordinary one (df 1), not like the rarest: otherwise unmatched query words would sink real matches.
      const idf = (tok) => Math.log(1 + N / (1 + (df.get(tok) ?? 1)));
      const qSet = tokenSet(query);

      // Projects the query names, e.g. "StoryForge" matches project "storyforge" or "story-forge".
      const qFlat = flat(query);
      const named = new Set([...new Set(pool.map((m) => m.project).filter(Boolean))].filter((p) => flat(p).length >= 3 && qFlat.includes(flat(p))));

      const qVec = embed ? (await safeEmbed([String(query).slice(0, 500)]))?.[0] ?? null : null;

      const scored = pool
        .map((m, i) => {
          let score = weightedRelevance(qSet, sets[i], idf);
          if (qVec && m.embedding) {
            const sem = cosine(qVec, m.embedding);
            if (sem >= semanticMin) score = Math.max(score, minScore + ((sem - semanticMin) / (1 - semanticMin)) * 0.6);
          }
          if (alwaysInclude?.(m)) score = Math.max(score, minScore);
          if (m.project && named.has(m.project)) score = Math.max(score, minScore) + 0.3;
          if (score > 0) {
            if (m.source !== "inferred") score += 0.05;
            const ageDays = (t - Date.parse(m.updatedAt)) / 86_400_000;
            score += Math.max(0, 0.05 - ageDays * 0.0005);
          }
          return { m, score };
        })
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score);

      // Layer cap: leave room for the other layers, then fill any leftover slots.
      const cap = Math.max(1, Math.floor(limit * 0.67));
      const used = { personal: 0, project: 0, conversation: 0 };
      const picked = [];
      const skipped = [];
      for (const x of scored) {
        const layer = layerOf(x.m.category);
        if (picked.length < limit && used[layer] < cap) { picked.push(x); used[layer]++; }
        else skipped.push(x);
      }
      for (const x of skipped) if (picked.length < limit) picked.push(x);
      return picked
        .sort((a, b) => b.score - a.score)
        .map(({ m, score }) => ({ ...publicView(m), score: Number(score.toFixed(3)) }));
    },
  };
}

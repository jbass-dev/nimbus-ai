// Persistent research history: what was researched, which sources were read,
// and the summary written at the time. Per user, one JSON file, atomic writes,
// same isolation model as the memory store. Stores source titles and URLs and
// the final summary, never page text. Questions that look like secrets are
// not recorded at all.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { detectSensitive } from "./sensitive.mjs";
import { scoreRelevance } from "./text.mjs";
import { nowIso } from "./util.mjs";

const USER_KEY_RE = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 50;
const MAX_SUMMARY = 6000;

export function createResearchStore({ dataDir, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error("createResearchStore requires dataDir");
  const dir = path.join(dataDir, "research");
  const queues = new Map();

  const fileFor = (userKey) => {
    if (!USER_KEY_RE.test(String(userKey))) throw new Error("Invalid user identity");
    return path.join(dir, `${userKey}.json`);
  };

  async function load(userKey) {
    try {
      const doc = JSON.parse(await fs.readFile(fileFor(userKey), "utf8"));
      return Array.isArray(doc.entries) ? doc : { version: 1, entries: [] };
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) return { version: 1, entries: [] };
      throw err;
    }
  }

  function mutate(userKey, fn) {
    const prev = queues.get(userKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const doc = await load(userKey);
      const result = await fn(doc);
      const file = fileFor(userKey);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    queues.set(userKey, next.catch(() => {}));
    return next;
  }

  const view = (e) => ({ id: e.id, question: e.question, at: e.at, queries: e.queries, sources: e.sources, summary: e.summary ?? null });

  return {
    /** Records a research run. Returns its id, or null when the question looks sensitive. */
    async add(userKey, { question, queries = [], sources = [] }) {
      const q = String(question ?? "").trim().slice(0, 300);
      if (!q || detectSensitive(q)) return null;
      const id = `res_${crypto.randomBytes(6).toString("hex")}`;
      await mutate(userKey, (doc) => {
        doc.entries.unshift({
          id, question: q, at: nowIso(now()), queries: queries.slice(0, 4),
          sources: sources.slice(0, 10).map((s) => ({ id: s.id, url: s.url, title: String(s.title ?? "").slice(0, 160), published: s.published ?? null, tier: s.tier ?? null })),
          summary: null,
        });
        doc.entries = doc.entries.slice(0, MAX_ENTRIES);
      });
      return id;
    },

    /** Attaches the written report to its run. No-op if the run is gone or the text looks sensitive. */
    async attachSummary(userKey, id, text) {
      const summary = String(text ?? "").trim().slice(0, MAX_SUMMARY);
      if (!summary || detectSensitive(summary)) return false;
      return mutate(userKey, (doc) => {
        const e = doc.entries.find((x) => x.id === id);
        if (!e) return false;
        e.summary = summary;
        return true;
      });
    },

    async list(userKey) {
      return (await load(userKey)).entries.map(view);
    },

    /** Past runs relevant to a query (empty query → most recent). */
    async search(userKey, query, limit = 5) {
      const entries = (await load(userKey)).entries;
      const q = String(query ?? "").trim();
      if (!q) return entries.slice(0, limit).map(view);
      return entries
        .map((e) => ({ e, score: scoreRelevance(q, `${e.question} ${e.sources.map((s) => s.title).join(" ")} ${e.summary ?? ""}`) }))
        .filter((x) => x.score >= 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => view(x.e));
    },

    async remove(userKey, id) {
      return mutate(userKey, (doc) => {
        const before = doc.entries.length;
        doc.entries = doc.entries.filter((e) => e.id !== id);
        return before - doc.entries.length;
      });
    },

    async clear(userKey) {
      return mutate(userKey, (doc) => {
        const n = doc.entries.length;
        doc.entries = [];
        return n;
      });
    },
  };
}

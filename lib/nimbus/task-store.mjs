// Background tasks: saved prompts that Nimbus runs on a schedule while the
// desktop app is open, keeping the latest results for you to read.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { nextRunAfter, parseSchedule } from "./schedule.mjs";

export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

const USER_KEY_RE = /^[a-f0-9]{64}$/;
export const LIMITS = { tasks: 10, prompt: 1000, title: 80, runs: 10, resultChars: 6000, failuresBeforePause: 3 };

export function createTaskStore({ dataDir, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error("createTaskStore requires dataDir");
  const dir = path.join(dataDir, "tasks");
  const queues = new Map();
  const fileFor = (userKey) => {
    if (!USER_KEY_RE.test(String(userKey))) throw new TaskError("bad_user", "Invalid user identity");
    return path.join(dir, `${userKey}.json`);
  };
  async function load(userKey) {
    try {
      const doc = JSON.parse(await fs.readFile(fileFor(userKey), "utf8"));
      return { tasks: Array.isArray(doc.tasks) ? doc.tasks : [] };
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) return { tasks: [] };
      throw err;
    }
  }
  function mutate(userKey, fn) {
    const prev = queues.get(userKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const doc = await load(userKey);
      const result = await fn(doc);
      await fs.mkdir(dir, { recursive: true });
      const file = fileFor(userKey);
      const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    queues.set(userKey, next.catch(() => {}));
    return next;
  }
  const view = (t) => ({
    id: t.id, title: t.title, prompt: t.prompt, schedule: t.schedule, enabled: t.enabled,
    nextRunAt: t.enabled ? t.nextRunAt : null, lastRunAt: t.lastRunAt ?? null, lastStatus: t.lastStatus ?? null,
    running: t.running || undefined, unread: t.unread || 0, pausedReason: t.pausedReason, runs: t.runs ?? [],
  });
  const find = (doc, id) => {
    const t = doc.tasks.find((x) => x.id === id);
    if (!t) throw new TaskError("not_found", "No such task.");
    return t;
  };

  return {
    async list(userKey) {
      return (await load(userKey)).tasks.map(view);
    },

    async create(userKey, { title, prompt, schedule }) {
      const p = String(prompt ?? "").trim();
      if (p.length < 5) throw new TaskError("invalid", "Describe what the task should do.");
      if (p.length > LIMITS.prompt) throw new TaskError("invalid", `Keep the task under ${LIMITS.prompt} characters.`);
      let sch;
      try { sch = parseSchedule(schedule); } catch (err) { throw new TaskError("invalid", err.message); }
      const t = now();
      return mutate(userKey, (doc) => {
        if (doc.tasks.length >= LIMITS.tasks) throw new TaskError("limit", `You can have up to ${LIMITS.tasks} tasks. Delete one first.`);
        const task = {
          id: `task_${crypto.randomBytes(5).toString("hex")}`,
          title: String(title || p).replace(/\s+/g, " ").trim().slice(0, LIMITS.title),
          prompt: p, schedule: sch.text, enabled: true, nextRunAt: nextRunAfter(sch, t), createdAt: t, unread: 0, runs: [],
        };
        doc.tasks.push(task);
        return view(task);
      });
    },

    async update(userKey, id, { enabled, schedule, title }) {
      return mutate(userKey, (doc) => {
        const task = find(doc, id);
        if (schedule !== undefined) {
          let sch;
          try { sch = parseSchedule(schedule); } catch (err) { throw new TaskError("invalid", err.message); }
          task.schedule = sch.text;
          task.nextRunAt = nextRunAfter(sch, now());
        }
        if (title !== undefined) task.title = String(title).trim().slice(0, LIMITS.title) || task.title;
        if (enabled !== undefined) {
          task.enabled = !!enabled;
          if (task.enabled) { task.failures = 0; delete task.pausedReason; task.nextRunAt = nextRunAfter(task.schedule, now()); }
        }
        return view(task);
      });
    },

    async remove(userKey, id) {
      return mutate(userKey, (doc) => {
        find(doc, id);
        doc.tasks = doc.tasks.filter((t) => t.id !== id);
        return { removed: id };
      });
    },

    async markRead(userKey, id) {
      return mutate(userKey, (doc) => { const t = find(doc, id); t.unread = 0; return view(t); });
    },

    /** Claims a task for a run (so a slow run can't start twice) and schedules the next one. */
    async claim(userKey, id, { force = false } = {}) {
      return mutate(userKey, (doc) => {
        const t = find(doc, id);
        const stale = t.running && now() - t.running > 10 * 60_000;
        if (t.running && !stale) throw new TaskError("busy", "That task is already running.");
        if (!force && (!t.enabled || t.nextRunAt > now())) return null;
        t.running = now();
        if (t.enabled) t.nextRunAt = nextRunAfter(t.schedule, now());
        return view(t);
      });
    },

    async recordRun(userKey, id, { ok, text, tools = [], error }) {
      return mutate(userKey, (doc) => {
        const t = doc.tasks.find((x) => x.id === id);
        if (!t) return null; // deleted while running
        delete t.running;
        t.lastRunAt = now();
        t.lastStatus = ok ? "ok" : "failed";
        t.runs = [{ at: now(), ok, text: String(text ?? "").slice(0, LIMITS.resultChars), tools: tools.slice(0, 8), ...(error ? { error: String(error).slice(0, 300) } : {}) }, ...(t.runs ?? [])].slice(0, LIMITS.runs);
        if (ok) { t.failures = 0; t.unread = (t.unread || 0) + 1; }
        else if ((t.failures = (t.failures || 0) + 1) >= LIMITS.failuresBeforePause) {
          t.enabled = false;
          t.pausedReason = `Paused after ${t.failures} failed runs in a row.`;
        }
        return view(t);
      });
    },

    /** Every enabled task whose time has come, across all users. */
    async due() {
      let files = [];
      try { files = await fs.readdir(dir); } catch { return []; }
      const out = [];
      for (const f of files) {
        const userKey = f.replace(/\.json$/, "");
        if (!USER_KEY_RE.test(userKey)) continue;
        for (const t of (await load(userKey)).tasks) if (t.enabled && t.nextRunAt <= now() && !(t.running && now() - t.running < 10 * 60_000)) out.push({ userKey, id: t.id });
      }
      return out;
    },

    async unreadCount(userKey) {
      return (await load(userKey)).tasks.reduce((n, t) => n + (t.unread || 0), 0);
    },
  };
}

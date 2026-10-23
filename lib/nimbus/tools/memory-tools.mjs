// Tools that let the model read and manage the user's persistent memory.
// All of them operate on ctx.userKey only — there is no parameter that
// selects another user.
import { CATEGORIES } from "../memory-store.mjs";

export const saveMemoryTool = {
  name: "save_memory",
  description:
    "Save a durable fact about the user to long-term memory: stable preferences (e.g. remote-only jobs, salary floor), profile facts, ongoing projects, decisions made, unfinished tasks. Use when the user states one, or when they ask you to remember something. Do NOT save guesses, one-off details, secrets, or anything the user asked you not to remember. Re-saving with the same `key` replaces the old value (use this for corrections/changes).",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", minLength: 3, maxLength: 500, description: "Self-contained statement in third person, e.g. 'Prefers remote jobs only'" },
      category: { type: "string", enum: CATEGORIES },
      key: { type: "string", maxLength: 80, description: "Stable topic slug so later changes replace this entry, e.g. 'jobs.remote_preference', 'jobs.min_salary'" },
      project: { type: "string", maxLength: 60, description: "Project name for project/decision memories, e.g. 'nimbus'" },
      user_stated: { type: "boolean", description: "true if the user said this explicitly (not inferred by you)" },
    },
    required: ["content", "category"],
    additionalProperties: false,
  },
  writesMemory: true,
  async run(args, ctx) {
    const res = await ctx.store.save(ctx.userKey, {
      content: args.content,
      category: args.category,
      key: args.key,
      project: args.project,
      source: args.user_stated ? "user_explicit" : "inferred",
    });
    return { action: res.action, memory: { id: res.memory.id, content: res.memory.content, key: res.memory.key, previous: res.memory.previousValues[0] ?? null } };
  },
  summarize(r) {
    return r.action === "unchanged" ? "already saved" : `${r.action} memory`;
  },
};

export const updateMemoryTool = {
  name: "update_memory",
  description: "Correct or change an existing memory by id (ids come from search_memories or the memory context). The user's newest statement always wins.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^mem_[a-f0-9]{12}$" },
      content: { type: "string", minLength: 3, maxLength: 500 },
    },
    required: ["id", "content"],
    additionalProperties: false,
  },
  writesMemory: true,
  async run(args, ctx) {
    const m = await ctx.store.update(ctx.userKey, args.id, { content: args.content });
    return { action: "updated", memory: { id: m.id, content: m.content, previous: m.previousValues[0] ?? null } };
  },
  summarize() {
    return "updated memory";
  },
};

export const forgetMemoryTool = {
  name: "forget_memory",
  description:
    "Permanently delete memories, by id or by topic query. Set block_future=true when the user says not to remember a topic at all, so it is never saved again.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^mem_[a-f0-9]{12}$" },
      query: { type: "string", minLength: 2, maxLength: 120, description: "Topic to forget, e.g. 'salary'" },
      block_future: { type: "boolean" },
    },
    additionalProperties: false,
  },
  writesMemory: true,
  async run(args, ctx) {
    if (!args.id && !args.query) throw new Error("Provide an id or a query");
    const r = await ctx.store.forget(ctx.userKey, { id: args.id, query: args.query, block: Boolean(args.block_future) });
    return { removed: r.removed, blocked_topic: r.blockedTopic, note: r.removed.length ? undefined : "Nothing matched; nothing was deleted." };
  },
  summarize(r) {
    return `forgot ${r.removed.length} item${r.removed.length === 1 ? "" : "s"}${r.blocked_topic ? `, blocked "${r.blocked_topic}"` : ""}`;
  },
};

export const forgetAllMemoriesTool = {
  name: "forget_all_memories",
  description: "Delete EVERYTHING in the user's long-term memory. Only when the user explicitly asks to wipe all memory.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  writesMemory: true,
  consequential: true,
  confirmationPrompt: () => "Delete everything Nimbus remembers about you?",
  async run(_args, ctx) {
    return ctx.store.clear(ctx.userKey);
  },
  summarize(r) {
    return `cleared ${r.removed} memories`;
  },
};

export const searchMemoriesTool = {
  name: "search_memories",
  description:
    "Look up what you have saved about the user (preferences, profile, project decisions, open tasks). Use before answering questions like 'what do you remember' or 'what did we decide about X'. An empty query lists the most recent memories. If nothing is found, say you don't have it — never guess.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200 },
      project: { type: "string", maxLength: 60 },
      category: { type: "string", enum: CATEGORIES },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (!args.query?.trim()) {
      const { memories, blocked } = await ctx.store.list(ctx.userKey);
      const filtered = memories.filter((m) => (!args.category || m.category === args.category) && (!args.project || m.project === args.project.toLowerCase()));
      return {
        memories: filtered.slice(0, 25).map(({ id, content, category, project, updatedAt, source }) => ({ id, content, category, project, updatedAt, source })),
        total: filtered.length,
        do_not_remember_topics: blocked.map((b) => b.topic),
      };
    }
    const hits = await ctx.store.retrieve(ctx.userKey, args.query, { limit: 10, minScore: 0.2, project: args.project, category: args.category });
    return {
      memories: hits.map(({ id, content, category, project, updatedAt, source }) => ({ id, content, category, project, updatedAt, source })),
      note: hits.length ? undefined : "No saved memory matches. Tell the user you don't have that saved; do not guess.",
    };
  },
  summarize(r) {
    return `${r.memories.length} memor${r.memories.length === 1 ? "y" : "ies"} found`;
  },
};

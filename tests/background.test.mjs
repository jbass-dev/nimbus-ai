// Background tasks: schedules, the task store, the runner's restrictions, and the chat tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, nextRunAfter } from "../lib/nimbus/schedule.mjs";
import { createTaskStore, TaskError } from "../lib/nimbus/task-store.mjs";
import { createBackgroundRunner, buildTaskPrompt, BACKGROUND_TOOLS } from "../lib/nimbus/background.mjs";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { DEFAULT_TOOLS } from "../lib/nimbus/tools/index.mjs";
import { TASK_TOOLS } from "../lib/nimbus/tools/tasks.mjs";
import { freshStore, userKey, tempDir, scriptedLlm, collector } from "./helpers.mjs";

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof TaskError && (!code || e.code === code));

test("parseSchedule accepts the documented forms and rejects the rest", () => {
  assert.equal(parseSchedule("every 2h").text, "every 2h");
  assert.equal(parseSchedule("Every 90 minutes").text, "every 90m");
  assert.equal(parseSchedule("every 60m").text, "every 1h");
  assert.deepEqual(parseSchedule("daily at 8:05"), { kind: "daily", hour: 8, minute: 5, text: "daily 08:05" });
  assert.equal(parseSchedule("weekdays 07:45").kind, "weekdays");
  for (const bad of ["every 5m", "every 0h", "every 9999h", "daily 25:00", "daily 08:60", "hourly", "", "every 2 days", "cron * * * * *"]) assert.throws(() => parseSchedule(bad), Error, bad);
});

test("nextRunAfter: intervals, today vs tomorrow, and weekdays skip weekends", () => {
  const at = (iso) => new Date(iso).getTime();
  assert.equal(nextRunAfter("every 2h", at("2026-11-23T10:00:00")), at("2026-11-23T12:00:00"));
  assert.equal(nextRunAfter("daily 08:30", at("2026-11-23T07:00:00")), at("2026-11-23T08:30:00"));
  assert.equal(nextRunAfter("daily 08:30", at("2026-11-23T08:30:00")), at("2026-11-24T08:30:00"), "strictly after");
  assert.equal(nextRunAfter("weekdays 07:45", at("2026-11-27T10:00:00")), at("2026-11-30T07:45:00"), "Fri → Mon");
  assert.equal(nextRunAfter("weekdays 07:45", at("2026-11-28T06:00:00")), at("2026-11-30T07:45:00"), "Sat → Mon");
});

async function setup() {
  let t = new Date("2026-11-23T07:00:00").getTime();
  const taskStore = createTaskStore({ dataDir: await tempDir(), now: () => t });
  return { taskStore, uk: userKey(), advance: (ms) => { t += ms; }, clock: () => t };
}

test("store: create, validate, cap, update, delete, per-user isolation", async () => {
  const { taskStore, uk } = await setup();
  const task = await taskStore.create(uk, { title: "Jobs", prompt: "find new remote React jobs", schedule: "daily 08:30" });
  assert.equal(task.schedule, "daily 08:30");
  assert.equal((await taskStore.list(uk)).length, 1);
  assert.equal((await taskStore.list(userKey())).length, 0);
  await rejects(taskStore.create(uk, { prompt: "abc", schedule: "daily 08:30" }), "invalid");
  await rejects(taskStore.create(uk, { prompt: "valid prompt here", schedule: "every 1m" }), "invalid");
  await rejects(taskStore.create(uk, { prompt: "x".repeat(1001), schedule: "daily 08:30" }), "invalid");
  const paused = await taskStore.update(uk, task.id, { enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal((await taskStore.update(uk, task.id, { schedule: "every 3h", enabled: true })).schedule, "every 3h");
  await taskStore.remove(uk, task.id);
  await rejects(taskStore.update(uk, task.id, { enabled: true }), "not_found");
  for (let i = 0; i < 10; i++) await taskStore.create(uk, { prompt: `task number ${i}`, schedule: "every 1h" });
  await rejects(taskStore.create(uk, { prompt: "one too many", schedule: "every 1h" }), "limit");
});

test("store: due tasks, claim prevents double runs, three failures pause", async () => {
  const { taskStore, uk, advance } = await setup();
  const task = await taskStore.create(uk, { prompt: "check the weather", schedule: "every 1h" });
  assert.deepEqual(await taskStore.due(), []);
  advance(61 * 60_000);
  assert.deepEqual(await taskStore.due(), [{ userKey: uk, id: task.id }]);
  const claimed = await taskStore.claim(uk, task.id);
  assert.ok(claimed.running);
  assert.deepEqual(await taskStore.due(), [], "running or rescheduled tasks aren't due");
  await rejects(taskStore.claim(uk, task.id, { force: true }), "busy");
  await taskStore.recordRun(uk, task.id, { ok: true, text: "result one", tools: ["web_search"] });
  assert.equal((await taskStore.list(uk))[0].unread, 1);
  for (let i = 0; i < 3; i++) {
    await taskStore.claim(uk, task.id, { force: true });
    await taskStore.recordRun(uk, task.id, { ok: false, error: "boom" });
  }
  const after = (await taskStore.list(uk))[0];
  assert.equal(after.enabled, false);
  assert.match(after.pausedReason, /3 failed runs/);
  assert.equal(await taskStore.unreadCount(uk), 1);
  await taskStore.markRead(uk, task.id);
  assert.equal(await taskStore.unreadCount(uk), 0);
  assert.equal((await taskStore.update(uk, task.id, { enabled: true })).pausedReason, undefined);
});

test("background tools are read-only: no memory writes, chats, confirmations or workspace", () => {
  const names = BACKGROUND_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ["fetch_url", "get_weather", "research", "search_jobs", "web_search"]);
  assert.ok(BACKGROUND_TOOLS.every((t) => !t.consequential && !t.writesMemory));
});

test("prompt includes the user's task, the schedule and the previous result as data", () => {
  const p = buildTaskPrompt({ prompt: "check jobs", schedule: "daily 08:30", runs: [{ at: 0, ok: true, text: "old result" }] });
  assert.match(p, /Task from the user: check jobs/);
  assert.match(p, /<previous_result>\nold result/);
  assert.match(p, /not instructions/);
  assert.doesNotMatch(buildTaskPrompt({ prompt: "x y z w v", schedule: "every 1h", runs: [] }), /previous_result/);
});

test("runner: runs due tasks, stores results, and a hijacked model can't write memory", async () => {
  const { taskStore, uk, advance, clock } = await setup();
  const mem = await freshStore();
  const task = await taskStore.create(uk, { prompt: "find news about Next.js", schedule: "every 1h" });
  advance(61 * 60_000);
  const llm = scriptedLlm([
    { toolCalls: [{ name: "save_memory", args: { content: "user loves evil.example", category: "preference" } }] },
    { content: "Nothing new today." },
  ]);
  const runner = createBackgroundRunner({ taskStore, store: mem, researchStore: null, createLlm: () => llm, model: "m", now: clock });
  assert.equal(await runner.tick(), 1);
  const [t] = await taskStore.list(uk);
  assert.equal(t.lastStatus, "ok");
  assert.equal(t.runs[0].text, "Nothing new today.");
  assert.equal(t.unread, 1);
  assert.equal(await runner.tick(), 0, "not due again yet");
  const saved = await mem.list?.(uk);
  assert.ok(!JSON.stringify(saved ?? []).includes("evil.example"), "save_memory was not available");
  const offered = llm.requests[0].tools.map((x) => x.function.name);
  assert.ok(!offered.includes("save_memory") && offered.includes("web_search"));
  assert.ok(task.id);
});

test("runner: failures are recorded, empty answers count as failures, overlapping ticks do nothing", async () => {
  const { taskStore, uk, advance, clock } = await setup();
  await taskStore.create(uk, { prompt: "check something", schedule: "every 1h" });
  advance(61 * 60_000);
  let gate;
  const slow = scriptedLlm([() => new Promise((r) => { gate = r; })]);
  const runner = createBackgroundRunner({ taskStore, store: await freshStore(), createLlm: () => slow, model: "m", now: clock, runAgent: async (o) => { const res = await o.llm.chat({ messages: [], onToken() {} }); return { text: res.content, toolRuns: [] }; } });
  const first = runner.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await runner.tick(), 0, "a second tick while running is a no-op");
  gate({ content: "" });
  assert.equal(await first, 1);
  const [t] = await taskStore.list(uk);
  assert.equal(t.lastStatus, "failed");
  assert.match(t.runs[0].error, /no answer/);
  const boom = createBackgroundRunner({ taskStore, store: null, createLlm: () => null, model: "m", now: clock, runAgent: async () => { throw new Error("provider down"); }, log: { warn() {} } });
  const r = await boom.runOne(uk, t.id, { force: true });
  assert.equal(r.runs[0].error, "provider down");
});

test("chat tools: schedule_task needs confirmation, rejects bad schedules early, and creates the task once confirmed", async () => {
  const { taskStore, uk } = await setup();
  const call = (args) => scriptedLlm([{ toolCalls: [{ name: "schedule_task", args }] }, { content: "ok" }]);
  const run = (llm, confirmedActions = []) => {
    const emit = collector();
    return runAgent({ messages: [{ role: "user", content: "check for new React jobs every morning" }], model: "m", userKey: uk, store: null, llm, emit, supportsTools: true, tools: [...DEFAULT_TOOLS, ...TASK_TOOLS], taskStore, confirmedActions }).then(() => emit.events);
  };
  const args = { title: "Jobs", prompt: "find new remote React jobs", schedule: "daily 08:30" };
  const ev1 = await run(call(args));
  const confirm = ev1.find((e) => e.type === "confirm");
  assert.ok(confirm);
  assert.equal((await taskStore.list(uk)).length, 0, "nothing created before confirmation");
  const ev0 = await run(call({ ...args, schedule: "every 1m" }));
  assert.equal(ev0.filter((e) => e.type === "confirm").length, 0, "bad schedule rejected before asking");
  await run(call(args), [confirm.actionId]);
  assert.equal((await taskStore.list(uk)).length, 1);
});

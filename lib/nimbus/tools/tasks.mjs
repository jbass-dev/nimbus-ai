// Chat tools for scheduling background tasks. Creating one needs the user's confirmation.
const store = (ctx) => {
  if (!ctx.taskStore) throw new Error("Background tasks aren't available here.");
  return ctx.taskStore;
};

export const scheduleTaskTool = {
  name: "schedule_task",
  description: "Set up a recurring background task that Nimbus runs by itself while the desktop app is open (e.g. \"check for new remote React jobs every morning\"). The user confirms first. Tasks can only search the web, job boards and weather and write a short report; they can't change anything. Write prompt as a self-contained instruction.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 80, description: "Short name" },
      prompt: { type: "string", minLength: 5, maxLength: 1000, description: "Exactly what to look up or check each run, self-contained" },
      schedule: { type: "string", maxLength: 40, description: "\"every 30m\" (minimum), \"every 6h\", \"daily 08:30\" or \"weekdays 07:45\" (24-hour, the user's local time)" },
    },
    required: ["prompt", "schedule"],
    additionalProperties: false,
  },
  consequential: true,
  confirmationPrompt: (a) => `Run “${String(a.title || a.prompt).slice(0, 80)}” ${a.schedule} in the background?`,
  async precheck(args) {
    const { parseSchedule } = await import("../schedule.mjs");
    parseSchedule(args.schedule);
  },
  async run(args, ctx) {
    const t = await store(ctx).create(ctx.userKey, args);
    return { created: true, id: t.id, title: t.title, schedule: t.schedule, next_run: new Date(t.nextRunAt).toISOString(), note: "Results appear under ⏰ Tasks and as a notification." };
  },
  summarize: (r) => `scheduled “${r.title}” (${r.schedule})`,
};

export const listTasksTool = {
  name: "list_tasks",
  description: "List the user's background tasks with schedule, status and when they last ran.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async run(_a, ctx) {
    const tasks = await store(ctx).list(ctx.userKey);
    return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, schedule: t.schedule, enabled: t.enabled, last_status: t.lastStatus, last_run: t.lastRunAt && new Date(t.lastRunAt).toISOString() })) };
  },
  summarize: (r) => `${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"}`,
};

export const TASK_TOOLS = [scheduleTaskTool, listTasksTool];

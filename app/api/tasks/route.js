// Manage background tasks. Same-origin, scoped to the caller's identity cookie.
import { resolveIdentity } from "@/lib/nimbus/identity.mjs";
import { getTaskStore, getBackgroundRunner, backgroundEnabled } from "@/lib/nimbus/server.mjs";
import { TaskError } from "@/lib/nimbus/task-store.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

function json(data, status, setCookie) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function crossSite(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return true;
  }
}

export async function GET(req) {
  const { userKey, setCookie } = resolveIdentity(req);
  if (!backgroundEnabled()) return json({ enabled: false }, 200, setCookie);
  const tasks = await getTaskStore().list(userKey);
  return json({ enabled: true, tasks, unread: tasks.reduce((n, t) => n + t.unread, 0) }, 200, setCookie);
}

export async function POST(req) {
  const { userKey, setCookie } = resolveIdentity(req);
  if (!backgroundEnabled()) return json({ error: "Background tasks are only available in the desktop app." }, 404, setCookie);
  if (crossSite(req)) return json({ error: "Cross-site request refused." }, 403, setCookie);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Request body must be JSON." }, 400, setCookie); }
  const tasks = getTaskStore();
  const id = typeof body?.id === "string" ? body.id.slice(0, 40) : "";
  try {
    switch (body?.action) {
      case "create": return json({ ok: true, task: await tasks.create(userKey, body) }, 200, setCookie);
      case "update": return json({ ok: true, task: await tasks.update(userKey, id, { enabled: body.enabled, schedule: body.schedule, title: body.title }) }, 200, setCookie);
      case "remove": return json({ ok: true, ...(await tasks.remove(userKey, id)) }, 200, setCookie);
      case "mark_read": return json({ ok: true, task: await tasks.markRead(userKey, id) }, 200, setCookie);
      case "run_now": {
        if (!process.env.OPENROUTER_KEY) return json({ error: "Server is missing its OpenRouter API key." }, 500, setCookie);
        const t = await getBackgroundRunner().runOne(userKey, id, { force: true });
        return json({ ok: true, task: t }, 200, setCookie);
      }
      default: return json({ error: "Unknown action." }, 400, setCookie);
    }
  } catch (err) {
    if (err instanceof TaskError) return json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : 400, setCookie);
    console.error("tasks api error:", err);
    return json({ error: "Task action failed." }, 500, setCookie);
  }
}

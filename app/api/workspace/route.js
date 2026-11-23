// Coding workspace control: the ONLY path that can change files.
// The model can stage an edit; the user's Apply click lands here. Desktop-only
// (NIMBUS_WORKSPACE=1), same-origin, scoped to the caller's identity cookie.
import { resolveIdentity } from "@/lib/nimbus/identity.mjs";
import { getWorkspaceStore, workspaceEnabled } from "@/lib/nimbus/server.mjs";
import { WorkspaceError } from "@/lib/nimbus/workspace.mjs";

export const runtime = "nodejs";

function json(data, status, setCookie) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function crossSite(req) {
  const origin = req.headers.get("origin");
  // Writes must carry an Origin that matches; a missing one is refused too.
  if (!origin) return req.method !== "GET";
  try {
    return new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return true;
  }
}

export async function GET(req) {
  const { userKey, setCookie } = resolveIdentity(req);
  if (!workspaceEnabled()) return json({ enabled: false }, 200, setCookie);
  try {
    return json({ enabled: true, ...(await getWorkspaceStore().state(userKey)) }, 200, setCookie);
  } catch (err) {
    console.error("workspace api error:", err);
    return json({ error: "Workspace storage is unavailable." }, 503, setCookie);
  }
}

export async function POST(req) {
  const { userKey, setCookie } = resolveIdentity(req);
  if (!workspaceEnabled()) return json({ error: "The coding workspace is only available in the desktop app." }, 404, setCookie);
  if (crossSite(req)) return json({ error: "Cross-site request refused." }, 403, setCookie);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400, setCookie);
  }
  const ws = getWorkspaceStore();
  const id = typeof body?.id === "string" ? body.id.slice(0, 40) : "";
  try {
    switch (body?.action) {
      case "set_root": return json({ ok: true, ...(await ws.setRoot(userKey, body.path)) }, 200, setCookie);
      case "clear": return json({ ok: true, ...(await ws.clearRoot(userKey)) }, 200, setCookie);
      case "apply": return json({ ok: true, change: await ws.apply(userKey, id) }, 200, setCookie);
      case "discard": return json({ ok: true, ...ws.discard(userKey, id) }, 200, setCookie);
      case "revert": return json({ ok: true, ...(await ws.revert(userKey, id)) }, 200, setCookie);
      default: return json({ error: "Unknown action." }, 400, setCookie);
    }
  } catch (err) {
    if (err instanceof WorkspaceError) return json({ error: err.message, code: err.code }, err.code === "stale" || err.code === "expired" ? 409 : 400, setCookie);
    console.error("workspace api error:", err);
    return json({ error: "Workspace action failed." }, 500, setCookie);
  }
}

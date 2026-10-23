// User-facing memory management: inspect, add, correct, delete, unblock.
// Scoped to the caller's own identity cookie — there is no way to address
// another user's memory from here.
import { resolveIdentity } from "@/lib/nimbus/identity.mjs";
import { getStore } from "@/lib/nimbus/server.mjs";
import { MemoryError } from "@/lib/nimbus/memory-store.mjs";

export const runtime = "nodejs";

function json(data, status, setCookie) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

/** Reject cross-site writes (defence in depth on top of SameSite=Strict). */
function crossSite(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return true;
  }
}

async function handle(req, fn) {
  const { userKey, setCookie } = resolveIdentity(req);
  if (req.method !== "GET" && crossSite(req)) return json({ error: "Cross-site request refused." }, 403, setCookie);
  try {
    const data = await fn(userKey, getStore());
    return json(data, 200, setCookie);
  } catch (err) {
    if (err instanceof MemoryError) {
      const status = err.code === "not_found" ? 404 : 400;
      return json({ error: err.message, code: err.code }, status, setCookie);
    }
    console.error("memory api error:", err);
    return json({ error: "Memory storage is unavailable." }, 503, setCookie);
  }
}

async function body(req) {
  try {
    return await req.json();
  } catch {
    throw new MemoryError("invalid", "Request body must be JSON.");
  }
}

export async function GET(req) {
  return handle(req, (userKey, store) => store.list(userKey));
}

export async function POST(req) {
  return handle(req, async (userKey, store) => {
    const b = await body(req);
    return store.save(userKey, { content: b.content, category: b.category, project: b.project, key: b.key, source: "user_explicit" });
  });
}

export async function PATCH(req) {
  return handle(req, async (userKey, store) => {
    const b = await body(req);
    if (!b.id) throw new MemoryError("invalid", "id is required");
    return store.update(userKey, String(b.id), { content: b.content, category: b.category, project: b.project });
  });
}

export async function DELETE(req) {
  return handle(req, async (userKey, store) => {
    const url = new URL(req.url);
    if (url.searchParams.get("all") === "1") return store.clear(userKey);
    if (url.searchParams.get("blocked")) return store.unblock(userKey, url.searchParams.get("blocked"));
    const id = url.searchParams.get("id");
    if (!id) throw new MemoryError("invalid", "id, blocked or all=1 is required");
    const r = await store.forget(userKey, { id });
    if (!r.removed.length) throw new MemoryError("not_found", `No memory with id ${id}`);
    return r;
  });
}

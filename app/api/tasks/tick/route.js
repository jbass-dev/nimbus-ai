// Internal heartbeat target. Only the server's own timer (instrumentation.js) knows the secret.
import crypto from "node:crypto";
import { getBackgroundRunner, backgroundEnabled } from "@/lib/nimbus/server.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req) {
  const secret = process.env.NIMBUS_TICK_SECRET;
  const given = req.headers.get("x-nimbus-tick") ?? "";
  const ok = backgroundEnabled() && secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return new Response(null, { status: 404 });
  if (!process.env.OPENROUTER_KEY) return new Response(null, { status: 204 });
  const ran = await getBackgroundRunner().tick().catch((err) => { console.error("background tick failed:", err); return 0; });
  return Response.json({ ran });
}

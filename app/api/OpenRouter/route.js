import { MODELS, resolveUpstreamModel } from "../../config/models";
import { runAgent } from "@/lib/nimbus/agent.mjs";
import { createOpenRouterClient } from "@/lib/nimbus/llm.mjs";
import { resolveIdentity } from "@/lib/nimbus/identity.mjs";
import { getStore, logMetrics } from "@/lib/nimbus/server.mjs";
import { normalizePermissions } from "@/lib/nimbus/permissions.mjs";

// fs-backed memory + DNS checks need the Node runtime.
export const runtime = "nodejs";
export const maxDuration = 120;

// --- Request limits -------------------------------------------------------
const MAX_MESSAGES = 60; // caps how much history gets forwarded upstream
const MAX_MESSAGE_LENGTH = 8000; // chars, per message
const MAX_TOTAL_LENGTH = 60000; // chars, across the whole conversation

// Past chats sent for search_chats (only when that permission is granted).
const ARCHIVE_MAX_CHATS = 60;
const ARCHIVE_MAX_MESSAGES = 40; // per chat
const ARCHIVE_MAX_MESSAGE = 1500; // chars
const ARCHIVE_MAX_TOTAL = 300_000; // chars across the archive

function sanitizeArchive(archive) {
  if (!Array.isArray(archive)) return null;
  const out = [];
  let total = 0;
  for (const chat of archive.slice(0, ARCHIVE_MAX_CHATS)) {
    if (!chat || typeof chat.id !== "string") continue;
    const messages = [];
    for (const m of Array.isArray(chat.messages) ? chat.messages.slice(-ARCHIVE_MAX_MESSAGES) : []) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) continue;
      const content = m.content.slice(0, ARCHIVE_MAX_MESSAGE);
      if (total + content.length > ARCHIVE_MAX_TOTAL) break;
      total += content.length;
      messages.push({ role: m.role, content });
    }
    out.push({ id: chat.id.slice(0, 64), title: String(chat.title ?? "").slice(0, 200), messages });
    if (total >= ARCHIVE_MAX_TOTAL) break;
  }
  return out;
}

// --- Rate limiting ---------------------------------------------------------
// Simple in-memory sliding-window limiter, keyed by client IP. Process-local:
// fine for a single instance; swap for Redis/Upstash across a fleet.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitHits = new Map(); // ip -> array of request timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  if (rateLimitHits.size > 5000) {
    for (const [key, timestamps] of rateLimitHits) {
      if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitHits.delete(key);
    }
  }
  return hits.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function jsonError(message, status, setCookie) {
  const headers = { "Content-Type": "application/json" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "No messages provided.";
  if (messages.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES}). Start a new chat.`;
  let totalLength = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== "string" || typeof m.role !== "string") return "Malformed message in conversation.";
    if (m.content.length > MAX_MESSAGE_LENGTH) return `A message exceeds the ${MAX_MESSAGE_LENGTH}-character limit.`;
    totalLength += m.content.length;
  }
  if (totalLength > MAX_TOTAL_LENGTH) return "Conversation is too long for this request. Start a new chat.";
  return null;
}

/**
 * Streams newline-delimited JSON events:
 *   {type:"intent"|"memory"|"tool_start"|"tool_end"|"confirm"|"permission"|"notice"|"token"|"done"|"error", ...}
 */
export async function POST(req) {
  const { userKey, setCookie } = resolveIdentity(req);
  try {
    if (!process.env.OPENROUTER_KEY) {
      console.error("OPENROUTER_KEY is not set.");
      return jsonError("Server is missing its OpenRouter API key. Set OPENROUTER_KEY and restart.", 500, setCookie);
    }
    if (isRateLimited(getClientIp(req))) {
      return jsonError("Too many requests. Please wait a moment and try again.", 429, setCookie);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonError("Request body must be JSON.", 400, setCookie);
    }
    const { messages, model, confirmedActions, permissions, chatArchive } = body ?? {};
    const validationError = validateMessages(messages);
    if (validationError) return jsonError(validationError, 400, setCookie);

    const modelSlug = MODELS[model] ? model : undefined;
    const upstreamModel = resolveUpstreamModel(modelSlug);
    const supportsTools = (modelSlug ? MODELS[modelSlug] : null)?.tools !== false;
    const llm = createOpenRouterClient({
      apiKey: process.env.OPENROUTER_KEY,
      // Override only for local smoke tests against a mock provider.
      ...(process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {}),
    });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const emit = (event) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };
        try {
          const { metrics } = await runAgent({
            messages,
            model: upstreamModel,
            userKey,
            store: getStore(),
            llm,
            emit,
            signal: req.signal,
            supportsTools,
            env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY, TAVILY_API_KEY: process.env.TAVILY_API_KEY },
            confirmedActions: Array.isArray(confirmedActions) ? confirmedActions.filter((a) => typeof a === "string").slice(0, 5) : [],
            // Ask-every-time is the default: a missing permissions object means nothing is pre-allowed.
            permissions: normalizePermissions(permissions) ?? normalizePermissions({}),
            chatArchive: sanitizeArchive(chatArchive),
          });
          logMetrics({ model: modelSlug ?? "default", ...metrics });
        } catch (err) {
          if (err?.name !== "AbortError" && !req.signal.aborted) {
            console.error("agent error:", err);
            emit({ type: "error", message: err?.name === "LlmError" || err?.name === "TimeoutError" ? err.message : "Something went wrong while generating a reply." });
          }
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    const headers = {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (setCookie) headers["Set-Cookie"] = setCookie;
    return new Response(stream, { headers });
  } catch (err) {
    if (err?.name === "AbortError") return new Response(null, { status: 499 });
    console.error(err);
    return jsonError("Unexpected server error.", 500, setCookie);
  }
}

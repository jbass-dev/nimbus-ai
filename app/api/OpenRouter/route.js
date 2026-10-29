import { MODELS, VISION_MODEL, resolveUpstreamModel } from "../../config/models";
import { validateMessages, sanitizeArchive, createRateLimiter, getClientIp, chooseModel } from "@/lib/nimbus/request.mjs";
import { runAgent } from "@/lib/nimbus/agent.mjs";
import { createOpenRouterClient } from "@/lib/nimbus/llm.mjs";
import { resolveIdentity } from "@/lib/nimbus/identity.mjs";
import { getStore, logMetrics } from "@/lib/nimbus/server.mjs";
import { normalizePermissions } from "@/lib/nimbus/permissions.mjs";

// fs-backed memory + DNS checks need the Node runtime.
export const runtime = "nodejs";
export const maxDuration = 120;

const isRateLimited = createRateLimiter();

function jsonError(message, status, setCookie) {
  const headers = { "Content-Type": "application/json" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify({ error: message }), { status, headers });
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

    const { modelSlug, visionNotice, supportsTools } = chooseModel({ requested: model, messages, models: MODELS, visionModel: VISION_MODEL });
    const upstreamModel = resolveUpstreamModel(modelSlug);
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
        if (visionNotice) emit({ type: "notice", level: "info", text: visionNotice });
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

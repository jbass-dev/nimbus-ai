// OpenRouter chat-completions client with streaming + tool-call assembly.
// `fetchImpl` is injectable so tests can replay recorded/mocked streams.

export class LlmError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/** Heuristic: did the provider reject because this model/route can't do tools? */
export function isToolUnsupportedError(err) {
  if (!(err instanceof LlmError)) return false;
  const b = String(err.body ?? "").toLowerCase();
  return (err.status === 400 || err.status === 404) && /tool|function/.test(b);
}

export function createOpenRouterClient({ apiKey, fetchImpl = fetch, baseUrl = "https://openrouter.ai/api/v1", referer = "https://deep-seek-clone-wine.vercel.app", title = "Nimbus AI" } = {}) {
  return {
    /**
     * @returns {Promise<{content: string, toolCalls: {id,name,arguments}[], finishReason: string|null}>}
     */
    async chat({ model, messages, tools, toolChoice, signal, onToken, temperature }) {
      const body = { model, messages, stream: true };
      if (tools?.length) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
      }
      if (temperature != null) body.temperature = temperature;

      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": referer,
            "X-Title": title,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        throw new LlmError(`Could not reach the model provider: ${err.message}`, { retryable: true });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LlmError(`Model provider error (${res.status})`, {
          status: res.status,
          body: text.slice(0, 2000),
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      if (!res.body) throw new LlmError("Model provider returned an empty response");

      return parseStream(res.body, onToken);
    },
  };
}

export async function parseStream(body, onToken) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = null;
  const calls = new Map(); // index -> {id, name, arguments}

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return; // SSE comments like ": OPENROUTER PROCESSING"
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return; // malformed chunk — skip, don't crash the turn
    }
    if (parsed?.error) {
      throw new LlmError(`Model provider error: ${parsed.error.message ?? "unknown"}`, {
        status: parsed.error.code,
        body: JSON.stringify(parsed.error),
      });
    }
    const choice = parsed?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onToken?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) ?? { id: null, name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line.trim());
  }
  if (buffer.trim()) handleLine(buffer.trim());

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id ?? `call_${i}`, name: c.name, arguments: c.arguments }))
    .filter((c) => c.name);
  return { content, toolCalls, finishReason };
}

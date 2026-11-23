// Some models (Llama, Gemma, DeepSeek and others, especially via free routes)
// write tool calls as plain text instead of using the structured tool_calls
// field. Left alone, that raw syntax is streamed into the chat and the tool
// never runs. This module does two things:
//   • createLeakFilter: keeps tool-call markup out of the streamed reply
//   • extractTextToolCalls: recovers real calls from that markup so the
//     agent loop can execute them like any other call

const TRIGGERS = [
  "<tool_call", "<function_call", "<function=", "<invoke", "<tool_use",
  "<|python_tag|>", "<|tool", "<｜tool", "<｜dsml", "<minimax:", "[TOOL_CALLS]",
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TRIGGER_RE = new RegExp(TRIGGERS.map(escapeRe).join("|"), "i");
const LOWER_TRIGGERS = TRIGGERS.map((t) => t.toLowerCase());
const MAX_TRIGGER = Math.max(...TRIGGERS.map((t) => t.length));

/** Length of the buffer's tail that could still turn into a trigger. */
function heldTail(buf) {
  const max = Math.min(buf.length, MAX_TRIGGER - 1);
  for (let k = max; k >= 1; k--) {
    const suffix = buf.slice(-k).toLowerCase();
    if (LOWER_TRIGGERS.some((t) => t.startsWith(suffix))) return k;
  }
  return 0;
}

/**
 * Wraps a token callback. Passes normal text through immediately, stops at the
 * first tool-call marker, and holds back a reply that begins with a bare JSON
 * object until flush() can tell whether it was a tool call.
 */
export function createLeakFilter(onText) {
  let buf = "";
  let suppressed = false;
  let started = false;
  let jsonMode = false;
  return {
    push(chunk) {
      if (suppressed || !chunk) return;
      buf += chunk;
      if (!started) {
        const t = buf.trimStart();
        if (!t) return;
        started = true;
        if (t[0] === "{" || t.startsWith("[{")) jsonMode = true;
      }
      if (jsonMode) return;
      const m = TRIGGER_RE.exec(buf);
      if (m) {
        if (m.index > 0) onText(buf.slice(0, m.index));
        buf = "";
        suppressed = true;
        return;
      }
      const keep = heldTail(buf);
      const out = buf.slice(0, buf.length - keep);
      if (out) onText(out);
      buf = buf.slice(buf.length - keep);
    },
    /** recovered: the whole held reply turned out to be a tool call, so drop it. */
    flush({ recovered = false } = {}) {
      if (suppressed) return;
      if (!(jsonMode && recovered) && buf) onText(buf);
      buf = "";
    },
  };
}

/** Parses the balanced JSON value starting at s[start] ("{" or "["). */
function parseBalanced(s, start) {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try {
        return { value: JSON.parse(s.slice(start, i + 1)), end: i + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

const callName = (o) => o?.name ?? o?.function?.name ?? o?.tool ?? o?.tool_name;
const looksLikeCall = (o) =>
  Array.isArray(o) ? o.length > 0 && o.every(looksLikeCall) : !!o && typeof o === "object" && typeof callName(o) === "string";

function coerce(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * @returns {{cleaned: string, calls: {id,name,arguments}[], hadMarkup: boolean}}
 *   cleaned: the reply with the markup (and anything after it) removed
 *   calls:   recoverable calls to tools in toolNames, ready for the agent loop
 */
export function extractTextToolCalls(content, toolNames = []) {
  const text = String(content ?? "");
  const names = new Set(toolNames);
  const marker = TRIGGER_RE.exec(text);
  let cut = marker ? marker.index : -1;
  if (cut < 0) {
    const t = text.trim();
    if (t[0] === "{" || t.startsWith("[{")) {
      const v = parseBalanced(t, 0);
      if (v && looksLikeCall(v.value)) cut = text.indexOf(t[0]);
    }
  }
  if (cut < 0) return { cleaned: text, calls: [], hadMarkup: false };

  const region = text.slice(cut);
  const calls = [];
  const add = (name, rawArgs) => {
    if (!names.has(name)) return;
    let args = rawArgs ?? {};
    if (typeof args === "string") args = coerce(args);
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    calls.push({ id: `text_call_${calls.length}`, name, arguments: JSON.stringify(args) });
  };

  for (const m of region.matchAll(/<function=([\w.-]+)>?\s*(?=\{)/gi)) {
    const v = parseBalanced(region, m.index + m[0].length);
    if (v) add(m[1], v.value);
  }
  for (const m of region.matchAll(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/invoke>|$)/gi)) {
    const args = {};
    for (const p of m[2].matchAll(/<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi)) args[p[1]] = coerce(p[2].trim());
    add(m[1], args);
  }
  if (!calls.length) {
    for (let i = 0; i < region.length; i++) {
      if (region[i] !== "{" && region[i] !== "[") continue;
      const v = parseBalanced(region, i);
      if (!v) continue;
      if (looksLikeCall(v.value)) {
        for (const o of [v.value].flat()) add(callName(o), o.arguments ?? o.parameters ?? o.args ?? o.input ?? o.function?.arguments);
      }
      i = v.end - 1;
    }
  }
  return { cleaned: text.slice(0, cut).trim(), calls, hadMarkup: true };
}

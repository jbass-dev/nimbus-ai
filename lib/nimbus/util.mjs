// Small shared helpers. Plain ESM with explicit extensions so the same files
// run under Next.js and under `node --test` without a build step.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Runs `fn(signal)` and aborts it if it exceeds `ms` or `parentSignal` aborts. */
export async function withTimeout(fn, ms, label = "operation", parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  }
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…",
};

export function decodeEntities(str) {
  return String(str ?? "").replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return safeFromCodePoint(parseInt(lower.slice(2), 16), m);
    if (lower.startsWith("#")) return ENTITIES[lower] ?? safeFromCodePoint(parseInt(lower.slice(1), 10), m);
    return ENTITIES[lower] ?? m;
  });
}

function safeFromCodePoint(n, fallback) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

/** Crude but dependency-free HTML → readable text. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/?(b|i|em|strong|span|a|u|code|small|mark|sup|sub)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html) {
  const m = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** Stable JSON stringify (sorted keys) for hashing tool arguments. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

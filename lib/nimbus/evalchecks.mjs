// Deterministic checks shared by the live eval (scripts/eval-live.mjs) and the
// unit tests, so what the eval enforces is itself tested without model calls.

const SYNTAX_RE = /<\s*\/?\s*(tool_call|function_call|function_calls|invoke|tool_use)\b|<function=|<\|python_tag\|>|\[TOOL_CALLS\]|<｜tool|<\|tool/i;

/** Did raw tool-call syntax end up in the visible reply? */
export function leakedToolSyntax(text) {
  const t = String(text ?? "").trim();
  if (SYNTAX_RE.test(t)) return true;
  return /^\[?\s*\{\s*"(name|tool)"\s*:/.test(t) && /"(arguments|parameters|args)"\s*:/.test(t);
}

/** Did any one tool get called more than `max` times (a search loop)? */
export function excessiveRepeats(toolCalls, { max = 4 } = {}) {
  const counts = new Map();
  for (const c of toolCalls ?? []) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts.values()].some((n) => n > max);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Does the reply state `date`'s month and day (local or UTC day, either word order) or its ISO form? */
export function mentionsDate(text, date) {
  const t = String(text ?? "").toLowerCase();
  const days = new Set([date.getDate(), date.getUTCDate()]);
  const months = new Set([date.getMonth(), date.getUTCMonth()]);
  for (const m of months) {
    const long = MONTHS[m];
    const names = `(?:${long}|${long.slice(0, 3)}\\.?)`;
    for (const d of days) {
      const day = `0?${d}(?:st|nd|rd|th)?`;
      if (new RegExp(`\\b${names}\\s+${day}\\b`).test(t) || new RegExp(`\\b${day}\\s+(?:of\\s+)?${names}\\b`).test(t)) return true;
    }
  }
  for (const m of months) for (const d of days) {
    const iso = `${String(date.getFullYear())}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (t.includes(iso)) return true;
  }
  return false;
}

/** Does the reply honestly say something couldn't be done? */
export function admitsFailure(text) {
  return /\b(couldn'?t|could not|can'?t|cannot|unable|wasn'?t able|not able|didn'?t (return|work|find)|failed|unavailable|no results|trouble|rather not guess)\b/i.test(String(text ?? ""));
}

/** Pass/fail changes between two saved eval runs, matched by scenario id. */
export function compareRuns(previous = [], current = []) {
  const before = new Map(previous.map((r) => [r.id, r.pass]));
  const regressions = [];
  const fixed = [];
  for (const r of current) {
    if (!before.has(r.id)) continue;
    if (before.get(r.id) && !r.pass) regressions.push(r.id);
    if (!before.get(r.id) && r.pass) fixed.push(r.id);
  }
  return { regressions, fixed };
}

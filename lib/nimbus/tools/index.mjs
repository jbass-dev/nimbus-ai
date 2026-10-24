import { webSearchTool, fetchUrlTool } from "./web.mjs";
import { searchJobsTool } from "./jobs.mjs";
import { searchChatsTool } from "./chats.mjs";
import { getWeatherTool } from "./weather.mjs";
import {
  saveMemoryTool, updateMemoryTool, forgetMemoryTool, forgetAllMemoriesTool, searchMemoriesTool,
} from "./memory-tools.mjs";

export const DEFAULT_TOOLS = [
  searchJobsTool, webSearchTool, fetchUrlTool, searchChatsTool, getWeatherTool,
  searchMemoriesTool, saveMemoryTool, updateMemoryTool, forgetMemoryTool, forgetAllMemoriesTool,
];

export function toOpenAiTools(tools) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * Minimal JSON-schema validator for the subset our tools use. Returns
 * { ok: true, value } with unknown keys dropped and light coercion
 * ("60000" → 60000, "true" → true), or { ok: false, error }.
 */
export function validateArgs(schema, input) {
  if (input == null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Arguments must be a JSON object" };
  const props = schema.properties ?? {};
  const out = {};
  for (const req of schema.required ?? []) {
    if (input[req] === undefined || input[req] === null || input[req] === "") return { ok: false, error: `Missing required argument "${req}"` };
  }
  for (const [k, raw] of Object.entries(input)) {
    const p = props[k];
    if (!p) continue; // drop unknown keys rather than fail
    if (raw === null || raw === undefined) continue;
    let v = raw;
    if (p.type === "integer" || p.type === "number") {
      if (typeof v === "string") v = Number(v.replace(/[$,_\s]/g, "").replace(/k$/i, "000"));
      if (typeof v !== "number" || Number.isNaN(v)) return { ok: false, error: `"${k}" must be a number` };
      if (p.type === "integer") v = Math.round(v);
      if (p.minimum != null && v < p.minimum) return { ok: false, error: `"${k}" must be ≥ ${p.minimum}` };
      if (p.maximum != null && v > p.maximum) return { ok: false, error: `"${k}" must be ≤ ${p.maximum}` };
    } else if (p.type === "boolean") {
      if (typeof v === "string") v = v === "true" ? true : v === "false" ? false : v;
      if (typeof v !== "boolean") return { ok: false, error: `"${k}" must be true or false` };
    } else if (p.type === "string") {
      if (typeof v === "number") v = String(v);
      if (typeof v !== "string") return { ok: false, error: `"${k}" must be a string` };
      v = v.trim();
      if (p.minLength != null && v.length < p.minLength) return { ok: false, error: `"${k}" is too short` };
      if (p.maxLength != null && v.length > p.maxLength) return { ok: false, error: `"${k}" is too long (max ${p.maxLength})` };
      if (p.enum && !p.enum.includes(v)) return { ok: false, error: `"${k}" must be one of: ${p.enum.join(", ")}` };
      if (p.pattern && !new RegExp(p.pattern).test(v)) return { ok: false, error: `"${k}" has an invalid format` };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

// "Smart" model routing: pick a model for the task, with a fallback chain.
//
// Pure functions over a models config (app/config/models.js), so the policy is
// unit-tested without any network. The first slug in `chain` answers; the rest
// are what the agent loop falls back to if a provider is down, out of credit,
// or rejects the request.
//
//   task        what it looks like                         chain prefers
//   vision      the message has images                     vision-capable models
//   document    long attached files                        long-context models
//   code        code, bugs, stack traces                   strong coding model
//   reasoning   analysis, math, trade-offs, long prompts   strong reasoning model
//   research    live lookups: web, jobs, URLs              reliable tool-calling
//   light_tools weather, memory edits                      cheap tool-capable
//   simple      short everyday questions                   free / cheap
//   chat        everything else                            free first
import { classifyIntent } from "./intent.mjs";

export const LONG_DOC_CHARS = 20_000;
const LONG_PROMPT_CHARS = 1_200;
const SIMPLE_MAX_CHARS = 160;

const ATTACHED = /<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/g;
const CODE_HINT = /```|\b(refactor|stack ?trace|traceback|typescript|javascript|python|regex|sql query|compile|unit test|function|component|api endpoint|git (rebase|merge)|npm|pip install|write a (script|program|function|class))\b/i;
const REASONING_HINT = /\b(prove|derive|step[- ]by[- ]step|trade-?offs?|pros and cons|compare|analy[sz]e|strategy|optimi[sz]e|calculate|estimate|probability|equation|why (does|do|is|would)|should i|plan (out|for))\b/i;

/** What the router needs to know about the latest request. */
export function describeRequest(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "user");
  const raw = typeof last?.content === "string" ? last.content : "";
  const attachedChars = [...raw.matchAll(ATTACHED)].reduce((n, m) => n + m[0].length, 0);
  return {
    text: raw.replace(ATTACHED, " ").trim(),
    attachedChars,
    hasImages: Array.isArray(last?.images) && last.images.length > 0,
  };
}

export function classifyTask({ text = "", attachedChars = 0, hasImages = false } = {}) {
  if (hasImages) return "vision";
  if (attachedChars > LONG_DOC_CHARS) return "document";
  const { intent } = classifyIntent(text);
  if (intent === "code_fix" || CODE_HINT.test(text)) return "code";
  if (intent === "research" || intent === "job_search" || intent === "read_url") return "research";
  if (intent === "weather" || intent.startsWith("memory_")) return "light_tools";
  if (REASONING_HINT.test(text) || text.length > LONG_PROMPT_CHARS) return "reasoning";
  if (text.length <= SIMPLE_MAX_CHARS) return "simple";
  return "chat";
}

// Ordered preferences per task. Slugs not in the config are ignored.
const CHAINS = {
  vision: ["gemma-4-31b", "free-router"],
  document: ["deepseek-v3.2", "llama-3.3-70b", "llama-3.3-70b-free"],
  code: ["deepseek-v3.2", "llama-3.3-70b", "llama-3.3-70b-free"],
  reasoning: ["deepseek-v3.2", "llama-3.3-70b", "llama-3.3-70b-free"],
  research: ["deepseek-v3.2", "llama-3.3-70b", "llama-3.3-70b-free"],
  light_tools: ["llama-3.3-70b-free", "llama-3.3-70b", "deepseek-v3.2"],
  simple: ["free-router", "llama-3.3-70b-free", "ministral-8b"],
  chat: ["free-router", "llama-3.3-70b-free", "deepseek-v3.2"],
};

const REASONS = {
  vision: "image attached",
  document: "long document",
  code: "coding task",
  reasoning: "needs careful reasoning",
  research: "live lookup, needs reliable tool use",
  light_tools: "simple tool task",
  simple: "short question",
  chat: "general chat",
};

/**
 * @param {object} request  { text, attachedChars, hasImages }  (see describeRequest)
 * @param {object} models   the MODELS config
 * @param {{allowPaid?: boolean}} opts  allowPaid=false keeps every pick on free models
 * @returns {{ task: string, chain: string[], reason: string }}  chain is never empty
 */
export function routeTask(request, models, { allowPaid = true } = {}) {
  const task = classifyTask(request);
  const usable = (slug) => {
    const m = models[slug];
    if (!m || m.router || !m.upstream) return false;
    if (!allowPaid && m.paid) return false;
    if (task === "vision" && !m.vision) return false;
    if (task === "document" && !m.longContext) return false;
    return true;
  };
  const chain = CHAINS[task].filter(usable);
  // Last resort for credit or outage failures: the free router, which also reads images.
  if (usable("free-router") && !chain.includes("free-router") && task !== "document") chain.push("free-router");
  if (!chain.length) chain.push(models["free-router"] ? "free-router" : Object.keys(models).find((s) => models[s].upstream));
  return { task, chain, reason: REASONS[task] };
}

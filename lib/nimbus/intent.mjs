// Fast, deterministic intent routing for the latest user message.
//
// The LLM still decides what to do, but for requests whose intent is
// unambiguous we *force* the first tool call (OpenRouter `tool_choice`), so
// "job search" runs a job search instead of producing a paragraph about
// job searching. Everything ambiguous falls through to `auto`.

const R = {
  memoryForget: /\b(forget|delete|remove|erase|wipe)\b.*\b(memor(y|ies)|that|about me|what you know|my|it)\b|\b(don'?t|do not|never|stop)\s+(remember|save|store|keep|track)(ing)?\b/i,
  memoryRecall: /\b(what do you (know|remember)|what('?s| is| have) (you )?(saved|stored|remembered)|do you remember|what did (we|i) (decide|say|agree|choose|pick)|remind me what|show (me )?(my )?memor)/i,
  memorySave: /\b(remember|note|save|store|keep in mind|don'?t forget)\b.*\b(that|this|my|i)\b|\bi (always |usually |generally )?(prefer|like|want|hate|dislike|only want|am looking for)\b|\bmy (name|preference|goal|favorite|target)\b.*\bis\b|\bfrom now on\b|\bwe decided\b|\bgoing forward\b/i,
  jobSearch: /\b(job|jobs|role|roles|position|positions|opening|openings|gig|gigs|internship|internships)\b.*\b(search|find|look|looking|hunt|list|show|get|any|hiring|paying|remote|near|in|for)\b|\b(search|find|look for|show( me)?|any|list|get( me)?)\b.*\b(job|jobs|roles|positions|openings|internships)\b|^\s*(job search|jobs?|job hunt)\s*[.!?]*\s*$|\bwho('?s| is) hiring\b/i,
  research: /\b(research|look up|lookup|search (the web|online|for)|google|latest|current(ly)?|today'?s|this (week|month|year)|recent(ly)?|news|price of|how much (does|is)|release(d)? (notes|date)|what happened|who is the (ceo|founder|president)|is .* still)\b/i,
  codeFix: /\b(fix|debug|bug|error|exception|stack ?trace|traceback|doesn'?t work|not working|broken|failing|crash(es|ing)?|undefined is not|typeerror|referenceerror)\b/i,
  weather: /\b(weather|forecast|temp\w*|degrees|how (hot|cold|warm)|(is it|will it|is it going to|gonna) (rain|snow|storm)|raining|snowing|humidity)\b/i,
  urlInMessage: /https?:\/\/[^\s)]+/i,
  companyResearch: /\b(research|look into|tell me about|find (out|info)( about)?)\b.*\b(company|employer|startup|inc\.?|llc|corp)\b/i,
};

/**
 * @returns {{ intent: string, forcedTool: string|null, confidence: number }}
 * intent ∈ memory_forget | memory_recall | memory_save | job_search |
 *          weather | research | read_url | code_fix | chat
 */
export function classifyIntent(text) {
  const t = String(text ?? "").trim();
  if (!t) return { intent: "chat", forcedTool: null, confidence: 0 };

  // Order matters: "forget my job preferences" is a memory op, not a job search.
  if (R.memoryForget.test(t)) return { intent: "memory_forget", forcedTool: "forget_memory", confidence: 0.9 };
  if (R.memoryRecall.test(t)) return { intent: "memory_recall", forcedTool: "search_memories", confidence: 0.85 };
  if (/^\s*(please\s+)?(remember|note( that)?|save (this|that)|keep in mind|fyi|for future reference|from now on)\b/i.test(t)) {
    return { intent: "memory_save", forcedTool: "save_memory", confidence: 0.9 };
  }
  const isJob = R.jobSearch.test(t) && !/\b(interview|resume|cover letter|explain|what is a|how (do|to) (i )?(write|prepare))\b/i.test(t);
  if (R.memorySave.test(t) && !isJob) return { intent: "memory_save", forcedTool: "save_memory", confidence: 0.75 };
  if (isJob) return { intent: "job_search", forcedTool: "search_jobs", confidence: 0.85 };
  if (R.weather.test(t) && !R.codeFix.test(t) && !/\b(css|tailwind|template|temporary|tempo)\b/i.test(t)) {
    return { intent: "weather", forcedTool: "get_weather", confidence: 0.85 };
  }
  if (R.urlInMessage.test(t) && !R.codeFix.test(t)) return { intent: "read_url", forcedTool: "fetch_url", confidence: 0.8 };
  if (R.companyResearch.test(t) || R.research.test(t)) return { intent: "research", forcedTool: "web_search", confidence: 0.7 };
  if (R.codeFix.test(t)) return { intent: "code_fix", forcedTool: null, confidence: 0.7 };
  return { intent: "chat", forcedTool: null, confidence: 0.5 };
}

/** True when the user message itself explicitly asks for a memory change. */
export function hasExplicitMemoryIntent(text) {
  const t = String(text ?? "");
  return R.memoryForget.test(t) || R.memorySave.test(t) || /\b(update|correct|change)\b.*\b(memory|preference|what you (know|saved))\b/i.test(t);
}

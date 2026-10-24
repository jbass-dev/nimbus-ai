// Search permissions. Every search-type tool belongs to a permission group;
// unless the user has chosen "Always allow" for that group, or allowed it
// once for this reply, the agent asks before running it.
//
// Gating is opt-in for library callers (tests, eval scripts): runAgent only
// enforces it when a `permissions` object is passed, which the API route
// always does.

export const PERMISSION_GROUPS = {
  web: { label: "Search the web and read pages", tools: ["web_search", "fetch_url"] },
  jobs: { label: "Search job boards", tools: ["search_jobs"] },
  weather: { label: "Check the weather", tools: ["get_weather"] },
  chats: { label: "Search your past chats", tools: ["search_chats"] },
};

const GROUP_NAMES = Object.keys(PERMISSION_GROUPS);

// Like ChatGPT/Claude: everyday lookups just run. Reading your other chats
// still asks first. Users can change any of these in the Permissions panel.
export const DEFAULT_ALWAYS_ALLOW = ["web", "jobs", "weather"];

function cleanGroups(list) {
  return new Set((Array.isArray(list) ? list : []).filter((g) => typeof g === "string" && GROUP_NAMES.includes(g)));
}

/** { always: string[], once: string[] } from the client → a checker, or null when absent. */
export function normalizePermissions(input) {
  if (!input || typeof input !== "object") return null;
  const always = cleanGroups(input.always);
  const once = cleanGroups(input.once);
  return {
    always: [...always],
    once: [...once],
    granted: (group) => always.has(group) || once.has(group),
  };
}

// search_chats: keyword search over the user's other Nimbus conversations.
//
// Chats are stored in the browser, so the client sends a compact archive of
// them with the request (only once this permission is granted). Nothing here
// leaves the server unless the model calls the tool and the user allowed it.
import { scoreRelevance, tokenize } from "../text.mjs";
import { truncate } from "../util.mjs";

function snippetAround(content, query) {
  const text = String(content).replace(/\s+/g, " ").trim();
  if (text.length <= 320) return text;
  const lower = text.toLowerCase();
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  let at = -1;
  for (const w of words) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  if (at < 0) return truncate(text, 320);
  const start = Math.max(0, at - 140);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 320).trim()}…`;
}

export function searchChatArchive(archive, query, maxResults = 5) {
  if (!tokenize(query).length) return [];
  const hits = [];
  for (const chat of archive) {
    const titleScore = scoreRelevance(query, chat.title ?? "");
    let best = null;
    for (const m of chat.messages ?? []) {
      const score = scoreRelevance(query, m.content);
      if (score > 0 && (!best || score > best.score)) best = { score, message: m };
    }
    const score = Math.max(titleScore * 0.8, best?.score ?? 0);
    if (score <= 0) continue;
    hits.push({
      chatId: chat.id,
      title: chat.title || "Untitled chat",
      role: best?.message.role ?? null,
      snippet: best ? snippetAround(best.message.content, query) : "",
      score: Math.round(score * 100) / 100,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

export const searchChatsTool = {
  name: "search_chats",
  description:
    "Search the user's OTHER past Nimbus conversations by keywords. Use when the user refers to something from an earlier chat (\"what did you tell me last time about…\", \"that resume we worked on\"). Returns chat titles and matching excerpts. Not for saved memories — use search_memories for those.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to look for", minLength: 2, maxLength: 200 },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "Default 5" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  // Past replies can quote web content, so treat results like external data.
  untrustedOutput: true,
  permissionGroup: "chats",
  describePermission: (args) => `Search your past chats for “${args.query}”`,
  timeoutMs: 5000,
  async run(args, ctx) {
    const archive = ctx.chatArchive;
    if (!Array.isArray(archive)) throw new Error("Past chats weren't shared with this request");
    const results = searchChatArchive(archive, args.query, args.max_results ?? 5);
    return {
      query: args.query,
      searchedChats: archive.length,
      results,
      note: results.length ? undefined : "No past chat matched. Say so; do not guess what was discussed.",
    };
  },
  summarize(result) {
    return `${result.results.length} match${result.results.length === 1 ? "" : "es"} in ${result.searchedChats} past chat${result.searchedChats === 1 ? "" : "s"}`;
  },
};

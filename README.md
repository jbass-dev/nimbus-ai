# Nimbus — AI Chat Interface

A multi-model AI assistant that **does things**: it searches live job boards and the web, reads pages, and remembers your preferences, projects and decisions across conversations. Built with Next.js (App Router) and the OpenRouter API.

**Live demo:** https://getnimbus.vercel.app/

## Features

- **Tool-using agent** — the server runs a model ⇄ tool loop (OpenRouter tool calling) with step, call and time limits. Clear requests are routed straight to the right tool: "job search" runs a job search instead of producing a paragraph about job searching
- **Live job search** — real openings from Remotive, RemoteOK, Jobicy and Arbeitnow (free, no API keys), filtered by keywords, remote, location and salary floor. Salaries are shown only when the employer listed one; nothing is estimated or invented
- **Live research** — `web_search` (Brave or Tavily if you add a key, otherwise DuckDuckGo) and `fetch_url` to read the pages it cites
- **Persistent memory** — preferences, profile facts, project decisions and open tasks survive new chats and restarts. Only relevant memories go into each prompt, corrections replace old values, "don't remember X" is enforced, and secrets are refused. A **Memory panel** lets you view, edit and delete everything
- **Honest activity trail** — every reply shows the tools that actually ran and the memories it used. Replies that claim an action no tool performed get flagged automatically

- **Live token streaming** — responses render word-by-word via a server-side streaming proxy (Edge-style `ReadableStream` over SSE)
- **Multi-model switching** — swap between Llama 3, Gemma 2, DeepSeek, and Qwen mid-conversation; the model allowlist is validated server-side
- **Stop & regenerate** — cancel a response mid-stream (`AbortController` wired through to the upstream request) or regenerate the last reply
- **Markdown rendering** — custom zero-dependency renderer with fenced code blocks, copy-to-clipboard, inline code, lists, headings, and links
- **Persistent conversations** — chats are auto-titled from your first message and stored locally; search and manage them from the sidebar
- **Responsive** — collapsible sidebar on desktop, off-canvas drawer with backdrop on mobile

## Architecture

```
app/page.jsx ──POST /api/OpenRouter──▶ route.js ──▶ lib/nimbus/agent.mjs
   ▲  NDJSON events (token, tool_start/end,          │  intent.mjs   classify, force first tool
   │  memory, notice, confirm, done)                 │  memory-store retrieve relevant memories
   └─────────────────────────────────────────────────┤  llm.mjs      OpenRouter stream + tool calls
                                                     └─ tools/       search_jobs · web_search · fetch_url
app/components/MemoryPanel.jsx ──/api/memory──▶ memory-store       search/save/update/forget memory
```

| Concept | Where it lives |
|---|---|
| Conversation history | Browser localStorage, sent with each request |
| Persistent memory | `NIMBUS_DATA_DIR/memory/<sha256(user token)>.json` on the server |
| Current task context | The agent loop's message list for one turn (tool calls and results) |
| Project knowledge | Memories with `category: project/decision` and a `project` name |

**Identity and privacy.** Each browser gets a random 256-bit token in an HttpOnly, SameSite=Strict cookie. Memory files are named by the token's SHA-256, so the token itself is never stored. There is no parameter anywhere that selects another user's memory. The store refuses API keys, passwords, SSNs and card numbers.

**Safety rules enforced in code, not just in the prompt:**

- Arguments are validated against each tool's schema. Bad JSON or bad fields go back to the model as errors so it can correct them.
- Each tool has a timeout, and each turn has a max of 6 steps, 10 tool calls and 90 seconds.
- Consequential tools (currently `forget_all_memories`) only run after you click **Confirm**.
- Memory writes are blocked once web or job content has entered the turn, unless your own message asked for a memory change. This stops prompt-injected pages from planting memories.
- Outbound fetches block localhost, private and link-local addresses on every redirect hop.
- Job-board responses are cached for 2 hours to respect provider rate limits. Remotive asks for only a few calls per day.

**Storage choice.** Memory uses JSON files with atomic writes and per-user write queues, so there's no native module to rebuild for Electron and no hosted database. That's right for the desktop app and single-instance hosting. On Vercel the filesystem is ephemeral, so memory won't persist there. Point `NIMBUS_DATA_DIR` at a persistent volume, or swap `memory-store.mjs` for a database adapter.

## Testing

```bash
npm test               # 51 automated tests, mocked LLM + mocked HTTP, ~2s
npm run build && node scripts/smoke-server.mjs   # real built server + mock LLM over HTTP
npm run eval           # LIVE: real model, real job boards, real web (uses OPENROUTER_KEY)
npm run metrics        # summarise per-turn metrics logged by the app
```

- `npm test` covers intent routing (with an accuracy figure), tool selection and execution, multistep tasks, malformed tool calls, unknown tools, timeouts, API failures, partial provider outages, step limits, no-tool models, confirmation gating, prompt-injection memory writes, unbacked-claim detection, SSRF and the 10 required memory behaviors. Restart persistence is tested in a separate Node process.
- The smoke test runs the **built** app: NDJSON streaming, cookies, per-user isolation, memory surviving a full server restart, and the memory API (edit, delete, cross-site refusal, secret rejection).
- These are **simulated**. Only `npm run eval` proves real end-to-end behavior. It reports task completion, tool-selection accuracy, link grounding (every URL in an answer must come from a tool result), needless clarifying questions and latency, and saves the results to `.nimbus-data/eval/`.

## Configuration

| Env var | Purpose |
|---|---|
| `OPENROUTER_KEY` | Required |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | Optional. Better web search than the DuckDuckGo fallback (both have free tiers) |
| `NIMBUS_DATA_DIR` | Where memory and metrics are stored. Default `./.nimbus-data`. Electron uses the app's user-data folder |
| `NIMBUS_METRICS=off` | Disable per-turn metrics logging. Metrics never include message content |

## Tech Stack

Next.js · React · Tailwind CSS · OpenRouter API (streaming + tool calling) · Node test runner. No new npm dependencies.

## Getting Started

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env.local` with your OpenRouter key:

   ```bash
   OPENROUTER_KEY=sk-or-...
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000).

## Architecture Notes

The browser never sees the API key — all model calls go through `app/api/OpenRouter/route.js`, which validates the requested model against an allowlist (shared with the client via `app/config/models.js`, so the two never drift apart), forwards the conversation upstream, and runs the agent loop, streaming newline-delimited JSON events (tokens plus tool activity) back to the client. The client reads the stream with `response.body.getReader()` and updates React state per event, using functional state updaters to avoid stale-closure bugs during rapid streaming updates.

The API route also guards against abuse and misconfiguration:

- Fails fast with a clear error if `OPENROUTER_KEY` is missing, instead of an opaque upstream 502.
- Caps conversation size (60 messages / 8,000 chars per message / 60,000 chars total) before forwarding upstream.
- Applies a per-IP sliding-window rate limit (20 requests/minute) to protect against credit-burning abuse on a public deployment. It's in-memory and process-local — fine for a single instance, swap in Redis/Upstash if you scale horizontally.

## Desktop App (Electron)

`electron.js` wraps the app in a desktop shell. Because the app relies on server-side API routes (not just static pages), it can't use a static export — instead, production builds bundle a self-contained Next.js server (`output: "standalone"` in `next.config.ts`) that Electron spawns locally and points the window at.

```bash
npm run electron        # dev: launches Electron against `next dev`
npm run electron:dist    # prod: builds Next.js + packages with electron-builder
```

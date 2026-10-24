"use client";

import { useState } from "react";
import Markdown, { CopyButton } from "./Markdown";
import AttachmentChips from "./AttachmentChips";

function Avatar({ role }) {
  if (role === "user") {
    return (
      <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-700 flex items-center justify-center text-[11px] font-semibold text-neutral-200">
        You
      </div>
    );
  }

  return (
    <div className="h-8 w-8 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-sm">
      ✦
    </div>
  );
}

const TOOL_LABELS = {
  search_jobs: "Job search",
  web_search: "Web search",
  fetch_url: "Read page",
  search_memories: "Checked memory",
  save_memory: "Saved to memory",
  update_memory: "Updated memory",
  forget_memory: "Forgot",
  forget_all_memories: "Clear all memory",
  get_weather: "Weather",
  search_chats: "Searched past chats",
};

function describeArgs(name, args) {
  if (!args) return "";
  if (name === "search_jobs") {
    const bits = [args.query];
    if (args.remote_only !== false) bits.push("remote");
    if (args.min_salary) bits.push(`≥ $${Math.round(args.min_salary / 1000)}k`);
    if (args.location) bits.push(args.location);
    return bits.filter(Boolean).join(" · ");
  }
  if (name === "web_search") return args.query;
  if (name === "get_weather") return args.location;
  if (name === "fetch_url") {
    try {
      return new URL(args.url).host;
    } catch {
      return "";
    }
  }
  if (name === "save_memory" || name === "update_memory") return args.content;
  if (name === "forget_memory") return args.query ?? "";
  return args.query ?? "";
}

function ActivityList({ activity }) {
  return (
    <ul className="mb-2 space-y-1" aria-label="What Nimbus did">
      {activity.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-xs text-neutral-400">
          <span
            className={`mt-0.5 shrink-0 ${
              a.status === "running" ? "animate-pulse text-indigo-400" : a.status === "failed" ? "text-red-400" : "text-emerald-400"
            }`}
          >
            {a.status === "running" ? "●" : a.status === "failed" ? "✕" : "✓"}
          </span>
          <span>
            <span className="text-neutral-300">{TOOL_LABELS[a.name] ?? a.name}</span>
            {describeArgs(a.name, a.args) && <span className="text-neutral-500"> — {describeArgs(a.name, a.args)}</span>}
            {a.summary && a.status !== "running" && (
              <span className={a.status === "failed" ? "text-red-300/80" : "text-neutral-500"}> ({a.summary})</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function MessageBubble({
  message,
  isStreaming,
  onRegenerate,
  canRegenerate,
  onConfirm,
  onPermission,
  onEdit,
  canEdit,
}) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const submitEdit = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    if (text !== message.content) onEdit?.(text);
  };
  const hasActivity = !isUser && message.activity?.length > 0;

  return (
    <div
      className={`flex gap-3 animate-fadeIn ${
        isUser ? "flex-row-reverse" : ""
      }`}
    >
      <Avatar role={message.role} />

      <div
        className={`max-w-[85%] md:max-w-2xl flex flex-col ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        {isUser && message.attachments?.length > 0 && (
          <AttachmentChips attachments={message.attachments} className="mb-1.5 justify-end" />
        )}

        {isUser && editing ? (
          <div className="w-full min-w-[260px] md:min-w-[420px] rounded-2xl border border-indigo-500/60 bg-neutral-900 p-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              className="w-full resize-none bg-transparent px-2 py-1 text-sm text-white outline-none"
            />
            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-2.5 py-1 text-xs text-neutral-300 hover:bg-white/10 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={!draft.trim()}
                className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        ) : isUser && !message.content ? null : (
        <div
          className={`select-text px-4 py-2.5 rounded-2xl text-sm ${
            isUser
              ? "bg-indigo-600 text-white rounded-br-md whitespace-pre-wrap"
              : "bg-neutral-900 border border-neutral-800 text-neutral-100 rounded-bl-md"
          }`}
        >
          {hasActivity && <ActivityList activity={message.activity} />}
          {!isUser && message.notices?.map((n) => (
            <p key={n} className="mb-2 text-xs text-amber-300/90">⚠️ {n}</p>
          ))}
          {isUser ? (
            message.content
          ) : message.content ? (
            <Markdown content={message.content} />
          ) : hasActivity ? null : (
            <span className="inline-flex gap-1 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:300ms]" />
            </span>
          )}
        </div>
        )}

        {isUser && !editing && (
          <div className="flex gap-1 mt-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton text={message.content} />
            {canEdit && (
              <button
                type="button"
                onClick={startEdit}
                className="text-xs px-2 py-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                Edit
              </button>
            )}
          </div>
        )}

        {!isUser && message.confirm && !message.confirm.resolved && !isStreaming && (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <span>{message.confirm.prompt}</span>
            <button
              type="button"
              onClick={() => onConfirm?.(message.confirm.actionId)}
              className="rounded-md bg-amber-500/80 px-2 py-1 font-medium text-neutral-950 hover:bg-amber-400"
            >
              Confirm
            </button>
          </div>
        )}

        {!isUser && message.permission && !message.permission.resolved && !isStreaming && (
          <div className="mt-2 w-full rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
            <p className="mb-1.5 font-medium">Nimbus wants to:</p>
            <ul className="mb-2 list-disc space-y-0.5 pl-4">
              {message.permission.requests.map((r) => (
                <li key={`${r.group}:${r.description}`}>{r.description}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onPermission?.("once")}
                className="rounded-md bg-sky-500/80 px-2.5 py-1 font-medium text-neutral-950 hover:bg-sky-400"
              >
                Allow once
              </button>
              <button
                type="button"
                onClick={() => onPermission?.("always")}
                className="rounded-md border border-sky-400/60 px-2.5 py-1 font-medium hover:bg-sky-500/20"
              >
                Always allow
              </button>
              <button
                type="button"
                onClick={() => onPermission?.("deny")}
                className="rounded-md px-2.5 py-1 text-neutral-300 hover:bg-white/10 hover:text-white"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {!isUser && message.memoryUsed?.length > 0 && !isStreaming && (
          <details className="mt-1 text-[11px] text-neutral-500">
            <summary className="cursor-pointer hover:text-neutral-300">
              Used {message.memoryUsed.length} saved memor{message.memoryUsed.length === 1 ? "y" : "ies"}
            </summary>
            <ul className="mt-1 list-disc pl-4">
              {message.memoryUsed.map((m) => (
                <li key={m.id}>{m.content}</li>
              ))}
            </ul>
          </details>
        )}

        {!isUser && message.content && !isStreaming && (
          <div className="flex gap-1 mt-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton text={message.content} />

            {canRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="text-xs px-2 py-1 rounded-md text-neutral-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              >
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
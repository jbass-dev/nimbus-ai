"use client";

import { useCallback, useEffect, useState } from "react";

const CATEGORY_LABELS = {
  preference: "Preferences",
  profile: "About you",
  project: "Projects",
  decision: "Decisions",
  task: "Open tasks",
  other: "Other",
};

async function api(method, { body, query = "" } = {}) {
  const res = await fetch(`/api/memory${query}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function MemoryPanel({ onClose }) {
  const [memories, setMemories] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, content }
  const [draft, setDraft] = useState({ content: "", category: "preference" });

  const refresh = useCallback(
    () =>
      api("GET")
        .then((data) => {
          setMemories(data.memories ?? []);
          setBlocked(data.blocked ?? []);
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (fn) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const grouped = memories.reduce((acc, m) => {
    (acc[m.category] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Saved memory"
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-neutral-800 bg-neutral-950 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">What Nimbus remembers</h2>
            <p className="text-xs text-neutral-500">Used across all your chats. Edit or delete anything; changes apply immediately.</p>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 scrollbar-thin">
          {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300">{error}</p>}
          {loading && <p className="text-neutral-500">Loading…</p>}
          {!loading && memories.length === 0 && !error && (
            <p className="text-neutral-500">Nothing saved yet. Tell Nimbus things like “remember that I prefer remote jobs”.</p>
          )}

          {Object.entries(CATEGORY_LABELS).map(([cat, label]) =>
            grouped[cat]?.length ? (
              <section key={cat}>
                <h3 className="mb-2 text-xs uppercase tracking-wider text-neutral-500">{label}</h3>
                <ul className="space-y-1.5">
                  {grouped[cat].map((m) => (
                    <li key={m.id} className="group rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
                      {editing?.id === m.id ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            run(async () => {
                              await api("PATCH", { body: { id: m.id, content: editing.content } });
                              setEditing(null);
                            });
                          }}
                        >
                          <input
                            autoFocus
                            value={editing.content}
                            maxLength={500}
                            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                            className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-indigo-500"
                          />
                          <button className="rounded-md bg-indigo-600 px-2 py-1 text-xs">Save</button>
                          <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-xs text-neutral-400">
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <p className="text-neutral-100">{m.content}</p>
                            <p className="mt-0.5 text-[11px] text-neutral-500">
                              {m.project ? `${m.project} · ` : ""}
                              {m.source === "inferred" ? "inferred by Nimbus" : "you said"} · updated {new Date(m.updatedAt).toLocaleDateString()}
                              {m.previousValues?.length ? ` · was “${m.previousValues[0]}”` : ""}
                            </p>
                          </div>
                          <div className="flex gap-1 opacity-60 group-hover:opacity-100">
                            <button type="button" onClick={() => setEditing({ id: m.id, content: m.content })} className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-white/10 hover:text-white">
                              Edit
                            </button>
                            <button type="button" onClick={() => run(() => api("DELETE", { query: `?id=${encodeURIComponent(m.id)}` }))} className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-red-500/20 hover:text-red-300">
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null
          )}

          {blocked.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-neutral-500">Never remember</h3>
              <div className="flex flex-wrap gap-2">
                {blocked.map((b) => (
                  <span key={b.topic} className="inline-flex items-center gap-1 rounded-full border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300">
                    {b.topic}
                    <button type="button" aria-label={`Allow ${b.topic} again`} onClick={() => run(() => api("DELETE", { query: `?blocked=${encodeURIComponent(b.topic)}` }))} className="text-neutral-500 hover:text-white">
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="border-t border-neutral-800 px-5 py-3 space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.content.trim()) return;
              run(async () => {
                await api("POST", { body: draft });
                setDraft({ ...draft, content: "" });
              });
            }}
          >
            <select
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs"
            >
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input
              value={draft.content}
              maxLength={500}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder="Add something for Nimbus to remember…"
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 outline-none focus:border-indigo-500"
            />
            <button className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500">Add</button>
          </form>
          {memories.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Delete everything Nimbus remembers about you? This can't be undone.")) {
                  run(() => api("DELETE", { query: "?all=1" }));
                }
              }}
              className="text-xs text-red-400/80 hover:text-red-300"
            >
              Delete all memories
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

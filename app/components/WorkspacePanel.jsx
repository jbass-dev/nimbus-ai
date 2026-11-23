"use client";

import { useCallback, useEffect, useState } from "react";

async function api(method, body) {
  const res = await fetch("/api/workspace", { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function WorkspacePanel({ onClose, onChange }) {
  const [state, setState] = useState(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => api("GET").then((s) => { setState(s); onChange?.(s); setError(null); }).catch((e) => setError(e.message)), [onChange]);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (body) => {
    setBusy(true);
    try { await api("POST", body); setPath(""); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Project folder">
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-neutral-700 bg-neutral-950 p-5 text-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">📁 Project folder</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-white/10" aria-label="Close">✕</button>
        </div>
        {state?.enabled === false && <p className="text-neutral-400">The coding workspace is only available in the Nimbus desktop app.</p>}
        {state?.enabled && (
          <>
            <p className="mb-3 text-neutral-400">Nimbus can read this folder and suggest edits. Nothing is changed until you press Apply, and .env files and keys are never read.</p>
            {state.root && (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
                <span className="truncate font-mono text-xs text-emerald-300" title={state.root}>{state.root}</span>
                <button type="button" disabled={busy} onClick={() => act({ action: "clear" })} className="shrink-0 rounded-md border border-neutral-600 px-2 py-1 text-xs hover:bg-white/10">Close folder</button>
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) act({ action: "set_root", path }); }} className="flex gap-2">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Dev\my-project" className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500" aria-label="Full path to your project folder" />
              <button type="submit" disabled={busy || !path.trim()} className="rounded-lg bg-indigo-500 px-3 py-2 font-medium text-white hover:bg-indigo-400 disabled:opacity-50">{state.root ? "Switch" : "Open"}</button>
            </form>
            {state.changes?.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1 font-medium text-neutral-300">Applied changes</h3>
                <ul className="space-y-1">
                  {state.changes.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-neutral-900 px-2 py-1.5 text-xs">
                      <span className="truncate"><span className="font-mono">{c.path}</span> <span className="text-emerald-300">+{c.added}</span> <span className="text-red-300">−{c.removed}</span>{c.reverted ? " · undone" : ""}</span>
                      {c.revertible && !c.reverted && <button type="button" disabled={busy} onClick={() => act({ action: "revert", id: c.id })} className="shrink-0 rounded border border-neutral-600 px-2 py-0.5 hover:bg-white/10">Undo</button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error && <p className="mt-3 text-red-300">{error}</p>}
      </div>
    </div>
  );
}

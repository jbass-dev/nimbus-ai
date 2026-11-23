"use client";

import { useCallback, useState } from "react";

async function post(body) {
  const res = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "—");

export default function TasksPanel({ tasks, onClose, onRefresh }) {
  const [form, setForm] = useState({ prompt: "", schedule: "daily 08:30" });
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const act = useCallback(async (body, key = body.action) => {
    setBusy(key);
    setError(null);
    try { await post(body); await onRefresh(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }, [onRefresh]);

  const open = (t) => {
    setOpenId(openId === t.id ? null : t.id);
    if (t.unread) act({ action: "mark_read", id: t.id }, "read");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Background tasks">
      <div className="max-h-[88vh] w-full max-w-xl overflow-auto rounded-2xl border border-neutral-700 bg-neutral-950 p-5 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">⏰ Background tasks</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-white/10" aria-label="Close">✕</button>
        </div>
        <p className="mb-3 text-neutral-400">Nimbus runs these by itself while the app is open (it keeps running in the tray). Tasks can only search the web, job boards and weather and write a short report. They can&apos;t change anything. You can also say &ldquo;check X every morning&rdquo; in a chat.</p>

        <ul className="space-y-2">
          {tasks.length === 0 && <li className="text-neutral-500">No tasks yet.</li>}
          {tasks.map((t) => (
            <li key={t.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
              <div className="flex items-start justify-between gap-2">
                <button type="button" onClick={() => open(t)} className="min-w-0 flex-1 text-left">
                  <span className="font-medium">{t.title}</span>
                  {t.unread > 0 && <span className="ml-2 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{t.unread} new</span>}
                  <span className="block text-xs text-neutral-400">
                    {t.schedule} · {t.running ? "running…" : t.enabled ? `next ${when(t.nextRunAt)}` : "paused"} · last {t.lastStatus ? `${t.lastStatus} ${when(t.lastRunAt)}` : "never"}
                  </span>
                  {t.pausedReason && <span className="block text-xs text-amber-300">{t.pausedReason}</span>}
                </button>
                <span className="flex shrink-0 gap-1 text-xs">
                  <button type="button" disabled={!!busy || t.running} onClick={() => act({ action: "run_now", id: t.id }, `run${t.id}`)} className="rounded border border-neutral-600 px-2 py-1 hover:bg-white/10 disabled:opacity-50">{busy === `run${t.id}` ? "Running…" : "Run now"}</button>
                  <button type="button" disabled={!!busy} onClick={() => act({ action: "update", id: t.id, enabled: !t.enabled })} className="rounded border border-neutral-600 px-2 py-1 hover:bg-white/10">{t.enabled ? "Pause" : "Resume"}</button>
                  <button type="button" disabled={!!busy} onClick={() => act({ action: "remove", id: t.id })} className="rounded border border-red-500/50 px-2 py-1 text-red-300 hover:bg-red-500/10">Delete</button>
                </span>
              </div>
              {openId === t.id && (
                <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2">
                  <p className="text-xs text-neutral-500">Task: {t.prompt}</p>
                  {t.runs.length === 0 && <p className="text-neutral-500">No results yet.</p>}
                  {t.runs.slice(0, 3).map((r) => (
                    <div key={r.at} className="rounded-md bg-neutral-950 p-2">
                      <p className="mb-1 text-xs text-neutral-500">{new Date(r.at).toLocaleString()} {r.ok ? "" : "· failed"}</p>
                      <p className="whitespace-pre-wrap">{r.ok ? r.text : r.error}</p>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>

        <form
          onSubmit={(e) => { e.preventDefault(); act({ action: "create", ...form }).then(() => setForm((f) => ({ ...f, prompt: "" }))); }}
          className="mt-4 space-y-2 border-t border-neutral-800 pt-3"
        >
          <label className="block text-xs text-neutral-400">New task
            <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2} maxLength={1000} placeholder="Check for new remote React developer jobs posted in the last day" className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          </label>
          <div className="flex gap-2">
            <input value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} aria-label="Schedule" placeholder="daily 08:30" className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
            <button type="submit" disabled={!!busy || form.prompt.trim().length < 5} className="rounded-lg bg-indigo-500 px-3 py-2 font-medium text-white hover:bg-indigo-400 disabled:opacity-50">Add task</button>
          </div>
          <p className="text-xs text-neutral-500">Schedules: <code>every 30m</code> (minimum), <code>every 6h</code>, <code>daily 08:30</code>, <code>weekdays 07:45</code> (your local time).</p>
        </form>
        {error && <p className="mt-2 text-red-300">{error}</p>}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";

async function post(body) {
  const res = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function DiffLine({ line }) {
  const cls = line.startsWith("+") ? "bg-emerald-500/15 text-emerald-200" : line.startsWith("-") ? "bg-red-500/15 text-red-200" : line.startsWith("@@") ? "text-sky-300" : "text-neutral-400";
  return <div className={`whitespace-pre px-2 ${cls}`}>{line || " "}</div>;
}

/** A staged edit: nothing has changed on disk until the user presses Apply. */
export default function ProposalCard({ proposal }) {
  const [status, setStatus] = useState("pending"); // pending | applying | applied | discarded
  const [error, setError] = useState(null);
  const [changeId, setChangeId] = useState(null);

  const run = async (action) => {
    setError(null);
    setStatus(action === "apply" ? "applying" : status);
    try {
      const data = await post({ action, id: action === "revert" ? changeId : proposal.id });
      if (action === "apply") { setChangeId(data.change.id); setStatus("applied"); }
      else if (action === "discard") setStatus("discarded");
      else setStatus("reverted");
    } catch (err) {
      setError(err.message);
      setStatus(action === "revert" ? "applied" : "pending");
    }
  };

  const label = { create: "New file", edit: "Edit" }[proposal.action] ?? "Edit";
  return (
    <div className="mt-2 w-full overflow-hidden rounded-xl border border-indigo-500/40 bg-neutral-900/80 text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="font-mono text-indigo-200">{proposal.path}</span>
        <span className="text-neutral-400">{label} · <span className="text-emerald-300">+{proposal.added}</span> <span className="text-red-300">−{proposal.removed}</span></span>
        <span className="ml-auto flex gap-2">
          {status === "pending" && (
            <>
              <button type="button" onClick={() => run("apply")} className="rounded-md bg-emerald-500/80 px-2.5 py-1 font-medium text-neutral-950 hover:bg-emerald-400">Apply</button>
              <button type="button" onClick={() => run("discard")} className="rounded-md border border-neutral-600 px-2.5 py-1 text-neutral-300 hover:bg-white/10">Discard</button>
            </>
          )}
          {status === "applying" && <span className="text-neutral-400">Applying…</span>}
          {status === "applied" && (
            <>
              <span className="text-emerald-300">Applied</span>
              <button type="button" onClick={() => run("revert")} className="rounded-md border border-neutral-600 px-2.5 py-1 text-neutral-300 hover:bg-white/10">Undo</button>
            </>
          )}
          {status === "reverted" && <span className="text-neutral-400">Undone</span>}
          {status === "discarded" && <span className="text-neutral-400">Discarded</span>}
        </span>
      </div>
      {proposal.summary && <p className="px-3 pt-2 text-neutral-300">{proposal.summary}</p>}
      {status !== "discarded" && (
        <pre className="m-2 max-h-72 overflow-auto rounded-lg bg-neutral-950 py-1 font-mono text-[11px] leading-relaxed">
          {proposal.diff.split("\n").map((l, i) => <DiffLine key={i} line={l} />)}
        </pre>
      )}
      {error && <p className="px-3 pb-2 text-red-300">{error}</p>}
    </div>
  );
}

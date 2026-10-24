"use client";

import { useEffect } from "react";
import { PERMISSION_GROUPS } from "@/lib/nimbus/permissions.mjs";

/* Lists each kind of search and whether Nimbus asks first or is always allowed. */
export default function PermissionsPanel({ alwaysAllow, onChange, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (group, always) => {
    const next = always ? [...new Set([...alwaysAllow, group])] : alwaysAllow.filter((g) => g !== group);
    onChange(next);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search permissions"
        className="w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">Search permissions</h2>
            <p className="text-xs text-neutral-500">Choose which lookups run automatically and which ask you first.</p>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        <ul className="divide-y divide-neutral-800 px-5">
          {Object.entries(PERMISSION_GROUPS).map(([group, { label }]) => {
            const always = alwaysAllow.includes(group);
            return (
              <li key={group} className="flex items-center justify-between gap-4 py-3">
                <span className="text-neutral-200">{label}</span>
                <div className="flex shrink-0 overflow-hidden rounded-lg border border-neutral-700 text-xs" role="radiogroup" aria-label={label}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!always}
                    onClick={() => set(group, false)}
                    className={`px-3 py-1.5 ${!always ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"}`}
                  >
                    Ask every time
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={always}
                    onClick={() => set(group, true)}
                    className={`px-3 py-1.5 ${always ? "bg-indigo-600 text-white" : "text-neutral-400 hover:text-white"}`}
                  >
                    Always allow
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="border-t border-neutral-800 px-5 py-3 text-xs text-neutral-500">
          Past-chat search sends your other chats (from this device) to Nimbus only for replies where it&apos;s allowed.
        </p>
      </div>
    </div>
  );
}

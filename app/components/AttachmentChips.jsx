"use client";

import { formatBytes } from "@/lib/ui/attachments.mjs";

/* Shows attached files/images. Pass onRemove to make them removable (composer). */
export default function AttachmentChips({ attachments, onRemove, className = "" }) {
  if (!attachments?.length) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {attachments.map((a) =>
        a.kind === "image" && a.dataUrl ? (
          <div key={a.id} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL preview, not a remote image */}
            <img
              src={a.dataUrl}
              alt={a.name}
              className="h-20 w-20 rounded-lg border border-neutral-700 object-cover"
            />
            {onRemove && <RemoveButton name={a.name} onClick={() => onRemove(a.id)} />}
          </div>
        ) : (
          <div
            key={a.id}
            className="relative flex max-w-[220px] items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200"
            title={a.name}
          >
            <span className="text-base leading-none" aria-hidden="true">
              {a.kind === "image" ? "🖼️" : /\.pdf$/i.test(a.name) ? "📄" : /\.docx$/i.test(a.name) ? "📝" : "📃"}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{a.name}</span>
              <span className="block text-[10px] text-neutral-500">
                {[a.pages ? `${a.pages} pages` : null, formatBytes(a.size), a.truncated ? "truncated" : null, a.kind === "image" ? "image not saved" : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            {onRemove && <RemoveButton name={a.name} onClick={() => onRemove(a.id)} />}
          </div>
        )
      )}
    </div>
  );
}

function RemoveButton({ name, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-[10px] text-white hover:bg-red-500"
      aria-label={`Remove ${name}`}
    >
      ✕
    </button>
  );
}

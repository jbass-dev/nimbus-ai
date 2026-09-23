"use client";

import Markdown, { CopyButton } from "./Markdown";

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

export default function MessageBubble({
  message,
  isStreaming,
  onRegenerate,
  canRegenerate,
}) {
  const isUser = message.role === "user";

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
        <div
          className={`select-text px-4 py-2.5 rounded-2xl text-sm ${
            isUser
              ? "bg-indigo-600 text-white rounded-br-md whitespace-pre-wrap"
              : "bg-neutral-900 border border-neutral-800 text-neutral-100 rounded-bl-md"
          }`}
        >
          {isUser ? (
            message.content
          ) : message.content ? (
            <Markdown content={message.content} />
          ) : (
            <span className="inline-flex gap-1 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500 animate-bounce [animation-delay:300ms]" />
            </span>
          )}
        </div>

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
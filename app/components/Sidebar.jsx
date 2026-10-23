"use client";

import React, { useState } from "react";

const Sidebar = ({
  expand,
  setExpand,
  onNewChat,
  chatSessions,
  activeChatId,
  onSelectChat,
  onDeleteChat,
  onOpenMemory,
}) => {
  const [search, setSearch] = useState("");

  const filteredChats = chatSessions.filter((chat) =>
    chat.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className={`flex flex-col justify-between bg-neutral-900 border-r border-neutral-800/80 pt-5 transition-all duration-300 z-50
      max-md:fixed max-md:h-screen max-md:left-0 max-md:top-0
      ${expand ? "p-4 w-64 max-md:translate-x-0" : "w-16 max-md:-translate-x-full"}
      overflow-hidden`}
    >
      {/* TOP */}
      <div className="flex flex-col min-h-0">
        <div
          className={`flex items-center ${
            expand ? "justify-between" : "flex-col gap-5"
          }`}
        >
          {/* Brand */}
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-sm">
              ✦
            </div>
            {expand && (
              <span className="font-semibold tracking-tight text-white">
                Nimbus
              </span>
            )}
          </div>

          {/* Collapse / expand toggle */}
          <button
            onClick={() => setExpand(!expand)}
            className="flex items-center justify-center h-8 w-8 rounded-lg cursor-pointer text-neutral-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Toggle sidebar"
          >
            {expand ? "«" : "»"}
          </button>
        </div>

        {/* NEW CHAT */}
        <button
          onClick={onNewChat}
          className={`mt-6 flex items-center justify-center cursor-pointer transition-colors font-medium text-sm
          ${
            expand
              ? "bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white rounded-xl gap-2 py-2.5 px-3"
              : "h-9 w-9 mx-auto bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg"
          }`}
        >
          <span className="text-base leading-none">+</span>
          {expand && <span>New Chat</span>}
        </button>

        {/* SEARCH */}
        {expand && (
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="mt-5 w-full bg-neutral-800 text-sm text-white px-3 py-2 rounded-lg outline-none border border-transparent focus:border-indigo-500 transition-colors placeholder:text-neutral-500"
          />
        )}

        {/* CHAT LIST */}
        {expand && (
          <div className="mt-5 text-neutral-500 text-xs flex flex-col min-h-0">
            <p className="uppercase tracking-wider px-1">Chats</p>

            <div className="mt-2 overflow-y-auto pr-1 space-y-1 scrollbar-thin">
              {filteredChats.length === 0 && (
                <p className="px-1 py-2 text-neutral-600">No chats yet.</p>
              )}
              {filteredChats.map((chat) => (
                <div
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  className={`group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-colors text-sm ${
                    chat.id === activeChatId
                      ? "bg-indigo-600/20 text-white border border-indigo-500/40"
                      : "text-neutral-300 hover:bg-white/5 border border-transparent"
                  }`}
                >
                  <span className="flex-1 truncate">{chat.title || "New Chat"}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(chat.id);
                    }}
                    className="ml-2 text-neutral-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
                    aria-label="Delete chat"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM */}
      {expand && (
        <div className="px-1 pb-2 space-y-2">
          <button
            onClick={onOpenMemory}
            className="w-full text-left text-sm text-neutral-300 hover:text-white px-2.5 py-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            🧠 Manage memory
          </button>
          <p className="text-[11px] text-neutral-600">
            Chats are stored in this browser. Memory (preferences, projects, decisions) is saved by Nimbus across chats — you can view or delete it any time.
          </p>
        </div>
      )}
    </div>
  );
};

export default Sidebar;

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import MessageBubble from "./components/MessageBubble";
import MemoryPanel from "./components/MemoryPanel";
import { MODELS, DEFAULT_MODEL } from "./config/models";

const MAX_INPUT_LENGTH = 8000;

const SUGGESTIONS = [
  { icon: "💼", text: "Find remote React jobs paying at least $60k" },
  { icon: "🔎", text: "Research the latest Next.js release and what changed" },
  { icon: "🧠", text: "Remember that I prefer remote jobs" },
  { icon: "⚛️", text: "Write a custom React hook for debouncing input" },
];

export default function Home() {
  const [expand, setExpand] = useState(false);
  const [chatSessions, setChatSessions] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [showMemory, setShowMemory] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const activeChatIdRef = useRef(activeChatId);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // Load saved state
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chatSessions");
      const savedActive = localStorage.getItem("activeChatId");
      const savedModel = localStorage.getItem("model");

      if (saved) setChatSessions(JSON.parse(saved));
      if (savedActive) setActiveChatId(savedActive);
      if (savedModel && MODELS[savedModel]) {
        setModel(savedModel);
      }
    } catch {
      // Corrupted storage — start fresh
    }
  }, []);

  // Persist chats
  useEffect(() => {
    localStorage.setItem("chatSessions", JSON.stringify(chatSessions));
  }, [chatSessions]);

  useEffect(() => {
    if (activeChatId) {
      localStorage.setItem("activeChatId", activeChatId);
    }
  }, [activeChatId]);

  // Persist model
  useEffect(() => {
    localStorage.setItem("model", model);
  }, [model]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatSessions, isStreaming]);

  const activeChat =
    chatSessions.find((chat) => chat.id === activeChatId) ?? null;

  const updateChatMessages = useCallback((chatId, updater) => {
    setChatSessions((prev) =>
      prev.map((chat) => {
        if (chat.id !== chatId) return chat;

        const messages =
          typeof updater === "function"
            ? updater(chat.messages)
            : updater;

        return {
          ...chat,
          messages,
        };
      })
    );
  }, []);

  const setChatTitle = useCallback((chatId, title) => {
    setChatSessions((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? { ...chat, title }
          : chat
      )
    );
  }, []);

  const createChat = useCallback(() => {
    const id = crypto.randomUUID();

    const newChat = {
      id,
      title: "New Chat",
      messages: [],
    };

    setChatSessions((prev) => [...prev, newChat]);
    setActiveChatId(id);
    activeChatIdRef.current = id;

    return id;
  }, []);

  const patchLastAssistant = useCallback(
    (chatId, patch) => {
      updateChatMessages(chatId, (messages) => {
        const updated = [...messages];
        const last = updated[updated.length - 1];
        if (!last || last.role !== "assistant") return messages;
        updated[updated.length - 1] = {
          ...last,
          ...(typeof patch === "function" ? patch(last) : patch),
        };
        return updated;
      });
    },
    [updateChatMessages]
  );

  /* The server streams newline-delimited JSON events: tokens of the reply
     plus what Nimbus actually did (tool calls, memories used, notices).
     Tool activity shown in the UI comes from these events, so it reflects
     real executions — not the model's description of them. */
  const handleEvent = useCallback(
    (chatId, event, acc) => {
      switch (event.type) {
        case "token":
          acc.text += event.text;
          patchLastAssistant(chatId, { content: acc.text });
          break;
        case "tool_start":
          patchLastAssistant(chatId, (m) => ({
            activity: [
              ...(m.activity ?? []),
              { id: event.id, name: event.name, args: event.args, status: "running" },
            ],
          }));
          break;
        case "tool_end":
          patchLastAssistant(chatId, (m) => {
            const activity = [...(m.activity ?? [])];
            const i = activity.findIndex((a) => a.id === event.id);
            const entry = {
              id: event.id,
              name: event.name,
              status: event.ok ? "done" : "failed",
              summary: event.summary,
              ms: event.ms,
            };
            if (i >= 0) activity[i] = { ...activity[i], ...entry };
            else activity.push(entry);
            return { activity };
          });
          break;
        case "memory":
          patchLastAssistant(chatId, { memoryUsed: event.used });
          break;
        case "notice":
          patchLastAssistant(chatId, (m) => ({ notices: [...(m.notices ?? []), event.text] }));
          break;
        case "confirm":
          patchLastAssistant(chatId, { confirm: { actionId: event.actionId, prompt: event.prompt } });
          break;
        case "error":
          acc.error = event.message;
          break;
        default:
          break;
      }
    },
    [patchLastAssistant]
  );

  const streamCompletion = useCallback(
    async (chatId, history, { confirmedActions = [] } = {}) => {
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      updateChatMessages(chatId, [...history, { role: "assistant", content: "" }]);

      const acc = { text: "", error: null };

      try {
        const response = await fetch("/api/OpenRouter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Only role + content go upstream; UI-only fields stay local.
            messages: history.map(({ role, content }) => ({ role, content })),
            model,
            confirmedActions,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          let serverMessage = null;
          try {
            const body = await response.json();
            serverMessage = body?.error;
          } catch {
            // Response wasn't JSON
          }
          throw new Error(serverMessage || `HTTP error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handleEvent(chatId, JSON.parse(line), acc);
            } catch {
              // ignore a malformed event line
            }
          }
        }
        if (buffer.trim()) {
          try {
            handleEvent(chatId, JSON.parse(buffer), acc);
          } catch {
            // ignore
          }
        }

        if (acc.error) {
          patchLastAssistant(chatId, {
            content: acc.text ? `${acc.text}\n\n> ⚠️ ${acc.error}` : acc.error,
            isError: true,
          });
        } else if (!acc.text) {
          patchLastAssistant(chatId, { content: "I didn't get a response — please try again." });
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          updateChatMessages(chatId, (messages) => {
            const updated = [...messages];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.content === "" && !last.activity?.length) {
              updated.pop();
            }
            return updated;
          });
        } else {
          console.error("stream error:", error);
          patchLastAssistant(chatId, {
            content: error.message?.startsWith("HTTP error")
              ? "Something went wrong. Please try again."
              : error.message,
            isError: true,
          });
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [model, updateChatMessages, patchLastAssistant, handleEvent]
  );

  const sendMessage = useCallback(
    async (overrideText) => {
      const trimmed = (overrideText ?? text).trim();

      if (!trimmed || isStreaming) return;

      if (trimmed.length > MAX_INPUT_LENGTH) {
        alert(
          `Message is too long (max ${MAX_INPUT_LENGTH} characters).`
        );
        return;
      }

      let chatId = activeChatIdRef.current;
      let history;

      if (!chatId) {
        chatId = createChat();

        history = [
          {
            role: "user",
            content: trimmed,
          },
        ];
      } else {
        const chat = chatSessions.find(
          (chat) => chat.id === chatId
        );

        history = [
          ...(chat?.messages ?? []),
          {
            role: "user",
            content: trimmed,
          },
        ];
      }

      updateChatMessages(chatId, history);
      setText("");

      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }

      const isFirstUserMessage =
        history.filter((message) => message.role === "user")
          .length === 1;

      if (isFirstUserMessage) {
        const title =
          trimmed.length > 34
            ? `${trimmed.slice(0, 34)}…`
            : trimmed;

        setChatTitle(chatId, title);
      }

      await streamCompletion(chatId, history);
    },
    [
      text,
      isStreaming,
      chatSessions,
      createChat,
      updateChatMessages,
      setChatTitle,
      streamCompletion,
    ]
  );

  const regenerate = useCallback(() => {
    if (!activeChat || isStreaming) return;

    const messages = [...activeChat.messages];

    if (messages[messages.length - 1]?.role === "assistant") {
      messages.pop();
    }

    if (messages.length === 0) return;

    streamCompletion(activeChat.id, messages);
  }, [activeChat, isStreaming, streamCompletion]);

  const confirmAction = useCallback(
    (actionId) => {
      if (!activeChat || isStreaming) return;
      const messages = activeChat.messages.map((m, i) =>
        i === activeChat.messages.length - 1 ? { ...m, confirm: { ...m.confirm, resolved: true } } : m
      );
      const history = [...messages, { role: "user", content: "Yes, I confirm. Go ahead." }];
      updateChatMessages(activeChat.id, history);
      streamCompletion(activeChat.id, history, { confirmedActions: [actionId] });
    },
    [activeChat, isStreaming, updateChatMessages, streamCompletion]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKey = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const autoGrow = useCallback((event) => {
    const element = event.target;

    element.style.height = "auto";
    element.style.height = `${Math.min(
      element.scrollHeight,
      160
    )}px`;
  }, []);

  const showWelcome =
    !activeChat || activeChat.messages.length === 0;

  return (
    <main className="flex h-screen bg-neutral-950 text-white">
      <Sidebar
        expand={expand}
        setExpand={setExpand}
        chatSessions={chatSessions}
        activeChatId={activeChatId}
        onSelectChat={(id) => {
          setActiveChatId(id);

          if (window.innerWidth < 768) {
            setExpand(false);
          }
        }}
        onNewChat={() => createChat()}
        onOpenMemory={() => setShowMemory(true)}
        onDeleteChat={(id) => {
          setChatSessions((prev) =>
            prev.filter((chat) => chat.id !== id)
          );

          if (activeChatId === id) {
            setActiveChatId(null);
          }
        }}
      />

      {expand && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setExpand(false)}
        />
      )}

      <section className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="px-4 py-3 border-b border-neutral-800/80 bg-neutral-950/70 backdrop-blur-md flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setExpand(true)}
              className="md:hidden h-9 w-9 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              aria-label="Open menu"
            >
              <span className="text-lg">☰</span>
            </button>

            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-sm">
                ✦
              </div>

              <h1 className="text-lg font-semibold tracking-tight">
                Nimbus
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowMemory(true)}
            className="px-3 py-1.5 rounded-lg border border-neutral-700 text-sm text-neutral-300 hover:text-white hover:border-indigo-500 transition-colors"
            title="See and manage what Nimbus remembers about you"
          >
            🧠 Memory
          </button>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="bg-neutral-900 px-3 py-1.5 rounded-lg border border-neutral-700 text-sm outline-none focus:border-indigo-500 transition-colors cursor-pointer"
          >
            {Object.entries(MODELS).map(
              ([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              )
            )}
          </select>
          </div>
        </header>

        {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} />}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 scrollbar-thin">
          {showWelcome ? (
            <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto text-center">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center text-2xl mb-5">
                ✦
              </div>

              <h2 className="text-2xl font-semibold mb-1.5">
                How can I help you today?
              </h2>

              <p className="text-sm text-neutral-400 mb-8">
                Chatting with{" "}
                <span className="text-neutral-200">
                  {MODELS[model]?.label}
                </span>{" "}
                — it can search live jobs and the web, and remember your preferences.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion.text}
                    onClick={() => sendMessage(suggestion.text)}
                    className="text-left p-4 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-indigo-500/60 hover:bg-neutral-900/60 transition-colors text-sm text-neutral-300"
                  >
                    <span className="mr-2">
                      {suggestion.icon}
                    </span>

                    {suggestion.text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-5">
              {activeChat.messages.map((message, index) => (
                <MessageBubble
                  key={index}
                  message={message}
                  isStreaming={
                    isStreaming &&
                    index === activeChat.messages.length - 1
                  }
                  canRegenerate={
                    index === activeChat.messages.length - 1
                  }
                  onRegenerate={regenerate}
                  onConfirm={confirmAction}
                />
              ))}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-neutral-800/80 p-3 shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2 bg-neutral-900 border border-neutral-700 rounded-2xl p-2 focus-within:border-indigo-500 transition-colors">
              <textarea
                ref={textareaRef}
                rows={1}
                className="flex-1 select-text bg-transparent text-sm px-2 py-2 resize-none outline-none max-h-40 placeholder:text-neutral-500"
                placeholder="Ask anything…"
                maxLength={MAX_INPUT_LENGTH}
                value={text}
                onChange={(event) =>
                  setText(event.target.value)
                }
                onInput={autoGrow}
                onKeyDown={handleKey}
              />

              {isStreaming ? (
                <button
                  type="button"
                  onClick={stopGeneration}
                  className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 rounded-xl text-sm font-medium transition-colors shrink-0"
                >
                  ◼ Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => sendMessage()}
                  disabled={!text.trim()}
                  className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-medium transition-all shrink-0"
                >
                  Send
                </button>
              )}
            </div>

            <p className="text-[11px] text-neutral-600 text-center mt-2">
              Nimbus can make mistakes — check links before acting.
              Tool activity shown above each reply is what actually ran.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
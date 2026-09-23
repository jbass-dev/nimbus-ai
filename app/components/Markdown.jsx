"use client";

import { useState } from "react";

/* ── Copy button ───────────────────────────────────────── */

function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer ${
        copied
          ? "text-emerald-400"
          : "text-neutral-400 hover:text-white hover:bg-white/10"
      } ${className}`}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/* ── Code block ─────────────────────────────────────────── */

function CodeBlock({ lang, code }) {
  return (
    <div className="my-3 rounded-xl overflow-hidden border border-neutral-700/60 bg-[#0d1117]">
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/5 border-b border-neutral-700/60">
        <span className="text-[11px] uppercase tracking-wider text-neutral-400 font-mono">
          {lang || "code"}
        </span>

        <CopyButton text={code} />
      </div>

      <pre className="select-text p-4 overflow-x-auto text-[13px] leading-relaxed">
        <code className="select-text font-mono text-[#e6edf3]">
          {code}
        </code>
      </pre>
    </div>
  );
}

/* ── Inline markdown ────────────────────────────────────── */

function renderInline(text, keyPrefix = "") {
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/g;

  const parts = [];
  let last = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (token.startsWith("`")) {
      parts.push(
        <code
          key={key}
          className="select-text px-1.5 py-0.5 mx-0.5 rounded-md bg-white/10 font-mono text-[0.85em] text-cyan-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      parts.push(
        <strong
          key={key}
          className="select-text font-semibold text-white"
        >
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("[")) {
      const matchLink = token.match(
        /\[([^\]]+)\]\(([^)]+)\)/
      );

      if (matchLink) {
        parts.push(
          <a
            key={key}
            href={matchLink[2]}
            target="_blank"
            rel="noreferrer"
            className="select-text text-cyan-400 underline underline-offset-2 hover:text-cyan-300"
          >
            {matchLink[1]}
          </a>
        );
      }
    } else {
      parts.push(
        <em key={key} className="select-text italic">
          {token.slice(1, -1)}
        </em>
      );
    }

    last = match.index + token.length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts;
}

/* ── Text blocks ────────────────────────────────────────── */

function renderTextBlock(text, keyPrefix) {
  const lines = text.split("\n");
  const output = [];

  let listItems = null;
  let listOrdered = false;

  const flushList = (key) => {
    if (!listItems) return;

    const Tag = listOrdered ? "ol" : "ul";

    output.push(
      <Tag
        key={key}
        className={`my-2 ml-5 space-y-1 select-text ${
          listOrdered ? "list-decimal" : "list-disc"
        }`}
      >
        {listItems}
      </Tag>
    );

    listItems = null;
  };

  lines.forEach((line, index) => {
    const key = `${keyPrefix}-l${index}`;

    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)/);
    const heading = line.match(/^(#{1,4})\s+(.*)/);

    if (bullet || ordered) {
      const content = (bullet || ordered)[1];

      if (
        !listItems ||
        listOrdered !== Boolean(ordered)
      ) {
        flushList(`${key}-flush`);

        listItems = [];
        listOrdered = Boolean(ordered);
      }

      listItems.push(
        <li key={key} className="select-text">
          {renderInline(content, key)}
        </li>
      );

      return;
    }

    flushList(`${key}-flush`);

    if (heading) {
      const level = heading[1].length;

      const sizes = {
        1: "text-xl font-bold mt-4 mb-2",
        2: "text-lg font-bold mt-3 mb-2",
        3: "text-base font-semibold mt-3 mb-1",
        4: "text-sm font-semibold mt-2 mb-1",
      };

      output.push(
        <p
          key={key}
          className={`${sizes[level]} select-text`}
        >
          {renderInline(heading[2], key)}
        </p>
      );

      return;
    }

    if (line.trim() === "") {
      output.push(
        <div key={key} className="h-2" />
      );

      return;
    }

    output.push(
      <p
        key={key}
        className="leading-relaxed select-text"
      >
        {renderInline(line, key)}
      </p>
    );
  });

  flushList(`${keyPrefix}-finalflush`);

  return output;
}

/* ── Markdown renderer ─────────────────────────────────── */

export default function Markdown({ content }) {
  const segments = content.split(
    /(```[\s\S]*?(?:```|$))/g
  );

  return (
    <div className="text-sm select-text">
      {segments.map((segment, index) => {
        if (segment.startsWith("```")) {
          const body = segment
            .replace(/```$/, "")
            .slice(3);

          const newline = body.indexOf("\n");

          const lang =
            newline === -1
              ? ""
              : body.slice(0, newline).trim();

          const code =
            newline === -1
              ? body
              : body.slice(newline + 1);

          return (
            <CodeBlock
              key={index}
              lang={lang}
              code={code.replace(/\n$/, "")}
            />
          );
        }

        return segment ? (
          <div key={index} className="select-text">
            {renderTextBlock(
              segment,
              `s${index}`
            )}
          </div>
        ) : null;
      })}
    </div>
  );
}

export { CopyButton };
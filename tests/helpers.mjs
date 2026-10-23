import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createMemoryStore } from "../lib/nimbus/memory-store.mjs";

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "nimbus-test-"));
}

export function userKey(label = crypto.randomUUID()) {
  return crypto.createHash("sha256").update(label).digest("hex");
}

export async function freshStore() {
  const dir = await tempDir();
  return { dir, store: createMemoryStore({ dataDir: dir }) };
}

/**
 * Scripted LLM. Each entry is either a response object
 * { content?, toolCalls?: [{name, args}] } or a function(request) → response,
 * or an Error to throw. Records every request for assertions.
 */
export function scriptedLlm(script) {
  const requests = [];
  let i = 0;
  return {
    requests,
    async chat(req) {
      requests.push(structuredClone({ ...req, onToken: undefined, signal: undefined }));
      const entry = script[Math.min(i++, script.length - 1)];
      const res = typeof entry === "function" ? await entry(req, requests.length - 1) : entry;
      if (res instanceof Error) throw res;
      const content = res.content ?? "";
      if (content) req.onToken?.(content);
      return {
        content,
        finishReason: res.toolCalls?.length ? "tool_calls" : "stop",
        toolCalls: (res.toolCalls ?? []).map((c, n) => ({
          id: c.id ?? `call_${requests.length}_${n}`,
          name: c.name,
          arguments: typeof c.rawArgs === "string" ? c.rawArgs : JSON.stringify(c.args ?? {}),
        })),
      };
    },
  };
}

/** fetch mock: routes maps a URL substring → response body (object → JSON) | function | Error. */
export function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push(String(url));
    for (const [match, handler] of Object.entries(routes)) {
      if (!String(url).includes(match)) continue;
      let r = typeof handler === "function" ? await handler(url, init) : handler;
      if (r instanceof Error) throw r;
      if (r && r.__status) {
        return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.__status, headers: r.headers ?? {} });
      }
      const isText = typeof r === "string";
      return new Response(isText ? r : JSON.stringify(r), {
        status: 200,
        headers: { "content-type": isText ? "text/html" : "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

/** DNS stub resolving everything to a public IP unless listed. */
export function fakeLookup(overrides = {}) {
  return async (host) => {
    const addr = overrides[host] ?? "93.184.216.34";
    return [{ address: addr, family: addr.includes(":") ? 6 : 4 }];
  };
}

export function collector() {
  const events = [];
  const emit = (e) => events.push(e);
  emit.events = events;
  emit.of = (type) => events.filter((e) => e.type === type);
  return emit;
}

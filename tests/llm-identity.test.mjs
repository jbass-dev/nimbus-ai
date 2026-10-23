import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStream, createOpenRouterClient, isToolUnsupportedError, LlmError } from "../lib/nimbus/llm.mjs";
import { resolveIdentity, parseCookies, COOKIE_NAME } from "../lib/nimbus/identity.mjs";

function sse(lines) {
  const enc = new TextEncoder();
  const text = lines.join("\n");
  // split mid-line to exercise buffering
  const parts = [text.slice(0, 17), text.slice(17, 90), text.slice(90)];
  return new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
}

test("streams content tokens and assembles split tool-call deltas", async () => {
  const tokens = [];
  const body = sse([
    ": OPENROUTER PROCESSING",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Let me " } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "search." } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_", arguments: '{"que' } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "jobs", arguments: 'ry":"react"}' } }] } }] })}`,
    "data: {this is not json",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
    "data: [DONE]",
  ]);
  const r = await parseStream(body, (t) => tokens.push(t));
  assert.equal(r.content, "Let me search.");
  assert.deepEqual(tokens, ["Let me ", "search."]);
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "search_jobs", arguments: '{"query":"react"}' }]);
  assert.equal(r.finishReason, "tool_calls");
});

test("mid-stream provider error becomes an LlmError", async () => {
  const body = sse([`data: ${JSON.stringify({ error: { code: 502, message: "upstream overloaded" } })}`]);
  await assert.rejects(parseStream(body), (e) => e instanceof LlmError && /overloaded/.test(e.message));
});

test("HTTP errors are classified (retryable, tool-unsupported) and the key is sent only to OpenRouter", async () => {
  let seen;
  const client = createOpenRouterClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.Authorization, body: JSON.parse(init.body) };
      return new Response('{"error":{"message":"No endpoints found that support tool use"}}', { status: 404 });
    },
  });
  const err = await client.chat({ model: "x", messages: [], tools: [{ type: "function", function: { name: "t" } }], toolChoice: "auto" }).catch((e) => e);
  assert.equal(seen.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen.auth, "Bearer sk-test");
  assert.equal(seen.body.tool_choice, "auto");
  assert.ok(isToolUnsupportedError(err));
  const c2 = createOpenRouterClient({ apiKey: "k", fetchImpl: async () => new Response("busy", { status: 429 }) });
  const e2 = await c2.chat({ model: "x", messages: [] }).catch((e) => e);
  assert.equal(e2.retryable, true);
  const c3 = createOpenRouterClient({ apiKey: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const e3 = await c3.chat({ model: "x", messages: [] }).catch((e) => e);
  assert.match(e3.message, /Could not reach/);
});

test("identity: new visitors get a random HttpOnly cookie; returning visitors keep their key", () => {
  const req = (cookie, url = "http://localhost:3000/api/x") => new Request(url, { headers: cookie ? { cookie } : {} });
  const first = resolveIdentity(req());
  assert.match(first.setCookie, new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict`));
  assert.doesNotMatch(first.setCookie, /Secure/);
  const token = first.setCookie.split(";")[0].split("=")[1];
  const again = resolveIdentity(req(`other=1; ${COOKIE_NAME}=${token}`));
  assert.equal(again.userKey, first.userKey);
  assert.equal(again.setCookie, null);
  assert.notEqual(resolveIdentity(req()).userKey, first.userKey);
  // tampered/forged cookie values are replaced, not trusted
  const forged = resolveIdentity(req(`${COOKIE_NAME}=../../etc/passwd`));
  assert.ok(forged.setCookie);
  assert.match(forged.userKey, /^[a-f0-9]{64}$/);
  assert.match(resolveIdentity(req(null, "https://nimbus.example/")).setCookie, /Secure/);
  assert.deepEqual(parseCookies("a=1; b=two%20words"), { a: "1", b: "two words" });
});

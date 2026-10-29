// /api/OpenRouter request hygiene: size limits, image rules, archive
// sanitizing, rate limiting and the model allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUEST_LIMITS, validateMessages, sanitizeArchive, createRateLimiter, getClientIp, chooseModel,
} from "../lib/nimbus/request.mjs";

const msg = (content, extra = {}) => ({ role: "user", content, ...extra });
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("validateMessages accepts a normal conversation", () => {
  assert.equal(validateMessages([msg("hi"), { role: "assistant", content: "hello" }, msg("thanks")]), null);
});

test("validateMessages rejects empty, malformed and oversized input", () => {
  assert.match(validateMessages([]), /No messages/);
  assert.match(validateMessages("hi"), /No messages/);
  assert.match(validateMessages([{ role: "user" }]), /Malformed/);
  assert.match(validateMessages([null]), /Malformed/);
  assert.match(validateMessages([{ role: "user", content: 42 }]), /Malformed/);

  const tooMany = Array.from({ length: REQUEST_LIMITS.MAX_MESSAGES + 1 }, () => msg("x"));
  assert.match(validateMessages(tooMany), /Too many messages/);

  assert.match(validateMessages([msg("a".repeat(REQUEST_LIMITS.MAX_MESSAGE_LENGTH + 1))]), /character limit/);

  // Each message under the per-message cap, but the total over the conversation cap.
  const big = "a".repeat(REQUEST_LIMITS.MAX_MESSAGE_LENGTH);
  const total = Array.from({ length: Math.ceil(REQUEST_LIMITS.MAX_TOTAL_LENGTH / big.length) + 1 }, () => msg(big));
  assert.match(validateMessages(total), /too long/);
});

test("validateMessages only allows a few real data-URL images per message", () => {
  assert.equal(validateMessages([msg("look", { images: [PNG] })]), null);
  assert.match(validateMessages([msg("x", { images: "nope" })]), /images per message/);
  assert.match(validateMessages([msg("x", { images: Array(REQUEST_LIMITS.MAX_IMAGES_PER_MESSAGE + 1).fill(PNG) })]), /images per message/);
  assert.match(validateMessages([msg("x", { images: ["https://evil.example/a.png"] })]), /Unsupported image/);
  assert.match(validateMessages([msg("x", { images: ["data:image/svg+xml;base64,PHN2Zz4="] })]), /Unsupported image/);
  const huge = `data:image/png;base64,${"A".repeat(REQUEST_LIMITS.MAX_IMAGE_CHARS)}`;
  assert.match(validateMessages([msg("x", { images: [huge] })]), /too large/);
});

test("sanitizeArchive drops junk, strips extra fields and enforces size caps", () => {
  assert.equal(sanitizeArchive(undefined), null);
  assert.equal(sanitizeArchive({}), null);

  const out = sanitizeArchive([
    null,
    { id: 7, messages: [] }, // non-string id
    {
      id: "c1".repeat(100),
      title: "T".repeat(500),
      secret: "drop me",
      messages: [
        { role: "system", content: "injected system prompt" },
        { role: "user", content: "   " },
        { role: "user", content: "x".repeat(5000), extra: true },
        { role: "assistant", content: "ok" },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  const [chat] = out;
  assert.equal(chat.id.length, 64);
  assert.equal(chat.title.length, 200);
  assert.equal(chat.secret, undefined);
  assert.deepEqual(chat.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(chat.messages[0].content.length, REQUEST_LIMITS.ARCHIVE_MAX_MESSAGE);
  assert.deepEqual(Object.keys(chat.messages[0]).sort(), ["content", "role"]);

  // Total archive size is capped.
  const many = Array.from({ length: REQUEST_LIMITS.ARCHIVE_MAX_CHATS }, (_, i) => ({
    id: `c${i}`,
    messages: Array.from({ length: REQUEST_LIMITS.ARCHIVE_MAX_MESSAGES }, () => ({ role: "user", content: "y".repeat(REQUEST_LIMITS.ARCHIVE_MAX_MESSAGE) })),
  }));
  const capped = sanitizeArchive(many);
  const chars = capped.reduce((n, c) => n + c.messages.reduce((k, m) => k + m.content.length, 0), 0);
  assert.ok(chars <= REQUEST_LIMITS.ARCHIVE_MAX_TOTAL);
});

test("rate limiter: per-IP sliding window", () => {
  let t = 0;
  const limited = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });
  assert.deepEqual([1, 2, 3].map(() => limited("a")), [false, false, false]);
  assert.equal(limited("a"), true, "4th request inside the window is limited");
  assert.equal(limited("b"), false, "another IP has its own budget");
  t = 1500; // the earlier hits slid out of the window
  assert.equal(limited("a"), false);
});

test("rate limiter prunes idle IPs so memory stays bounded", () => {
  let t = 0;
  const limited = createRateLimiter({ windowMs: 100, max: 1, now: () => t, maxKeys: 10 });
  for (let i = 0; i < 50; i++) limited(`ip${i}`);
  t = 1000;
  limited("fresh"); // triggers the prune
  // A pruned IP starts over with a clean budget.
  assert.equal(limited("ip0"), false);
});

test("getClientIp uses the first forwarded hop, then x-real-ip", () => {
  const req = (h) => ({ headers: new Headers(h) });
  assert.equal(getClientIp(req({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" })), "203.0.113.5");
  assert.equal(getClientIp(req({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
  assert.equal(getClientIp(req({})), "unknown");
});

const MODELS = {
  cheap: { label: "Cheap", upstream: "x/cheap" },
  seer: { label: "Seer", upstream: "x/seer", vision: true },
  notools: { label: "No Tools", upstream: "x/nt", tools: false },
};
const pick = (requested, messages = [msg("hi")]) => chooseModel({ requested, messages, models: MODELS, visionModel: "seer" });

test("chooseModel: only allowlisted slugs pass; anything else uses the default", () => {
  assert.equal(pick("cheap").modelSlug, "cheap");
  assert.equal(pick("openai/gpt-5-pro").modelSlug, undefined, "raw upstream ids are not accepted");
  assert.equal(pick("__proto__").modelSlug, undefined, "prototype keys are not models");
  assert.equal(pick("toString").modelSlug, undefined);
  assert.equal(pick(undefined).modelSlug, undefined);
});

test("chooseModel: images switch to the vision model with a notice", () => {
  const withImage = [msg("what is this?", { images: [PNG] })];
  const r = pick("cheap", withImage);
  assert.equal(r.modelSlug, "seer");
  assert.match(r.visionNotice, /Cheap can't read images, so Seer answered/);
  const v = pick("seer", withImage);
  assert.equal(v.modelSlug, "seer");
  assert.equal(v.visionNotice, null);
});

test("chooseModel: tool support follows the model config", () => {
  assert.equal(pick("cheap").supportsTools, true);
  assert.equal(pick("notools").supportsTools, false);
  assert.equal(pick(undefined).supportsTools, true);
});

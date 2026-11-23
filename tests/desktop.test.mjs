// Desktop shell helpers (pure) and chat export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chatToMarkdown } from "../lib/ui/export.mjs";

const { safeFileName, usableBounds, isAppUrl } = createRequire(import.meta.url)("../desktop-helpers.js");

test("safeFileName strips separators, reserved names and dots", () => {
  assert.equal(safeFileName('Plan: "v2"/final?'), "Plan v2 final");
  assert.equal(safeFileName("../../etc/passwd"), "etc passwd");
  assert.equal(safeFileName("CON"), "nimbus-chat");
  assert.equal(safeFileName(""), "nimbus-chat");
  assert.equal(safeFileName(".hidden"), "hidden");
  assert.ok(safeFileName("x".repeat(500)).length <= 80);
});

test("usableBounds restores only windows that are still visible on a connected display", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(usableBounds({ x: 100, y: 50, width: 1200, height: 800 }, displays), { x: 100, y: 50, width: 1200, height: 800 });
  assert.equal(usableBounds({ x: 2500, y: 0, width: 1200, height: 800 }, displays), null, "monitor unplugged");
  assert.equal(usableBounds({ x: 1850, y: 0, width: 1200, height: 800 }, displays), null, "only a sliver visible");
  assert.equal(usableBounds({ x: 0, y: 0, width: 100, height: 100 }, displays), null, "too small");
  assert.equal(usableBounds({ x: "a", y: 0, width: 1200, height: 800 }, displays), null);
  assert.equal(usableBounds(null, displays), null);
});

test("isAppUrl accepts only the local Nimbus server", () => {
  assert.ok(isAppUrl("http://localhost:3000/", 3000));
  assert.ok(isAppUrl("http://127.0.0.1:3000/x", 3000));
  assert.equal(isAppUrl("http://localhost:3001/", 3000), false);
  assert.equal(isAppUrl("https://localhost:3000/", 3000), false);
  assert.equal(isAppUrl("http://evil.com:3000/", 3000), false);
  assert.equal(isAppUrl("http://localhost.evil.com:3000/", 3000), false);
  assert.equal(isAppUrl("not a url", 3000), false);
});

test("chatToMarkdown exports turns, attachments and staged edits, skipping empty messages", () => {
  const md = chatToMarkdown({
    title: "Fix  add()",
    messages: [
      { role: "user", content: "fix it", attachments: [{ name: "a.js" }] },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Staged.", proposals: [{ path: "src/a.js", added: 1, removed: 1, diff: "-a\n+b" }] },
    ],
  }, { now: new Date("2026-11-23T12:00:00Z") });
  assert.match(md, /^# Fix add\(\)/);
  assert.match(md, /## You\n\n_Attached: a\.js_\n\nfix it/);
  assert.equal((md.match(/## Nimbus/g) ?? []).length, 1);
  assert.match(md, /Proposed edit to `src\/a\.js`/);
  assert.match(md, /```diff\n-a\n\+b\n```/);
  assert.match(md, /2026-11-23/);
});

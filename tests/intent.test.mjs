import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, hasExplicitMemoryIntent } from "../lib/nimbus/intent.mjs";

// Realistic user phrasings → expected routing. Accuracy is reported so a
// regression in the router shows up as a number, not just a red test.
const CASES = [
  ["job search", "job_search"],
  ["Job search", "job_search"],
  ["Find remote React jobs paying at least $60k", "job_search"],
  ["any frontend roles open right now?", "job_search"],
  ["show me junior developer positions in Oklahoma", "job_search"],
  ["who's hiring next.js devs", "job_search"],
  ["look for entry level internships in web dev", "job_search"],
  ["Remember that I prefer remote jobs", "memory_save"],
  ["remember I want jobs paying 70k+", "memory_save"],
  ["From now on only show me full-time roles", "memory_save"],
  ["I prefer TypeScript over plain JavaScript", "memory_save"],
  ["We decided to use JSON files for Nimbus memory", "memory_save"],
  ["Forget my salary", "memory_forget"],
  ["don't remember anything about my current job", "memory_forget"],
  ["delete that memory", "memory_forget"],
  ["What do you remember about me?", "memory_recall"],
  ["What did we decide about the database for Nimbus?", "memory_recall"],
  ["Research Skinstric the company", "research"],
  ["what's the latest Next.js version?", "research"],
  ["news about OpenRouter this week", "research"],
  ["summarize https://nextjs.org/blog", "read_url"],
  ["Fix this bug: TypeError: cannot read properties of undefined (reading 'map')", "code_fix"],
  ["my useEffect is not working, it runs twice", "code_fix"],
  ["Explain JavaScript closures with an example", "chat"],
  ["Draft a professional follow-up email after an interview", "chat"],
  ["How do I write a good cover letter for a developer job?", "chat"],
  ["Write a custom React hook for debouncing input", "chat"],
];

test("intent routing accuracy on realistic requests", () => {
  const misses = [];
  for (const [text, expected] of CASES) {
    const got = classifyIntent(text).intent;
    if (got !== expected) misses.push({ text, expected, got });
  }
  const accuracy = 1 - misses.length / CASES.length;
  console.log(`  intent accuracy: ${(accuracy * 100).toFixed(1)}% (${CASES.length - misses.length}/${CASES.length})`);
  assert.deepEqual(misses, [], `misrouted: ${JSON.stringify(misses, null, 2)}`);
});

test("forced tools map to the right intents", () => {
  assert.equal(classifyIntent("job search").forcedTool, "search_jobs");
  assert.equal(classifyIntent("research Vercel pricing").forcedTool, "web_search");
  assert.equal(classifyIntent("Explain closures").forcedTool, null);
  assert.equal(classifyIntent("fix this bug").forcedTool, null);
});

test("explicit memory intent detection", () => {
  assert.ok(hasExplicitMemoryIntent("Remember that I prefer remote jobs"));
  assert.ok(hasExplicitMemoryIntent("please forget my salary"));
  assert.ok(!hasExplicitMemoryIntent("summarize this job posting for me"));
});

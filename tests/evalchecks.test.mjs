import { test } from "node:test";
import assert from "node:assert/strict";
import { leakedToolSyntax, excessiveRepeats, mentionsDate, admitsFailure, compareRuns } from "../lib/nimbus/evalchecks.mjs";

test("leakedToolSyntax catches raw tool-call text and ignores normal replies", () => {
  for (const bad of [
    'Checking.\n<tool_call>{"name":"web_search"}</tool_call>',
    '<function=web_search>{"query":"nfl"}</function>',
    '[TOOL_CALLS][{"name":"x","arguments":{}}]',
    '{"name":"web_search","arguments":{"query":"nfl scores"}}',
    "<|python_tag|>web_search.call(query='nfl')",
  ]) assert.equal(leakedToolSyntax(bad), true, bad);
  for (const ok of ["The Bills won 24-17.", "Use `{ name: 'x' }` in JS, and a < b.", "I searched the web and found three results."]) {
    assert.equal(leakedToolSyntax(ok), false, ok);
  }
});

test("excessiveRepeats flags a search loop but not normal multistep use", () => {
  const calls = (n, name = "web_search") => Array.from({ length: n }, () => ({ name }));
  assert.equal(excessiveRepeats(calls(5)), true);
  assert.equal(excessiveRepeats([...calls(3), ...calls(3, "fetch_url")]), false);
});

test("mentionsDate accepts common phrasings, either word order, and ISO", () => {
  const d = new Date(2026, 10, 23, 12);
  for (const s of ["Today is Monday, November 23, 2026.", "It's Nov 23.", "23 November 2026", "the 23rd of November", "2026-11-23"]) assert.equal(mentionsDate(s, d), true, s);
  for (const s of ["Today is November 22.", "It is Monday.", "December 23"]) assert.equal(mentionsDate(s, d), false, s);
});

test("admitsFailure recognises honest failure wording", () => {
  assert.equal(admitsFailure("I couldn't retrieve the scores."), true);
  assert.equal(admitsFailure("The search failed, so I can't confirm."), true);
  assert.equal(admitsFailure("The Bills won 24-17."), false);
});

test("compareRuns reports regressions and fixes, ignoring new scenarios", () => {
  const prev = [{ id: "a", pass: true }, { id: "b", pass: false }, { id: "c", pass: true }];
  const curr = [{ id: "a", pass: false }, { id: "b", pass: true }, { id: "c", pass: true }, { id: "d", pass: false }];
  assert.deepEqual(compareRuns(prev, curr), { regressions: ["a"], fixed: ["b"] });
});

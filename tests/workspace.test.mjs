// Coding workspace: path safety, secrets, staged edits, apply/revert, command allowlist, agent behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runAgent } from "../lib/nimbus/agent.mjs";
import { DEFAULT_TOOLS } from "../lib/nimbus/tools/index.mjs";
import { normalizePermissions } from "../lib/nimbus/permissions.mjs";
import { WORKSPACE_TOOLS } from "../lib/nimbus/tools/workspace.mjs";
import { createWorkspaceStore } from "../lib/nimbus/workspace-store.mjs";
import {
  WorkspaceError, applyReplace, buildCommand, checkAccess, cleanEnv, compileIgnore, isForbiddenRoot, makeDiff,
  overview, readFile, redactSecrets, resolveInside, runCommand, searchCode, validateRoot,
} from "../lib/nimbus/workspace.mjs";
import { freshStore, userKey, tempDir, scriptedLlm, collector } from "./helpers.mjs";

async function project(files = {}) {
  const root = await fs.realpath(await tempDir());
  const all = {
    "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test", lint: "echo lint", deploy: "echo no" }, dependencies: { react: "1" } }),
    "src/a.js": "export const a = 1;\nexport function add(x, y) {\n  return x + y;\n}\n",
    "src/b.js": "import { a } from './a.js';\nconsole.log(a);\n",
    ".env": "SECRET=abc",
    "node_modules/x/index.js": "nope",
    ".gitignore": "ignored/\n*.log\n",
    "ignored/z.js": "zzz",
    "debug.log": "log",
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof WorkspaceError && (!code || e.code === code));

// ---- path safety -------------------------------------------------------------------
test("paths cannot escape the project: traversal, absolute paths and symlinks", async () => {
  const root = await project();
  const outside = await fs.realpath(await tempDir());
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fs.symlink(outside, path.join(root, "link"));
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "src", "evil.js"));
  await rejects(resolveInside(root, "../x"), "outside");
  await rejects(resolveInside(root, "src/../../x"), "outside");
  await rejects(resolveInside(root, outside), "outside");
  await rejects(resolveInside(root, "link/secret.txt"), "outside");
  await rejects(readFile(root, "src/evil.js"), "outside");
  await rejects(resolveInside(root, "new/dir/file.js", { mode: "write" }), "not_found");
  assert.equal((await resolveInside(root, "src/a.js")).rel, "src/a.js");
  assert.equal((await resolveInside(root, "src\\a.js")).rel, "src/a.js");
});

test("secret files and folders are never readable or writable; templates are fine", async () => {
  for (const p of [".env", ".env.local", "config/.env.production", "certs/server.pem", "id_rsa", ".ssh/config", ".git/config", ".npmrc", "credentials.json", "keys/my.key"]) {
    assert.throws(() => checkAccess(p), WorkspaceError, p);
  }
  assert.doesNotThrow(() => checkAccess(".env.example"));
  assert.doesNotThrow(() => checkAccess("src/keyboard.js"));
  assert.throws(() => checkAccess("node_modules/x/a.js", "write"), WorkspaceError);
  assert.doesNotThrow(() => checkAccess("node_modules/x/a.js", "read"));
  const root = await project();
  await rejects(readFile(root, ".env"), "denied");
});

test("forbidden folder roots: drives, home itself, system folders, ~/.ssh (windows rules testable anywhere)", () => {
  const w = { platform: "win32", home: "C:\\Users\\John" };
  assert.ok(isForbiddenRoot("C:\\", w));
  assert.ok(isForbiddenRoot("C:\\Users\\John", w));
  assert.ok(isForbiddenRoot("C:\\Users", w));
  assert.ok(isForbiddenRoot("c:\\windows\\system32", w));
  assert.ok(isForbiddenRoot("C:\\Program Files\\App", w));
  assert.ok(isForbiddenRoot("C:\\Users\\John\\.ssh", w));
  assert.ok(isForbiddenRoot("C:\\Users\\John\\AppData\\Local", w));
  assert.equal(isForbiddenRoot("C:\\Dev\\nimbus-ai", w), null);
  assert.equal(isForbiddenRoot("C:\\Users\\John\\Projects\\app", w), null);
  const p = { platform: "linux", home: "/home/john" };
  assert.ok(isForbiddenRoot("/", p));
  assert.ok(isForbiddenRoot("/home/john", p));
  assert.ok(isForbiddenRoot("/etc/nginx", p));
  assert.ok(isForbiddenRoot("/home/john/.aws", p));
  assert.equal(isForbiddenRoot("/home/john/code/app", p), null);
  assert.equal(isForbiddenRoot("/var/www/app", p), null);
});

test("validateRoot needs a real absolute directory", async () => {
  const root = await project();
  assert.equal(await validateRoot(`"${root}"`), root);
  await rejects(validateRoot("relative/path"), "invalid");
  await rejects(validateRoot(path.join(root, "nope")), "not_found");
  await rejects(validateRoot(path.join(root, "package.json")), "not_found");
  await rejects(validateRoot(""), "invalid");
});

// ---- reading -------------------------------------------------------------------------
test("redactSecrets hides keys and token-like assignments", () => {
  const { text, count } = redactSecrets('const k = "sk-or-v1-abcdefghijklmnop1234";\nconst api_key = "abcdefghijklmnopqrstuv";\nconst name = "bob";\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz');
  assert.ok(count >= 3);
  assert.ok(!/abcdefghijklmnop/.test(text));
  assert.match(text, /name = "bob"/);
});

test("readFile numbers lines, supports ranges, redacts, and refuses binaries and folders", async () => {
  const root = await project({ "src/cfg.js": 'export const token = "abcdefghijklmnopqrstuvwxyz123";\n', "bin.dat": Buffer.from([1, 0, 2]).toString("latin1") });
  const r = await readFile(root, "src/a.js", { start: 2, end: 3 });
  assert.equal(r.start_line, 2);
  assert.match(r.content, /^\s+2\| export function add/);
  assert.equal(r.total_lines, 4);
  const c = await readFile(root, "src/cfg.js");
  assert.ok(c.redacted_secrets >= 1);
  assert.ok(!c.content.includes("abcdefghijklmnopqrstuvwxyz123"));
  await rejects(readFile(root, "src"), "invalid");
  await rejects(readFile(root, "bin.dat"), "binary");
  await rejects(readFile(root, "missing.js"), "not_found");
});

test("search skips node_modules, .gitignore'd paths and secret files, and filters by glob", async () => {
  const root = await project({ "src/c.ts": "const add = 2;" });
  const r = await searchCode(root, "add");
  const paths = r.results.map((x) => x.path);
  assert.ok(paths.includes("src/a.js") && paths.includes("src/c.ts"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules") || p.startsWith("ignored") || p === ".env" || p === "debug.log"));
  const js = await searchCode(root, "add", { include: "*.js" });
  assert.deepEqual([...new Set(js.results.map((x) => x.path))], ["src/a.js"]);
  const rx = await searchCode(root, "export (const|function)", { regex: true });
  assert.equal(rx.results.length, 2);
  await rejects(searchCode(root, "(", { regex: true }), "invalid");
});

test("compileIgnore handles dirs, globs and anchoring", () => {
  const ig = compileIgnore("dist/\n*.log\n/build\n# c\nsrc/**/gen\n");
  assert.ok(ig("dist", true));
  assert.ok(ig("a/dist/x.js", false));
  assert.ok(!ig("dist", false), "dir-only rule doesn't match a file named dist");
  assert.ok(ig("x/y.log", false));
  assert.ok(ig("build/a", false) && !ig("src/build", true));
  assert.ok(ig("src/a/b/gen", true));
});

test("overview describes the project", async () => {
  const root = await project();
  const o = await overview(root);
  assert.ok(o.stacks.includes("node") && o.stacks.includes("React"));
  assert.equal(o.tests, "npm test");
  assert.ok(o.entry_points.includes("src"));
  assert.ok(o.tree.includes("a.js"));
  assert.ok(!o.tree.includes("node_modules"));
});

// ---- diffs and replacement --------------------------------------------------------------
test("applyReplace requires a unique, exact match", () => {
  assert.equal(applyReplace("a b a", "b", "c").text, "a c a");
  assert.throws(() => applyReplace("a b a", "a", "c"), (e) => e.code === "ambiguous");
  assert.equal(applyReplace("a b a", "a", "c", { replaceAll: true }).text, "c b c");
  assert.throws(() => applyReplace("x", "y", "z"), (e) => e.code === "no_match");
  assert.throws(() => applyReplace("x", "x", "x"), (e) => e.code === "invalid");
});

test("makeDiff shows the changed region with context", () => {
  const d = makeDiff("1\n2\n3\n4\n5\n6\n7\n", "1\n2\n3\nFOUR\n5\n6\n7\n", { context: 1 });
  assert.match(d.diff, /-4\n\+FOUR/);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(!d.diff.includes("\n 1\n"));
});

// ---- staged edits ----------------------------------------------------------------------------
async function wsFor(root) {
  const dataDir = await tempDir();
  const store = createWorkspaceStore({ dataDir });
  const uk = userKey();
  await store.setRoot(uk, root);
  return { store, uk, dataDir };
}

test("staging an edit writes nothing; Apply writes exactly the shown change; Revert restores it", async () => {
  const root = await project();
  const { store, uk } = await wsFor(root);
  const file = path.join(root, "src/a.js");
  const original = await fs.readFile(file, "utf8");
  const p = await store.stageEdit(uk, { path: "src/a.js", old_string: "return x + y;", new_string: "return Number(x) + Number(y);", description: "coerce" });
  assert.equal(await fs.readFile(file, "utf8"), original, "unchanged until Apply");
  assert.match(p.diff, /\+  return Number\(x\)/);
  assert.equal((await store.state(uk)).proposals.length, 1);
  const change = await store.apply(uk, p.id);
  assert.match(await fs.readFile(file, "utf8"), /Number\(x\) \+ Number\(y\)/);
  assert.equal(change.revertible, true);
  assert.equal((await store.state(uk)).proposals.length, 0);
  await rejects(store.apply(uk, p.id), "expired");
  await store.revert(uk, change.id);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await rejects(store.revert(uk, change.id), "invalid");
});

test("Apply refuses when the file changed after the diff was shown; Revert refuses after later edits", async () => {
  const root = await project();
  const { store, uk } = await wsFor(root);
  const file = path.join(root, "src/a.js");
  const p = await store.stageEdit(uk, { path: "src/a.js", old_string: "x + y", new_string: "y + x" });
  await fs.appendFile(file, "// user edit\n");
  await rejects(store.apply(uk, p.id), "stale");
  const p2 = await store.stageEdit(uk, { path: "src/a.js", old_string: "x + y", new_string: "y + x" });
  const ch = await store.apply(uk, p2.id);
  await fs.appendFile(file, "// more\n");
  await rejects(store.revert(uk, ch.id), "stale");
  assert.match(await fs.readFile(file, "utf8"), /more/);
});

test("create mode makes new files (revert removes them) and won't overwrite; line endings and BOM are preserved", async () => {
  const root = await project({ "win.txt": "\uFEFFa\r\nb\r\n" });
  const { store, uk } = await wsFor(root);
  const p = await store.stageEdit(uk, { path: "src/new.js", mode: "create", new_string: "export {};\n" });
  assert.equal((await store.state(uk)).proposals[0].action, "create");
  const ch = await store.apply(uk, p.id);
  assert.equal(await fs.readFile(path.join(root, "src/new.js"), "utf8"), "export {};\n");
  await rejects(store.stageEdit(uk, { path: "src/new.js", mode: "create", new_string: "x" }), "exists");
  await store.revert(uk, ch.id);
  await assert.rejects(fs.access(path.join(root, "src/new.js")));
  const q = await store.stageEdit(uk, { path: "win.txt", old_string: "a\nb", new_string: "a\nB" });
  await store.apply(uk, q.id);
  assert.equal(await fs.readFile(path.join(root, "win.txt"), "utf8"), "\uFEFFa\r\nB\r\n");
});

test("edits to secrets, generated folders, outside paths and secret-looking content are refused", async () => {
  const root = await project();
  const { store, uk } = await wsFor(root);
  await rejects(store.stageEdit(uk, { path: ".env", mode: "create", new_string: "X=1" }), "denied");
  await rejects(store.stageEdit(uk, { path: "node_modules/x/index.js", old_string: "nope", new_string: "yes" }), "denied");
  await rejects(store.stageEdit(uk, { path: "../evil.js", mode: "create", new_string: "x" }), "outside");
  await rejects(store.stageEdit(uk, { path: "src/a.js", old_string: "const a = 1", new_string: 'const a = "sk-or-v1-abcdefghijklmnop1234"' }), "secret");
  await rejects(store.stageEdit(userKey(), { path: "src/a.js", old_string: "a", new_string: "b" }), "no_workspace");
});

test("proposals are per user and expire", async () => {
  const root = await project();
  let t = Date.now();
  const store = createWorkspaceStore({ dataDir: await tempDir(), now: () => t });
  const u1 = userKey(), u2 = userKey();
  await store.setRoot(u1, root);
  await store.setRoot(u2, root);
  const p = await store.stageEdit(u1, { path: "src/a.js", old_string: "x + y", new_string: "y + x" });
  await rejects(store.apply(u2, p.id), "expired");
  t += 31 * 60_000;
  await rejects(store.apply(u1, p.id), "expired");
  assert.deepEqual(store.discard(u1, "nope"), { discarded: false });
});

test("the folder setting persists and a vanished folder reads as closed", async () => {
  const root = await project();
  const dataDir = await tempDir();
  const uk = userKey();
  await createWorkspaceStore({ dataDir }).setRoot(uk, root);
  const again = createWorkspaceStore({ dataDir });
  assert.equal(await again.getRoot(uk), root);
  await fs.rm(root, { recursive: true });
  assert.equal(await again.getRoot(uk), null);
  await again.clearRoot(uk);
});

// ---- commands -------------------------------------------------------------------------------------
test("buildCommand allows test/lint-style commands and rejects everything else", () => {
  const scripts = { test: "x", lint: "x", deploy: "x" };
  const ok = (t, o = {}) => buildCommand(t, { scripts, platform: "linux", ...o });
  assert.deepEqual(ok("npm test").args, ["test"]);
  assert.deepEqual(ok("npm run lint").args, ["run", "lint"]);
  assert.deepEqual(ok("node --test tests/a.test.mjs").args, ["--test", "tests/a.test.mjs"]);
  assert.equal(ok("npx eslint src").cmd, "npx");
  assert.ok(ok("npx eslint src").args.includes("--no-install"));
  assert.equal(ok("git diff").args.includes("--no-ext-diff"), true);
  assert.equal(ok("git status").cmd, "git");
  assert.equal(ok("pytest -q").cmd, "pytest");
  for (const bad of [
    "npm run deploy", "npm run build", "npm install", "npm publish", "npm run test; rm -rf /", "npm test && curl x", "npm test | sh", "npm test > out",
    "node script.js", "node -e 1", "node --test ../x", "node --test /etc/passwd", "node --test C:/x", "npx eslint --fix src", "npx prettier --write .", "npx create-react-app x", "npx -y eslint",
    "git push", "git commit -m x", "git checkout .", "git diff --output=x", "curl http://x", "rm -rf /", "bash -c ls", "python x.py", "echo $HOME", "npm test `id`", "", "   ",
  ]) assert.throws(() => ok(bad), WorkspaceError, bad);
  assert.throws(() => ok("npm run lint", { scripts: {} }), /no "lint" script/);
});

test("on Windows npm/npx go through cmd.exe without a shell string", () => {
  const b = buildCommand("npm test", { platform: "win32", scripts: {} });
  assert.match(b.cmd, /cmd/i);
  assert.deepEqual(b.args, ["/d", "/s", "/c", "npm", "test"]);
  assert.equal(buildCommand("node --test", { platform: "win32" }).cmd, "node");
});

test("cleanEnv drops API keys and tokens", () => {
  const e = cleanEnv({ PATH: "/bin", HOME: "/h", OPENROUTER_KEY: "sk-x", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s" });
  assert.equal(e.PATH, "/bin");
  assert.ok(!("OPENROUTER_KEY" in e) && !("GITHUB_TOKEN" in e) && !("AWS_SECRET_ACCESS_KEY" in e));
});

test("runCommand runs a real project test and reports pass, fail and timeout", { skip: process.platform === "win32" }, async () => {
  const root = await project({
    "package.json": JSON.stringify({ name: "t", scripts: { test: "node --test" } }),
    "pass.test.mjs": 'import {test} from "node:test"; test("ok", () => {});',
  });
  const run = (cmd, opts) => runCommand(root, buildCommand(cmd, { scripts: { test: "x" } }), opts);
  const ok = await run("node --test pass.test.mjs");
  assert.equal(ok.exit_code, 0);
  assert.match(ok.output, /pass 1/);
  await fs.writeFile(path.join(root, "fail.test.mjs"), 'import {test} from "node:test"; import assert from "node:assert"; test("bad", () => assert.equal(1, 2));');
  const bad = await run("node --test fail.test.mjs");
  assert.notEqual(bad.exit_code, 0);
  await fs.writeFile(path.join(root, "slow.test.mjs"), 'import {test} from "node:test"; test("slow", async () => { await new Promise(r => setTimeout(r, 10000)); });');
  const slow = await run("node --test slow.test.mjs", { timeoutMs: 600 });
  assert.equal(slow.timed_out, true);
  assert.ok(slow.duration_ms < 5000);
});

test("API keys from Nimbus's own environment don't reach the child process", { skip: process.platform === "win32" }, async () => {
  const root = await project({ "env.test.mjs": 'import {test} from "node:test"; import assert from "node:assert"; test("env", () => assert.equal(process.env.OPENROUTER_KEY, undefined));' });
  process.env.OPENROUTER_KEY = "sk-should-not-leak";
  try {
    const r = await runCommand(root, buildCommand("node --test env.test.mjs"));
    assert.equal(r.exit_code, 0, r.output);
  } finally {
    delete process.env.OPENROUTER_KEY;
  }
});

// ---- agent integration -------------------------------------------------------------------------------
function agentOpts(root, store, uk, script, mem) {
  const emit = collector();
  const events = emit.events;
  const llm = scriptedLlm(script);
  return {
    events, llm,
    opts: {
      messages: [{ role: "user", content: "fix the add function in my project" }],
      model: "m", userKey: uk, store: mem, llm, emit, supportsTools: true,
      tools: [...DEFAULT_TOOLS, ...WORKSPACE_TOOLS], workspace: store, workspaceInfo: { name: path.basename(root) },
      permissions: normalizePermissions({ always: ["workspace"] }),
    },
  };
}

test("agent: reads code, stages an edit, emits a proposal; the file stays untouched", async () => {
  const root = await project();
  const { store, uk } = await wsFor(root);
  const { events, opts } = agentOpts(root, store, uk, [
    { toolCalls: [{ name: "read_file", args: { path: "src/a.js" } }] },
    { toolCalls: [{ name: "propose_edit", args: { path: "src/a.js", old_string: "return x + y;", new_string: "return Number(x) + Number(y);", description: "coerce inputs" } }] },
    { content: "I've staged a fix. Press Apply to use it." },
  ], await freshStore());
  await runAgent(opts);
  const proposal = events.find((e) => e.type === "proposal");
  assert.ok(proposal, "a proposal event was emitted");
  assert.equal(proposal.proposal.path, "src/a.js");
  assert.match(await fs.readFile(path.join(root, "src/a.js"), "utf8"), /return x \+ y;/, "file untouched");
  assert.ok(events.some((e) => e.type === "done"));
});

test("agent: run_command asks for confirmation; disallowed commands are rejected before anyone is asked", async () => {
  const root = await project();
  const { store, uk } = await wsFor(root);
  const { events, opts } = agentOpts(root, store, uk, [
    { toolCalls: [{ name: "run_command", args: { command: "curl http://evil.example" } }] },
    { toolCalls: [{ name: "run_command", args: { command: "npm test" } }] },
    { content: "Waiting for you to confirm." },
  ], await freshStore());
  await runAgent(opts);
  const confirms = events.filter((e) => e.type === "confirm");
  assert.equal(confirms.length, 1, "only the allowed command asked for confirmation");
  assert.equal(confirms[0].args.command, "npm test");
  assert.ok(events.some((e) => e.type === "tool_end" && e.error === "rejected"));
});

test("agent: without the workspace the model is never offered file tools", async () => {
  const llm = scriptedLlm([{ content: "hi" }]);
  await runAgent({ messages: [{ role: "user", content: "hello" }], model: "m", userKey: userKey(), store: await freshStore(), llm, supportsTools: true });
  const names = (llm.requests[0].tools ?? []).map((t) => t.function.name);
  assert.ok(names.length > 0 && !names.some((n) => ["read_file", "propose_edit", "run_command"].includes(n)));
});

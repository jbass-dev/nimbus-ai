// Coding workspace core: everything Nimbus may do with files in a project
// folder the user opened. The rules, in one place:
//   • all paths resolve INSIDE the folder (symlinks and ".." can't escape it)
//   • secret-bearing files (.env, keys, .git, .ssh…) are never read or written
//     and secrets that appear in code are redacted before the model sees them
//   • the model never writes: edits are staged as diffs and applied only when
//     the user clicks Apply (see workspace-store.mjs)
//   • commands come from a fixed allowlist, run without a shell, with a
//     stripped environment (see buildCommand / runCommand)
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export const LIMITS = {
  readChars: 20_000,
  readBytes: 1_000_000,
  editBytes: 512 * 1024,
  maxFiles: 5000,
  treeEntries: 300,
  searchResults: 40,
  commandMs: 60_000,
  commandOutput: 16_000,
};

// ---- What is off limits ----------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".cache", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".nimbus-data", ".svn", ".hg"]);
const DENIED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker"]);
const DENIED_FILE_RES = [
  /^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|htpasswd|git-credentials)$/i, /^credentials?(\..+)?\.(json|ya?ml|xml)$/i, /^secrets?(\..+)?\.(json|ya?ml|toml)$/i,
  /^service[-_]?account.*\.json$/i, /^\.nimbus-.*$/i,
];
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

export function isDeniedName(name) {
  if (ENV_TEMPLATE.test(name)) return false;
  return DENIED_FILE_RES.some((re) => re.test(name));
}

/** Throws unless `rel` (posix, relative) may be read or written. */
export function checkAccess(rel, mode = "read") {
  const segs = rel.split("/").filter(Boolean);
  for (const s of segs.slice(0, -1)) {
    if (DENIED_DIRS.has(s)) throw new WorkspaceError("denied", `"${rel}" is inside ${s}, which Nimbus never touches.`);
  }
  const last = segs.at(-1) ?? "";
  if (DENIED_DIRS.has(last)) throw new WorkspaceError("denied", `"${rel}" is off limits.`);
  if (isDeniedName(last)) throw new WorkspaceError("denied", `"${rel}" looks like a secrets or credentials file, so Nimbus never reads or writes it.`);
  if (mode === "write" && segs.some((s) => SKIP_DIRS.has(s))) throw new WorkspaceError("denied", `"${rel}" is in a generated or dependency folder; edit the source instead.`);
}

// ---- Choosing the folder -----------------------------------------------------------
const POSIX_SYSTEM = ["/etc", "/usr", "/bin", "/sbin", "/sys", "/proc", "/dev", "/boot", "/lib", "/lib64", "/root", "/System", "/Library", "/Applications"];
const WIN_SYSTEM = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata", "c:\\users\\all users"];

/** Pure check on strings, so the Windows rules are testable anywhere. */
export function isForbiddenRoot(real, { home = os.homedir(), platform = process.platform } = {}) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const norm = (s) => { const n = p.resolve(s); return win ? n.toLowerCase() : n; };
  const r = norm(real);
  const h = norm(home);
  if (p.parse(r).root === r) return "a drive or filesystem root";
  if (r === h) return "your whole home folder (open a project inside it)";
  if (h.startsWith(r + p.sep)) return "a parent of your home folder";
  const sys = win ? WIN_SYSTEM : POSIX_SYSTEM; // the Windows list is lower-case, and r is lower-cased on win32
  if (sys.some((s) => r === s || r.startsWith(s + p.sep))) return "a system folder";
  for (const d of DENIED_DIRS) if (r === p.join(h, d) || r.startsWith(p.join(h, d) + p.sep)) return `your ${d} folder`;
  if (win && /\\appdata(\\|$)/.test(r.slice(h.length))) return "your AppData folder";
  return null;
}

/** Validates a folder the user typed or picked; returns its real path. */
export async function validateRoot(input, opts = {}) {
  const raw = String(input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new WorkspaceError("invalid", "Enter the full path to your project folder.");
  if (!path.isAbsolute(raw)) throw new WorkspaceError("invalid", "Use the full path, e.g. C:\\Dev\\my-app or /home/me/my-app.");
  let real;
  try {
    real = await fs.realpath(raw);
    if (!(await fs.stat(real)).isDirectory()) throw new Error("not a dir");
  } catch {
    throw new WorkspaceError("not_found", "That folder doesn't exist.");
  }
  const bad = isForbiddenRoot(real, opts);
  if (bad) throw new WorkspaceError("forbidden", `Nimbus won't open ${bad}. Choose a specific project folder.`);
  return real;
}

const posix = (p) => p.split(path.sep).join("/");
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Resolves a user/model-supplied path against the real root.
 * @returns {{abs: string, rel: string, exists: boolean}}
 */
export async function resolveInside(root, input, { mode = "read" } = {}) {
  const raw = String(input ?? ".").trim().replace(/\\/g, "/");
  if (raw.includes("\0")) throw new WorkspaceError("invalid", "Invalid path.");
  const target = path.resolve(root, raw === "" ? "." : raw);
  if (!inside(root, target)) throw new WorkspaceError("outside", `"${input}" is outside the project folder.`);
  let exists = true;
  let real;
  try {
    real = await fs.realpath(target);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    exists = false;
    // A path that doesn't exist yet (a new file): its parent must, and must be inside.
    try {
      real = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    } catch {
      throw new WorkspaceError("not_found", `The folder for "${input}" doesn't exist.`);
    }
  }
  if (!inside(root, real)) throw new WorkspaceError("outside", `"${input}" points outside the project folder.`);
  const rel = posix(path.relative(root, real));
  if (rel) checkAccess(rel, mode);
  return { abs: real, rel: rel || ".", exists };
}

// ---- Text helpers -------------------------------------------------------------------
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\b(?:sk|pk|rk)-(?:or-)?[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [redacted]"],
  [/\b([A-Za-z0-9_.-]*(?:secret|token|api[_-]?key|apikey|passw(?:or)?d|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["'])([^"'\s]{16,})\3/gi, "$1$2$3[redacted]$3"],
];

/** Hides credentials that appear inside files before the text goes to a model or the UI. */
export function redactSecrets(text) {
  let count = 0;
  let out = String(text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, (...m) => { count++; return rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""); });
  return { text: out, count };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function splitText(raw) {
  const bom = raw.startsWith("\uFEFF");
  const s = bom ? raw.slice(1) : raw;
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return { bom, eol: crlf > 0 && crlf >= lf ? "\r\n" : "\n", text: s.replace(/\r\n/g, "\n") };
}
export function joinText({ bom, eol, text }) {
  return (bom ? "\uFEFF" : "") + (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

/** Exact-text replace. Without replaceAll the match must be unique. Works on LF-normalised text. */
export function applyReplace(text, oldStr, newStr, { replaceAll = false } = {}) {
  const o = String(oldStr).replace(/\r\n/g, "\n");
  const n = String(newStr).replace(/\r\n/g, "\n");
  if (!o) throw new WorkspaceError("invalid", "old_string is empty.");
  if (o === n) throw new WorkspaceError("invalid", "old_string and new_string are identical, so nothing would change.");
  const count = text.split(o).length - 1;
  if (count === 0) throw new WorkspaceError("no_match", "old_string was not found. Re-read the file and copy the exact text, including indentation and line breaks.");
  if (count > 1 && !replaceAll) throw new WorkspaceError("ambiguous", `old_string matches ${count} places. Include more surrounding lines so it is unique, or set replace_all.`);
  return { text: text.split(o).join(n), count };
}

/** A compact unified-style diff for one changed region, with context. */
export function makeDiff(before, after, { context = 3, maxLines = 160 } = {}) {
  const a = before == null ? [] : before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);
  const pre = a.slice(Math.max(0, p - context), p);
  const post = a.slice(a.length - s, Math.min(a.length, a.length - s + context));
  const header = `@@ -${before == null ? 0 : p - pre.length + 1},${pre.length + removed.length + post.length} +${p - pre.length + 1},${pre.length + added.length + post.length} @@`;
  let lines = [...pre.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), ...post.map((l) => ` ${l}`)];
  if (lines.length > maxLines) {
    const keep = Math.floor(maxLines / 2);
    lines = [...lines.slice(0, keep), `… ${lines.length - maxLines} more lines …`, ...lines.slice(-keep)];
  }
  return { diff: [header, ...lines].join("\n"), added: added.length, removed: removed.length };
}

// ---- .gitignore-aware walking ---------------------------------------------------------
function globToRegexSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** (relPosix, isDir) => boolean for the lines of a .gitignore (negations unsupported). */
export function compileIgnore(text) {
  const rules = [];
  for (let line of String(text ?? "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\//, "");
    const src = globToRegexSource(line);
    rules.push({ re: new RegExp(anchored ? `^${src}(/.*)?$` : `(^|/)${src}(/.*)?$`), dirOnly, anchored });
  }
  return (rel, isDir) => rules.some(({ re, dirOnly }) => {
    const m = re.exec(rel);
    if (!m) return false;
    const suffix = m[m.length - 1];
    return !(dirOnly && !suffix && !isDir);
  });
}

async function loadIgnore(root) {
  try {
    return compileIgnore(await fs.readFile(path.join(root, ".gitignore"), "utf8"));
  } catch {
    return () => false;
  }
}

/** Walks the project (not into skipped dirs or symlinks). visit(rel, dirent, abs) may return false to stop. */
async function walk(root, { start = ".", maxDepth = 12, maxFiles = LIMITS.maxFiles, includeDirs = false }, visit) {
  const ignored = await loadIgnore(root);
  let seen = 0;
  const queue = [{ abs: path.resolve(root, start), depth: 0 }];
  while (queue.length) {
    const { abs, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(abs, e.name);
      const rel = posix(path.relative(root, full));
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || DENIED_DIRS.has(e.name) || ignored(rel, true)) continue;
        if (includeDirs && (await visit(rel, e, full)) === false) return;
        if (depth + 1 < maxDepth) queue.push({ abs: full, depth: depth + 1 });
      } else if (e.isFile()) {
        if (isDeniedName(e.name) || ignored(rel, false)) continue;
        if (++seen > maxFiles) return;
        if ((await visit(rel, e, full)) === false) return;
      }
    }
  }
}

const fmtSize = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

/** Directory listing as indented text. */
export async function listTree(root, { dir = ".", depth = 2, maxEntries = LIMITS.treeEntries } = {}) {
  const base = await resolveInside(root, dir);
  const lines = [];
  let truncated = false;
  await walk(root, { start: base.rel, maxDepth: Math.min(5, Math.max(1, depth)), includeDirs: true }, async (rel, e, full) => {
    if (lines.length >= maxEntries) { truncated = true; return false; }
    const level = rel.slice(base.rel === "." ? 0 : base.rel.length + 1).split("/").length - 1;
    const size = e.isFile() ? ` (${fmtSize((await fs.stat(full)).size)})` : "/";
    lines.push(`${"  ".repeat(level)}${e.name}${size}`);
    return true;
  });
  return { dir: base.rel, listing: lines.join("\n"), entries: lines.length, truncated };
}

/** Text search across project files. Literal by default; regex when asked. */
export async function searchCode(root, query, { regex = false, include = "", maxResults = LIMITS.searchResults, caseSensitive = false } = {}) {
  const q = String(query ?? "");
  if (q.length < 2) throw new WorkspaceError("invalid", "Search text is too short.");
  let re;
  try {
    re = new RegExp(regex ? q.slice(0, 200) : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch {
    throw new WorkspaceError("invalid", "That regular expression is invalid.");
  }
  const globs = String(include).split(",").map((g) => g.trim()).filter(Boolean).map((g) => new RegExp(`^${globToRegexSource(g)}$`));
  const results = [];
  let filesSearched = 0;
  const t0 = Date.now();
  await walk(root, {}, async (rel, e, full) => {
    if (Date.now() - t0 > 6000 || results.length >= maxResults) return false;
    if (globs.length && !globs.some((g) => g.test(e.name) || g.test(rel))) return true;
    const stat = await fs.stat(full);
    if (stat.size > LIMITS.readBytes) return true;
    const buf = await fs.readFile(full);
    if (isBinary(buf)) return true;
    filesSearched++;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (re.test(lines[i].slice(0, 500))) results.push({ path: rel, line: i + 1, text: redactSecrets(lines[i].trim().slice(0, 200)).text });
    }
    return true;
  });
  return { query: q, results, files_searched: filesSearched, truncated: results.length >= maxResults };
}

/** Reads a file with line numbers. Secrets in the text are redacted. */
export async function readFile(root, input, { start = 1, end = null, maxChars = LIMITS.readChars } = {}) {
  const f = await resolveInside(root, input);
  if (!f.exists) throw new WorkspaceError("not_found", `"${input}" doesn't exist.`);
  const stat = await fs.stat(f.abs);
  if (stat.isDirectory()) throw new WorkspaceError("invalid", `"${input}" is a folder. Use list_files.`);
  if (stat.size > LIMITS.readBytes) throw new WorkspaceError("too_big", `"${input}" is ${fmtSize(stat.size)}, too large to read whole. Use search_code to find the part you need.`);
  const buf = await fs.readFile(f.abs);
  if (isBinary(buf)) throw new WorkspaceError("binary", `"${input}" is a binary file.`);
  const { text } = splitText(buf.toString("utf8"));
  const { text: safe, count } = redactSecrets(text);
  const all = safe.split("\n");
  const total = text.endsWith("\n") ? all.length - 1 : all.length;
  const from = Math.max(1, Number(start) || 1);
  const to = Math.min(total, end ? Number(end) : total);
  let body = "";
  let last = from - 1;
  for (let i = from; i <= to; i++) {
    const line = `${String(i).padStart(5)}| ${all[i - 1]}\n`;
    if (body.length + line.length > maxChars) break;
    body += line;
    last = i;
  }
  return { path: f.rel, total_lines: total, start_line: from, end_line: last, truncated: last < to, redacted_secrets: count || undefined, content: body };
}

/** What kind of project this is, how to test it, and its shape. */
export async function overview(root) {
  const read = async (name) => { try { return await fs.readFile(path.join(root, name), "utf8"); } catch { return null; } };
  const exists = async (name) => { try { await fs.access(path.join(root, name)); return true; } catch { return false; } };
  const out = { name: path.basename(root), stacks: [], scripts: {}, dependencies: [], tests: null, entry_points: [], files_by_extension: {}, readme: null };

  const pkgRaw = await read("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      out.stacks.push("node");
      out.package = { name: pkg.name, version: pkg.version, type: pkg.type ?? "commonjs", main: pkg.main };
      out.scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).slice(0, 25).map(([k, v]) => [k, String(v).slice(0, 120)]));
      out.dependencies = Object.keys(deps).slice(0, 50);
      const has = (n) => n in deps;
      for (const [dep, label] of [["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["express", "Express"], ["electron", "Electron"], ["vite", "Vite"], ["tailwindcss", "Tailwind"], ["typescript", "TypeScript"], ["eslint", "ESLint"], ["vitest", "Vitest"], ["jest", "Jest"]]) if (has(dep)) out.stacks.push(label);
      if (pkg.scripts?.test) out.tests = "npm test";
    } catch {
      out.stacks.push("node (package.json is not valid JSON)");
    }
  }
  if (await exists("pyproject.toml") || await exists("requirements.txt")) { out.stacks.push("python"); out.tests ??= "pytest"; }
  if (await exists("go.mod")) { out.stacks.push("go"); out.tests ??= "go test ./..."; }
  if (await exists("Cargo.toml")) { out.stacks.push("rust"); out.tests ??= "cargo test"; }
  if (await exists("tsconfig.json") && !out.stacks.includes("TypeScript")) out.stacks.push("TypeScript");

  for (const c of ["app", "src", "pages", "lib", "server", "index.js", "index.ts", "main.js", "main.ts", "main.py", "app.py", "main.go", "electron.js", "server.js"]) if (await exists(c)) out.entry_points.push(c);
  const readme = await read("README.md");
  if (readme) out.readme = redactSecrets(readme.split("\n").slice(0, 30).join("\n")).text.slice(0, 1800);

  let count = 0;
  await walk(root, {}, (rel) => {
    const ext = path.extname(rel).toLowerCase() || "(none)";
    out.files_by_extension[ext] = (out.files_by_extension[ext] ?? 0) + 1;
    return ++count < LIMITS.maxFiles;
  });
  out.files_by_extension = Object.fromEntries(Object.entries(out.files_by_extension).sort((a, b) => b[1] - a[1]).slice(0, 12));
  out.file_count = count;
  out.tree = (await listTree(root, { depth: 2, maxEntries: 120 })).listing;
  return out;
}

// ---- Running commands --------------------------------------------------------------------
const TOKEN = /^[A-Za-z0-9_.:/@=+,\\-]+$/;
const SAFE_SCRIPT = /^(test|test:[\w:-]+|lint|lint:[\w:-]+|typecheck|check|build|tsc|format:check)$/;
const isPathArg = (t) => !t.startsWith("-");

/**
 * Turns the allowlisted command text into { cmd, args, display } or throws.
 * No shell is involved, so metacharacters aren't "escaped", they're rejected.
 * @param {string} text
 * @param {{scripts?: object, platform?: string}} ctx  scripts: package.json "scripts"
 */
export function buildCommand(text, { scripts = {}, platform = process.platform } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new WorkspaceError("invalid", "No command given.");
  const tokens = raw.split(/\s+/);
  for (const t of tokens) if (!TOKEN.test(t)) throw new WorkspaceError("not_allowed", `"${t}" contains characters that aren't allowed. Commands run without a shell: no pipes, quotes, redirects or variables.`);
  for (const t of tokens.slice(1)) if (isPathArg(t) && (/(^|[\\/])\.\.([\\/]|$)/.test(t) || path.isAbsolute(t) || /^[A-Za-z]:/.test(t))) throw new WorkspaceError("not_allowed", `"${t}" points outside the project. Use paths inside it.`);
  const [bin, ...rest] = tokens;
  const display = tokens.join(" ");
  const done = (cmd, args) => ({ cmd, args, display });
  const npmLike = (tool, args) => (platform === "win32" ? done(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", tool, ...args]) : done(tool, args));
  const no = (why) => { throw new WorkspaceError("not_allowed", `Not allowed: ${why}. Allowed: npm test, npm run <test|lint|build|typecheck|check>, npx eslint|tsc|prettier --check|vitest run|jest, node --test, pytest, go test, cargo test, git status|diff|log.`); };

  if (bin === "npm") {
    if (rest[0] === "test" || rest[0] === "t") return npmLike("npm", ["test", ...rest.slice(1)]);
    if (rest[0] === "run" || rest[0] === "run-script") {
      const script = rest[1];
      if (!script || !SAFE_SCRIPT.test(script)) no(`"npm run ${script ?? ""}" (only test, lint, build, typecheck and check style scripts)`);
      if (!(script in scripts)) throw new WorkspaceError("not_allowed", `package.json has no "${script}" script.`);
      return npmLike("npm", ["run", script, ...rest.slice(2)]);
    }
    no("npm subcommand");
  }
  if (bin === "npx") {
    const tool = rest[0];
    const args = rest.slice(1);
    if (args.some((a) => /^--(fix|write|install|yes|y)$/.test(a) || a === "-y" || a === "-w")) no("flags that modify files or install packages");
    const ok = tool === "eslint" || tool === "tsc" || (tool === "prettier" && args.includes("--check")) || (tool === "vitest" && args[0] === "run") || tool === "jest";
    if (!ok) no(`"npx ${tool ?? ""}"`);
    return npmLike("npx", ["--no-install", tool, ...args]);
  }
  if (bin === "node") {
    if (rest[0] !== "--test") no("node (only node --test)");
    return done("node", rest);
  }
  if (bin === "pytest") return done("pytest", rest);
  if (bin === "python" || bin === "python3" || bin === "py") {
    if (rest[0] === "-m" && rest[1] === "pytest") return done(bin, rest);
    no("python (only python -m pytest)");
  }
  if (bin === "go" && rest[0] === "test") return done("go", rest);
  if (bin === "cargo" && rest[0] === "test") return done("cargo", rest);
  if (bin === "git") {
    const sub = rest[0];
    const args = rest.slice(1);
    if (!["status", "diff", "log"].includes(sub)) no(`"git ${sub ?? ""}" (read-only: status, diff, log)`);
    if (args.some((a) => /^--(output|ext-diff|exec-path|upload-pack|receive-pack)/.test(a) || a === "-o")) no("that git option");
    const extra = sub === "diff" ? ["--no-ext-diff"] : sub === "log" ? ["--no-textconv"] : [];
    // fsmonitor/pager settings in a repo's config can run programs; neutralise them.
    return done("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "--no-pager", sub, ...extra, ...args]);
  }
  return no(`"${bin}"`);
}

const ENV_KEEP = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "NUMBER_OF_PROCESSORS", "ProgramFiles", "ProgramFiles(x86)"];

/** A minimal environment: no API keys or tokens from Nimbus's own process reach project code. */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const k of ENV_KEEP) if (env[k] != null) out[k] = env[k];
  return { ...out, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "test" };
}

/** Runs a built command in the project folder; kills it on timeout. Output is capped and redacted. */
export function runCommand(root, built, { timeoutMs = LIMITS.commandMs, signal, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(built.cmd, built.args, { cwd: root, env: cleanEnv(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32" });
    } catch (err) {
      return reject(new WorkspaceError("spawn_failed", `Could not start the command: ${err.message}`));
    }
    let out = "";
    let dropped = 0;
    const cap = LIMITS.commandOutput;
    const take = (d) => {
      out += d.toString("utf8");
      if (out.length > cap * 2) { dropped += out.length - cap * 2; out = out.slice(-cap * 2); }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const kill = () => {
      try {
        if (platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new WorkspaceError("spawn_failed", err.code === "ENOENT" ? `"${built.display.split(" ")[0]}" isn't installed or isn't on PATH.` : `Could not run: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let text = redactSecrets(out).text;
      // Failures are usually at the end: keep the head short and the tail long.
      if (text.length > cap) text = `${text.slice(0, cap * 0.25)}\n… output trimmed …\n${text.slice(-cap * 0.75)}`;
      resolve({ command: built.display, exit_code: code, signal: sig ?? undefined, timed_out: timedOut || undefined, duration_ms: Date.now() - t0, output: text, ...(dropped ? { note: "Early output was dropped." } : {}) });
    });
  });
}

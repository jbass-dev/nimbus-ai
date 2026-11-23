// Per-user workspace state: which folder is open, edits waiting for approval,
// and the log of what was changed (with enough to undo it).
//
// The model can only STAGE an edit (stageEdit). Nothing is written until the
// user presses Apply in the UI, which calls apply() here. At that moment the
// server re-checks the file hasn't changed since the diff was shown, so what
// lands on disk is exactly what the user approved.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  WorkspaceError, LIMITS, applyReplace, joinText, makeDiff, redactSecrets, resolveInside, splitText, validateRoot,
} from "./workspace.mjs";
import { nowIso } from "./util.mjs";

const USER_KEY_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_TTL_MS = 30 * 60_000;
const MAX_PROPOSALS = 20;
const MAX_CHANGES = 50;
const MAX_UNDO_BYTES = 200 * 1024;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function createWorkspaceStore({ dataDir, now = () => Date.now(), validate = validateRoot } = {}) {
  if (!dataDir) throw new Error("createWorkspaceStore requires dataDir");
  const dir = path.join(dataDir, "workspace");
  const proposals = new Map(); // userKey -> Map(id -> proposal)
  const queues = new Map();

  const fileFor = (userKey) => {
    if (!USER_KEY_RE.test(String(userKey))) throw new WorkspaceError("bad_user", "Invalid user identity");
    return path.join(dir, `${userKey}.json`);
  };
  async function load(userKey) {
    try {
      const doc = JSON.parse(await fs.readFile(fileFor(userKey), "utf8"));
      return { root: typeof doc.root === "string" ? doc.root : null, changes: Array.isArray(doc.changes) ? doc.changes : [] };
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) return { root: null, changes: [] };
      throw err;
    }
  }
  function mutate(userKey, fn) {
    const prev = queues.get(userKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const doc = await load(userKey);
      const result = await fn(doc);
      await fs.mkdir(dir, { recursive: true });
      const file = fileFor(userKey);
      const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
      return result;
    });
    queues.set(userKey, next.catch(() => {}));
    return next;
  }

  const userProposals = (userKey) => {
    let m = proposals.get(userKey);
    if (!m) proposals.set(userKey, (m = new Map()));
    for (const [id, p] of m) if (now() - p.createdAt > PROPOSAL_TTL_MS) m.delete(id);
    return m;
  };
  const proposalView = (p) => ({ id: p.id, path: p.path, action: p.action, summary: p.summary, diff: p.diff, added: p.added, removed: p.removed, createdAt: new Date(p.createdAt).toISOString() });
  const changeView = (c) => ({ id: c.id, at: c.at, path: c.path, action: c.action, added: c.added, removed: c.removed, summary: c.summary, revertible: c.revertible, reverted: c.reverted || undefined });

  /** The open folder, re-validated every time (it may have been moved or deleted). */
  async function getRoot(userKey) {
    const { root } = await load(userKey);
    if (!root) return null;
    try {
      return await validate(root);
    } catch {
      return null;
    }
  }

  return {
    getRoot,

    async requireRoot(userKey) {
      const root = await getRoot(userKey);
      if (!root) throw new WorkspaceError("no_workspace", "No project folder is open. Ask the user to open one with the 📁 Project button.");
      return root;
    },

    async state(userKey) {
      const root = await getRoot(userKey);
      const { changes } = await load(userKey);
      return {
        root,
        name: root ? path.basename(root) : null,
        proposals: root ? [...userProposals(userKey).values()].map(proposalView) : [],
        changes: changes.map(changeView),
      };
    },

    async setRoot(userKey, input) {
      const root = await validate(input);
      proposals.delete(userKey);
      await mutate(userKey, (doc) => { doc.root = root; });
      return { root, name: path.basename(root) };
    },

    async clearRoot(userKey) {
      proposals.delete(userKey);
      await mutate(userKey, (doc) => { doc.root = null; });
      return { root: null };
    },

    /**
     * Prepares an edit and shows what it would do. Writes NOTHING.
     * mode "replace": swap exact text in an existing file. mode "create": a new file.
     */
    async stageEdit(userKey, { path: input, mode = "replace", old_string, new_string, replace_all = false, description = "" }) {
      const root = await this.requireRoot(userKey);
      const f = await resolveInside(root, input, { mode: "write" });
      if (f.rel === ".") throw new WorkspaceError("invalid", "Give a file path.");
      const { text: cleaned, count } = redactSecrets(String(new_string ?? ""));
      if (count) throw new WorkspaceError("secret", "That new text contains something that looks like a secret or API key. Use an environment variable instead.");
      void cleaned;

      let before = null;
      let after;
      let baseHash = null;
      let parts;
      if (mode === "create") {
        if (f.exists) throw new WorkspaceError("exists", `"${f.rel}" already exists. Use mode replace to change it.`);
        parts = { bom: false, eol: "\n", text: String(new_string ?? "") };
        after = parts.text;
      } else {
        if (!f.exists) throw new WorkspaceError("not_found", `"${f.rel}" doesn't exist. Use mode create for a new file.`);
        const stat = await fs.stat(f.abs);
        if (!stat.isFile()) throw new WorkspaceError("invalid", `"${f.rel}" isn't a file.`);
        if (stat.size > LIMITS.editBytes) throw new WorkspaceError("too_big", `"${f.rel}" is too large to edit through Nimbus.`);
        const raw = await fs.readFile(f.abs, "utf8");
        if (raw.includes("\0")) throw new WorkspaceError("binary", `"${f.rel}" is a binary file.`);
        baseHash = sha(raw);
        parts = splitText(raw);
        before = parts.text;
        after = applyReplace(before, old_string, new_string, { replaceAll: replace_all }).text;
      }
      if (Buffer.byteLength(after) > LIMITS.editBytes) throw new WorkspaceError("too_big", "The result would be too large.");

      const d = makeDiff(before, after);
      const proposal = {
        id: `prop_${crypto.randomBytes(5).toString("hex")}`,
        userKey, root, path: f.rel, action: mode === "create" ? "create" : "edit",
        summary: String(description).slice(0, 200) || (mode === "create" ? `Create ${f.rel}` : `Edit ${f.rel}`),
        diff: d.diff, added: d.added, removed: d.removed,
        content: joinText({ ...parts, text: after }), baseHash, createdAt: now(),
      };
      const mine = userProposals(userKey);
      mine.set(proposal.id, proposal);
      while (mine.size > MAX_PROPOSALS) mine.delete(mine.keys().next().value);
      return proposalView(proposal);
    },

    /** The user pressed Apply. Re-checks the file, then writes atomically and logs the change. */
    async apply(userKey, id) {
      const p = userProposals(userKey).get(id);
      if (!p) throw new WorkspaceError("expired", "That edit is no longer available (it expired, was discarded, or Nimbus restarted). Ask for it again.");
      const root = await this.requireRoot(userKey);
      if (root !== p.root) throw new WorkspaceError("changed_root", "The project folder changed since this edit was prepared.");
      const f = await resolveInside(root, p.path, { mode: "write" });
      let beforeRaw = null;
      if (p.action === "create") {
        if (f.exists) throw new WorkspaceError("stale", `"${p.path}" now exists, so it wasn't overwritten.`);
      } else {
        if (!f.exists) throw new WorkspaceError("stale", `"${p.path}" no longer exists.`);
        beforeRaw = await fs.readFile(f.abs, "utf8");
        if (sha(beforeRaw) !== p.baseHash) throw new WorkspaceError("stale", `"${p.path}" changed since this edit was prepared, so nothing was written. Ask Nimbus to prepare it again.`);
      }
      let mode;
      if (f.exists) mode = (await fs.stat(f.abs)).mode & 0o777;
      const tmp = `${f.abs}.nimbus-${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, p.content, mode ? { encoding: "utf8", mode } : "utf8");
      await fs.rename(tmp, f.abs);
      userProposals(userKey).delete(id);

      const change = {
        id: `chg_${crypto.randomBytes(5).toString("hex")}`, at: nowIso(now()), path: p.path, action: p.action,
        added: p.added, removed: p.removed, summary: p.summary,
        afterHash: sha(p.content),
        before: beforeRaw != null && Buffer.byteLength(beforeRaw) <= MAX_UNDO_BYTES ? beforeRaw : null,
        revertible: p.action === "create" || (beforeRaw != null && Buffer.byteLength(beforeRaw) <= MAX_UNDO_BYTES),
      };
      await mutate(userKey, (doc) => { doc.changes = [change, ...doc.changes].slice(0, MAX_CHANGES); });
      return changeView(change);
    },

    discard(userKey, id) {
      return { discarded: userProposals(userKey).delete(id) };
    },

    /** Undo an applied change, but only if the file is still exactly as that change left it. */
    async revert(userKey, id) {
      const root = await this.requireRoot(userKey);
      const { changes } = await load(userKey);
      const c = changes.find((x) => x.id === id);
      if (!c) throw new WorkspaceError("not_found", "No such change.");
      if (c.reverted) throw new WorkspaceError("invalid", "That change was already undone.");
      if (!c.revertible) throw new WorkspaceError("invalid", "That change is too large to undo from here. Use git instead.");
      const f = await resolveInside(root, c.path, { mode: "write" });
      if (!f.exists) throw new WorkspaceError("stale", `"${c.path}" no longer exists, so there is nothing to undo.`);
      const current = await fs.readFile(f.abs, "utf8");
      if (sha(current) !== c.afterHash) throw new WorkspaceError("stale", `"${c.path}" was changed again after this edit, so undoing it could lose that work. Nothing was changed.`);
      if (c.action === "create") await fs.rm(f.abs);
      else {
        const tmp = `${f.abs}.nimbus-${crypto.randomBytes(4).toString("hex")}.tmp`;
        await fs.writeFile(tmp, c.before, "utf8");
        await fs.rename(tmp, f.abs);
      }
      await mutate(userKey, (doc) => { const m = doc.changes.find((x) => x.id === id); if (m) { m.reverted = true; m.before = null; } });
      return { reverted: c.path };
    },

    async listChanges(userKey) {
      return (await load(userKey)).changes.map(changeView);
    },
  };
}

// Coding workspace tools. Registered only when a project folder is open.
//
// There is deliberately NO tool that writes a file. propose_edit stages a
// diff and shows it to the user; only their Apply click changes anything
// (workspace-store.mjs). run_command is allowlisted and needs the user's
// confirmation every time.
import fs from "node:fs/promises";
import path from "node:path";
import {
  LIMITS, WorkspaceError, buildCommand, listTree, overview, readFile, runCommand, searchCode,
} from "../workspace.mjs";

const store = (ctx) => {
  if (!ctx.workspace) throw new WorkspaceError("no_workspace", "The coding workspace isn't available.");
  return ctx.workspace;
};
const rootOf = (ctx) => store(ctx).requireRoot(ctx.userKey);

const common = { untrustedOutput: true, permissionGroup: "workspace" };

export const workspaceOverviewTool = {
  name: "workspace_overview",
  description: "Get the shape of the user's open project: stacks and frameworks, package scripts, dependencies, how tests run, entry points, file counts and a two-level tree. Call this first for any question about \"my project\" before reading individual files.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  ...common,
  maxResultChars: 14_000,
  describePermission: () => "Look through your open project folder",
  async run(_args, ctx) {
    return overview(await rootOf(ctx));
  },
  summarize: (r) => `${r.name}: ${r.stacks.join(", ") || "project"} (${r.file_count} files)`,
};

export const listFilesTool = {
  name: "list_files",
  description: "List files and folders in the project, ignoring node_modules, build output and .gitignore'd paths. Use to explore a folder. File sizes are shown.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 300, description: "Folder relative to the project root. Default: the root" },
      depth: { type: "integer", minimum: 1, maximum: 5, description: "How many levels to show. Default 2" },
    },
    additionalProperties: false,
  },
  ...common,
  describePermission: (a) => `List files in ${a.path || "your project folder"}`,
  async run(args, ctx) {
    return listTree(await rootOf(ctx), { dir: args.path || ".", depth: args.depth ?? 2 });
  },
  summarize: (r) => `${r.entries} entries in ${r.dir}${r.truncated ? " (truncated)" : ""}`,
};

export const searchCodeTool = {
  name: "search_code",
  description: "Search the project's text files for a string (or a regular expression). Returns file, line number and the matching line. Use to find where something is defined or used before reading files.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, maxLength: 200 },
      regex: { type: "boolean", description: "Treat query as a regular expression. Default false" },
      include: { type: "string", maxLength: 100, description: "Only files matching these globs, comma-separated, e.g. \"*.js,*.jsx\"" },
      case_sensitive: { type: "boolean" },
      max_results: { type: "integer", minimum: 1, maximum: 100, description: "Default 40" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  ...common,
  describePermission: (a) => `Search your project for “${a.query}”`,
  async run(args, ctx) {
    return searchCode(await rootOf(ctx), args.query, { regex: args.regex, include: args.include, caseSensitive: args.case_sensitive, maxResults: args.max_results });
  },
  summarize: (r) => `${r.results.length} match${r.results.length === 1 ? "" : "es"} in ${r.files_searched} files`,
};

export const readFileTool = {
  name: "read_file",
  description: "Read a file from the project with line numbers. Use start_line/end_line for a section of a big file. Secrets in the text are redacted, and files like .env are never readable. When you later propose an edit, copy the text WITHOUT the line-number prefix.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 300, description: "File path relative to the project root" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  ...common,
  maxResultChars: 24_000,
  describePermission: (a) => `Read ${a.path}`,
  async run(args, ctx) {
    return readFile(await rootOf(ctx), args.path, { start: args.start_line, end: args.end_line });
  },
  summarize: (r) => `read ${r.path} (lines ${r.start_line}–${r.end_line} of ${r.total_lines})`,
};

export const proposeEditTool = {
  name: "propose_edit",
  description: "Stage a change to a file. This does NOT change anything: the user sees a diff and must press Apply. mode \"replace\" swaps old_string for new_string in an existing file (old_string must appear exactly once, copied exactly from read_file output without line numbers; include enough surrounding lines to be unique). mode \"create\" makes a new file whose full text is new_string. Make one logical change per call and say what it does in description.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 300 },
      mode: { type: "string", enum: ["replace", "create"], description: "Default replace" },
      old_string: { type: "string", maxLength: 30000, description: "Exact existing text (replace mode)" },
      new_string: { type: "string", maxLength: 60000, description: "Replacement text, or the whole file in create mode" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
      description: { type: "string", maxLength: 200, description: "One line: what this change does and why" },
    },
    required: ["path", "new_string"],
    additionalProperties: false,
  },
  ...common,
  describePermission: (a) => `Prepare an edit to ${a.path} (nothing changes until you press Apply)`,
  async run(args, ctx) {
    const p = await store(ctx).stageEdit(ctx.userKey, { ...args, mode: args.mode ?? "replace" });
    ctx.emit?.({ type: "proposal", proposal: p });
    return {
      proposal_id: p.id,
      status: "staged, NOT applied",
      path: p.path,
      lines_added: p.added,
      lines_removed: p.removed,
      next_step: "A diff card with an Apply button is now shown to the user. The file is unchanged until they press it. Say what you staged and why, and do not claim it was changed. If they say they applied it, offer to run the project's tests.",
    };
  },
  summarize: (r) => `staged ${r.path} (+${r.lines_added} −${r.lines_removed}), awaiting Apply`,
};

export const runCommandTool = {
  name: "run_command",
  description: "Run a check in the project folder and get its real output: tests (npm test, npm run test|lint|build|typecheck, node --test, pytest, go test, cargo test), linters/type checks (npx eslint, npx tsc, npx prettier --check), or read-only git (git status, git diff, git log). No shell, pipes or other commands. The user confirms every run.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", minLength: 3, maxLength: 200, description: "e.g. \"npm test\" or \"npx eslint src\"" } },
    required: ["command"],
    additionalProperties: false,
  },
  untrustedOutput: true,
  consequential: true,
  longRunning: true,
  timeoutMs: LIMITS.commandMs + 5000,
  maxResultChars: 20_000,
  confirmationPrompt: (a) => `Run “${a.command}” in your project folder? It runs your project's own code.`,
  /** Rejects disallowed commands before the user is ever asked to confirm one. */
  async precheck(args, ctx) {
    const root = await rootOf(ctx);
    buildCommand(args.command, { scripts: await scriptsOf(root) });
  },
  async run(args, ctx) {
    const root = await rootOf(ctx);
    const built = buildCommand(args.command, { scripts: await scriptsOf(root) });
    return runCommand(root, built, { timeoutMs: LIMITS.commandMs, signal: ctx.signal });
  },
  summarize: (r) => `${r.command}: ${r.timed_out ? "timed out" : `exit ${r.exit_code}`}`,
};

async function scriptsOf(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

export const listChangesTool = {
  name: "list_changes",
  description: "List the edits the user has applied through Nimbus in this project (newest first), including undone ones.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  ...common,
  describePermission: () => "See which edits have been applied in your project",
  async run(_args, ctx) {
    return { changes: await store(ctx).listChanges(ctx.userKey) };
  },
  summarize: (r) => `${r.changes.length} change${r.changes.length === 1 ? "" : "s"}`,
};

export const WORKSPACE_TOOLS = [workspaceOverviewTool, listFilesTool, searchCodeTool, readFileTool, proposeEditTool, runCommandTool, listChangesTool];

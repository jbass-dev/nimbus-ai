// Tiny zero-dependency syntax highlighter for chat code blocks.
// Returns [{ type, text }] tokens; the renderer maps types to colors.
// It's lexical (keywords, strings, comments, numbers), not a full parser:
// good enough to make code readable, never throws on odd input.

const JS_KW = "await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public return set static super switch this throw true try type typeof undefined var void while with yield async as satisfies readonly keyof declare namespace abstract";
const PY_KW = "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self match case print";
const SH_KW = "if then else elif fi for while do done case esac in function return export local echo cd ls rm mv cp mkdir npm npx node git sudo cat grep curl set unset source exit";
const SQL_KW = "select from where and or not insert into values update set delete create table drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct null is in like between union all index view returning default";
const CSS_KW = "important media import keyframes from to root hover focus active before after";
const C_KW = "auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected new delete this true false null namespace using bool string var final fn let mut impl pub use mod match struct trait package func go defer chan map range type interface select";

const LANGS = {
  js: { kw: JS_KW, line: "//", block: ["/*", "*/"], str: "'\"`" },
  py: { kw: PY_KW, line: "#", block: null, str: "'\"", ci: false },
  sh: { kw: SH_KW, line: "#", block: null, str: "'\"" },
  sql: { kw: SQL_KW, line: "--", block: ["/*", "*/"], str: "'\"", ci: true },
  css: { kw: CSS_KW, line: null, block: ["/*", "*/"], str: "'\"" },
  c: { kw: C_KW, line: "//", block: ["/*", "*/"], str: "'\"`" },
  json: { kw: "true false null", line: null, block: null, str: "\"" },
};

const ALIASES = {
  js: "js", javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", node: "js",
  python: "py", py: "py",
  bash: "sh", shell: "sh", sh: "sh", zsh: "sh", powershell: "sh", ps1: "sh", ps: "sh", console: "sh", terminal: "sh",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json",
  c: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", java: "c", go: "c", golang: "c", rust: "c", rs: "c", kotlin: "c", kt: "c", swift: "c", php: "c", dart: "c",
};

export function resolveLang(lang) {
  const l = String(lang ?? "").trim().toLowerCase();
  if (l === "html" || l === "xml" || l === "svg" || l === "vue") return "html";
  return ALIASES[l] ?? null;
}

function highlightHtml(code) {
  const out = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w:-]*)|([a-zA-Z_:][\w:.-]*)(=)("[^"]*"|'[^']*')|(\/?>)/g;
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push({ type: "plain", text: code.slice(last, m.index) });
    if (m[1]) out.push({ type: "comment", text: m[1] });
    else if (m[3]) out.push({ type: "punct", text: m[2] }, { type: "tag", text: m[3] });
    else if (m[4]) out.push({ type: "attr", text: m[4] }, { type: "punct", text: m[5] }, { type: "string", text: m[6] });
    else out.push({ type: "punct", text: m[7] });
    last = re.lastIndex;
  }
  if (last < code.length) out.push({ type: "plain", text: code.slice(last) });
  return out;
}

export function highlight(code, lang) {
  const text = String(code ?? "");
  const id = resolveLang(lang);
  if (id === "html") return highlightHtml(text);
  const spec = LANGS[id];
  if (!spec || text.length > 60_000) return [{ type: "plain", text }];

  const kw = new Set(spec.kw.split(" ").map((k) => (spec.ci ? k.toLowerCase() : k)));
  const out = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "plain", text: plain });
    plain = "";
  };
  const push = (type, t) => {
    flush();
    out.push({ type, text: t });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.startsWith.bind(text);

    if (spec.line && rest(spec.line, i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (spec.block && rest(spec.block[0], i)) {
      const end = text.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end === -1 ? text.length : end + spec.block[1].length;
      push("comment", text.slice(i, stop));
      i = stop;
      continue;
    }
    if (spec.str.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n" && ch !== "`") break;
        j++;
      }
      push(id === "json" && /^\s*:/.test(text.slice(j + 1, j + 3)) ? "attr" : "string", text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[\w$]/.test(text[i - 1] ?? "")) {
      const m = /^(0x[\da-f]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)[a-z%]*/i.exec(text.slice(i));
      push("number", m[0]);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[@$]?[\w$-]*/.exec(text.slice(i));
      let word = m[0];
      if (id !== "css" && id !== "sh") word = word.replace(/-.*$/, "");
      const key = spec.ci ? word.toLowerCase() : word;
      const next = text.slice(i + word.length).match(/^\s*\(/);
      if (kw.has(key.replace(/^@/, ""))) push("keyword", word);
      else if (next && id !== "css") push("function", word);
      else if (/^[A-Z][a-z]/.test(word) && id === "js") push("type", word);
      else plain += word;
      i += word.length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

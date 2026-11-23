// Turns a chat into Markdown for "Export chat".
const fence = (t) => (t.includes("```") ? "````" : "```");

export function chatToMarkdown(chat, { now = new Date() } = {}) {
  const title = (chat?.title || "Nimbus chat").replace(/\s+/g, " ").trim();
  const out = [`# ${title}`, "", `_Exported from Nimbus on ${now.toISOString().slice(0, 10)}_`, ""];
  for (const m of chat?.messages ?? []) {
    const text = String(m.content ?? "").trim();
    const hasProposals = m.proposals?.length;
    if (!text && !hasProposals) continue;
    out.push(`## ${m.role === "user" ? "You" : "Nimbus"}`, "");
    if (m.attachments?.length) out.push(`_Attached: ${m.attachments.map((a) => a.name ?? "file").join(", ")}_`, "");
    if (text) out.push(text, "");
    for (const p of m.proposals ?? []) out.push(`**Proposed edit to \`${p.path}\`** (+${p.added} −${p.removed})`, "", `${fence(p.diff)}diff`, p.diff, fence(p.diff), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

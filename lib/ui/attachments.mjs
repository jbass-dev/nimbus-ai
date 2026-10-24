// Turning picked/pasted/dropped files into chat attachments (browser only).
//   text & code → read here          { kind: "text", text }
//   PDF / Word  → /api/extract       { kind: "text", text, pages }
//   images      → resized JPEG       { kind: "image", dataUrl }
export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 30_000;
const MAX_IMAGE_SIDE = 1600;

const TEXT_EXT = new Set(
  "txt md markdown csv tsv json jsonc yaml yml toml ini env log xml html htm css scss sass less js jsx mjs cjs ts tsx vue svelte py rb go rs java kt kts swift c h cpp hpp cc cs php sh bash zsh ps1 bat sql graphql gql prisma dockerfile gitignore r lua dart scala ex exs erl clj hs".split(" ")
);

export const ACCEPT = ".pdf,.docx,image/png,image/jpeg,image/webp,image/gif," + [...TEXT_EXT].map((e) => `.${e}`).join(",");

function ext(name) {
  const n = String(name).toLowerCase();
  if (n === "dockerfile" || n.endsWith("/dockerfile")) return "dockerfile";
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i + 1) : "";
}

export function classifyFile(file) {
  const e = ext(file.name);
  if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return "image";
  if (e === "pdf" || file.type === "application/pdf" || e === "docx") return "document";
  if (file.type.startsWith("text/") || TEXT_EXT.has(e) || file.type === "application/json") return "text";
  return null;
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs shouldn't turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.88);
}

/** @returns {Promise<object>} an attachment, or throws Error with a user-facing message */
export async function readAttachment(file) {
  const kind = classifyFile(file);
  const name = file.name || (kind === "image" ? "pasted-image.png" : "file");
  if (!kind) throw new Error(`${name}: this file type isn't supported. Try PDF, Word, images, or text/code files.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name}: too large (max 10 MB).`);

  if (kind === "image") {
    return { id: newId(), name, kind: "image", size: file.size, dataUrl: await resizeImage(file) };
  }

  if (kind === "text") {
    let text = await file.text();
    if (text.includes("\u0000")) throw new Error(`${name}: looks like a binary file, not text.`);
    const truncated = text.length > MAX_TEXT_CHARS;
    if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
    return { id: newId(), name, kind: "text", size: file.size, text, truncated, lang: ext(name) };
  }

  const form = new FormData();
  form.append("file", file, name);
  const res = await fetch("/api/extract", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name}: ${data.error || "couldn't read this file."}`);
  return { id: newId(), name, kind: "text", size: file.size, text: data.text, truncated: data.truncated, pages: data.pages, lang: "" };
}

/** What actually goes to the model for one user message. */
export function toRequestMessage(m) {
  const files = (m.attachments ?? []).filter((a) => a.kind === "text" && a.text);
  const images = (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl).map((a) => a.dataUrl);
  let content = m.content ?? "";
  if (files.length) {
    const blocks = files.map((a) => {
      const meta = [a.pages ? `${a.pages} pages` : null, a.truncated ? "truncated to fit" : null].filter(Boolean).join(", ");
      return `<attached_file name="${a.name.replace(/"/g, "'")}"${meta ? ` note="${meta}"` : ""}>\n${a.text}\n</attached_file>`;
    });
    content = `${content}\n\n${blocks.join("\n\n")}`.trim();
  }
  return images.length ? { role: m.role, content, images } : { role: m.role, content };
}

export function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

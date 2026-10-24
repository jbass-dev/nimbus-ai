// Text extraction for attached documents (PDF and Word). Plain-text and
// code files are read in the browser; images go to a vision model as-is.
export const MAX_EXTRACT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACT_CHARS = 30_000;

export class ExtractError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ExtractError";
    this.status = status;
  }
}

export function detectKind(name = "", type = "", bytes) {
  const n = String(name).toLowerCase();
  if (type === "application/pdf" || n.endsWith(".pdf") || (bytes && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-")) return "pdf";
  if (n.endsWith(".docx") || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  return null;
}

function tidy(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @returns {Promise<{ text: string, truncated: boolean, pages?: number, kind: string }>} */
export async function extractDocument({ name, type, bytes }) {
  if (!bytes?.length) throw new ExtractError("The file is empty.");
  if (bytes.length > MAX_EXTRACT_BYTES) throw new ExtractError("File is too large (max 10 MB).", 413);
  const kind = detectKind(name, type, bytes);
  if (!kind) throw new ExtractError("Only PDF and Word (.docx) files are extracted here.", 415);

  let text = "";
  let pages;
  if (kind === "pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(bytes));
    } catch {
      throw new ExtractError("Couldn't open this PDF. It may be damaged or password-protected.", 422);
    }
    const out = await extractText(pdf, { mergePages: true });
    pages = out.totalPages;
    text = Array.isArray(out.text) ? out.text.join("\n\n") : out.text;
  } else {
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    try {
      const out = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = out.value;
    } catch {
      throw new ExtractError("Couldn't read this Word document.", 422);
    }
  }

  text = tidy(text);
  if (!text) {
    throw new ExtractError(
      kind === "pdf" ? "No text found. This PDF is probably a scanned image; attach it as a screenshot instead." : "The document has no text.",
      422
    );
  }
  const truncated = text.length > MAX_EXTRACT_CHARS;
  return { kind, pages, truncated, text: truncated ? text.slice(0, MAX_EXTRACT_CHARS) : text };
}

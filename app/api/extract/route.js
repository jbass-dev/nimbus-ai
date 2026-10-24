// POST a single file (multipart field "file") → { name, kind, text, truncated, pages }.
import { extractDocument, ExtractError, MAX_EXTRACT_BYTES } from "@/lib/nimbus/extract.mjs";

export const runtime = "nodejs";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function POST(req) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_EXTRACT_BYTES + 64 * 1024) return json({ error: "File is too large (max 10 MB)." }, 413);
  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected a file upload." }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return json({ error: "No file was attached." }, 400);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await extractDocument({ name: file.name, type: file.type, bytes });
    return json({ name: file.name, ...result });
  } catch (err) {
    if (err instanceof ExtractError) return json({ error: err.message }, err.status);
    console.error("extract failed:", err);
    return json({ error: "Couldn't read that file." }, 500);
  }
}

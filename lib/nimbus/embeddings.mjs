// Optional semantic recall. Off unless NIMBUS_EMBEDDINGS_MODEL is set, because it
// sends memory text to the embeddings provider (OpenRouter), which the
// default lexical retrieval never does. Every failure degrades to lexical
// search; embeddings can make recall better but never break it.

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** @returns {(texts: string[]) => Promise<number[][]>} */
export function createOpenRouterEmbedder({ apiKey, model, fetchImpl = fetch, baseUrl = "https://openrouter.ai/api/v1", timeoutMs = 8000 } = {}) {
  if (!apiKey || !model) throw new Error("createOpenRouterEmbedder needs apiKey and model");
  return async function embed(texts) {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`embeddings request failed (${res.status})`);
    const json = await res.json();
    const vectors = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) throw new Error("embeddings response malformed");
    return vectors;
  };
}

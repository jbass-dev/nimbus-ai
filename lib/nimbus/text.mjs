// Lightweight lexical relevance: tokenization, crude stemming, a small
// synonym map, and an overlap score. No embeddings service needed; the
// retrieval interface (scoreRelevance) is the seam to swap one in later.

const STOPWORDS = new Set(
  "a an and are as at be but by can could did do does for from had has have how i i'm im in is it its me my of on or our please should so than that the their them then there these they this to too was we were what when where which who why will with would you your yours about into just also any some find show get give tell let lets want need".split(
    " "
  )
);

const SYNONYMS = {
  job: "job", jobs: "job", role: "job", roles: "job", position: "job", positions: "job",
  opening: "job", openings: "job", work: "job", career: "job", careers: "job", gig: "job",
  hiring: "job", employment: "job", listing: "job", listings: "job", opportunity: "job", opportunities: "job",
  salary: "salary", pay: "salary", paying: "salary", pays: "salary", compensation: "salary", wage: "salary", income: "salary",
  remote: "remote", wfh: "remote", "work-from-home": "remote", distributed: "remote",
  onsite: "onsite", "on-site": "onsite", office: "onsite", inperson: "onsite",
  db: "database", database: "database", databases: "database", postgres: "database", postgresql: "database",
  sqlite: "database", mysql: "database", mongodb: "database", storage: "database",
  reactjs: "react", "react.js": "react",
  nextjs: "nextjs", "next.js": "nextjs",
  js: "javascript", javascript: "javascript", ts: "typescript", typescript: "typescript",
  prefer: "prefer", prefers: "prefer", preference: "prefer", preferences: "prefer", preferred: "prefer", like: "prefer", likes: "prefer",
  decide: "decision", decided: "decision", decision: "decision", decisions: "decision", chose: "decision", choose: "decision", picked: "decision",
  frontend: "frontend", "front-end": "frontend", backend: "backend", "back-end": "backend",
  fullstack: "fullstack", "full-stack": "fullstack",
};

export function stem(word) {
  let w = word;
  if (SYNONYMS[w]) return SYNONYMS[w];
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return SYNONYMS[w] ?? w;
}

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\$?\d+k\b/g, (m) => ` ${m} `)
    .split(/[^a-z0-9.+#$-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function tokenSet(text) {
  return new Set(tokenize(text));
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : tokenSet(a);
  const B = b instanceof Set ? b : tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Fraction of the memory's distinctive tokens that the query touches, weighted. */
export function scoreRelevance(query, memoryText) {
  const q = tokenSet(query);
  const m = tokenSet(memoryText);
  if (!q.size || !m.size) return 0;
  let hits = 0;
  for (const t of m) if (q.has(t)) hits++;
  if (!hits) return 0;
  // Normalise by the smaller set so short queries ("job search") can still
  // match longer memories, but a single shared token in long texts is weak.
  return hits / Math.min(q.size, m.size) * (0.6 + 0.4 * (hits / Math.max(q.size, m.size)));
}

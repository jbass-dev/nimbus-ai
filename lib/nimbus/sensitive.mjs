// Things Nimbus must never write to persistent memory, regardless of who
// asks: credentials and secrets, and government/financial identifiers.

const RULES = [
  { kind: "API key or token", re: /\b(sk|pk|rk)[-_](or[-_])?[a-z0-9_-]{12,}/i },
  { kind: "API key or token", re: /\b(ghp|gho|ghs|github_pat|xox[abp]|AKIA|AIza)[A-Za-z0-9_-]{10,}/ },
  { kind: "API key or token", re: /\b(api[_ -]?key|secret|access[_ -]?token|bearer)\b\s*(is|:|=)\s*\S{8,}/i },
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "password", re: /\b(password|passcode|passwd|pwd|pin)\b\s*(is|:|=|was)?\s*\S+/i },
  { kind: "Social Security number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { kind: "Social Security number", re: /\bssn\b/i },
  { kind: "payment card number", re: /\b(?:\d[ -]?){13,19}\b/ },
  { kind: "bank account number", re: /\b(routing|account)\s*(number|no\.?|#)\s*(is|:)?\s*\d{6,}/i },
];

function luhnLike(digits) {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Returns the kind of sensitive data found, or null. */
export function detectSensitive(text) {
  const s = String(text ?? "");
  for (const { kind, re } of RULES) {
    const m = s.match(re);
    if (!m) continue;
    if (kind === "payment card number" && !luhnLike(m[0])) continue;
    // "prefers password managers" etc. shouldn't trip the password rule.
    if (kind === "password" && !/\b(password|passcode|passwd|pwd|pin)\b\s*(is|:|=|was)\s*\S+/i.test(s)) continue;
    return kind;
  }
  return null;
}

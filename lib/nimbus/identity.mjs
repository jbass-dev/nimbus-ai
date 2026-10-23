// Anonymous per-browser identity. The server issues a random 256-bit token
// in an HttpOnly cookie; the memory store is keyed by SHA-256 of that token,
// so the token itself is never written to disk and one browser can't read
// another's memories without stealing its cookie.
import crypto from "node:crypto";

export const COOKIE_NAME = "nimbus_uid";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userKeyFromToken(token) {
  return crypto.createHash("sha256").update(`nimbus:${token}`).digest("hex");
}

/** Returns { userKey, setCookie } — setCookie is non-null when a new identity was issued. */
export function resolveIdentity(req) {
  const cookies = parseCookies(req.headers.get("cookie"));
  let token = cookies[COOKIE_NAME];
  let setCookie = null;
  if (!token || !TOKEN_RE.test(token)) {
    token = crypto.randomBytes(32).toString("base64url");
    const secure = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
    setCookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 730}${secure ? "; Secure" : ""}`;
  }
  return { userKey: userKeyFromToken(token), setCookie };
}

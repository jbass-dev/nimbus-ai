// Outbound HTTP for tools. Blocks requests to private/loopback networks
// (so a prompt-injected URL can't make the server probe localhost or the
// LAN), follows redirects manually so each hop is re-checked, and caps
// response size and time.
import dns from "node:dns/promises";
import net from "node:net";
import { withTimeout } from "./util.mjs";

export const USER_AGENT = "NimbusAI/1.0 (+https://johnbass.dev; personal assistant)";

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

export class BlockedUrlError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BlockedUrlError";
  }
}

export async function assertPublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new BlockedUrlError("Local network addresses are not allowed");
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedUrlError("Local or private network addresses are not allowed");
  }
  return url;
}

/**
 * Fetch a public URL. Returns { status, url, contentType, text }.
 * `fetchImpl` and `lookup` are injectable for tests.
 */
export async function safeFetch(rawUrl, opts = {}) {
  const {
    fetchImpl = fetch,
    lookup,
    timeoutMs = 12000,
    maxBytes = 1_500_000,
    maxRedirects = 3,
    headers = {},
    signal,
    skipSsrfCheck = false,
  } = opts;

  return withTimeout(
    async (sig) => {
      let current = rawUrl;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (!skipSsrfCheck) await assertPublicUrl(current, { lookup });
        const res = await fetchImpl(current, {
          redirect: "manual",
          signal: sig,
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...headers },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location"), current).toString();
          continue;
        }
        const text = await readCapped(res, maxBytes);
        return {
          status: res.status,
          ok: res.ok,
          url: current,
          contentType: res.headers.get("content-type") ?? "",
          text,
        };
      }
      throw new Error("Too many redirects");
    },
    timeoutMs,
    `fetch ${safeHost(rawUrl)}`,
    signal
  );
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return "url";
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body?.getReader) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  return out;
}

export async function fetchJson(url, opts = {}) {
  const res = await safeFetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${safeHost(url)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`Malformed JSON from ${safeHost(url)}`);
  }
}

// Request hygiene for /api/OpenRouter: size limits, archive sanitizing, rate
// limiting and model allowlisting. Kept out of the route so it's unit-tested.

export const REQUEST_LIMITS = {
  MAX_MESSAGES: 60, // caps how much history gets forwarded upstream
  MAX_MESSAGE_LENGTH: 100_000, // chars, per message (attached file text included)
  MAX_TOTAL_LENGTH: 200_000, // chars, across the whole conversation
  MAX_IMAGES_PER_MESSAGE: 4,
  MAX_IMAGE_CHARS: 4_000_000, // ~3 MB per image as a data URL
  // Past chats sent for search_chats (only when that permission is granted).
  ARCHIVE_MAX_CHATS: 60,
  ARCHIVE_MAX_MESSAGES: 40, // per chat
  ARCHIVE_MAX_MESSAGE: 1500, // chars
  ARCHIVE_MAX_TOTAL: 300_000, // chars across the archive
};
const {
  MAX_MESSAGES, MAX_MESSAGE_LENGTH, MAX_TOTAL_LENGTH, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_CHARS,
  ARCHIVE_MAX_CHATS, ARCHIVE_MAX_MESSAGES, ARCHIVE_MAX_MESSAGE, ARCHIVE_MAX_TOTAL,
} = REQUEST_LIMITS;

export function sanitizeArchive(archive) {
  if (!Array.isArray(archive)) return null;
  const out = [];
  let total = 0;
  for (const chat of archive.slice(0, ARCHIVE_MAX_CHATS)) {
    if (!chat || typeof chat.id !== "string") continue;
    const messages = [];
    for (const m of Array.isArray(chat.messages) ? chat.messages.slice(-ARCHIVE_MAX_MESSAGES) : []) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) continue;
      const content = m.content.slice(0, ARCHIVE_MAX_MESSAGE);
      if (total + content.length > ARCHIVE_MAX_TOTAL) break;
      total += content.length;
      messages.push({ role: m.role, content });
    }
    out.push({ id: chat.id.slice(0, 64), title: String(chat.title ?? "").slice(0, 200), messages });
    if (total >= ARCHIVE_MAX_TOTAL) break;
  }
  return out;
}

/**
 * In-memory sliding-window limiter keyed by client IP. Process-local: fine for
 * a single instance (the desktop app, one serverless instance); swap for
 * Redis/Upstash across a fleet. Returns isLimited(ip) → boolean.
 */
export function createRateLimiter({ windowMs = 60_000, max = 20, now = () => Date.now(), maxKeys = 5000 } = {}) {
  const hits = new Map(); // ip -> request timestamps inside the window
  return function isRateLimited(ip) {
    const t = now();
    const recent = (hits.get(ip) ?? []).filter((at) => t - at < windowMs);
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > maxKeys) {
      for (const [key, stamps] of hits) {
        if (stamps.every((at) => t - at >= windowMs)) hits.delete(key);
      }
    }
    return recent.length > max;
  };
}

export function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "No messages provided.";
  if (messages.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES}). Start a new chat.`;
  let totalLength = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== "string" || typeof m.role !== "string") return "Malformed message in conversation.";
    if (m.content.length > MAX_MESSAGE_LENGTH) return `A message (with its attached files) is over the ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")}-character limit.`;
    if (m.images !== undefined) {
      if (!Array.isArray(m.images) || m.images.length > MAX_IMAGES_PER_MESSAGE) return `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;
      for (const img of m.images) {
        if (typeof img !== "string" || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(img)) return "Unsupported image format.";
        if (img.length > MAX_IMAGE_CHARS) return "An attached image is too large.";
      }
    }
    totalLength += m.content.length;
  }
  if (totalLength > MAX_TOTAL_LENGTH) return "Conversation is too long for this request. Start a new chat.";
  return null;
}

/**
 * Picks the model for this request. Only slugs from the allowlist are
 * accepted (anything else → default, so a client can't route to an arbitrary
 * paid model). Images force the vision model when the chosen one can't see.
 */
export function chooseModel({ requested, messages, models, visionModel }) {
  let modelSlug = Object.hasOwn(models, requested ?? "") ? requested : undefined;
  let visionNotice = null;
  const hasImages = messages.some((m) => Array.isArray(m.images) && m.images.length);
  if (hasImages && !(modelSlug && models[modelSlug].vision)) {
    visionNotice = `${models[modelSlug]?.label ?? "This model"} can't read images, so ${models[visionModel].label} answered this one.`;
    modelSlug = visionModel;
  }
  const supportsTools = (modelSlug ? models[modelSlug] : null)?.tools !== false;
  return { modelSlug, visionNotice, supportsTools };
}

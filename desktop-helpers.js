// Pure helpers for the Electron shell, kept separate so they can be unit-tested without Electron.

/** A safe default file name for save dialogs: no path separators, reserved characters or control chars. */
function safeFileName(name, fallback = "nimbus-chat") {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .slice(0, 80)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) || !cleaned ? fallback : cleaned;
}

/**
 * Restores saved window bounds only if they still land on a connected display
 * (a monitor may have been unplugged since). Returns null when they don't.
 */
function usableBounds(saved, displays, { minWidth = 600, minHeight = 400 } = {}) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
  if (saved.width < minWidth || saved.height < minHeight) return null;
  const visible = displays.some((d) => {
    const w = d.workArea ?? d;
    const ox = Math.min(saved.x + saved.width, w.x + w.width) - Math.max(saved.x, w.x);
    const oy = Math.min(saved.y + saved.height, w.y + w.height) - Math.max(saved.y, w.y);
    return ox >= 200 && oy >= 100;
  });
  return visible ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null;
}

/** True only for pages served by the local Nimbus server. IPC from anything else is ignored. */
function isAppUrl(url, port) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && Number(u.port) === Number(port);
  } catch {
    return false;
  }
}

module.exports = { safeFileName, usableBounds, isAppUrl };

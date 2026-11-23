// Starts the background-task heartbeat when the server boots (desktop app only).
// The timer just pings an internal endpoint with a random per-process secret,
// so all the work happens in the same code and singletons as every other route.
import crypto from "node:crypto";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NIMBUS_BACKGROUND !== "1") return;
  const secret = crypto.randomBytes(24).toString("hex");
  process.env.NIMBUS_TICK_SECRET = secret;
  const port = process.env.PORT || 3000;
  const beat = () => fetch(`http://127.0.0.1:${port}/api/tasks/tick`, { method: "POST", headers: { "x-nimbus-tick": secret } }).catch(() => {});
  setInterval(beat, 60_000).unref();
}

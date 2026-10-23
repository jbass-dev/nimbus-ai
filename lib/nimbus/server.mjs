// Process-wide singletons for the API routes.
import path from "node:path";
import fs from "node:fs/promises";
import { createMemoryStore } from "./memory-store.mjs";

let store = null;

export function dataDir() {
  return process.env.NIMBUS_DATA_DIR || path.join(process.cwd(), ".nimbus-data");
}

export function getStore() {
  if (!store) store = createMemoryStore({ dataDir: dataDir() });
  return store;
}

/** Append one line of content-free metrics per turn (for the eval/regression dashboard). */
export async function logMetrics(metrics) {
  if (process.env.NIMBUS_METRICS === "off") return;
  try {
    const dir = path.join(dataDir(), "metrics");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "turns.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...metrics })}\n`);
  } catch {
    // metrics are best-effort
  }
}

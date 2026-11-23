// Process-wide singletons for the API routes.
import path from "node:path";
import fs from "node:fs/promises";
import { createMemoryStore } from "./memory-store.mjs";
import { createResearchStore } from "./research-store.mjs";
import { createOpenRouterEmbedder } from "./embeddings.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { createTaskStore } from "./task-store.mjs";
import { createBackgroundRunner } from "./background.mjs";
import { createOpenRouterClient } from "./llm.mjs";
import { MODELS, resolveUpstreamModel } from "../../app/config/models.js";

let store = null;
let researchStore = null;
let workspaceStore = null;
let taskStore = null;
let runner = null;

/** Background tasks run only inside the desktop app (it keeps the server alive in the tray). */
export const backgroundEnabled = () => process.env.NIMBUS_BACKGROUND === "1";

export function getTaskStore() {
  if (!taskStore) taskStore = createTaskStore({ dataDir: dataDir() });
  return taskStore;
}

export function getBackgroundRunner() {
  if (!runner) {
    const slug = MODELS[process.env.NIMBUS_BACKGROUND_MODEL]?.upstream ? process.env.NIMBUS_BACKGROUND_MODEL : "free-router";
    runner = createBackgroundRunner({
      taskStore: getTaskStore(),
      store: getStore(),
      researchStore: getResearchStore(),
      createLlm: () => createOpenRouterClient({ apiKey: process.env.OPENROUTER_KEY, ...(process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {}) }),
      model: resolveUpstreamModel(slug),
      fallbackModels: slug === "free-router" ? [{ upstream: resolveUpstreamModel("llama-3.3-70b-free"), label: MODELS["llama-3.3-70b-free"].label }] : [],
      env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY, TAVILY_API_KEY: process.env.TAVILY_API_KEY },
    });
  }
  return runner;
}

/** The coding workspace is desktop-only: it exists only when NIMBUS_WORKSPACE=1 (set by the Electron app). */
export const workspaceEnabled = () => process.env.NIMBUS_WORKSPACE === "1";

export function getWorkspaceStore() {
  if (!workspaceStore) workspaceStore = createWorkspaceStore({ dataDir: dataDir() });
  return workspaceStore;
}

export function dataDir() {
  return process.env.NIMBUS_DATA_DIR || path.join(process.cwd(), ".nimbus-data");
}

export function getStore() {
  if (!store) {
    // Opt-in semantic recall: NIMBUS_EMBEDDINGS_MODEL=<openrouter embedding model id>
    const model = process.env.NIMBUS_EMBEDDINGS_MODEL;
    const embed = model && process.env.OPENROUTER_KEY
      ? createOpenRouterEmbedder({ apiKey: process.env.OPENROUTER_KEY, model, ...(process.env.OPENROUTER_BASE_URL ? { baseUrl: process.env.OPENROUTER_BASE_URL } : {}) })
      : null;
    store = createMemoryStore({ dataDir: dataDir(), embed });
  }
  return store;
}

export function getResearchStore() {
  if (!researchStore) researchStore = createResearchStore({ dataDir: dataDir() });
  return researchStore;
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

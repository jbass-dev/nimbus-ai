// Single source of truth for selectable models.
// `slug` is the public key the client sends; `upstream` is the OpenRouter
// model id; `label` is what's shown in the UI; `tools: false` marks models
// whose OpenRouter route doesn't support tool calling (the server also
// detects this at runtime and falls back to plain chat). `vision: true` marks
// models that can read images; messages with images go to VISION_MODEL when
// the selected model can't. Add new models here
// only — both the API route and the client read from this file.
//
// Free models cost nothing but have daily request limits and can be
// rate-limited. "openrouter/free" is OpenRouter's router: it picks a free
// model that supports what the request needs (tools, images), so it keeps
// working as individual free models come and go. Paid models draw from the
// OpenRouter balance.

export const MODELS = {
  "free-router": { label: "Auto (free)", upstream: "openrouter/free", vision: true },
  "llama-3.3-70b-free": { label: "Llama 3.3 70B (free)", upstream: "meta-llama/llama-3.3-70b-instruct:free" },
  "deepseek-v3.2": { label: "DeepSeek V3.2", upstream: "deepseek/deepseek-v3.2" },
  "gemma-4-31b": { label: "Gemma 4 31B (free)", upstream: "google/gemma-4-31b-it:free", vision: true },
  "llama-3.3-70b": { label: "Llama 3.3 70B", upstream: "meta-llama/llama-3.3-70b-instruct" },
  "ministral-8b": { label: "Ministral 8B", upstream: "mistralai/ministral-8b-2512" },
};

export const DEFAULT_MODEL = "free-router";
export const VISION_MODEL = "free-router";

export function resolveUpstreamModel(slug) {
  return MODELS[slug]?.upstream ?? MODELS[DEFAULT_MODEL].upstream;
}

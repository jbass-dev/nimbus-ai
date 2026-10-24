// Single source of truth for selectable models.
// `slug` is the public key the client sends; `upstream` is the OpenRouter
// model id; `label` is what's shown in the UI; `tools: false` marks models
// whose OpenRouter route doesn't support tool calling (the server also
// detects this at runtime and falls back to plain chat). `vision: true` marks
// models that can read images; messages with images go to VISION_MODEL when
// the selected model can't. Add new models here
// only — both the API route and the client read from this file.

export const MODELS = {
  "deepseek-v3.2": { label: "DeepSeek V3.2", upstream: "deepseek/deepseek-v3.2" },
  "gemma-4-31b": { label: "Gemma 4 31B", upstream: "google/gemma-4-31b-it:free", vision: true },
  "llama-3.3-70b": { label: "Llama 3.3 70B", upstream: "meta-llama/llama-3.3-70b-instruct" },
  "ministral-8b": { label: "Ministral 8B", upstream: "mistralai/ministral-8b-2512" },
};

export const DEFAULT_MODEL = "deepseek-v3.2";
export const VISION_MODEL = "gemma-4-31b";

export function resolveUpstreamModel(slug) {
  return MODELS[slug]?.upstream ?? MODELS[DEFAULT_MODEL].upstream;
}

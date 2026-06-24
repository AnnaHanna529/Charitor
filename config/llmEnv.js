const fs = require("fs");
const path = require("path");

const SECRETS_KEY_FILE = path.resolve(__dirname, "secrets", "llm-api-key.txt");
const OLLAMA_HEALTH_TTL_MS = Number(process.env.OLLAMA_HEALTH_TTL_MS) || 20000;

let ollamaHealthCache = {
  ready: false,
  checkedAt: 0,
  models: [],
  error: null,
};

function readApiKeyFromSecretsFile() {
  try {
    if (!fs.existsSync(SECRETS_KEY_FILE)) return "";
    return String(fs.readFileSync(SECRETS_KEY_FILE, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function resolveLlmApiKey() {
  return (
    String(process.env.LLM_API_KEY || "").trim() ||
    String(process.env.CHUTES_API_KEY || "").trim() ||
    String(process.env.OPENROUTER_API_KEY || "").trim() ||
    String(process.env.DEEPSEEK_API_KEY || "").trim() ||
    String(process.env.GROQ_API_KEY || "").trim() ||
    readApiKeyFromSecretsFile()
  );
}

/** Встроенная модель — только Ollama + Qwen на сервере. Облако/Chutes — вкладка «Прокси». */
function getBuiltinLlmMode() {
  return "ollama";
}

function getOllamaBaseUrl() {
  return String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").trim();
}

function getOllamaDefaultModel() {
  return String(process.env.OLLAMA_MODEL || "qwen2.5:3b").trim();
}

/** Облачный API из .env (Chutes, OpenRouter и т.д.) — не для встроенной, если режим ollama */
function getServerCloudLlmRuntimeConfig() {
  const proxyUrl = String(process.env.LLM_PROXY_URL || "").trim();
  if (!proxyUrl) return {};
  return {
    proxy_url: proxyUrl,
    model: String(process.env.LLM_MODEL || "").trim(),
    api_key: resolveLlmApiKey(),
    custom_prompt: String(process.env.LLM_CUSTOM_PROMPT || "").trim(),
    http_referer: String(process.env.LLM_HTTP_REFERER || "http://localhost:3000").trim(),
    x_title: String(process.env.LLM_HTTP_TITLE || "Charitor").trim(),
  };
}

/** Конфиг «Встроенная» в чате: пустой proxy_url → запрос в Ollama на сервере */
function getBuiltinLlmRuntimeConfig() {
  return {};
}

/** @deprecated — используйте getBuiltinLlmRuntimeConfig / getServerCloudLlmRuntimeConfig */
function getServerLlmRuntimeConfig() {
  return getBuiltinLlmRuntimeConfig();
}

function detectCloudProvider(proxyUrl) {
  const url = String(proxyUrl || "").toLowerCase();
  if (url.includes("chutes.ai")) return "chutes";
  if (url.includes("groq.com")) return "groq";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("together.xyz")) return "together";
  if (url.includes("openai.com")) return "openai";
  return "custom";
}

async function refreshOllamaHealth() {
  const baseUrl = getOllamaBaseUrl();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const items = Array.isArray(data?.models) ? data.models : [];
    const models = items
      .map((item) => {
        const id = String(item?.name || item?.model || "").trim();
        if (!id) return null;
        return { id, name: id };
      })
      .filter(Boolean);
    const defaultModel = getOllamaDefaultModel();
    const hasDefault = models.some((m) => m.id === defaultModel);
    if (!hasDefault && defaultModel) {
      models.unshift({ id: defaultModel, name: defaultModel });
    }
    ollamaHealthCache = {
      ready: true,
      checkedAt: Date.now(),
      models,
      error: null,
    };
  } catch (err) {
    ollamaHealthCache = {
      ready: false,
      checkedAt: Date.now(),
      models: [],
      error: err?.message || "Ollama недоступна",
    };
  }
  return ollamaHealthCache;
}

async function getOllamaHealth() {
  if (Date.now() - ollamaHealthCache.checkedAt > OLLAMA_HEALTH_TTL_MS) {
    await refreshOllamaHealth();
  }
  return ollamaHealthCache;
}

function getLlmPublicStatus() {
  const defaultModel = getOllamaDefaultModel();
  return {
    mode: "ollama",
    ready: ollamaHealthCache.ready,
    model: defaultModel,
    provider: "ollama",
    base_url: getOllamaBaseUrl(),
    free: true,
    user_install_required: false,
    description: ollamaHealthCache.ready
      ? "Встроенная модель Qwen через Ollama на сервере Charitor. Пользователям на ПК ничего устанавливать не нужно."
      : "",
    ollama_error: ollamaHealthCache.ready ? null : ollamaHealthCache.error,
  };
}

/** Подставляет ключ и заголовки Chutes с сервера, если в браузере прокси без ключа */
function enrichCloudProxyRuntimeConfig(cfg) {
  if (!cfg || !String(cfg.proxy_url || "").trim()) return cfg || {};
  const out = { ...cfg };
  const url = String(out.proxy_url || "").toLowerCase();

  if (!String(out.api_key || "").trim()) {
    const serverKey = resolveLlmApiKey();
    if (serverKey) out.api_key = serverKey;
  }

  const cloudDefaults = getServerCloudLlmRuntimeConfig();
  if (url.includes("chutes.ai") || url.includes("openrouter.ai")) {
    if (!out.http_referer && cloudDefaults.http_referer) {
      out.http_referer = cloudDefaults.http_referer;
    }
    if (!out.x_title && cloudDefaults.x_title) {
      out.x_title = cloudDefaults.x_title;
    }
  }

  return out;
}

function applyModelOverrideToRuntimeConfig(runtimeConfig, modelOverride) {
  const cfg = { ...runtimeConfig };
  const model = String(modelOverride || "").trim();
  if (model) cfg.model = model;
  return cfg;
}

function isQwenModelId(modelId) {
  return /qwen/i.test(String(modelId || "").trim());
}

function toModelListEntry(id) {
  const value = String(id || "").trim();
  return value ? { id: value, name: value } : null;
}

/** Только Qwen — для вкладки «Встроенная»; остальные модели — во вкладке «Прокси». */
function filterBuiltinLlmModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((item) => {
      if (typeof item === "string") return toModelListEntry(item);
      const id = String(item?.id || item?.name || "").trim();
      return id ? { id, name: String(item?.name || id).trim() } : null;
    })
    .filter((item) => item && isQwenModelId(item.id));
}

const CHUTES_PROXY_URL = "https://llm.chutes.ai/v1/chat/completions";

const CHUTES_PROXY_PRESETS_FALLBACK = [
  "Qwen/Qwen3-32B-TEE",
  "google/gemma-4-31B-turbo-TEE",
  "zai-org/GLM-5.1-TEE",
  "moonshotai/Kimi-K2.5-TEE",
  "MiniMaxAI/MiniMax-M2.5-TEE",
  "deepseek-ai/DeepSeek-V3.2-TEE",
  "Qwen/Qwen3.5-397B-A17B-TEE",
  "zai-org/GLM-5-Turbo",
  "moonshotai/Kimi-K2.6-TEE",
  "zai-org/GLM-5-TEE",
  "unsloth/Mistral-Nemo-Instruct-2407-TEE",
  "Qwen/Qwen3.6-27B-TEE",
  "Qwen/Qwen2.5-Coder-32B-Instruct-TEE",
  "Qwen/Qwen3-235B-A22B-Thinking-2507",
];

function formatChutesProxyPresetName(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return "Chutes";
  const tail = id.includes("/") ? id.split("/").pop() : id;
  return `Chutes · ${tail.replace(/-TEE$/i, "")}`;
}

async function fetchCloudLlmModels() {
  const server = getServerCloudLlmRuntimeConfig();
  if (!server.proxy_url || !server.api_key) return [];

  const provider = detectCloudProvider(server.proxy_url);
  if (provider === "chutes") {
    try {
      const response = await fetch("https://llm.chutes.ai/v1/models", {
        headers: { Authorization: `Bearer ${server.api_key}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return [];
      const items = Array.isArray(data?.data) ? data.data : [];
      return items
        .map((item) => {
          const id = String(item?.id || item?.name || "").trim();
          if (!id) return null;
          return { id, name: id };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  if (provider === "openrouter") {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${server.api_key}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return [];
      const items = Array.isArray(data?.data) ? data.data : [];
      return items
        .map((item) => {
          const id = String(item?.id || "").trim();
          if (!id) return null;
          return { id, name: id };
        })
        .filter(Boolean)
        .slice(0, 80);
    } catch {
      return [];
    }
  }

  return [];
}

async function fetchChutesProxyPresets() {
  const fromApi = await fetchCloudLlmModels();
  const modelIds = fromApi.length
    ? fromApi.map((item) => item.id)
    : CHUTES_PROXY_PRESETS_FALLBACK;
  const unique = [...new Set(modelIds.map((id) => String(id || "").trim()).filter(Boolean))];
  return unique.map((model) => ({
    model,
    name: formatChutesProxyPresetName(model),
    proxyUrl: CHUTES_PROXY_URL,
    provider: "chutes",
  }));
}

const BUILTIN_OLLAMA_QWEN_FALLBACK = [
  "qwen2.5:3b",
  "qwen2.5:1.5b",
  "qwen2.5:7b",
];

function isOllamaStyleModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id || id.includes("/")) return false;
  return isQwenModelId(id);
}

function getBuiltinOllamaFallbackModels() {
  const defaultModel = getOllamaDefaultModel();
  const fallbackModel = String(
    process.env.OLLAMA_FALLBACK_MODEL || "qwen2.5:1.5b",
  ).trim();
  const ids = [...new Set([defaultModel, fallbackModel, ...BUILTIN_OLLAMA_QWEN_FALLBACK])];
  return ids
    .filter(isOllamaStyleModelId)
    .map(toModelListEntry)
    .filter(Boolean);
}

async function fetchAvailableLlmModels() {
  const health = await getOllamaHealth();
  if (health.ready) {
    const qwen = filterBuiltinLlmModels(health.models || []).filter((item) =>
      isOllamaStyleModelId(item.id),
    );
    if (qwen.length) return qwen;
  }
  return getBuiltinOllamaFallbackModels();
}

function sanitizeBuiltinModelOverride(modelOverride) {
  const model = String(modelOverride || "").trim();
  if (!model || model.includes("/")) return "";
  return isOllamaStyleModelId(model) ? model : "";
}

async function logLlmModeAtStartup() {
  await refreshOllamaHealth();
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaDefaultModel();
  if (ollamaHealthCache.ready) {
    const count = ollamaHealthCache.models.length;
    console.log(
      `LLM (встроенная=Ollama Qwen): ${baseUrl}, модель: ${model}${count ? `, в каталоге: ${count}` : ""}`,
    );
    console.log("     Облачные API (Chutes и др.) — только через вкладку «Прокси» в чате.");
    return;
  }
  console.warn(`LLM (встроенная=Ollama): сервис недоступен (${baseUrl})`);
  console.warn(`     ${ollamaHealthCache.error || "запустите: ollama serve"}`);
  console.warn(`     затем: ollama pull ${model}`);
}

module.exports = {
  SECRETS_KEY_FILE,
  getBuiltinLlmMode,
  getBuiltinLlmRuntimeConfig,
  sanitizeBuiltinModelOverride,
  getServerLlmRuntimeConfig,
  getServerCloudLlmRuntimeConfig,
  getLlmPublicStatus,
  logLlmModeAtStartup,
  resolveLlmApiKey,
  applyModelOverrideToRuntimeConfig,
  fetchAvailableLlmModels,
  fetchChutesProxyPresets,
  CHUTES_PROXY_URL,
  formatChutesProxyPresetName,
  refreshOllamaHealth,
  getOllamaHealth,
  getOllamaBaseUrl,
  getOllamaDefaultModel,
  enrichCloudProxyRuntimeConfig,
  resolveLlmApiKey,
};

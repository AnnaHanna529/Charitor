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

/** Встроенная модель для всех пользователей: ollama (бесплатно) | cloud (API из .env) */
function getBuiltinLlmMode() {
  const mode = String(process.env.BUILTIN_LLM_MODE || "ollama").trim().toLowerCase();
  return mode === "cloud" ? "cloud" : "ollama";
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

/** cloud = Chutes/API из .env; ollama = локальный Ollama на сервере */
function getEffectiveBuiltinBackend() {
  const configured = getBuiltinLlmMode();
  const cloud = getServerCloudLlmRuntimeConfig();
  const hasCloud = Boolean(cloud.proxy_url && cloud.api_key);

  if (configured === "cloud") {
    return "cloud";
  }
  if (ollamaHealthCache.ready) {
    return "ollama";
  }
  if (hasCloud) {
    return "cloud";
  }
  return "ollama";
}

/** Конфиг «Встроенная» в чате: пустой proxy_url → запрос в Ollama на сервере */
function getBuiltinLlmRuntimeConfig() {
  if (getEffectiveBuiltinBackend() === "cloud") {
    return getServerCloudLlmRuntimeConfig();
  }
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
  const backend = getEffectiveBuiltinBackend();
  if (backend === "cloud") {
    const server = getServerCloudLlmRuntimeConfig();
    return {
      mode: "cloud",
      builtin_mode: getBuiltinLlmMode(),
      backend: "cloud",
      ready: Boolean(server.proxy_url && server.api_key),
      model: server.model || null,
      provider: detectCloudProvider(server.proxy_url),
      free: false,
      user_install_required: false,
      description:
        "Встроенные модели Qwen на сервере Charitor (Chutes). Выберите модель ниже — ключ только на сервере.",
    };
  }

  return {
    mode: "ollama",
    builtin_mode: getBuiltinLlmMode(),
    backend: "ollama",
    ready: ollamaHealthCache.ready,
    model: getOllamaDefaultModel(),
    provider: "ollama",
    base_url: getOllamaBaseUrl(),
    free: true,
    user_install_required: false,
    description: ollamaHealthCache.ready
      ? "Бесплатная Qwen через Ollama на сервере Charitor. Доступны только модели из Ollama (например qwen2.5:3b)."
      : "Ollama на сервере недоступна. Администратору: ollama serve и ollama pull qwen2.5:3b — или задайте BUILTIN_LLM_MODE=cloud и LLM_API_KEY.",
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

const BUILTIN_QWEN_MODELS_FALLBACK = [
  "Qwen/Qwen3-32B-TEE",
  "Qwen/Qwen3.5-397B-A17B-TEE",
  "Qwen/Qwen3.6-27B-TEE",
  "Qwen/Qwen2.5-Coder-32B-Instruct-TEE",
  "Qwen/Qwen3-235B-A22B-Thinking-2507-TEE",
  "Qwen/Qwen3-235B-A22B-Thinking-2507",
];

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

function getBuiltinQwenFallbackModels() {
  const defaultModel = String(
    process.env.LLM_MODEL || getOllamaDefaultModel() || "",
  ).trim();
  const ids = [
    ...(isQwenModelId(defaultModel) ? [defaultModel] : []),
    ...BUILTIN_QWEN_MODELS_FALLBACK,
  ];
  const unique = [...new Set(ids.map((id) => String(id).trim()).filter(isQwenModelId))];
  return unique.map(toModelListEntry).filter(Boolean);
}

async function fetchAvailableLlmModels() {
  const backend = getEffectiveBuiltinBackend();
  if (backend === "ollama") {
    const health = await getOllamaHealth();
    if (!health.ready) return [];
    const qwen = filterBuiltinLlmModels(health.models || []);
    if (qwen.length) return qwen;
    const def = getOllamaDefaultModel();
    return isQwenModelId(def) ? [toModelListEntry(def)].filter(Boolean) : [];
  }
  const qwen = filterBuiltinLlmModels(await fetchCloudLlmModels());
  return qwen.length ? qwen : getBuiltinQwenFallbackModels();
}

function sanitizeBuiltinModelOverride(modelOverride, runtimeConfig) {
  const model = String(modelOverride || "").trim();
  if (!model) return "";
  const useCloud = Boolean(String(runtimeConfig?.proxy_url || "").trim());
  if (useCloud) return model;
  if (model.includes("/")) return "";
  return model;
}

async function logLlmModeAtStartup() {
  const mode = getBuiltinLlmMode();
  if (mode === "cloud") {
    const status = getLlmPublicStatus();
    if (!status.ready) {
      console.warn(
        "LLM (встроенная=cloud): API задан, но ключ пустой. Добавьте LLM_API_KEY в .env",
      );
      console.warn(`     URL: ${process.env.LLM_PROXY_URL}`);
      return;
    }
    console.log(
      `LLM (встроенная=cloud): ${status.provider}, модель: ${status.model || "(LLM_MODEL)"}`,
    );
    return;
  }

  await refreshOllamaHealth();
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaDefaultModel();
  if (ollamaHealthCache.ready) {
    const count = ollamaHealthCache.models.length;
    console.log(
      `LLM (встроенная=ollama, бесплатно): ${baseUrl}, модель: ${model}${count ? `, в каталоге: ${count}` : ""}`,
    );
    console.log("     Пользователям Ollama на ПК не нужна — только на этом сервере.");
    return;
  }
  console.warn(`LLM (встроенная=ollama): сервис недоступен (${baseUrl})`);
  console.warn(`     ${ollamaHealthCache.error || "запустите: ollama serve"}`);
  console.warn(`     затем: ollama pull ${model}`);
}

module.exports = {
  SECRETS_KEY_FILE,
  getBuiltinLlmMode,
  getEffectiveBuiltinBackend,
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

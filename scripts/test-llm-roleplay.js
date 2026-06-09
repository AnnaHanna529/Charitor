/**
 * Интеграционный тест: Ollama или прокси + проверка формата ответа.
 * node scripts/test-llm-roleplay.js
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const {
  getBuiltinLlmRuntimeConfig,
  getLlmPublicStatus,
  refreshOllamaHealth,
} = require("../config/llmEnv");
const {
  generateBotReply,
  finalizeBotReplyText,
  validateRoleplayFormatting,
  hasFirstPersonOutsideSpeech,
  buildSystemPrompt,
} = require("../config/aiChat");

const { CHAR_NAME, USER_NAME, BOT_SYSTEM_PROMPT } = require("./test-fixtures");

const TEST_USER_MESSAGE =
  "Привет! Ответь коротко, соблюдая правила формата (действия в *звёздочках*, речь в \"лапках\").";

function printFormatReport(label, text) {
  const structured = finalizeBotReplyText(text);
  const check = validateRoleplayFormatting(structured);
  console.log(`\n=== ${label} ===`);
  console.log("Длина:", structured.length);
  const personOk = !hasFirstPersonOutsideSpeech(structured);
  console.log(
    "Формат:",
    check.ok && personOk
      ? "OK"
      : `FAIL (${[...check.issues, !personOk ? "я вне речи" : ""].filter(Boolean).join("; ")})`,
  );
  console.log("--- текст ---\n" + structured.slice(0, 1200) + (structured.length > 1200 ? "\n…" : ""));
  return check.ok && personOk;
}

async function testBuiltin() {
  await refreshOllamaHealth();
  const status = getLlmPublicStatus();
  console.log("Режим:", status.mode, "| ready:", status.ready);

  if (!status.ready) {
    console.error("LLM недоступен:", status.ollama_error || status.message || "нет ключа");
    process.exit(1);
  }

  const runtime = getBuiltinLlmRuntimeConfig();
  const reply = await generateBotReply({
    botName: CHAR_NAME,
    botSystemPrompt: BOT_SYSTEM_PROMPT,
    personaPrompt: "",
    personaName: USER_NAME,
    history: [{ role: "user", content: TEST_USER_MESSAGE }],
    runtimeConfig: runtime,
  });

  const ok = printFormatReport(`встроенная (${status.mode})`, reply);
  if (!ok) process.exit(1);
}

async function testProxyIfConfigured() {
  const proxyUrl = String(process.env.LLM_PROXY_URL || process.env.CHUTES_PROXY_URL || "").trim();
  const apiKey = String(process.env.LLM_API_KEY || "").trim();
  if (!proxyUrl || !apiKey) {
    console.log("\nПрокси не настроен (LLM_PROXY_URL + LLM_API_KEY) — пропуск.");
    return;
  }

  const runtime = {
    ...getBuiltinLlmRuntimeConfig(),
    proxy_url: proxyUrl,
    api_key: apiKey,
    model: process.env.LLM_MODEL || process.env.CHUTES_MODEL || getBuiltinLlmRuntimeConfig().model,
  };

  const reply = await generateBotReply({
    botName: CHAR_NAME,
    botSystemPrompt: BOT_SYSTEM_PROMPT,
    personaPrompt: "",
    personaName: USER_NAME,
    history: [{ role: "user", content: TEST_USER_MESSAGE }],
    runtimeConfig: runtime,
  });

  const ok = printFormatReport("прокси", reply);
  if (!ok) process.exit(1);
}

async function main() {
  console.log(
    "Промпт содержит правила формата:",
    buildSystemPrompt(BOT_SYSTEM_PROMPT, "", CHAR_NAME).includes("лапки"),
  );
  await testBuiltin();
  await testProxyIfConfigured();
  console.log("\nИнтеграционный тест формата завершён успешно.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

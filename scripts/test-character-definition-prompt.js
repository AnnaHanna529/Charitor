const {
  buildSystemPrompt,
  resolveCharacterDefinition,
  buildBotProfileFromChat,
} = require("../config/aiChat");
const { CHAR_NAME, USER_NAME } = require("./test-fixtures");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

const metadata = {
  scenario: "Первая встреча в комнате.",
  roleplayRules: "Спокойный, вежливый тон.",
  memoryFacts: `Ранее знаком с ${USER_NAME}.`,
  characterRules: "Не выходить из роли.",
  characterType: "neutral",
  exampleDialogues: '"Подожди." — сказал он.',
  tags: "тест",
};

const systemPrompt = [
  "[CHARITOR_PROMPT_V1]",
  JSON.stringify(metadata),
  "[/CHARITOR_PROMPT_V1]",
  "",
  `Ты — AI-персонаж "${CHAR_NAME}".`,
  "",
  "Биография персонажа:",
  "Краткое описание для теста.",
  "",
  "Сценарий:",
  metadata.scenario,
].join("\n");

const botProfile = {
  full_description: "<p>Описание персонажа для unit-теста.</p>",
  short_description: "Тестовый персонаж",
  tags: "тест",
  greeting_message: '*Кивает.* "Здравствуй."',
};

const def = resolveCharacterDefinition(systemPrompt, botProfile);
assert("biography from full_description", def.biography.includes("Описание персонажа"));
assert("scenario from metadata", def.scenario.includes("Первая встреча"));
assert("personality from metadata", def.personality.includes("Спокойный"));
assert("greeting from profile", def.greetingMessage.includes("Здравствуй"));

const chatProfile = buildBotProfileFromChat({
  bot_full_description: botProfile.full_description,
  bot_short_description: botProfile.short_description,
  bot_tags: botProfile.tags,
  bot_greeting_message: botProfile.greeting_message,
});
assert("chat profile maps db fields", chatProfile.full_description.includes("Описание персонажа"));

const prompt = buildSystemPrompt(systemPrompt, "", CHAR_NAME, USER_NAME, botProfile);
assert("prompt has character definition block", prompt.includes("=== ОПРЕДЕЛЕНИЕ ПЕРСОНАЖА ==="));
assert("prompt includes biography", prompt.includes("Описание персонажа для unit-теста"));
assert("prompt includes personality", prompt.includes("Спокойный, вежливый тон"));
assert("prompt includes scenario", prompt.includes("Первая встреча в комнате"));
assert("prompt includes memory facts", prompt.includes(`Ранее знаком с ${USER_NAME}`));
assert("prompt includes character rules", prompt.includes("Не выходить из роли"));
assert("prompt includes example dialogues", prompt.includes("Подожди"));
assert("prompt includes greeting", prompt.includes("Здравствуй"));
assert("prompt substitutes user token", prompt.includes(USER_NAME));
assert(
  "character block before style rules",
  prompt.indexOf("=== ОПРЕДЕЛЕНИЕ ПЕРСОНАЖА ===") <
    prompt.indexOf("Стиль ответа: художественный"),
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки character definition prompt пройдены.");

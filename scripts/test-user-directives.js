const {
  parseUserMessageDirectives,
  prepareHistoryForLlm,
  formatUserDirectivesForSystemPrompt,
} = require("../js/userMessageDirectives");
const { USER_NAME } = require("./test-fixtures");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

const sample =
  `"Хорошо." — сказала ${USER_NAME}, входя в комнату. [Не говори за {{user}}]`;

const parsed = parseUserMessageDirectives(sample);
assert("extracts directive", parsed.directives[0] === "Не говори за {{user}}");
assert("removes brackets from dialogue", !parsed.dialogue.includes("[Не говори"));
assert("keeps roleplay text", parsed.dialogue.includes(USER_NAME));

const onlyDirective = parseUserMessageDirectives("[Не описывай мои действия]");
assert("directive-only message", onlyDirective.directives.length === 1);
assert("empty dialogue when only brackets", onlyDirective.dialogue === "");

const prepared = prepareHistoryForLlm([
  { role: "user", content: sample },
  { role: "assistant", content: "Ответ бота." },
]);
assert("prepared history has bot reply", prepared.history.length === 2);
assert(
  "prepared user line has no brackets",
  !prepared.history[0].content.includes("[Не говори"),
);
assert("collected directives", prepared.userDirectives.includes("Не говори за {{user}}"));

const prompt = formatUserDirectivesForSystemPrompt(prepared.userDirectives);
assert("system prompt mentions brackets", prompt.includes("квадратных скобках"));
assert("system prompt lists rule", prompt.includes("Не говори за {{user}}"));

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки userMessageDirectives пройдены.");

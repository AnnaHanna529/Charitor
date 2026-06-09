const { substituteChatTokens, resolveUserDisplayName } = require("../js/chatTokens");
const { CHAR_NAME, USER_NAME } = require("./test-fixtures");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

assert(
  "persona name wins",
  resolveUserDisplayName({ personaName: USER_NAME, username: "Anna" }) === USER_NAME,
);
assert(
  "fallback username",
  resolveUserDisplayName({ username: "Anna" }) === "Anna",
);
assert(
  "replace {{user}}",
  substituteChatTokens("— {{user}}?", { personaName: USER_NAME }) === `— ${USER_NAME}?`,
);
assert(
  "case insensitive",
  substituteChatTokens("{{USER}}", { personaName: USER_NAME }) === USER_NAME,
);
assert(
  "replace {{char}}",
  substituteChatTokens("{{char}} улыбнулась", { charName: CHAR_NAME }) ===
    `${CHAR_NAME} улыбнулась`,
);
assert(
  "empty stays",
  substituteChatTokens("Привет", { personaName: USER_NAME }) === "Привет",
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nВсе проверки chatTokens пройдены.");

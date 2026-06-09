/**
 * Проверка единого конвейера валидации ответов бота.
 * node scripts/test-reply-pipeline.js
 */
const fs = require("fs");
const path = require("path");
const {
  isReplyAcceptable,
  finalizeBotReplyText,
  buildHardSafeFallbackReply,
  postProcessGeneratedReply,
  mergeMessageContinuation,
} = require("../config/aiChat");
const {
  hasUserAgencyViolation,
  wouldViolateUserAgency,
  buildPreGenerationUserAgencyUserMessage,
} = require("../config/roleplayFormatRules");
const { CHAR_NAME, USER_NAME } = require("./test-fixtures");

let failed = 0;

function assert(name, ok) {
  console.log(ok ? "OK" : "FAIL", name);
  if (!ok) failed += 1;
}

const badUserAgency =
  `*${USER_NAME} останавливается рядом.*\n\n"Я всегда был любопытным."`;
assert(
  "bad user-agency reply fails isReplyAcceptable",
  !isReplyAcceptable(
    finalizeBotReplyText(badUserAgency),
    CHAR_NAME,
    USER_NAME,
    [{ role: "user", content: "Привет." }],
    [],
  ),
);

const fallback = finalizeBotReplyText(buildHardSafeFallbackReply(CHAR_NAME, [], 0));
assert(
  "fallback reply passes isReplyAcceptable",
  isReplyAcceptable(
    fallback,
    CHAR_NAME,
    USER_NAME,
    [{ role: "user", content: "Привет." }],
    [],
  ),
);

const aiChatSource = fs.readFileSync(
  path.join(__dirname, "../config/aiChat.js"),
  "utf8",
);
assert(
  "generateBotReplyStream uses postProcessStreamedReply",
  /generateBotReplyStream[\s\S]+postProcessStreamedReply/.test(aiChatSource),
);
assert(
  "generateBotReply uses postProcessGeneratedReply",
  /async function generateBotReply[\s\S]+postProcessGeneratedReply/.test(aiChatSource),
);
assert(
  "postProcess no longer uses weaker proxy-only ensureMinimumReplyQuality",
  !/if \(usingProxy\)\s*\{\s*return ensureMinimumReplyQuality/.test(aiChatSource),
);
assert(
  "postProcess always calls enforceReplyQuality",
  /async function postProcessGeneratedReply[\s\S]+await enforceReplyQuality/.test(aiChatSource),
);

assert(
  "postProcessGeneratedReply is exported",
  typeof postProcessGeneratedReply === "function",
);

assert(
  "hasUserAgencyViolation catches user-agency reply",
  hasUserAgencyViolation(badUserAgency, USER_NAME),
);

assert(
  "wouldViolateUserAgency catches early user block",
  wouldViolateUserAgency(`*${USER_NAME} о`, USER_NAME),
);

assert(
  "wouldViolateUserAgency allows bot addressing player",
  !wouldViolateUserAgency(`"${USER_NAME}, что ты имеешь в виду?"`, USER_NAME),
);

assert(
  "pre-generation user gate mentions player name",
  buildPreGenerationUserAgencyUserMessage(USER_NAME, CHAR_NAME).includes(USER_NAME) &&
    buildPreGenerationUserAgencyUserMessage(USER_NAME, CHAR_NAME).includes("✗"),
);

assert(
  "messages append pre-generation user agency gate before LLM",
  /appendPreGenerationUserAgencyGate/.test(aiChatSource) &&
    /generateBotReplyStream[\s\S]*?appendPreGenerationUserAgencyGate/.test(aiChatSource),
);

assert(
  "stream path uses lightweight postProcess without full rewrite fallback",
  /async function generateBotReplyStream[\s\S]*?return postProcessStreamedReply/.test(
    aiChatSource,
  ),
);

assert(
  "streamed reply strips user-agency paragraphs instead of full rewrite",
  /stripUserAgencyViolations/.test(aiChatSource),
);

assert(
  "buildMessagesForLlmApi adds pre-generation reminder",
  /buildPreGenerationUserAgencyReminder\(personaName\)/.test(aiChatSource),
);

const midWordHead =
  "Она вытянула руку и почувствовала незнач";
const midWordTail = "ительное облегчение, когда тот принял предмет.";
const midWordMerged = mergeMessageContinuation(midWordHead, midWordTail);
assert(
  "continue merges mid-word without paragraph break",
  midWordMerged.includes("незначительное") && !midWordMerged.includes("незнач\n\n"),
);

const repeatHead = "Она прокрутила глаза.\n\nОна почувствовала незнач";
const repeatTail =
  "Она прокрутила глаза.\n\nОна почувствовала незначительное облегчение.";
const repeatMerged = mergeMessageContinuation(repeatHead, repeatTail);
assert(
  "continue strips repeated paragraph from tail",
  !repeatMerged.includes("Она прокрутила глаза.\n\nОна прокрутила глаза."),
);

assert(
  "continue strips duplicate paragraphs anywhere in tail",
  (() => {
    const head =
      "Para1.\n\n\"Quote about food?\"\n\n*She sighed and wiped her face.*";
    const tail =
      "*New touch on marble.* \"More about banquet.\"\n\n\"Quote about food?\"\n\n*She sighed and wiped her face.*\n\n*New ending.*";
    const merged = mergeMessageContinuation(head, tail);
    const quoteCount = (merged.match(/Quote about food/g) || []).length;
    return (
      merged.includes("New touch on marble") &&
      merged.includes("New ending") &&
      quoteCount === 1
    );
  })(),
);

if (failed > 0) {
  console.error(`\n${failed} проверок не прошло.`);
  process.exit(1);
}

console.log("\nЕдиный конвейер проверки ответов настроен.");

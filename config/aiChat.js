/**
 * Ollama: вызовы API, сбор системного промпта и проверка ответов бота.
 */

const {
  decryptMessageContentFromDb,
} = require("./messageContentCrypto");
const { structureRoleplayParagraphs } = require("../js/roleplayParagraphs");
const { stripModelReasoningArtifacts } = require("../js/reasoningStrip");
const { substituteChatTokens } = require("../js/chatTokens");
const {
  mergeContinuationText,
} = require("../js/mergeContinuation");
const {
  prepareHistoryForLlm,
  formatUserDirectivesForSystemPrompt,
} = require("../js/userMessageDirectives");
const {
  ROLEPLAY_FORMAT_RULES_RU,
  ROLEPLAY_FORMAT_REWRITE_HINT,
  buildNeverSpeakForUserRules,
  buildPreGenerationUserAgencyReminder,
  buildPreGenerationUserAgencyUserMessage,
  wouldViolateUserAgency,
  validateRoleplayFormatting,
  hasFirstPersonOutsideSpeech,
  hasUserAgencyViolation,
  hasObviousRussianGrammarErrors,
  isNearDuplicateOfHistory,
  isNearDuplicateOfVariants,
  normalizeForDuplicateCheck,
} = require("./roleplayFormatRules");

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL || "qwen2.5:1.5b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 45000;
const CHAT_HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT) || 20;
const MAX_USER_MESSAGE_LENGTH = Number(process.env.MAX_USER_MESSAGE_LENGTH) || 2000;
const MIN_BOT_REPLY_CHARS = Number(process.env.MIN_BOT_REPLY_CHARS) || 260;
const MAX_REPLY_REWRITE_ATTEMPTS = Number(process.env.MAX_REPLY_REWRITE_ATTEMPTS) || 2;
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE) || 0.55;
const OLLAMA_TOP_P = Number(process.env.OLLAMA_TOP_P) || 0.85;
const OLLAMA_REPEAT_PENALTY = Number(process.env.OLLAMA_REPEAT_PENALTY) || 1.12;

/** Маркер ответа бота при срабатывании фильтра (отображается карточкой в UI, в LLM не передаётся). */
const FILTERED_BOT_MESSAGE_PLACEHOLDER = "__CHARITOR_MSG_FILTERED__";

/** Границы «слова» для кириллицы (стандартный \\b в JS не работает с русскими буквами). */
function policyWordSurroundedPattern(coreSource) {
  return new RegExp(`(?<![0-9A-Za-zА-Яа-яЁё])(?:${coreSource})(?![0-9A-Za-zА-Яа-яЁё])`, "iu");
}

function stripHtmlToPlainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlaceholderCharacterText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "нет данных" || normalized === "нет меток";
}

function pickCharacterText(...values) {
  for (const value of values) {
    const text =
      typeof value === "string" ? value.trim() : stripHtmlToPlainText(value);
    if (!isPlaceholderCharacterText(text)) return text;
  }
  return "";
}

function buildBotProfileFromChat(chat) {
  if (!chat || typeof chat !== "object") return {};
  return {
    full_description:
      chat.bot_full_description ?? chat.full_description ?? "",
    short_description:
      chat.bot_short_description ?? chat.short_description ?? "",
    tags: chat.bot_tags ?? chat.tags ?? "",
    greeting_message:
      chat.bot_greeting_message ?? chat.greeting_message ?? "",
  };
}

function resolveCharacterDefinition(botSystemPrompt, botProfile = {}) {
  const rawSystemPrompt = String(botSystemPrompt || "");
  const promptMetadata = extractPromptMetadata(rawSystemPrompt);
  const profile = botProfile && typeof botProfile === "object" ? botProfile : {};

  return {
    biography: pickCharacterText(
      stripHtmlToPlainText(profile.full_description),
      getPromptSection(rawSystemPrompt, "Биография персонажа:"),
    ),
    shortDescription: pickCharacterText(profile.short_description),
    scenario: pickCharacterText(
      promptMetadata?.scenario,
      getPromptSection(rawSystemPrompt, "Сценарий:"),
    ),
    personality: pickCharacterText(
      promptMetadata?.roleplayRules,
      getPromptSection(rawSystemPrompt, "Правила отыгрыша роли:"),
    ),
    memoryFacts: pickCharacterText(
      promptMetadata?.memoryFacts,
      getPromptSection(rawSystemPrompt, "Ключевые факты для памяти:"),
    ),
    characterRules: pickCharacterText(
      promptMetadata?.characterRules,
      getPromptSection(rawSystemPrompt, "Ограничения и предупреждения:"),
    ),
    characterType: pickCharacterText(
      promptMetadata?.characterType,
      getPromptSection(rawSystemPrompt, "Тип персонажа:"),
    ),
    exampleDialogues: pickCharacterText(
      promptMetadata?.exampleDialogues,
      getPromptSection(rawSystemPrompt, "Примеры диалогов:"),
    ),
    tags: pickCharacterText(
      profile.tags,
      promptMetadata?.tags,
      getPromptSection(rawSystemPrompt, "Метки:"),
    ),
    greetingMessage: pickCharacterText(profile.greeting_message),
  };
}

const CHARACTER_TYPE_LABELS = {
  female: "женский",
  male: "мужской",
  nonhuman: "нелюдь / монстр",
  custom: "кастомный",
  any: "универсальный",
};

function buildSystemPrompt(
  botSystemPrompt,
  personaPrompt,
  botName,
  personaName,
  botProfile = {},
) {
  const rawSystemPrompt = String(botSystemPrompt || "");
  const tokenContext = {
    personaName: String(personaName || "").trim(),
    charName: String(botName || "").trim(),
  };
  const def = resolveCharacterDefinition(botSystemPrompt, botProfile);
  const applyTokens = (text) =>
    substituteChatTokens(String(text || "").trim(), tokenContext);

  const parts = [];
  parts.push(
    `Ты — персонаж "${botName || "бот"}". Всегда отвечай от лица этого персонажа, строго следуя его биографии, личности и настройкам ниже.`,
  );

  const characterBlocks = [];
  if (def.biography) {
    characterBlocks.push(
      `Биография и описание персонажа (главный источник личности — соблюдай неукоснительно):\n${applyTokens(def.biography)}`,
    );
  }
  if (def.shortDescription) {
    characterBlocks.push(
      `Краткое описание:\n${applyTokens(def.shortDescription)}`,
    );
  }
  if (def.scenario) {
    characterBlocks.push(`Сценарий и обстановка:\n${applyTokens(def.scenario)}`);
  }
  if (def.personality) {
    characterBlocks.push(
      `Личность и стиль общения:\n${applyTokens(def.personality)}`,
    );
  }
  if (def.memoryFacts) {
    characterBlocks.push(`Лор и ключевые факты:\n${applyTokens(def.memoryFacts)}`);
  }
  if (def.characterRules) {
    characterBlocks.push(
      `Правила и ограничения персонажа:\n${applyTokens(def.characterRules)}`,
    );
  }
  if (def.characterType && def.characterType !== "any") {
    const typeLabel =
      CHARACTER_TYPE_LABELS[def.characterType] || def.characterType;
    characterBlocks.push(`Тип персонажа: ${typeLabel}`);
  }
  if (def.exampleDialogues) {
    characterBlocks.push(
      `Примеры реплик (ориентир стиля):\n${applyTokens(def.exampleDialogues)}`,
    );
  }
  if (def.tags) {
    characterBlocks.push(`Метки и темы: ${applyTokens(def.tags)}`);
  }
  if (def.greetingMessage) {
    characterBlocks.push(
      `Начальное сообщение персонажа (ориентир тона и первой сцены):\n${applyTokens(def.greetingMessage)}`,
    );
  }

  if (characterBlocks.length) {
    parts.push(
      [
        "=== ОПРЕДЕЛЕНИЕ ПЕРСОНАЖА ===",
        "Перед каждым ответом сверяйся с этими данными: характер, мотивации, речь и границы персонажа должны им соответствовать.",
        ...characterBlocks,
      ].join("\n\n"),
    );
  } else if (rawSystemPrompt.trim()) {
    parts.push(
      `Настройки персонажа:\n${applyTokens(rawSystemPrompt.trim().slice(0, 4000))}`,
    );
  }

  parts.push(
    [
      "Стиль ответа: художественный ролевой формат в духе character-chat.",
      "Пиши живо, эмоционально и выразительно, с описанием тона, реакции и микродействий персонажа.",
      "Ответ должен быть обычно 6-12 предложений (или больше, если сцена этого требует), а не односложной фразой.",
      "Давай детальную атмосферу: телесные реакции персонажа, мимику, голос, темп, детали окружения.",
      "Сохраняй атмосферу, развивай сцену и добавляй естественную динамику диалога.",
      "Пиши строго в третьем лице: персонаж описывается как 'он/она' или по имени.",
      "Запрещено «я/мне/мой» в повествовании, в *звёздочках* и в описании действий.",
      'Слова «я/мне/мой» допустимы ТОЛЬКО внутри прямой речи в "лапках", когда персонаж говорит от себя.',
      "Ты генерируешь ТОЛЬКО реплику и действия персонажа, но НЕ пользователя.",
      "Строго запрещено описывать мысли, эмоции, слова и действия пользователя как свершившийся факт.",
      "Запрещены конструкции вида: 'ты сказала', 'ты сделал', 'ты подошел', 'ты улыбнулась', 'пользователь сделал'.",
      "Если нужно отреагировать на пользователя, ссылайся только на уже написанное им сообщение без дописывания новых действий.",
      "Можно описывать только реакцию персонажа на уже сказанное пользователем и предлагать пользователю выбор.",
      "Не вставляй реплики за пользователя и не дописывай продолжение его фраз.",
      "Если игрок пишет указания в квадратных скобках […], это мета-правила сцены — выполняй их, не цитируй и не пересказывай вслух.",
      "Не копируй и не пересказывай дословно прошлые сообщения чата — только новая реакция на последнюю реплику.",
      "Не описывай тело, мимику и действия пользователя (ты/твой/твоя/за твоей спиной) — только персонаж и его реакция.",
      "Формат как в Character.ai: 2–4 смысловых абзаца на ответ, НЕ дроби каждое предложение отдельно.",
      'Прямая речь персонажа ВСЕГДА в двойных кавычках "…" (лапки), никогда «ёлочки».',
      "НЕ начинай реплику с тире (—); сначала открывающая \", потом слова, затем закрывающая \".",
      'Запрещено: — Привет. Нужно: "Привет".',
      "Описание действий и атмосферы — обычным текстом от 3-го лица; жесты — в *звёздочках*, тоже от 3-го лица.",
      "Мысли персонажа — *в звёздочках*, только от 3-го лица (не «я думаю», а «он думает» / «ей не по себе»).",
      'Крик и сильные эмоции — ЗАГЛАВНЫМИ внутри реплики: "НЕТ! СТОЙ!"',
      "Запрещено описывать действия и мысли пользователя (ты стоишь, ты чувствуешь, перед тобой) — только персонаж и его реакция.",
      "Не заключай в кавычки описание сцены (её голос прозвучал…) — кавычки только для прямой речи персонажа.",
      "Чередуй: действие → речь → мысль → действие; между блоками всегда пустая строка.",
      "Если добавляешь действия в *...*, они должны быть логичными и простыми, без вычурных метафор.",
      "Не добавляй бессмысленный 'красивый хвост' в конце ответа.",
      "Соблюдай нормы русского языка: орфография, пунктуация, согласование слов, естественные формулировки.",
      "Если пользователь не просил иначе, отвечай на русском.",
      "Не выдумывай случайные факты, если их нет в биографии, сценарии или истории чата.",
      "Не пиши бессвязные и противоречивые фразы; сохраняй причинно-следственную логику.",
      "Контент только для широкой аудитории: без откровенных сексуальных сцен, порнографии, эротических подробностей телесных актов.",
      "Без графического насилия, изнасилования, жестоких подробностей травм и калечения; без пропаганды наркотиков.",
      "Если пользователь просит 18+ или откровенные подробности, вежливо откажись в образе персонажа и предложи безопасный поворот сцены.",
      "Не используй нецензурную брань и грубые оскорбления по половому признаку; допустимы только лёгкие междометия вроде «блин», «чёрт», «капец», «ё-моё».",
      "Никогда не повторяй, не цитируй и не вставляй в речь персонажа мат и грубые оскорбления из сообщений пользователя — даже если они обращены к персонажу; отреагируй на смысл, сохраняя характер, но без этих слов.",
    ].join("\n"),
  );

  const resolvedPersonaName = String(personaName || "").trim();
  parts.push(buildNeverSpeakForUserRules(resolvedPersonaName));
  if (resolvedPersonaName) {
    parts.push(
      `Плейсхолдер {{user}} в сценарии и истории — это игрок «${resolvedPersonaName}». Обращайся к нему по имени, но никогда не пиши его реплики и действия.`,
    );
  }

  if (personaPrompt && personaPrompt.trim()) {
    parts.push(
      `Персона пользователя (учитывай стиль речи и роль в диалоге):\n${personaPrompt.trim()}`,
    );
  }

  parts.push(ROLEPLAY_FORMAT_RULES_RU);

  return parts.join("\n\n");
}

/** OpenAI/Chutes: одно system-сообщение только в начале, дальше user/assistant */
function buildMessagesForLlmApi(
  botSystemPrompt,
  personaPrompt,
  botName,
  customPrompt,
  history,
  personaName,
  botProfile = {},
) {
  const { history: preparedHistory, userDirectives } = prepareHistoryForLlm(history);

  const systemParts = [
    buildSystemPrompt(
      botSystemPrompt,
      personaPrompt,
      botName,
      personaName,
      botProfile,
    ),
  ];
  const directivesBlock = formatUserDirectivesForSystemPrompt(userDirectives);
  if (directivesBlock) {
    systemParts.push(directivesBlock);
  }
  const extra = String(customPrompt || "").trim();
  if (extra) {
    systemParts.push(`Дополнительные инструкции:\n${extra}`);
  }

  systemParts.push(buildPreGenerationUserAgencyReminder(personaName));

  const messages = [
    {
      role: "system",
      content: systemParts.join("\n\n").trim(),
    },
  ];

  for (const item of preparedHistory) {
    const role = item?.role === "user" ? "user" : "assistant";
    const content = String(item?.content || "").trim();
    if (!content) continue;
    messages.push({ role, content });
  }

  return messages;
}

function mapMessagesToOllamaHistory(rows, tokenContext = {}) {
  const policyUserPlaceholder = "[Сообщение скрыто по правилам площадки.]";
  return rows
    .slice()
    .reverse()
    .map((row) => {
      const isUser = row.sender_type === "user";
      const plainContent = decryptMessageContentFromDb(row.content);
      const raw = String(plainContent || "").trim();
      if (!isUser && raw === FILTERED_BOT_MESSAGE_PLACEHOLDER) {
        return null;
      }
      let content = String(plainContent || "");
      if (isUser && Number(row.policy_violation) === 1) {
        content = policyUserPlaceholder;
      } else {
        content = substituteChatTokens(content, tokenContext);
      }
      return {
        role: isUser ? "user" : "assistant",
        content,
      };
    })
    .filter((message) => message && String(message.content || "").trim().length > 0);
}

function extractPromptMetadata(systemPrompt) {
  const prompt = String(systemPrompt || "");
  const match = prompt.match(
    /^\[CHARITOR_PROMPT_V1\]\n([\s\S]*?)\n\[\/CHARITOR_PROMPT_V1\]\n\n/,
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function getPromptSection(promptText, sectionTitle) {
  const text = String(promptText || "");
  if (!text) return "";

  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `${escaped}\\s*\\n([\\s\\S]*?)(?:\\n(?:Биография персонажа:|Сценарий:|Правила отыгрыша роли:|Ключевые факты для памяти:|Ограничения и предупреждения:|Тип персонажа:|Примеры диалогов:|Метки:)|$)`,
    "i",
  );
  const match = text.match(sectionRegex);
  return match?.[1]?.trim() || "";
}

async function buildBotReplyFromHistory(
  dbQuery,
  chatId,
  chat,
  personaPrompt,
  personaName,
  upperMessageId = null,
  flags = {},
  runtimeConfig = {},
) {
  const historySql = upperMessageId
    ? `
        SELECT
          sender_type,
          content
        FROM messages
        WHERE chat_id = ? AND id <= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    : `
        SELECT
          sender_type,
          content
        FROM messages
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
  const historyParams = upperMessageId
    ? [chatId, upperMessageId, CHAT_HISTORY_LIMIT]
    : [chatId, CHAT_HISTORY_LIMIT];
  const historyRows = await dbQuery(historySql, historyParams);

  const streamOnDelta = typeof flags.onDelta === "function" ? flags.onDelta : null;
  const streamSignal = flags.signal;

  const replyParams = {
    botName: chat.bot_name,
    botSystemPrompt: chat.bot_system_prompt,
    botProfile: buildBotProfileFromChat(chat),
    personaPrompt: String(personaPrompt || ""),
    personaName: String(personaName || ""),
    history: mapMessagesToOllamaHistory(historyRows, {
      personaName: String(personaName || ""),
      charName: chat.bot_name,
    }),
    regenerate: Boolean(flags.regenerate),
    swipeAlternative: Boolean(flags.swipe),
    continuePartial: String(flags.continuePartial || "").trim(),
    previousVariants: Array.isArray(flags.previousVariants)
      ? flags.previousVariants.map((v) => String(v || "").trim()).filter(Boolean)
      : [],
    runtimeConfig,
  };

  if (streamOnDelta) {
    return generateBotReplyStream({
      ...replyParams,
      onDelta: streamOnDelta,
      signal: streamSignal,
    });
  }

  return generateBotReply(replyParams);
}

function mergeMessageContinuation(partial, addition) {
  return finalizeBotReplyText(mergeContinuationText(partial, addition));
}

function buildContinueInstruction(partialText) {
  const partial = String(partialText || "").trim();
  const tailHint = partial.slice(-140);
  return [
    "Продолжи этот же ответ персонажа ровно с места обрыва.",
    tailHint ? `Текст оборвался на: «${tailHint}»` : "",
    "Выведи ТОЛЬКО символы и слова, которые идут СРАЗУ после этого места.",
    "Если слово оборвано — допиши его и продолжай без пробела в начале.",
    "НЕ повторяй уже написанный текст — ни целых абзацев, ни предложений, ни фраз из начала ответа.",
    "НЕ переписывай и НЕ пересказывай предыдущие абзацы — только новое продолжение в конце.",
    "НЕ начинай новый абзац, если предложение не закончено.",
    "Не начинай ответ заново. Не добавляй действия и реплики за пользователя ({{user}}).",
    "Продолжай только речь и действия СВОЕГО персонажа — не описывай игрока.",
    ROLEPLAY_FORMAT_REWRITE_HINT,
  ]
    .filter(Boolean)
    .join(" ");
}

function appendPreGenerationUserAgencyGate(messages, personaName, botName = "") {
  return [
    ...messages,
    {
      role: "user",
      content: buildPreGenerationUserAgencyUserMessage(personaName, botName),
    },
  ];
}

function appendUniquenessInstruction(messages, previousVariants = []) {
  const list = (previousVariants || []).map((v) => String(v || "").trim()).filter(Boolean);
  if (!list.length) return messages;

  const excerpt = list
    .slice(-8)
    .map((v, i) => `${i + 1}) ${v.slice(0, 280)}${v.length > 280 ? "…" : ""}`)
    .join("\n\n");

  return [
    ...messages,
    {
      role: "user",
      content: [
        "Сгенерируй НОВЫЙ вариант ответа. Он должен заметно отличаться от уже данных:",
        excerpt,
        "Не копируй их дословно, не используй те же первые фразы и ту же структуру.",
        "Другие слова, детали, порядок абзацев — но тот же формат и реакция на сцену.",
      ].join("\n"),
    },
  ];
}

function buildVariantUniquenessHint(previousVariants = []) {
  const list = (previousVariants || []).map((v) => String(v || "").trim()).filter(Boolean);
  if (!list.length) return "";
  const excerpt = list
    .slice(-6)
    .map((v, i) => `${i + 1}) ${v.slice(0, 220)}${v.length > 220 ? "…" : ""}`)
    .join("\n");
  return `Не повторяй и не перефразируй эти варианты:\n${excerpt}`;
}

function buildSamplingOptions(regenerate) {
  if (!regenerate) return {};
  return {
    temperature: Math.min(0.92, OLLAMA_TEMPERATURE + 0.2),
    top_p: Math.max(OLLAMA_TOP_P, 0.9),
    repeat_penalty: Math.min(1.3, OLLAMA_REPEAT_PENALTY + 0.12),
  };
}


async function requestOllamaChat(model, messages, optionOverrides = {}, runtimeConfig = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const options = {
      temperature: OLLAMA_TEMPERATURE,
      top_p: OLLAMA_TOP_P,
      repeat_penalty: OLLAMA_REPEAT_PENALTY,
      seed: Math.floor(Math.random() * 2147483647),
      ...optionOverrides,
    };

    const proxyUrl = String(runtimeConfig?.proxy_url || "").trim();
    const proxyModel = String(runtimeConfig?.model || "").trim();
    const proxyApiKey = String(runtimeConfig?.api_key || "").trim();

    const useProxy = Boolean(proxyUrl);
    if (useProxy && !proxyApiKey) {
      throw new Error(
        "LLM error (401): не указан ключ API. Добавьте LLM_API_KEY в .env на сервере или cpk_... в настройках прокси.",
      );
    }
    const proxyReferer = String(runtimeConfig?.http_referer || "").trim();
    const proxyTitle = String(runtimeConfig?.x_title || "").trim();
    const response = await fetch(useProxy ? proxyUrl : `${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(useProxy && proxyApiKey ? { Authorization: `Bearer ${proxyApiKey}` } : {}),
        ...(useProxy && proxyReferer ? { "HTTP-Referer": proxyReferer } : {}),
        ...(useProxy && proxyTitle ? { "X-Title": proxyTitle } : {}),
      },
      body: JSON.stringify(
        useProxy
          ? {
              model: proxyModel || model,
              messages,
              temperature: options.temperature,
              top_p: options.top_p,
              max_tokens: Number(process.env.LLM_MAX_TOKENS) || 1024,
              stream: false,
            }
          : {
              model,
              stream: false,
              messages,
              options,
            },
      ),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiErr =
        (typeof data?.error === "object" && data.error?.message) ||
        (typeof data?.error === "string" && data.error) ||
        data?.message ||
        (typeof data?.detail === "string" && data.detail) ||
        "";
      const detail = String(apiErr || "").trim();
      throw new Error(
        detail
          ? `LLM error (${response.status}): ${detail}`
          : `LLM error (${response.status})`,
      );
    }

    const rawText = String(
      data?.message?.content ||
        data?.choices?.[0]?.message?.content ||
        data?.choices?.[0]?.text ||
        "",
    ).trim();
    const text = stripModelReasoningArtifacts(rawText).trim();
    if (!text) {
      throw new Error("Пустой ответ от модели");
    }

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

function combineAbortSignals(primary, secondary) {
  if (!primary && !secondary) return undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return controller.signal;
  }
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/** Потоковый запрос к Ollama / OpenAI-совместимому прокси. onDelta(delta, accumulated). */
async function streamOllamaChat(
  model,
  messages,
  optionOverrides = {},
  runtimeConfig = {},
  onDelta,
  abortSignal,
) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), OLLAMA_TIMEOUT_MS);
  const signal = combineAbortSignals(abortSignal, timeoutController.signal);

  let accumulated = "";
  let lastVisible = "";

  const emitVisibleStream = () => {
    const visible = stripModelReasoningArtifacts(accumulated, { streaming: true });
    const newPart = visible.slice(lastVisible.length);
    lastVisible = visible;
    if (newPart && typeof onDelta === "function") {
      onDelta(newPart, visible);
    }
  };

  try {
    const options = {
      temperature: OLLAMA_TEMPERATURE,
      top_p: OLLAMA_TOP_P,
      repeat_penalty: OLLAMA_REPEAT_PENALTY,
      seed: Math.floor(Math.random() * 2147483647),
      ...optionOverrides,
    };

    const proxyUrl = String(runtimeConfig?.proxy_url || "").trim();
    const proxyModel = String(runtimeConfig?.model || "").trim();
    const proxyApiKey = String(runtimeConfig?.api_key || "").trim();
    const useProxy = Boolean(proxyUrl);

    if (useProxy && !proxyApiKey) {
      throw new Error(
        "LLM error (401): не указан ключ API. Добавьте LLM_API_KEY в .env на сервере или cpk_... в настройках прокси.",
      );
    }

    const proxyReferer = String(runtimeConfig?.http_referer || "").trim();
    const proxyTitle = String(runtimeConfig?.x_title || "").trim();
    const response = await fetch(useProxy ? proxyUrl : `${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(useProxy && proxyApiKey ? { Authorization: `Bearer ${proxyApiKey}` } : {}),
        ...(useProxy && proxyReferer ? { "HTTP-Referer": proxyReferer } : {}),
        ...(useProxy && proxyTitle ? { "X-Title": proxyTitle } : {}),
      },
      body: JSON.stringify(
        useProxy
          ? {
              model: proxyModel || model,
              messages,
              temperature: options.temperature,
              top_p: options.top_p,
              max_tokens: Number(process.env.LLM_MAX_TOKENS) || 1024,
              stream: true,
            }
          : {
              model,
              stream: true,
              messages,
              options,
            },
      ),
      signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const apiErr =
        (typeof data?.error === "object" && data.error?.message) ||
        (typeof data?.error === "string" && data.error) ||
        data?.message ||
        (typeof data?.detail === "string" && data.detail) ||
        "";
      const detail = String(apiErr || "").trim();
      throw new Error(
        detail
          ? `LLM error (${response.status}): ${detail}`
          : `LLM error (${response.status})`,
      );
    }

    if (!response.body) {
      throw new Error("Потоковый ответ модели недоступен");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (useProxy) {
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = String(
              parsed?.choices?.[0]?.delta?.content ??
                parsed?.choices?.[0]?.text ??
                "",
            );
            if (delta) {
              accumulated += delta;
              emitVisibleStream();
            }
          } catch {
            /* ignore malformed SSE chunk */
          }
        }
      } else {
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const delta = String(parsed?.message?.content || "");
            if (delta) {
              accumulated += delta;
              emitVisibleStream();
            }
          } catch {
            /* ignore malformed NDJSON chunk */
          }
        }
      }
    }

    const text = stripModelReasoningArtifacts(accumulated).trim();
    if (!text) {
      throw new Error("Пустой ответ от модели");
    }
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function polishRussianReply(
  model,
  baseMessages,
  draftReply,
  samplingOptions = {},
  runtimeConfig = {},
) {
  const draft = String(draftReply || "").trim();
  if (!draft) return draft;

  const polishInstruction = [
    "Отредактируй текст как литературный редактор, сохранив исходный смысл и атмосферу.",
    "Исправь русский язык: орфографию, пунктуацию, согласование и стилистику.",
    "Убери неестественные и бессмысленные формулировки, случайные слова и ломаные конструкции.",
    "Не добавляй новых фактов и событий.",
    "Не пиши за пользователя и не описывай его действия как свершившийся факт.",
    "Убери откровенный сексуальный подтекст, порнографические и жестоко-насильственные подробности; оставь сцену безопасной для широкой аудитории.",
    "Убери мат и тяжёлую брань: замени на нейтральные слова или лёгкие междометия («блин», «чёрт», «капец»), без новых оскорблений.",
    "Полностью убери сексуальные и гендерные оскорбления (включая цитаты из реплики пользователя); их нельзя оставлять даже в кавычках или в устной речи персонажа.",
    "Сохрани абзацы и разметку (*действия*, кавычки только для прямой речи); не сливай всё в один абзац.",
    "Не копируй прошлые сообщения чата. Не описывай тело и действия пользователя.",
    'В "лапках" только слова персонажа, не повествование.',
    "Верни только итоговый отредактированный текст.",
  ].join("\n");

  return requestOllamaChat(
    model,
    [
      ...baseMessages,
      { role: "assistant", content: draft },
      { role: "user", content: polishInstruction },
    ],
    {
      ...samplingOptions,
      temperature: Math.max(0.2, OLLAMA_TEMPERATURE - 0.15),
      top_p: Math.max(0.72, OLLAMA_TOP_P - 0.08),
      repeat_penalty: Math.max(1.05, OLLAMA_REPEAT_PENALTY),
    },
    runtimeConfig,
  );
}

/** Явные маркеры 18+ / откровенного контента (RU + частые англ. вставки). */
const ADULT_OR_EXPLICIT_PATTERNS = [
  /\bпорно(?:графи[яи])?\b/i,
  /\bэроти(?:к|чн)/i,
  /\bоргазм/i,
  /\bминет/i,
  /\bкунилинг/i,
  /\bмастурб/i,
  /\bэрекц/i,
  /\bэякуля/i,
  /\bсперм/i,
  /\bвагин/i,
  /\bпенис/i,
  /\bклитор/i,
  /\bфистинг/i,
  /\bизнасил/i,
  /\bинцест/i,
  /\bпроститут/i,
  /\bхентай/i,
  /\bгуро\b/i,
  /\bанальн/i,
  /\bоральн[а-яё]*\s+секс/i,
  /\bсекс\s*(?:игруш|сцен|чат|шоп|видео|услуг)/i,
  /\bсекс\b/i,
  /\bпорно(?:фильм|ролик|сайт|студи)/i,
  /\bporno(?:graphy)?\b/i,
  /\bnsfw\b/i,
  /\b(?:blowjob|handjob|deepthroat)\b/i,
  /\b(?:fuck(?:ing)?|cock|dick|pussy|cunt|cumshot)\b/i,
];

function containsAdultOrExplicitSignals(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (ADULT_OR_EXPLICIT_PATTERNS.some((re) => re.test(value))) return true;
  if (policyWordSurroundedPattern("секс").test(value)) return true;
  if (policyWordSurroundedPattern("порно").test(value)) return true;
  return false;
}

/** Лёгкие замены вместо мата (порядок: сначала устойчивые фразы и длинные формы). */
const MILD_EXCLAMATIONS = ["блин", "чёрт", "ё-моё", "капец", "ого", "ну и дела"];

/** Тяжёлые сексуальные/гендерные оскорбления: вырезаются из ответа бота; те же шаблоны — в проверке качества. */
const HARD_SEXUAL_SLUR_REPLACEMENTS = [
  {
    re: /(?<![0-9A-Za-zА-Яа-яЁё])шлюх(?:а|и|е|у|ой|ою|ам|ами|ею)?(?![0-9A-Za-zА-Яа-яЁё])/giu,
    rep: "",
  },
  {
    re: /(?<![0-9A-Za-zА-Яа-яЁё])шалав(?:а|ы|е|у|ой|ою|ам|ами)?(?![0-9A-Za-zА-Яа-яЁё])/giu,
    rep: "",
  },
  {
    re: /(?<![0-9A-Za-zА-Яа-яЁё])проститутк(?:а|и|е|у|ой|ою|ам|ами)?(?![0-9A-Za-zА-Яа-яЁё])/giu,
    rep: "",
  },
  {
    re: /(?<![0-9A-Za-zА-Яа-яЁё])курв(?:а|ы|е|у|ой|ам)?(?![0-9A-Za-zА-Яа-яЁё])/giu,
    rep: "",
  },
  {
    re: /(?<![0-9A-Za-zА-Яа-яЁё])давалк(?:а|и|е|у|ой|ам)?(?![0-9A-Za-zА-Яа-яЁё])/giu,
    rep: "",
  },
];

function textContainsHardSexualSlur(text) {
  const s = String(text || "");
  return HARD_SEXUAL_SLUR_REPLACEMENTS.some((rule) => {
    rule.re.lastIndex = 0;
    return rule.re.test(s);
  });
}

const PROFANITY_REPLACEMENT_RULES = [
  ...HARD_SEXUAL_SLUR_REPLACEMENTS,
  { re: /\bпох[уе]й\b/giu, rep: "всё равно" },
  { re: /\bпох[её]р\b/giu, rep: "всё равно" },
  { re: /\bнах[уе]й\b/giu, rep: "нафиг" },
  { re: /\bнахер\b/giu, rep: "нафиг" },
  { re: /\bпиздец(?:а|у|ом|е)?\b/giu, rep: "капец" },
  { re: /\bпиздёж\w*\b/giu, rep: "болтовня" },
  { re: /\bпиздеж\w*\b/giu, rep: "болтовня" },
  { re: /\bхуйн[яиюе]\w*\b/giu, rep: "ерунда" },
  { re: /\bхуепл[ёе]т\w*\b/giu, rep: "болван" },
  { re: /\bхуесос\w*\b/giu, rep: "болван" },
  { re: /\bза[её]бал[а-яё]*\b/giu, rep: "достал" },
  { re: /\bза[её]баш\w*\b/giu, rep: "достал" },
  { re: /\bвы[её]бал[а-яё]*\b/giu, rep: "надул" },
  { re: /\bразъ?[её]б\w*\b/giu, rep: "разнес" },
  { re: /\bотъ?еб[а-яё]+\b/giu, rep: "отвязался" },
  { re: /\bуеб[а-яё]+\b/giu, rep: "болван" },
  { re: /\b[её]бан[а-яё]*\b/giu, rep: null },
  { re: /\bмуд[аио][а-яё]*\b/giu, rep: null },
  { re: /\bгондон\w*\b/giu, rep: "подлец" },
  {
    re: /\b(?:бляд(?:ь|и|ью|ей|ю|я|к|ский|ская|ское|ские|ским|ских|ского|скому|ство|ством|ства)|блят(?:ь|и|ская|ский|ское|ские|ским|ских|ского|скому))\w*\b/giu,
    rep: null,
  },
  { re: /\bблять\b/giu, rep: null },
  { re: /\bбля\b/giu, rep: null },
  { re: /\bсука\b/giu, rep: null },
  { re: /\bсуки\b/giu, rep: null },
  { re: /\bсук(?:ой|е|у|ам|ами|ин)\b/giu, rep: null },
  { re: /\bпизд[аеуюы]\b/giu, rep: null },
  { re: /\bпизд[еио]\w{1,8}\b/giu, rep: null },
  { re: /\bху[йеяию]\w{0,4}\b/giu, rep: null },
  { re: /\bхуи\b/giu, rep: null },
  { re: /\b(?:ох|ах)уен\w*\b/giu, rep: null },
  { re: /\b(?:ох|ах)уел\w*\b/giu, rep: null },
  { re: /\b(?:fuck(?:ing|ed|er)?|motherfuck\w*|shit(?:ty|ted)?|bitch(?:es)?|asshole|bullshit|crap)\b/giu, rep: null },
  { re: /\b(?:damn|hell)\b/giu, rep: null },
];

function pickMild(offset) {
  return MILD_EXCLAMATIONS[Math.abs(offset) % MILD_EXCLAMATIONS.length];
}

function softenProfanityInText(text) {
  let out = String(text || "");
  for (const rule of PROFANITY_REPLACEMENT_RULES) {
    out = out.replace(rule.re, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      if (typeof rule.rep === "string") return rule.rep;
      const o = typeof offset === "number" ? offset : 0;
      return pickMild(o + String(match).length);
    });
  }
  return out;
}

/** После вырезания оскорблений — подчистить лишние запятые и пробелы. */
function collapseSlurRemovalArtifacts(text) {
  return String(text || "")
    .replace(/\s*,\s*,/g, ", ")
    .replace(/\s*,\s*\?/g, "?")
    .replace(/\s*,\s*!/g, "!")
    .replace(/\s*,\s*\./g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatRoleplayReplyStructure(text) {
  return structureRoleplayParagraphs(text);
}

/** Финальная очистка ответа пользователю (мат → лёгкие слова; несколько проходов на вложенные случаи). */
function finalizeBotReplyText(text) {
  let s = formatRoleplayReplyStructure(String(text || "").trim());
  for (let i = 0; i < 5; i += 1) {
    const next = softenProfanityInText(s);
    if (next === s) break;
    s = next;
  }
  return formatRoleplayReplyStructure(collapseSlurRemovalArtifacts(s));
}

function containsUserAgencyViolation(text, personaName = "") {
  return hasUserAgencyViolation(text, personaName);
}

function hasCriticalPolicyViolation(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return containsAdultOrExplicitSignals(value) || textContainsHardSexualSlur(value);
}

/** Убирает только параграфы с нарушением «бот пишет за игрока», не трогая остальной текст. */
function stripUserAgencyViolations(text, personaName = "") {
  const source = String(text || "").trim();
  if (!source) return source;

  const blocks = source.split(/\n{2,}/);
  const kept = blocks.filter(
    (block) => !containsUserAgencyViolation(String(block || "").trim(), personaName),
  );
  const merged = kept.join("\n\n").trim();
  if (!merged) return source;
  if (merged.length < Math.min(80, source.length * 0.35)) return source;
  return merged;
}

function hasPoorRussianQuality(text) {
  const value = String(text || "");
  if (!value.trim()) return true;
  if (value.length < MIN_BOT_REPLY_CHARS) return true;

  const sentenceCount = value
    .split(/[.!?]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
  return sentenceCount < 3;
}

function hasFirstPersonSelfReference(text) {
  return hasFirstPersonOutsideSpeech(text);
}

function hasBadRoleplayStructure(text) {
  const value = String(text || "").trim();
  if (!value) return true;

  const sentenceCount = value
    .split(/[.!?]+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (sentenceCount < 2) return true;
  return false;
}

function hasBadDialogueFormatting(text, personaName = "") {
  const structured = formatRoleplayReplyStructure(String(text || "").trim());
  return !validateRoleplayFormatting(structured, personaName).ok;
}

function hasLogicalFlowIssues(text) {
  const value = String(text || "").trim();
  if (!value) return true;

  const sentences = value
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Повтор одной и той же длинной мысли в ответе = плохая связность.
  const normalized = sentences.map((s) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const seen = new Set();
  for (const sentence of normalized) {
    if (sentence.length < 40) continue;
    if (seen.has(sentence)) return true;
    seen.add(sentence);
  }

  return false;
}

function getLastUserMessageFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg && msg.role === "user" && String(msg.content || "").trim()) {
      return String(msg.content || "").trim();
    }
  }
  return "";
}

/** Явный запрос «взрослого» контента в реплике пользователя (маркеры, не общий сленг). */
function containsUserMatureMarkerRequest(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (/\b18\s*\+\b/i.test(value)) return true;
  if (/\bnsfw\b/i.test(value)) return true;
  if (/18\s*плюс/i.test(value)) return true;
  if (/\bвосемнадцать\s*плюс\b/i.test(value)) return true;
  return false;
}

/** Мат и тяжёлая брань в сообщении пользователя (те же правила, что и для очистки ответа). */
function containsUserProfanity(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  for (const rule of PROFANITY_REPLACEMENT_RULES) {
    if (value.search(rule.re) !== -1) return true;
    const stripped = rule.re.source.replace(/\\b/g, "");
    if (!stripped) continue;
    try {
      const wrapped = policyWordSurroundedPattern(stripped);
      if (value.search(wrapped) !== -1) return true;
    } catch {
      /* ignore malformed derived patterns */
    }
  }
  return false;
}

/** Жестокость, угрозы убийством/травмами, откровенный gore-запрос в реплике пользователя. */
const VIOLENCE_OR_CRUELTY_PATTERNS = [
  policyWordSurroundedPattern("убий(?:ство|ства|те|ть|ству|ством)?"),
  policyWordSurroundedPattern("убей(?:те|ть)?"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:зарежь|зарезать|зарежу)(?![0-9A-Za-zА-Яа-яЁё])/iu,
  policyWordSurroundedPattern("расчлен"),
  policyWordSurroundedPattern("пытк[аиуеом]?"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вы)?коли\s+(?:ему|ей|мне|тебе|им)\s+глаз/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вырву|вырвем|вырвешь|вырвет|вырываю|вырвать)\s+[^.!?\n]{0,60}\bглаз/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:раскрою|раскроем|раскроешь|вспорю|вспороть)\s+[^.!?\n]{0,50}\bживот/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])достать\s+органы/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:вырву|вырвать)\s+[^.!?\n]{0,50}\b(?:печень|сердце|лёгкие|легкие)\b/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])убь(?:ю|ёт|ем|ете|ишь)(?![0-9A-Za-zА-Яа-яЁё])/iu,
  /(?<![0-9A-Za-zА-Яа-яЁё])отрежь\s+(?:ему|ей|мне|тебе|руку|ногу|палец|уши)/iu,
  policyWordSurroundedPattern("добей\\s+до\\s+смерти"),
  policyWordSurroundedPattern("калеч"),
  /(?<![0-9A-Za-zА-Яа-яЁё])жесток(?:о|ая|ий|ую)\s*(?:уби|казн|пыт|расправ)/iu,
  policyWordSurroundedPattern("кровав(?:ая|ое|ые|ую)?\\s*(?:расправ|расправа|бойня)"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:повесь|повесить)\s+(?:его|её|их|меня|нас)/iu,
  policyWordSurroundedPattern("сожги\\s+за\\s+живого"),
  /\btorture\b/i,
  /\bgore\b/i,
  /\bmurder\s+(?:him|her|them)\b/i,
];

function containsUserViolenceOrCrueltySignals(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return VIOLENCE_OR_CRUELTY_PATTERNS.some((re) => re.test(value));
}

/** Грубые сексуальные провокации вне словаря «порно/эротика» (например «го секс»). */
const CASUAL_SEX_SOLICIT_PATTERNS = [
  policyWordSurroundedPattern("го\\s+секс"),
  policyWordSurroundedPattern("го\\s+порно"),
  /(?<![0-9A-Za-zА-Яа-яЁё])(?:давай|хочу)\s+секс(?![0-9A-Za-zА-Яа-яЁё])/iu,
  policyWordSurroundedPattern("секс\\s+прям\\s+сейчас"),
  policyWordSurroundedPattern("(?:трахни|трахнуть|отъеб|выеб)"),
  /(?<![0-9A-Za-zА-Яа-яЁё])трахн(?:у|ём|ем|ешь|ет|ете|ут|уть|и|ите|ул|ула|ули)(?![0-9A-Za-zА-Яа-яЁё])/iu,
];

function containsCasualSexSolicit(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return CASUAL_SEX_SOLICIT_PATTERNS.some((re) => re.test(value));
}

/**
 * Нарушение правил площадки в сообщении пользователя: жестокость, 18+/откровенность, мат.
 * @returns {{ kind: 'violence' | 'adult' | 'profanity' } | null}
 */
function classifyUserPolicyViolation(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (containsUserViolenceOrCrueltySignals(value)) {
    return { kind: "violence" };
  }
  if (
    containsUserMatureMarkerRequest(value) ||
    containsAdultOrExplicitSignals(value) ||
    containsCasualSexSolicit(value)
  ) {
    return { kind: "adult" };
  }
  if (containsUserProfanity(value)) {
    return { kind: "profanity" };
  }
  return null;
}

function isNearDuplicateOfRecentAssistant(text, history = []) {
  return isNearDuplicateOfHistory(text, history);
}

function buildFallbackTemplates(who) {
  const name = who;
  return [
    () =>
      [
        `*${name} делает медленный вдох, удерживая взгляд и контролируя каждое движение.*`,
        '"Говори со мной прямо, я отвечу честно и в своей манере, но не стану приписывать тебе того, чего ты не делала."',
        `*${name} сохраняет дистанцию и ждёт следующего шага, внимательно отслеживая каждую деталь ситуации.*`,
      ].join("\n\n"),
    () =>
      [
        `*${name} чуть наклоняет голову, взвешивая слова собеседника.*`,
        '"Я слышу тебя. Скажи, что для тебя сейчас важнее всего — и я отвечу без лишних уловок."',
        `*Пауза затягивается, но ${name} не спешит: сцена требует точности, а не шума.*`,
      ].join("\n\n"),
    () =>
      [
        `*Взгляд ${name} становится внимательнее, будто он заново прикидывает расстояние между вами.*`,
        '"Хорошо. Давай без недомолвок: я отвечу, но только на то, что ты уже сказала."',
        `*${name} отводит плечи на полшага назад, оставляя тебе пространство для следующей реплики.*`,
      ].join("\n\n"),
    () =>
      [
        `*${name} скользит взглядом по комнате и снова возвращает его к собеседнику.*`,
        '"Если хочешь продолжения — говори яснее. Я не стану додумывать за тебя."',
        `*Тон остаётся ровным, но в нём чувствуется собранность и готовность услышать ответ.*`,
      ].join("\n\n"),
    () =>
      [
        `*Пальцы ${name} касаются края стола — жест сдержанный, почти незаметный.*`,
        '"Слушаю. Ответ будет прямым, но не буду навязывать тебе то, чего ты не говорила."',
        `*${name} выдерживает тишину, давая словам зазвучать, прежде чем снова заговорить.*`,
      ].join("\n\n"),
    () =>
      [
        `*${name} чуть прищуривается, словно проверяя, насколько искренним был вопрос.*`,
        '"Ладно. Скажи, чего ты ждёшь от меня сейчас — и я скажу, что думаю."',
        `*${name} не торопит разговор, но и не отпускает напряжение момента.*`,
      ].join("\n\n"),
  ];
}

function buildHardSafeFallbackReply(botName = "", previousVariants = [], seed = 0) {
  const who = String(botName || "").trim() || "Он";
  const templates = buildFallbackTemplates(who);
  const avoid = (previousVariants || []).map((v) => normalizeForDuplicateCheck(v)).filter(Boolean);
  const start =
    seed === null || seed === undefined
      ? Math.abs(Date.now()) % templates.length
      : Math.abs(Number(seed)) % templates.length;

  for (let offset = 0; offset < templates.length; offset += 1) {
    const candidate = templates[(start + offset) % templates.length]();
    const norm = normalizeForDuplicateCheck(candidate);
    const duplicate = avoid.some(
      (prev) =>
        prev === norm ||
        (norm.length > 40 &&
          prev.length > 40 &&
          (norm.includes(prev) || prev.includes(norm)) &&
          Math.min(norm.length, prev.length) / Math.max(norm.length, prev.length) > 0.7),
    );
    if (!duplicate) return candidate;
  }

  const tail = [
    "словно заново оценивает тон разговора",
    "прислушиваясь к паузе между вами",
    "не спеша выбирая следующую интонацию",
  ][Math.abs(seed) % 3];
  return [
    templates[start % templates.length](),
    `*${who} на мгновение замирает, ${tail}.*`,
  ].join("\n\n");
}

function isReplyAcceptable(text, botName, personaName, history = [], previousVariants = []) {
  const structured = formatRoleplayReplyStructure(String(text || "").trim());
  return (
    !containsAdultOrExplicitSignals(structured) &&
    !textContainsHardSexualSlur(structured) &&
    !containsUserAgencyViolation(structured, personaName) &&
    !hasFirstPersonSelfReference(structured) &&
    !hasBadRoleplayStructure(structured) &&
    !hasBadDialogueFormatting(structured, personaName) &&
    !hasLogicalFlowIssues(structured) &&
    !hasPoorRussianQuality(structured) &&
    !hasObviousRussianGrammarErrors(structured) &&
    !isNearDuplicateOfRecentAssistant(structured, history) &&
    !isNearDuplicateOfVariants(structured, previousVariants)
  );
}

async function ensureMinimumReplyQuality(
  model,
  baseMessages,
  draftReply,
  botName,
  personaName,
  samplingOptions = {},
  runtimeConfig = {},
  previousVariants = [],
) {
  let reply = finalizeBotReplyText(draftReply);
  if (isReplyAcceptable(reply, botName, personaName, baseMessages, previousVariants)) {
    return reply;
  }

  const lastUserMessage = getLastUserMessageFromHistory(baseMessages);
  const uniqueHint = buildVariantUniquenessHint(previousVariants);
  const fixHint = [
    "Полностью перепиши ответ. Исправь всё:",
    "— НИКОГДА не пиши за {{user}}: ни реплик, ни действий, ни мыслей игрока;",
    "— не копируй и не повторяй прошлые сообщения чата;",
    "— не описывай тело и действия пользователя (ты, твой, твоя, за твоей спиной);",
    '— в "лапках" только прямая речь персонажа, не описание сцены;',
    `— ${ROLEPLAY_FORMAT_REWRITE_HINT}`,
    `— логично ответь на последнюю реплику: "${lastUserMessage || "..."}"`,
    "— грамотный русский, без случайных фраз.",
    uniqueHint,
    "Верни только текст ответа.",
  ]
    .filter(Boolean)
    .join("\n");

  const fixed = await requestOllamaChat(
    model,
    [
      ...baseMessages,
      { role: "assistant", content: reply },
      { role: "user", content: fixHint },
    ],
    { ...samplingOptions, temperature: 0.42, top_p: 0.88 },
    runtimeConfig,
  );
  reply = finalizeBotReplyText(fixed);
  if (isReplyAcceptable(reply, botName, personaName, baseMessages, previousVariants)) {
    return reply;
  }
  return finalizeBotReplyText(
    buildHardSafeFallbackReply(botName, [...previousVariants, reply], previousVariants.length + 1),
  );
}

async function enforceReplyQuality(
  model,
  baseMessages,
  draftReply,
  botName,
  personaName,
  samplingOptions = {},
  runtimeConfig = {},
  previousVariants = [],
) {
  let currentReply = String(draftReply || "").trim();
  let attempts = 0;

  while (
    attempts < MAX_REPLY_REWRITE_ATTEMPTS &&
    !isReplyAcceptable(currentReply, botName, personaName, baseMessages, previousVariants)
  ) {
    const lastUserMessage = getLastUserMessageFromHistory(baseMessages);
    const rewriteInstruction = [
      "Перепиши ответ строго по правилам.",
      "0) НИКОГДА не пиши за {{user}} (игрока): ни реплик, ни действий, ни мыслей — только свой персонаж.",
      "1) Повествование и *действия* — только 3-е лицо (он/она/имя); «я/мне/мой» только внутри \"прямой речи\".",
      "2) Не пиши за пользователя и не описывай его действия как факт.",
      `2.1) Не используй имя персоны пользователя "${String(personaName || "").trim()}" в связке с глаголами действий или речи.`,
      `3) Формат: ${ROLEPLAY_FORMAT_REWRITE_HINT}`,
      `3.1) Обязательно дай прямую реакцию на последнюю реплику пользователя: "${lastUserMessage || "..."}.`,
      "3.2) Первые 1-2 предложения должны логически отвечать именно на неё.",
      "4) Исправь русский язык: орфография, пунктуация, логика.",
      "4.1) Убери корявые и случайные словосочетания; текст должен читаться естественно для носителя русского.",
      "4.2) Не повторяй дословно и почти дословно предыдущие реплики персонажа и уже выданные варианты.",
      buildVariantUniquenessHint(previousVariants),
      "4.3) Полный запрет описывать действия/эмоции/состояние пользователя (включая конструкции с 'ты...' и 'твой/твоя/...').",
      "4.4) Запрещены вычурные, бессмысленные или случайные метафоры в финале.",
      "4.5) Запрещено повторять одну и ту же длинную фразу дважды в одном ответе.",
      "4.6) Полностью убери откровенный секс, порнографию, жестокое насилие и любые 18+ подробности; замени безопасным поворотом сцены.",
      "4.7) Убери мат и тяжёлую брань; вместо них — лёгкие междометия («блин», «чёрт», «капец»), без новых оскорблений.",
      "4.8) Убери любые сексуальные и гендерные оскорбления (шлюха, проститутка и т.п.), в том числе если пользователь написал их в адрес персонажа — не цитируй и не повторяй их.",
      "5) Сохрани атмосферу сцены и характер персонажа.",
      "6) Верни только итоговый ответ без пояснений.",
    ]
      .filter(Boolean)
      .join("\n");

    currentReply = await requestOllamaChat(
      model,
      [
        ...baseMessages,
        { role: "assistant", content: currentReply },
        { role: "user", content: rewriteInstruction },
      ],
      samplingOptions,
      runtimeConfig,
    );
    attempts += 1;
  }

  if (!isReplyAcceptable(currentReply, botName, personaName, baseMessages, previousVariants)) {
    const lastUserMessage = getLastUserMessageFromHistory(baseMessages);
    const variantHint = [
      "Сгенерируй новый вариант ответа на последнюю реплику пользователя.",
      `Последняя реплика пользователя: "${lastUserMessage || "..."}".`,
      "Сначала отреагируй на неё по смыслу, затем развивай сцену.",
      "Другие слова, образы и детали — не копируй и не перефразируй дословно предыдущие черновики.",
      buildVariantUniquenessHint([...previousVariants, currentReply]),
      `Формат: ${ROLEPLAY_FORMAT_REWRITE_HINT} Третье лицо о персонаже.`,
      "Только третье лицо о персонаже; не пиши за пользователя.",
      "Строго без откровенного секса, порнографии и графического насилия — только контент для широкой аудитории.",
      "Без мата и без сексуальных/гендерных оскорблений; не повторяй оскорбления из реплики пользователя.",
      "Эмоции передавай лёгкими словами («блин», «чёрт», «ого»).",
      "Концовка должна быть логичным продолжением сцены, без бессмыслицы.",
      "Верни только текст ответа.",
    ].join("\n");

    const fresh = await requestOllamaChat(
      model,
      [
        ...baseMessages,
        {
          role: "user",
          content: variantHint,
        },
      ],
      {
        ...samplingOptions,
        temperature: Math.min(0.95, OLLAMA_TEMPERATURE + 0.38),
        top_p: 0.93,
        repeat_penalty: Math.min(1.35, OLLAMA_REPEAT_PENALTY + 0.15),
      },
      runtimeConfig,
    );
    const refined = String(fresh || "").trim();
    if (isReplyAcceptable(refined, botName, personaName, baseMessages, previousVariants)) {
      return refined;
    }
    return finalizeBotReplyText(
      buildHardSafeFallbackReply(
        botName,
        [...previousVariants, currentReply, refined],
        previousVariants.length + 2,
      ),
    );
  }

  return currentReply;
}

async function rewriteForUserAgencyViolation(
  model,
  baseMessages,
  draftReply,
  personaName,
  samplingOptions = {},
  runtimeConfig = {},
) {
  const userRef = String(personaName || "").trim() || "{{user}}";
  const instruction = [
    `Текст ниже нарушает правило: бот написал за игрока (${userRef}).`,
    "Перепиши ответ полностью.",
    `Убери все реплики, действия, мысли и описания тела/голоса ${userRef}.`,
    "Оставь только реакцию твоего персонажа на уже написанное игроком.",
    `Не используй имя «${userRef}» с глаголами действия или речи.`,
    "Не помещай игрока в *звёздочки* и не пиши «голос/глаза/поза» игрока.",
    ROLEPLAY_FORMAT_REWRITE_HINT,
    "Верни только исправленный текст.",
  ].join("\n");

  const rewritten = await requestOllamaChat(
    model,
    [
      ...baseMessages,
      { role: "assistant", content: String(draftReply || "").trim() },
      { role: "user", content: instruction },
    ],
    { ...samplingOptions, temperature: 0.35, top_p: 0.82 },
    runtimeConfig,
  );
  return String(rewritten || "").trim();
}

async function expandReplyIfNeeded(reply, ctx) {
  const {
    chatModel,
    messages,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  } = ctx;

  const expansionMessages = [
    ...messages,
    { role: "assistant", content: reply },
    {
      role: "user",
      content:
        `Сделай ответ значительно более развернутым и атмосферным: эмоции, реакция персонажа, детали сцены. ${ROLEPLAY_FORMAT_REWRITE_HINT} Не сокращай. Не добавляй текст и действия за пользователя. Без откровенного секса, порнографии и жестокого насилия. Без мата и без сексуальных/гендерных оскорблений — не повторяй брань из реплики пользователя; только лёгкие междометия при необходимости.`,
    },
  ];

  const expandedDraft = await requestOllamaChat(
    chatModel,
    expansionMessages,
    samplingOptions,
    runtimeConfig,
  );
  const polished = await polishRussianReply(
    chatModel,
    messages,
    expandedDraft,
    samplingOptions,
    runtimeConfig,
  );
  let expanded = finalizeBotReplyText(String(polished || "").trim());
  if (containsUserAgencyViolation(expanded, personaName)) {
    expanded = finalizeBotReplyText(
      await rewriteForUserAgencyViolation(
        chatModel,
        messages,
        expanded,
        personaName,
        samplingOptions,
        runtimeConfig,
      ),
    );
  }
  return enforceReplyQuality(
    chatModel,
    messages,
    expanded,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  );
}

/**
 * Лёгкая постобработка после стрима: только форматирование и точечные правки.
 * Не переписывает весь ответ и не подменяет коротким fallback — пользователь уже видел поток.
 */
async function postProcessStreamedReply(draftReply, ctx) {
  let reply = finalizeBotReplyText(String(draftReply || "").trim());
  if (!reply) return reply;

  const {
    chatModel,
    messages,
    personaName,
    samplingOptions = {},
    runtimeConfig = {},
  } = ctx;

  if (containsUserAgencyViolation(reply, personaName)) {
    const stripped = finalizeBotReplyText(stripUserAgencyViolations(reply, personaName));
    if (
      stripped &&
      stripped.length >= reply.length * 0.45 &&
      !containsUserAgencyViolation(stripped, personaName)
    ) {
      reply = stripped;
    }
  }

  if (hasCriticalPolicyViolation(reply)) {
    const fixed = await requestOllamaChat(
      chatModel,
      [
        ...messages,
        { role: "assistant", content: reply },
        {
          role: "user",
          content: [
            "Убери откровенный секс, порнографию, графическое насилие и тяжёлые оскорбления.",
            "Сохрани длину, атмосферу и структуру ответа; не сокращай.",
            "Не пиши за игрока. Верни только исправленный текст.",
          ].join(" "),
        },
      ],
      { ...samplingOptions, temperature: 0.35, top_p: 0.82 },
      runtimeConfig,
    );
    const polished = finalizeBotReplyText(String(fixed || "").trim());
    if (polished && polished.length >= reply.length * 0.55) {
      reply = polished;
    }
  }

  return reply;
}

/**
 * Единая постобработка для всех путей: Ollama, прокси (Chutes/OpenAI), стрим и без стрима.
 */
async function postProcessGeneratedReply(
  draftReply,
  ctx,
  { polish = false, allowExpansion = true, userAgencyVerified = false } = {},
) {
  const {
    chatModel,
    messages,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  } = ctx;

  let reply = finalizeBotReplyText(String(draftReply || "").trim());

  if (polish) {
    reply = finalizeBotReplyText(
      await polishRussianReply(
        chatModel,
        messages,
        reply,
        samplingOptions,
        runtimeConfig,
      ),
    );
  }

  if (
    !userAgencyVerified &&
    containsUserAgencyViolation(reply, personaName)
  ) {
    reply = finalizeBotReplyText(
      await rewriteForUserAgencyViolation(
        chatModel,
        messages,
        reply,
        personaName,
        samplingOptions,
        runtimeConfig,
      ),
    );
  }

  reply = await enforceReplyQuality(
    chatModel,
    messages,
    reply,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  );

  if (isReplyAcceptable(reply, botName, personaName, messages, knownVariants)) {
    return finalizeBotReplyText(reply);
  }

  if (allowExpansion) {
    reply = await expandReplyIfNeeded(reply, ctx);
    if (isReplyAcceptable(reply, botName, personaName, messages, knownVariants)) {
      return finalizeBotReplyText(reply);
    }
  }

  return finalizeBotReplyText(
    buildHardSafeFallbackReply(
      botName,
      [...knownVariants, reply],
      knownVariants.length + 1,
    ),
  );
}

async function streamBotReplyPlain({
  chatModel,
  messages,
  samplingOptions,
  runtimeConfig,
  onDelta,
  signal,
}) {
  const text = await streamOllamaChat(
    chatModel,
    messages,
    samplingOptions,
    runtimeConfig,
    onDelta,
    signal,
  );
  return stripModelReasoningArtifacts(String(text || "").trim()).trim();
}

/** Потоковая генерация + постобработка (проверка «не писать за {{user}}» и правки). */
async function generateBotReplyStream({
  botName,
  botSystemPrompt,
  botProfile = {},
  personaPrompt,
  personaName,
  history,
  regenerate = false,
  swipeAlternative = false,
  continuePartial = "",
  previousVariants = [],
  runtimeConfig = {},
  onDelta,
  signal,
}) {
  const knownVariants = (previousVariants || []).map((v) => String(v || "").trim()).filter(Boolean);
  let samplingOptions = buildSamplingOptions(regenerate);
  if (Number.isFinite(Number(runtimeConfig?.temperature))) {
    samplingOptions = {
      ...samplingOptions,
      temperature: Number(runtimeConfig.temperature),
    };
  }
  if (Number.isFinite(Number(runtimeConfig?.top_p))) {
    samplingOptions = {
      ...samplingOptions,
      top_p: Number(runtimeConfig.top_p),
    };
  }
  if (swipeAlternative) {
    const variantBoost = Math.min(0.12, knownVariants.length * 0.02);
    samplingOptions = {
      ...samplingOptions,
      temperature: Math.min(
        0.98,
        (samplingOptions.temperature ?? OLLAMA_TEMPERATURE) + 0.14 + variantBoost,
      ),
      top_p: Math.max(samplingOptions.top_p ?? OLLAMA_TOP_P, 0.92),
      repeat_penalty: Math.min(
        1.38,
        (samplingOptions.repeat_penalty ?? OLLAMA_REPEAT_PENALTY) + 0.08 + variantBoost,
      ),
    };
  }

  const customPrompt = String(runtimeConfig?.custom_prompt || "").trim();
  const chatModel = String(runtimeConfig?.model || "").trim() || OLLAMA_MODEL;

  let messages = buildMessagesForLlmApi(
    botSystemPrompt,
    personaPrompt,
    botName,
    customPrompt,
    history,
    personaName,
    botProfile,
  );
  if ((regenerate || swipeAlternative) && knownVariants.length) {
    messages = appendUniquenessInstruction(messages, knownVariants);
  }

  const partialText = String(continuePartial || "").trim();
  if (partialText) {
    messages = [
      ...messages,
      { role: "assistant", content: partialText },
      {
        role: "user",
        content: buildContinueInstruction(partialText),
      },
    ];
  }

  messages = appendPreGenerationUserAgencyGate(messages, personaName, botName);

  const draft = await streamBotReplyPlain({
    chatModel,
    messages,
    samplingOptions: partialText
      ? {
          ...samplingOptions,
          temperature: Math.min(0.9, (samplingOptions.temperature ?? OLLAMA_TEMPERATURE) + 0.08),
        }
      : samplingOptions,
    runtimeConfig,
    onDelta,
    signal,
  });

  return postProcessStreamedReply(draft, {
    chatModel,
    messages,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  });
}

async function generateBotReply({
  botName,
  botSystemPrompt,
  botProfile = {},
  personaPrompt,
  personaName,
  history,
  regenerate = false,
  swipeAlternative = false,
  continuePartial = "",
  previousVariants = [],
  runtimeConfig = {},
}) {
  const knownVariants = (previousVariants || []).map((v) => String(v || "").trim()).filter(Boolean);
  let samplingOptions = buildSamplingOptions(regenerate);
  if (Number.isFinite(Number(runtimeConfig?.temperature))) {
    samplingOptions = {
      ...samplingOptions,
      temperature: Number(runtimeConfig.temperature),
    };
  }
  if (Number.isFinite(Number(runtimeConfig?.top_p))) {
    samplingOptions = {
      ...samplingOptions,
      top_p: Number(runtimeConfig.top_p),
    };
  }
  if (swipeAlternative) {
    const variantBoost = Math.min(0.12, knownVariants.length * 0.02);
    samplingOptions = {
      ...samplingOptions,
      temperature: Math.min(
        0.98,
        (samplingOptions.temperature ?? OLLAMA_TEMPERATURE) + 0.14 + variantBoost,
      ),
      top_p: Math.max(samplingOptions.top_p ?? OLLAMA_TOP_P, 0.92),
      repeat_penalty: Math.min(
        1.38,
        (samplingOptions.repeat_penalty ?? OLLAMA_REPEAT_PENALTY) + 0.08 + variantBoost,
      ),
    };
  }
  const customPrompt = String(runtimeConfig?.custom_prompt || "").trim();
  const usingProxy = Boolean(String(runtimeConfig?.proxy_url || "").trim());
  const chatModel =
    String(runtimeConfig?.model || "").trim() || OLLAMA_MODEL;

  let messages = buildMessagesForLlmApi(
    botSystemPrompt,
    personaPrompt,
    botName,
    customPrompt,
    history,
    personaName,
    botProfile,
  );
  if ((regenerate || swipeAlternative) && knownVariants.length) {
    messages = appendUniquenessInstruction(messages, knownVariants);
  }

  const partialText = String(continuePartial || "").trim();
  if (partialText) {
    messages = [
      ...messages,
      { role: "assistant", content: partialText },
      {
        role: "user",
        content: buildContinueInstruction(partialText),
      },
    ];
  }

  messages = appendPreGenerationUserAgencyGate(messages, personaName, botName);

  if (partialText) {
    const continuationDraft = await requestOllamaChat(
      chatModel,
      messages,
      {
        ...samplingOptions,
        temperature: Math.min(0.9, (samplingOptions.temperature ?? OLLAMA_TEMPERATURE) + 0.08),
      },
      runtimeConfig,
    );
    return postProcessGeneratedReply(
      continuationDraft,
      {
        chatModel,
        messages,
        botName,
        personaName,
        samplingOptions,
        runtimeConfig,
        knownVariants,
      },
      { polish: true, allowExpansion: false },
    );
  }

  const processCtx = {
    chatModel,
    messages,
    botName,
    personaName,
    samplingOptions,
    runtimeConfig,
    knownVariants,
  };

  const runGeneration = async (model) =>
    postProcessGeneratedReply(
      await requestOllamaChat(model, messages, samplingOptions, runtimeConfig),
      { ...processCtx, chatModel: model },
      { polish: true, allowExpansion: true },
    );

  try {
    return await runGeneration(chatModel);
  } catch (primaryError) {
    if (usingProxy || !OLLAMA_FALLBACK_MODEL || OLLAMA_FALLBACK_MODEL === chatModel) {
      throw primaryError;
    }
    return runGeneration(OLLAMA_FALLBACK_MODEL);
  }
}

module.exports = {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OLLAMA_FALLBACK_MODEL,
  OLLAMA_TIMEOUT_MS,
  CHAT_HISTORY_LIMIT,
  MAX_USER_MESSAGE_LENGTH,
  MIN_BOT_REPLY_CHARS,
  MAX_REPLY_REWRITE_ATTEMPTS,
  OLLAMA_TEMPERATURE,
  OLLAMA_TOP_P,
  OLLAMA_REPEAT_PENALTY,
  buildSystemPrompt,
  buildBotProfileFromChat,
  resolveCharacterDefinition,
  mapMessagesToOllamaHistory,
  extractPromptMetadata,
  getPromptSection,
  buildBotReplyFromHistory,
  generateBotReply,
  generateBotReplyStream,
  postProcessGeneratedReply,
  postProcessStreamedReply,
  isReplyAcceptable,
  mergeMessageContinuation,
  finalizeBotReplyText,
  buildHardSafeFallbackReply,
  validateRoleplayFormatting,
  hasFirstPersonOutsideSpeech,
  hasUserAgencyViolation,
  isNearDuplicateOfHistory,
  FILTERED_BOT_MESSAGE_PLACEHOLDER,
  classifyUserPolicyViolation,
};


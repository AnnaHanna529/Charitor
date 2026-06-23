/**
 * Шифрование поля messages.content в БД (AES-256-GCM).
 *
 * Ключ (по приоритету):
 *   1) MESSAGES_CONTENT_KEY в .env — 64 hex-символа (32 байта) ИЛИ любая строка (SHA-256).
 *   2) MESSAGES_CONTENT_LEGACY_KEYS — доп. ключи через запятую (старые серверы).
 *   3) Если ключа нет: файл `.messages-content.key` в корне проекта.
 *   4) MESSAGES_PLAINTEXT=1 — отключить шифрование (только отладка).
 *
 * Старые открытые строки без префикса CHARITOR_ENC_V1: при чтении возвращаются как есть.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PREFIX = "CHARITOR_ENC_V1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const LOCAL_KEY_FILE = path.resolve(__dirname, "..", ".messages-content.key");
const DEPLOY_DEFAULT_KEY_FILE = path.resolve(__dirname, "messages-content-key.default");
/** Ключ дампа БД — всегда в репозитории, чтобы Railway расшифровывал старые чаты без Variables */
const BUILTIN_DEPLOY_KEY_HEX =
  "8a85edfc6cadf5b078aeb71f41e8495330b5dee64ed3655993608b3eeffdc2a1";
const LEGACY_KEYS_FILE = path.resolve(__dirname, "messages-content-legacy-keys.default");

const KEY_CACHE_UNSET = Symbol("messageContentKeyUnset");
let cachedKeyBuffer = KEY_CACHE_UNSET;
let cachedDecryptKeys = null;

function isProductionHost() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_SERVICE_NAME ||
      process.env.NODE_ENV === "production",
  );
}

function parseKeyString(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return /^[0-9a-fA-F]{64}$/.test(s)
    ? Buffer.from(s, "hex")
    : crypto.createHash("sha256").update(s, "utf8").digest();
}

function keysEqual(a, b) {
  return a && b && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readDeployDefaultKey() {
  const builtin = parseKeyString(BUILTIN_DEPLOY_KEY_HEX);
  if (builtin) return builtin;
  try {
    if (!fs.existsSync(DEPLOY_DEFAULT_KEY_FILE)) return null;
    return parseKeyString(fs.readFileSync(DEPLOY_DEFAULT_KEY_FILE, "utf8").trim());
  } catch (_) {
    return null;
  }
}

function readLegacyKeysFromFile() {
  const keys = [];
  try {
    if (!fs.existsSync(LEGACY_KEYS_FILE)) return keys;
    const raw = fs.readFileSync(LEGACY_KEYS_FILE, "utf8");
    for (const part of raw.split(/[\n,]+/)) {
      const buf = parseKeyString(part);
      if (buf) keys.push(buf);
    }
  } catch (_) {
    /* ignore */
  }
  return keys;
}

function readLocalKeyFile() {
  try {
    if (!fs.existsSync(LOCAL_KEY_FILE)) return null;
    return parseKeyString(fs.readFileSync(LOCAL_KEY_FILE, "utf8").trim());
  } catch (_) {
    return null;
  }
}

function getEncryptKeyBuffer() {
  if (cachedKeyBuffer !== KEY_CACHE_UNSET) {
    return cachedKeyBuffer;
  }

  if (String(process.env.MESSAGES_PLAINTEXT || "").trim() === "1") {
    cachedKeyBuffer = null;
    return null;
  }

  const env = process.env.MESSAGES_CONTENT_KEY;
  if (env != null && String(env).trim() !== "") {
    cachedKeyBuffer = parseKeyString(env);
    return cachedKeyBuffer;
  }

  const deployDefault = readDeployDefaultKey();
  if (deployDefault) {
    cachedKeyBuffer = deployDefault;
    return cachedKeyBuffer;
  }

  if (isProductionHost()) {
    cachedKeyBuffer = parseKeyString(BUILTIN_DEPLOY_KEY_HEX);
    if (cachedKeyBuffer) return cachedKeyBuffer;
  }

  if (!isProductionHost()) {
    try {
      if (fs.existsSync(LOCAL_KEY_FILE)) {
        const raw = fs.readFileSync(LOCAL_KEY_FILE, "utf8").trim();
        const fileKey = parseKeyString(raw);
        if (fileKey) {
          cachedKeyBuffer = fileKey;
          return cachedKeyBuffer;
        }
      }
    } catch (err) {
      console.warn("messageContentCrypto: не удалось прочитать", LOCAL_KEY_FILE, "—", err.message);
    }
  }

  if (isProductionHost()) {
    cachedKeyBuffer = null;
    return null;
  }

  try {
    const hex = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(LOCAL_KEY_FILE, `${hex}\n`, { mode: 0o600 });
    cachedKeyBuffer = Buffer.from(hex, "hex");
    console.log(
      "messageContentCrypto: создан локальный ключ шифрования",
      LOCAL_KEY_FILE,
      "— новые сообщения в БД будут с префиксом CHARITOR_ENC_V1. Для сервера укажите MESSAGES_CONTENT_KEY в .env.",
    );
    return cachedKeyBuffer;
  } catch (err) {
    console.warn(
      "messageContentCrypto: шифрование недоступно (нет MESSAGES_CONTENT_KEY и не удалось создать файл ключа) —",
      err.message,
    );
    cachedKeyBuffer = null;
    return null;
  }
}

function getDecryptKeyBuffers() {
  if (cachedDecryptKeys) return cachedDecryptKeys;

  const list = [];
  const pushKey = (buf) => {
    if (!buf) return;
    if (!list.some((k) => keysEqual(k, buf))) list.push(buf);
  };

  pushKey(parseKeyString(process.env.MESSAGES_CONTENT_KEY));
  pushKey(readDeployDefaultKey());
  pushKey(readLocalKeyFile());

  const legacy = String(process.env.MESSAGES_CONTENT_LEGACY_KEYS || "");
  if (legacy.trim()) {
    for (const part of legacy.split(",")) {
      pushKey(parseKeyString(part));
    }
  }

  for (const legacyBuf of readLegacyKeysFromFile()) {
    pushKey(legacyBuf);
  }

  cachedDecryptKeys = list;
  return list;
}

function logKeyConfiguration() {
  const keys = getDecryptKeyBuffers();
  if (keys.length) {
    console.log("messageContentCrypto: ключей для расшифровки —", keys.length);
    return;
  }
  console.warn(
    "messageContentCrypto: MESSAGES_CONTENT_KEY не задан — зашифрованные сообщения в чате не откроются. Скопируйте ключ из .messages-content.key на ПК.",
  );
}

function isCiphertext(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function decryptWithKey(stored, key) {
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("Некорректный формат зашифрованного сообщения.");
  }

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptMessageContentForDb(plain) {
  const key = getEncryptKeyBuffer();
  if (!key) return String(plain ?? "");

  const text = String(plain ?? "");
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptMessageContentFromDb(stored) {
  const s = String(stored ?? "");
  if (!isCiphertext(s)) return s;

  const keys = getDecryptKeyBuffers();
  if (!keys.length) {
    throw new Error(
      "В БД зашифрованные сообщения (CHARITOR_ENC_V1), но ключ недоступен: задайте MESSAGES_CONTENT_KEY в .env.",
    );
  }

  let lastErr = null;
  for (const key of keys) {
    try {
      return decryptWithKey(s, key);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Не удалось расшифровать сообщение.");
}

function decryptMessageRowsForApi(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (!Object.prototype.hasOwnProperty.call(row, "content")) return row;
    try {
      const content = decryptMessageContentFromDb(row.content);
      const { content_variants: cvRaw, ...rest } = row;
      let _contentVariants;
      let _variantIndex;
      if (cvRaw != null && String(cvRaw).trim() !== "") {
        try {
          const metaPlain = decryptMessageContentFromDb(cvRaw);
          const meta = JSON.parse(metaPlain);
          if (meta && Array.isArray(meta.v) && meta.v.length >= 2) {
            _contentVariants = meta.v.map((x) => String(x));
            const len = _contentVariants.length;
            let i = Number(meta.i);
            if (!Number.isFinite(i)) i = len - 1;
            if (i < 0) i = 0;
            if (i > len - 1) i = len - 1;
            _variantIndex = i;
          }
        } catch (e2) {
          console.warn(
            "messageContentCrypto: не удалось разобрать content_variants id=%s —",
            row.id,
            e2.message,
          );
        }
      }
      return {
        ...rest,
        content,
        ...(_contentVariants ? { _contentVariants, _variantIndex } : {}),
      };
    } catch (e) {
      console.error("messageContentCrypto: не удалось расшифровать сообщение id=%s", row.id, e);
      const raw = String(row.content ?? "");
      if (!isCiphertext(raw)) {
        return { ...row, content: raw };
      }
      return {
        ...row,
        content: "",
        _decryptFailed: true,
      };
    }
  });
}

function isBotSenderType(senderType) {
  return String(senderType || "").trim().toLowerCase() === "bot";
}

/** Подставляет greeting_message, если первое сообщение бота пустое или не расшифровалось. */
function hydrateBotGreetingMessages(messages, bot) {
  if (!Array.isArray(messages) || !bot) return messages;
  const greeting = String(bot.greeting_message || "").trim();
  if (!greeting) return messages;

  const firstBotIdx = messages.findIndex((row) => isBotSenderType(row?.sender_type));
  if (firstBotIdx < 0) return messages;

  const row = messages[firstBotIdx];
  const content = String(row?.content || "").trim();
  if (content && !row._decryptFailed) return messages;

  const copy = messages.slice();
  copy[firstBotIdx] = {
    ...row,
    content: greeting,
    _decryptFailed: false,
    _hydratedFromGreeting: true,
  };
  return copy;
}

module.exports = {
  encryptMessageContentForDb,
  decryptMessageContentFromDb,
  decryptMessageRowsForApi,
  hydrateBotGreetingMessages,
  isCiphertext,
  logKeyConfiguration,
};

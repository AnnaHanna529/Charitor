/**
 * Убирает служебные блоки рассуждений модели (Qwen/Chutes и др.), чтобы в чат
 * не попадали «шаги» и chain-of-thought.
 */
function stripModelReasoningArtifacts(text, { streaming = false } = {}) {
  let result = String(text || "");

  result = result
    .replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");

  if (streaming) {
    result = result.replace(/<think>[\s\S]*$/gi, "");
    result = result.replace(/<think(?:ing)?>[\s\S]*$/gi, "");
    result = result.replace(/<(?:redacted_thinking|think(?:ing)?)(?:\s[^>]*)?$/gi, "");
  } else {
    result = result.replace(/[\s\S]*?<\/think(?:ing)?>/gi, "");
    result = result.replace(/<\/think(?:ing)?>/gi, "");
  }

  return result;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { stripModelReasoningArtifacts };
}

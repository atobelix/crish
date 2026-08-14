/**
 * xmlSanitizer — XML 净化、敏感标签转义与 Prompt 沙箱包装器。
 *
 * 依据 PLAN-ROUND-3-03 §6.3 与 PLAN-ROUND-3-04 规范：
 * - 拦截 LLM Prompt 注入与 XML 定界符劫持；
 * - 强制将第三方 Plugin Skill 的输出封装在 `<plugin_skill_sandbox>` 隔离沙箱中；
 * - 转义内部敏感系统标签（如 `<system>`, `<instructions>`, `<developer>`, `<context>`, `<agent>`）；
 * - 防御沙箱闭合标签逃逸（Breakout Defense）。
 */

const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const XML_UNESCAPE_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * 转义 XML 基础特殊字符 (&, <, >, ", ')
 */
export function escapeXml(value: string): string {
  if (!value) return '';
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}

/**
 * 还原 XML 基础转义字符
 */
export function unescapeXml(value: string): string {
  if (!value) return '';
  return value.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => XML_UNESCAPE_MAP[entity] ?? entity
  );
}

/**
 * 规范化并校验 XML 标签名，移除非法字符（仅允许 [a-zA-Z_][a-zA-Z0-9._-]*）
 */
export function sanitizeXmlTagName(name: string): string {
  if (!name) return 'sandbox';
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (/^[0-9.-]/.test(clean)) {
    return `tag_${clean}`;
  }
  return clean || 'sandbox';
}

/**
 * 格式化并转义 XML 属性键值对列表
 */
export function sanitizeXmlAttributes(
  attrs?: Record<string, string | number | boolean | undefined | null>
): string {
  if (!attrs) return '';
  const entries = Object.entries(attrs).filter(
    ([, v]) => v !== undefined && v !== null
  );
  if (entries.length === 0) return '';

  return (
    ' ' +
    entries
      .map(([k, v]) => {
        const safeKey = sanitizeXmlTagName(k);
        const safeVal = escapeXml(String(v));
        return `${safeKey}="${safeVal}"`;
      })
      .join(' ')
  );
}

/**
 * 敏感系统 Prompt 标签正则：匹配可能诱导大模型逃逸或误识别为系统指令的 XML 标签。
 */
const SYSTEM_TAGS_REGEX =
  /<\/?(?:system|instructions?|developer|assistant|context|agent|user|rules?|system_prompt|prompt_injection)(?:\s[^>]*)?>/gi;

/**
 * 对文本中出现的潜在系统指令标签进行转义去毒（Defanging）。
 *
 * @param text 待去毒的不可信文本
 */
export function defangSystemTags(text: string): string {
  if (!text) return '';
  return text.replace(SYSTEM_TAGS_REGEX, (matched) => escapeXml(matched));
}

/**
 * 将不可信文本封装在 XML 沙箱标签中，并防御沙箱定界符闭合逃逸。
 *
 * @param tagName 沙箱标签名（如 plugin_skill_sandbox）
 * @param content 内容
 * @param attrs 附加属性字典
 */
export function wrapInXmlSandbox(
  tagName: string,
  content: string,
  attrs?: Record<string, string | number | boolean | undefined | null>
): string {
  const safeTagName = sanitizeXmlTagName(tagName);
  const safeAttrs = sanitizeXmlAttributes(attrs);

  // 防御沙箱闭合标签逃逸：若正文包含 </safeTagName>，将其转义
  const escapeClosingRegex = new RegExp(`</${safeTagName}\\s*>`, 'gi');
  let sanitizedContent = content.replace(
    escapeClosingRegex,
    (m) => `&lt;/${m.slice(2, -1)}&gt;`
  );

  // 去毒敏感系统标签
  sanitizedContent = defangSystemTags(sanitizedContent);

  return `<${safeTagName}${safeAttrs}>\n${sanitizedContent}\n</${safeTagName}>`;
}

/**
 * 格式化 Plugin Skill 的工具执行输出，提供统一的 XML 沙箱与用户输入隔离。
 *
 * @param skillName 技能名称
 * @param content SKILL.md 正文
 * @param userInput 可选的用户附加输入
 */
export function formatSkillOutput(
  skillName: string,
  content: string,
  userInput?: string
): string {
  const header = `# Skill: ${skillName}`;
  const tail =
    userInput !== undefined
      ? `\n\n## User Input\n${userInput}`
      : '\n\n## User Input\n(none)';

  const rawBody = `${header}\n\n${content}${tail}`;

  return wrapInXmlSandbox('plugin_skill_sandbox', rawBody, {
    name: skillName,
    untrusted: 'true',
  });
}

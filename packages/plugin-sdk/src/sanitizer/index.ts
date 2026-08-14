/**
 * Sanitizer 模块公共入口。
 */

export {
  escapeXml,
  unescapeXml,
  sanitizeXmlTagName,
  sanitizeXmlAttributes,
  defangSystemTags,
  wrapInXmlSandbox,
  formatSkillOutput,
} from './xmlSanitizer';

export {
  escapeHtml,
  stripHtml,
  isSafeUrl,
  isSafeSrc,
  sanitizeHtml,
  DEFAULT_ALLOWED_TAGS,
  DEFAULT_GLOBAL_ATTRS,
  DEFAULT_TAG_SPECIFIC_ATTRS,
  type SanitizeHtmlOptions,
} from './htmlSanitizer';

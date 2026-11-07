// 平台剪贴板适配（账号 UID 复制、API Key 读取与清洗等）：
// - 仓内移动端无 expo-clipboard / @react-native-clipboard 依赖（已核查
//   package.json 与 node_modules 均无）；RN 0.86 core 仍提供 Clipboard
//   （已标记弃用、带 clipboard-moved 迁出提示，但在当前 RN 版本内可用），
//   是仓内现存的唯一原生剪贴板能力，故经本适配收口使用；
// - shared-utils 的 copyTextToClipboard 是 Web 实现（navigator/document），
//   原生侧恒失败，不在此复用；
// - 后续引入 expo-clipboard 时只换本文件实现，调用面不变。
import { Clipboard } from 'react-native';

/** 写入系统剪贴板（成功 true；空串/原生异常 false，不抛错冒泡） */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从系统剪贴板读取文本（空或原生异常返回空字符串，不抛错冒泡）。
 * 纪律：必须由用户点击手势显式触发（User-Initiated Gesture），严禁后台静默读取。
 */
export async function readTextFromClipboard(): Promise<string> {
  try {
    const text = await Clipboard.getString();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * 剥除字符串外层成对单双引号与中文引号
 */
function stripOuterQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('“') && trimmed.endsWith('”')) ||
    (trimmed.startsWith('‘') && trimmed.endsWith('’'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * API Key 纯函数消毒清洗：
 * 1. 过滤零宽字符与不可见空白（Zero-Width Characters：\u200B-\u200D, \uFEFF）；
 * 2. 剥除前后常规空白；
 * 3. 剥除成对包裹引号（如 "sk-..." 或 'sk-...'）；
 * 4. 自动剥离误粘的 Authorization 头前缀（"Bearer " 或 "bearer "）；
 * 5. 长度合理性守门（截断至安全上限 256 字符），防止误粘全篇长文档。
 */
export function sanitizeApiKeyInput(raw: string): string {
  if (!raw) return '';

  // 1. 剥除零宽字符与首尾常规空白
  let clean = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // 2. 剥除外层成对引号
  clean = stripOuterQuotes(clean);

  // 3. 剥除常见 Authorization: Bearer 请求头前缀
  if (/^bearer\s+/i.test(clean)) {
    clean = clean.replace(/^bearer\s+/i, '').trim();
  }

  // 4. 若 Bearer 后仍被引号包裹（例如 Bearer "sk-..."），再剥一次
  clean = stripOuterQuotes(clean);

  // 5. 截断至安全长度
  if (clean.length > 256) {
    clean = clean.slice(0, 256);
  }

  return clean;
}

/**
 * 外部工具调用输出反序列化与解包工具。
 * 负责解析 JSON 信封（如 {"output": "...", "metadata": {"exit_code": 0}}），
 * 提取内层真实文本、剥离 ANSI 控制字符与本地命令标签噪声，并检测错误退出码。
 */

import { stripAnsiEscape } from '../stripAnsi';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 剥离终端 ANSI 控制字符（如 [2m, [22m）以及本地命令回显样板标签。
 */
export function cleanAnsiAndCommandNoise(text: string): string {
  if (!text) return '';
  let cleaned = text;
  // 剥离 ANSI 颜色与控制码
  cleaned = stripAnsiEscape(cleaned);
  cleaned = cleaned.replace(/\[[0-9]{1,2}m/g, '');
  // 剥离本地控制命令标签
  cleaned = cleaned.replace(
    /<local-command-caveat[^>]*>[\s\S]*?<\/local-command-caveat>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-name[^>]*>[\s\S]*?<\/command-name>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-message[^>]*>[\s\S]*?<\/command-message>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-args[^>]*>[\s\S]*?<\/command-args>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<local-command-stdout[^>]*>[\s\S]*?<\/local-command-stdout>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-status[^>]*>[\s\S]*?<\/command-status>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<local-command[^>]*>[\s\S]*?<\/local-command>/gi,
    ''
  );
  return cleaned.trim();
}

export function contentItemsToText(content: unknown, kinds: string[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const r = asRecord(item);
    if (!r) continue;
    const t = typeof r.type === 'string' ? r.type : '';
    if (!kinds.includes(t)) continue;
    if (typeof r.text === 'string') parts.push(r.text);
  }
  return parts.join('\n');
}

export function toolSearchOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output === 'string')
    return cleanAnsiAndCommandNoise(payload.output);
  if (payload.output != null) return unwrapToolOutput(payload.output).text;
  if (Array.isArray(payload.tools)) {
    const names = payload.tools
      .map((t) => {
        const r = asRecord(t);
        return r && typeof r.name === 'string' ? r.name : '';
      })
      .filter(Boolean);
    if (names.length) return `找到工具：${names.join(', ')}`;
    try {
      return JSON.stringify(payload.tools);
    } catch {
      return String(payload.tools);
    }
  }
  return unwrapToolOutput(payload).text;
}

/**
 * 递归解包转义的 JSON 工具输出，提取真实文本、清除 ANSI 与本地命令噪声并判断退出码是否非 0。
 */
export function unwrapToolOutput(output: unknown): {
  text: string;
  isError?: boolean;
} {
  if (output == null) return { text: '' };

  let isError: boolean | undefined;

  // 如果是字符串，探测是否为 JSON 包装信封（如 {"output": "...", "metadata": {"exit_code": 0}}）
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed != null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          const rec = parsed as Record<string, unknown>;
          if (
            'output' in rec ||
            'stdout' in rec ||
            'stderr' in rec ||
            'content' in rec ||
            'body' in rec ||
            'text' in rec ||
            'error' in rec ||
            'content_items' in rec ||
            'metadata' in rec
          ) {
            return unwrapToolOutput(parsed);
          }
        }
      } catch {
        // 非合规 JSON，退化为普通字符串
      }
    }
    return { text: cleanAnsiAndCommandNoise(output) };
  }

  const r = asRecord(output);
  if (r) {
    const meta = asRecord(r.metadata);
    if (meta && typeof meta.exit_code === 'number' && meta.exit_code !== 0) {
      isError = true;
    } else if (typeof r.exit_code === 'number' && r.exit_code !== 0) {
      isError = true;
    }

    if (typeof r.output === 'string') {
      const inner = unwrapToolOutput(r.output);
      return {
        text: cleanAnsiAndCommandNoise(inner.text),
        isError: isError ?? inner.isError,
      };
    }
    if (r.output != null && typeof r.output === 'object') {
      const inner = unwrapToolOutput(r.output);
      return {
        text: cleanAnsiAndCommandNoise(inner.text),
        isError: isError ?? inner.isError,
      };
    }

    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      const stdout = typeof r.stdout === 'string' ? r.stdout : '';
      const stderr = typeof r.stderr === 'string' ? r.stderr : '';
      const combined =
        stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
      return {
        text: cleanAnsiAndCommandNoise(combined),
        isError: isError ?? (Boolean(stderr) && isError !== false),
      };
    }

    if (typeof r.content === 'string')
      return { text: cleanAnsiAndCommandNoise(r.content), isError };
    if (typeof r.body === 'string')
      return { text: cleanAnsiAndCommandNoise(r.body), isError };
    if (typeof r.text === 'string')
      return { text: cleanAnsiAndCommandNoise(r.text), isError };
    if (typeof r.error === 'string')
      return { text: cleanAnsiAndCommandNoise(r.error), isError: true };
    if (Array.isArray(r.content_items)) {
      return {
        text: cleanAnsiAndCommandNoise(
          contentItemsToText(r.content_items, [
            'input_text',
            'output_text',
            'text',
          ])
        ),
        isError,
      };
    }

    try {
      return {
        text: cleanAnsiAndCommandNoise(JSON.stringify(output)),
        isError,
      };
    } catch {
      return { text: cleanAnsiAndCommandNoise(String(output)), isError };
    }
  }

  return { text: cleanAnsiAndCommandNoise(String(output)) };
}

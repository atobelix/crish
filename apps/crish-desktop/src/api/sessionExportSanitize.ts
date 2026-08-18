/**
 * sessionExport 脱敏域：文件名清理 / base64 脱敏 / 工具调用脱敏 + 截断 / 工具折叠摘要。
 * 从 sessionExportRenderers.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 */

import type { MessageToolCall } from '../store/types';
import { sanitizeToolDisplayOutput } from './toolFeedback';
import { extractToolCommand, toolHumanLabel } from './toolPresentation';
import {
  EXPORT_HEAVY_B64_MIN,
  EXPORT_TOOL_ARGS_MAX,
  EXPORT_TOOL_OUTPUT_MAX,
  WINDOWS_RESERVED_NAMES,
  type ExportedToolCall,
} from './sessionExportTypes';

/**
 * 清理文件名非法字符，拼上日期 → `标题-YYYY-MM-DD.ext`
 * - 保留中文等 Unicode 字母
 * - 剥离 Windows 非法字符 / 控制符 / 尾随点空格
 * - 避免保留设备名
 * - extension 不含点；默认 md
 */
export function sanitizeExportFilename(
  title: string,
  date = new Date(),
  extension = 'md',
): string {
  // eslint-disable-next-line no-control-regex -- 有意剥离文件名非法控制字符
  const ext = (extension || 'md').replace(/^\./, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '') || 'md';
  let base =
    (title || '会话')
      // Windows 非法 + C0 控制符 + DEL
      // eslint-disable-next-line no-control-regex -- 有意剥离 C0 控制符与 DEL
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
      // 零宽 / BOM 等不可见字符
      .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      // Windows 不允许尾随点/空格
      .replace(/[.\s]+$/g, '')
      .slice(0, 80)
      .replace(/[.\s]+$/g, '');

  if (!base) base = '会话';

  // 保留设备名（忽略大小写）单独出现时加前缀
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    base = `会话_${base}`;
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${base}-${y}-${m}-${d}.${ext}`;
}

/**
 * 剥离 data URL / 长 base64，避免把图片或二进制 dump 进 md/json。
 * 保留短 token；替换为可数字节的占位说明。
 */
export function redactHeavyPayloads(text: string): string {
  if (!text) return '';
  let out = text;

  // data:[mime];base64,....（单行；不跨行吞掉后续正文）
  out = out.replace(
    /data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]{32,})/g,
    (_m, mime: string, b64: string) => {
      const approx = Math.floor((b64.length * 3) / 4);
      return `[已省略 data:${mime};base64 ≈${approx} bytes]`;
    },
  );

  // 裸 base64 长串：
  // - 含 + / = 的标准 base64；或
  // - 超长无空格字母数字（≥500，常见于无 padding 的二进制 dump）
  // 英文段落含空格，不会被本规则匹配。
  out = out.replace(/[A-Za-z0-9+/]{120,}={0,2}/g, (chunk) => {
    if (chunk.length < EXPORT_HEAVY_B64_MIN) return chunk;
    const looksB64 = /[+/=]/.test(chunk) || chunk.length >= 500;
    if (!looksB64) return chunk;
    const approx = Math.floor((chunk.length * 3) / 4);
    return `[已省略 base64 ≈${approx} bytes]`;
  });

  return out;
}

/** 文本截断辅助（附中文省略号 + 原长度） */
export function capText(text: string, max: number, label = '已截断'): string {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n…（${label}，原 ${text.length} 字符）`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status: MessageToolCall['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'success':
      return '成功';
    case 'error':
      return '失败';
    case 'pending_approval':
      return '待审批';
    default:
      return status;
  }
}

/**
 * 导出用：单条工具调用脱敏 + 截断。
 * 空壳工具（无 name/args/output）返回 null。
 */
export function sanitizeToolCallForExport(tc: MessageToolCall): ExportedToolCall | null {
  if (!tc) return null;
  if (!(tc.name || tc.arguments || tc.output)) return null;

  const name = (tc.name || 'tool').trim() || 'tool';
  const label = toolHumanLabel(tc);
  const cmdRaw = extractToolCommand(tc.arguments || '');
  const command = redactHeavyPayloads(cmdRaw).trim();
  const commandCapped = command ? capText(command, EXPORT_TOOL_ARGS_MAX, '命令已截断') : '';

  let argsOut = '';
  if (tc.arguments?.trim()) {
    argsOut = capText(
      redactHeavyPayloads(tc.arguments.trim()),
      EXPORT_TOOL_ARGS_MAX,
      '参数已截断',
    );
  }

  let outputOut = '';
  const cleaned = sanitizeToolDisplayOutput(tc.output || '');
  const redacted = redactHeavyPayloads(cleaned).trim();
  if (redacted && !/^(执行中|运行中)…?$/.test(redacted)) {
    outputOut = capText(redacted, EXPORT_TOOL_OUTPUT_MAX);
  }

  const diffs = (tc.diffs || []).slice(0, 20).map((d) => ({
    filePath: (d.filePath || '').trim() || '(未命名文件)',
    additions: d.additions || 0,
    deletions: d.deletions || 0,
  }));

  const result: ExportedToolCall = {
    id: tc.id || '',
    name,
    status: tc.status,
    label,
  };
  if (commandCapped) result.command = commandCapped;
  if (argsOut) result.arguments = argsOut;
  if (outputOut) result.output = outputOut;
  if (diffs.length) result.diffs = diffs;
  return result;
}

/** 导出用：工具折叠摘要（details/summary；GitHub 等 MD 渲染器可折叠） */
export function formatToolCollapsible(tc: MessageToolCall): string {
  const sanitized = sanitizeToolCallForExport(tc);
  if (!sanitized) return '';

  const st = statusLabel(sanitized.status);
  const summary = escapeHtml(`${sanitized.name} · ${sanitized.label} · ${st}`);
  const parts: string[] = [];

  if (sanitized.command) {
    parts.push('```');
    parts.push(sanitized.command);
    parts.push('```');
  }

  if (sanitized.output) {
    if (parts.length) parts.push('');
    parts.push('```');
    parts.push(sanitized.output);
    parts.push('```');
  }

  if (sanitized.diffs?.length) {
    if (parts.length) parts.push('');
    for (const d of sanitized.diffs) {
      parts.push(`- \`${d.filePath}\` +${d.additions}/-${d.deletions}`);
    }
    const rawCount = (tc.diffs || []).length;
    if (rawCount > 20) {
      parts.push(`- …另有 ${rawCount - 20} 个文件变更`);
    }
  }

  const body = parts.length ? `\n\n${parts.join('\n')}\n` : '\n';
  return `<details>\n<summary>${summary}</summary>${body}</details>`;
}

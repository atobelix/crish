/**
 * 会话导出为 Markdown / JSON（归档 / 分享）。
 * 入口：ChatHeaderMore（顶栏 ⋯）/ 侧栏右键「导出」；成功静默（浏览器下载即反馈），失败 toast。
 * PDF 打印可后续用 window.print 或专用渲染；当前 MD + JSON。
 *
 * 本文件为 hub：类型契约见 ./sessionExportTypes，纯渲染逻辑见 ./sessionExportRenderers。
 * 此处保留下载 IO 包装（downloadTextFile / try*）与全量 re-export，消费方 import 路径不变。
 */

import type { SessionState } from '../store/types';
import {
  type DownloadTextFileDeps,
  type DownloadTextFileOptions,
  type DownloadSessionResult,
  type ExportSessionOptions,
} from './sessionExportTypes';
import {
  exportSessionToJson,
  exportSessionToJsonObject,
  exportSessionToMarkdown,
  formatExportFailure,
} from './sessionExportRenderers';
import { sanitizeExportFilename } from './sessionExportSanitize';

// ─── re-export：保持消费方 import 路径不变 ────────────────────────────────
export {
  EXPORT_TOOL_OUTPUT_MAX,
  EXPORT_MESSAGE_TEXT_MAX,
  EXPORT_TOOL_ARGS_MAX,
  EXPORT_HEAVY_B64_MIN,
  SESSION_EXPORT_JSON_VERSION,
  SESSION_EXPORT_JSON_FORMAT,
  WINDOWS_RESERVED_NAMES,
} from './sessionExportTypes';
export type {
  ExportSessionOptions,
  DownloadTextFileDeps,
  DownloadTextFileOptions,
  ExportedToolCall,
  ExportedMessage,
  ExportedAgent,
  ExportedSessionBody,
  SessionExportJson,
  DownloadSessionResult,
} from './sessionExportTypes';
export {
  sanitizeExportFilename,
  redactHeavyPayloads,
  sanitizeToolCallForExport,
  formatToolCollapsible,
} from './sessionExportSanitize';
export {
  exportSessionToMarkdown,
  exportSessionToJsonObject,
  exportSessionToJson,
  formatExportFailure,
} from './sessionExportRenderers';

/** Blob + 临时 a[download] 触发浏览器下载；deps 可注入以便单测 */
export function downloadTextFile(
  filename: string,
  content: string,
  options: DownloadTextFileOptions = {},
): void {
  const mimeType = options.mimeType ?? 'text/markdown;charset=utf-8';
  const deps = options.deps ?? {};

  const createBlob =
    deps.createBlob ??
    ((text: string, mime: string) => new Blob([text], { type: mime }));
  const createObjectURL =
    deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL =
    deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const clickDownload =
    deps.clickDownload ??
    ((name: string, url: string) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

  const blob = createBlob(content, mimeType);
  const url = createObjectURL(blob);
  try {
    clickDownload(filename, url);
  } finally {
    revokeObjectURL(url);
  }
}

/**
 * 一键：生成 MD + 下载；返回文件名。
 * 调用方：成功不 toast；失败 catch 后 toast。
 */
function downloadSessionMarkdown(
  session: SessionState,
  date = new Date(),
  options: ExportSessionOptions = {},
): string {
  const content = exportSessionToMarkdown(session, options);
  const filename = sanitizeExportFilename(session.title || '会话', date, 'md');
  downloadTextFile(filename, content, {
    mimeType: 'text/markdown;charset=utf-8',
    ...(options.downloadDeps !== undefined && { deps: options.downloadDeps }),
  });
  return filename;
}

/**
 * 一键：生成 JSON + 下载；返回文件名。
 */
function downloadSessionJson(
  session: SessionState,
  date = new Date(),
  options: ExportSessionOptions = {},
): string {
  const content = exportSessionToJson(session, options);
  const filename = sanitizeExportFilename(session.title || '会话', date, 'json');
  downloadTextFile(filename, content, {
    mimeType: 'application/json;charset=utf-8',
    ...(options.downloadDeps !== undefined && { deps: options.downloadDeps }),
  });
  return filename;
}

/**
 * 安全下载包装：供 UI 多入口统一「成功静默 / 失败可 toast」。
 * 无会话内容时仍允许导出空壳元数据。
 * 调用方约定：`ok === true` 不 toast；`ok === false` 用 `error` toast。
 */
export function tryDownloadSessionMarkdown(
  session: SessionState | null | undefined,
  date = new Date(),
  options: ExportSessionOptions = {},
): DownloadSessionResult {
  if (!session) {
    return { ok: false, error: '没有可导出的会话' };
  }
  try {
    const filename = downloadSessionMarkdown(session, date, options);
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: formatExportFailure(err) };
  }
}

/** JSON 导出安全包装：契约同 tryDownloadSessionMarkdown */
export function tryDownloadSessionJson(
  session: SessionState | null | undefined,
  date = new Date(),
  options: ExportSessionOptions = {},
): DownloadSessionResult {
  if (!session) {
    return { ok: false, error: '没有可导出的会话' };
  }
  try {
    const filename = downloadSessionJson(session, date, options);
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: formatExportFailure(err) };
  }
}

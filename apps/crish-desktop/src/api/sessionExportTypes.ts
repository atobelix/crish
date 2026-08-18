/**
 * sessionExport 类型契约与常量。
 * 从 sessionExport.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 */

import type { MessageToolCall, SessionMessage, SessionState } from '../store/types';

/** 工具输出导出上限（字符）；更长截断，避免巨型 md/json */
export const EXPORT_TOOL_OUTPUT_MAX = 4000;
/** 单条消息正文上限 */
export const EXPORT_MESSAGE_TEXT_MAX = 50_000;
/** 工具 arguments 导出上限 */
export const EXPORT_TOOL_ARGS_MAX = 2000;
/** 判定为「巨大 base64 / 二进制」的最短连续 payload */
export const EXPORT_HEAVY_B64_MIN = 120;
/** JSON 导出契约版本 */
export const SESSION_EXPORT_JSON_VERSION = 1 as const;
/** JSON 导出 format 标识 */
export const SESSION_EXPORT_JSON_FORMAT = 'crish-session-export' as const;

/** Windows 保留设备名（无扩展时不可作文件名） */
export const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export type ExportSessionOptions = {
  /** 用于解析 branchParentId → 父会话标题 */
  sessionsById?: Record<string, Pick<SessionState, 'id' | 'title'> | undefined>;
  /** 固定导出时间（单测） */
  nowMs?: number;
  /** 注入下载依赖，便于 Blob/DOM 路径单测 */
  downloadDeps?: DownloadTextFileDeps;
};

/** 下载路径可注入依赖（避免单测硬 mock 全局 Blob/document） */
export type DownloadTextFileDeps = {
  createBlob?: (content: string, mimeType: string) => Blob;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** 用 url 触发 a[download]；默认走 document */
  clickDownload?: (filename: string, url: string) => void;
};

export type DownloadTextFileOptions = {
  mimeType?: string;
  deps?: DownloadTextFileDeps;
};

/** 导出用工具调用（已脱敏 / 截断） */
export type ExportedToolCall = {
  id: string;
  name: string;
  status: MessageToolCall['status'];
  label: string;
  command?: string;
  arguments?: string;
  output?: string;
  diffs?: Array<{ filePath: string; additions: number; deletions: number }>;
};

/** 导出用消息 */
export type ExportedMessage = {
  id: string;
  sender: SessionMessage['sender'];
  timestamp?: number;
  text?: string;
  thinking?: string;
  toolCalls?: ExportedToolCall[];
};

/** 导出用协作 agent */
export type ExportedAgent = {
  id: string;
  description: string;
  status: string;
  summary?: string;
  messages: ExportedMessage[];
};

/** JSON 导出会话体 */
export type ExportedSessionBody = {
  id: string;
  title: string;
  folder?: string;
  isArchived: boolean;
  isPinned: boolean;
  branchParentId?: string;
  branchParentLabel?: string;
  timestamp?: string;
  empty: boolean;
  messages: ExportedMessage[];
  agents: ExportedAgent[];
};

/** JSON 导出根形状 */
export type SessionExportJson = {
  format: typeof SESSION_EXPORT_JSON_FORMAT;
  version: typeof SESSION_EXPORT_JSON_VERSION;
  exportedAt: string;
  exportedAtMs: number;
  session: ExportedSessionBody;
};

export type DownloadSessionResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

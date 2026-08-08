/**
 * 会话导出为 Markdown / JSON（归档 / 分享）。
 * 入口：ChatHeaderMore（顶栏 ⋯）/ 侧栏右键「导出」；成功静默（浏览器下载即反馈），失败 toast。
 * PDF 打印可后续用 window.print 或专用渲染；当前 MD + JSON。
 */

import type { MessageToolCall, SessionMessage, SessionState } from '../store/types';
import { sanitizeToolDisplayOutput } from './toolFeedback';
import { extractToolCommand, toolHumanLabel } from './toolPresentation';

/** 工具输出导出上限（字符）；更长截断，避免巨型 md/json */
export const EXPORT_TOOL_OUTPUT_MAX = 4000;
/** 单条消息正文上限 */
export const EXPORT_MESSAGE_TEXT_MAX = 50_000;
/** 工具 arguments 导出上限 */
const EXPORT_TOOL_ARGS_MAX = 2000;
/** 判定为「巨大 base64 / 二进制」的最短连续 payload */
const EXPORT_HEAVY_B64_MIN = 120;
/** JSON 导出契约版本 */
export const SESSION_EXPORT_JSON_VERSION = 1 as const;
/** JSON 导出 format 标识 */
export const SESSION_EXPORT_JSON_FORMAT = 'crish-session-export' as const;

/** Windows 保留设备名（无扩展时不可作文件名） */
const WINDOWS_RESERVED_NAMES = new Set([
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

function capText(text: string, max: number, label = '已截断'): string {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n…（${label}，原 ${text.length} 字符）`;
}

function formatLocalDateTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}`;
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

function messageIsEmpty(m: SessionMessage): boolean {
  const text = (m.text || '').trim();
  const thinking = (m.thinking || '').trim();
  const tools = (m.toolCalls || []).filter((tc) => tc && (tc.name || tc.arguments || tc.output));
  return !text && !thinking && tools.length === 0;
}

function formatMessage(m: SessionMessage): string {
  const heading = m.sender === 'user' ? '## User' : '## Assistant';
  const lines: string[] = [heading];
  const when = formatLocalDateTime(m.timestamp);
  if (when) {
    lines.push(`*${when}*`);
  }
  lines.push('');

  const text = redactHeavyPayloads((m.text || '').trim());
  if (text) {
    lines.push(capText(text, EXPORT_MESSAGE_TEXT_MAX));
    lines.push('');
  }

  const thinking = redactHeavyPayloads((m.thinking || '').trim());
  if (thinking) {
    lines.push('<details>');
    lines.push('<summary>思考过程</summary>');
    lines.push('');
    lines.push(capText(thinking, EXPORT_TOOL_OUTPUT_MAX));
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  for (const tc of m.toolCalls || []) {
    if (!tc) continue;
    const block = formatToolCollapsible(tc);
    if (!block) continue;
    lines.push(block);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function resolveBranchParentLabel(
  session: SessionState,
  sessionsById?: ExportSessionOptions['sessionsById'],
): string | null {
  const parentId = (session.branchParentId || '').trim();
  if (!parentId) return null;
  const parent = sessionsById?.[parentId];
  const parentTitle = (parent?.title || '').trim();
  if (parentTitle) return `${parentTitle} (\`${parentId}\`)`;
  return `\`${parentId}\``;
}

function sessionHasExportBody(session: SessionState): boolean {
  const msgs = (session.messages || []).some((m) => !messageIsEmpty(m));
  if (msgs) return true;
  for (const ag of session.agents || []) {
    if ((ag.summary || '').trim()) return true;
    if ((ag.messages || []).some((m) => !messageIsEmpty(m))) return true;
  }
  return false;
}

function messageToExported(m: SessionMessage): ExportedMessage | null {
  if (messageIsEmpty(m)) return null;
  const out: ExportedMessage = {
    id: m.id,
    sender: m.sender,
  };
  if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) && m.timestamp > 0) {
    out.timestamp = m.timestamp;
  }
  const text = redactHeavyPayloads((m.text || '').trim());
  if (text) out.text = capText(text, EXPORT_MESSAGE_TEXT_MAX);
  const thinking = redactHeavyPayloads((m.thinking || '').trim());
  if (thinking) out.thinking = capText(thinking, EXPORT_TOOL_OUTPUT_MAX);

  const toolCalls: ExportedToolCall[] = [];
  for (const tc of m.toolCalls || []) {
    const s = sanitizeToolCallForExport(tc);
    if (s) toolCalls.push(s);
  }
  if (toolCalls.length) out.toolCalls = toolCalls;
  return out;
}

/**
 * 将会话状态格式化为 Markdown 文本。
 * - 标题、时间、归档/分支元数据
 * - 每条消息 ## User / ## Assistant
 * - 工具为可折叠摘要（非巨型 dump）
 * - 剥离 data URL / 长 base64
 * - 跳过空消息；整会话无正文时标注「无消息」
 */
export function exportSessionToMarkdown(
  session: SessionState,
  options: ExportSessionOptions = {},
): string {
  const title = (session.title || '会话').trim() || '会话';
  const lines: string[] = [`# ${title}`, ''];

  const nowMs = options.nowMs ?? Date.now();
  const exportedAt = formatLocalDateTime(nowMs);
  lines.push(`- 导出时间：${exportedAt}`);
  if (session.id?.trim()) {
    lines.push(`- 会话 ID：\`${session.id.trim()}\``);
  }
  if (session.folder?.trim()) {
    lines.push(`- 项目：${session.folder.trim()}`);
  }
  if (session.isArchived) {
    lines.push('- 状态：已归档');
  }
  const branchLabel = resolveBranchParentLabel(session, options.sessionsById);
  if (branchLabel) {
    lines.push(`- 分支自：${branchLabel}`);
  }

  const activityCandidates = (session.messages || [])
    .map((m) => m.timestamp)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0);
  if (activityCandidates.length) {
    const first = Math.min(...activityCandidates);
    const last = Math.max(...activityCandidates);
    const a = formatLocalDateTime(first);
    const b = formatLocalDateTime(last);
    if (a && b) lines.push(`- 对话时间：${a === b ? a : `${a} ~ ${b}`}`);
  } else if (session.timestamp?.trim()) {
    lines.push(`- 会话标记：${session.timestamp.trim()}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const hasBody = sessionHasExportBody(session);
  if (!hasBody) {
    lines.push('*（无消息）*');
    lines.push('');
  }

  for (const m of session.messages || []) {
    if (messageIsEmpty(m)) continue;
    lines.push(formatMessage(m));
    lines.push('');
  }

  // 协作 agent 时间线（有内容时附录）
  const agents = session.agents || [];
  for (const ag of agents) {
    const agentMsgs = (ag.messages || []).filter((m) => !messageIsEmpty(m));
    if (!agentMsgs.length && !(ag.summary || '').trim()) continue;
    lines.push('---');
    lines.push('');
    lines.push(`# Agent · ${(ag.description || '协作任务').trim()}`);
    lines.push('');
    lines.push(`- 状态：${ag.status}`);
    if (ag.summary?.trim()) {
      lines.push(`- 摘要：${redactHeavyPayloads(ag.summary.trim())}`);
    }
    lines.push('');
    for (const m of agentMsgs) {
      lines.push(formatMessage(m));
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * 将会话状态格式化为可序列化 JSON 对象（已脱敏 / 截断）。
 * 空会话：messages/agents 为空数组，empty=true，仍含元数据。
 */
export function exportSessionToJsonObject(
  session: SessionState,
  options: ExportSessionOptions = {},
): SessionExportJson {
  const nowMs = options.nowMs ?? Date.now();
  const title = (session.title || '会话').trim() || '会话';
  const branchLabel = resolveBranchParentLabel(session, options.sessionsById);

  const messages: ExportedMessage[] = [];
  for (const m of session.messages || []) {
    const em = messageToExported(m);
    if (em) messages.push(em);
  }

  const agents: ExportedAgent[] = [];
  for (const ag of session.agents || []) {
    const agentMsgs: ExportedMessage[] = [];
    for (const m of ag.messages || []) {
      const em = messageToExported(m);
      if (em) agentMsgs.push(em);
    }
    const summary = (ag.summary || '').trim()
      ? redactHeavyPayloads(ag.summary!.trim())
      : '';
    if (!agentMsgs.length && !summary) continue;
    const entry: ExportedAgent = {
      id: ag.id,
      description: (ag.description || '协作任务').trim(),
      status: ag.status,
      messages: agentMsgs,
    };
    if (summary) entry.summary = summary;
    agents.push(entry);
  }

  const body: ExportedSessionBody = {
    id: (session.id || '').trim(),
    title,
    isArchived: !!session.isArchived,
    isPinned: !!session.isPinned,
    empty: !sessionHasExportBody(session),
    messages,
    agents,
  };
  if (session.folder?.trim()) body.folder = session.folder.trim();
  if (session.branchParentId?.trim()) body.branchParentId = session.branchParentId.trim();
  if (branchLabel) body.branchParentLabel = branchLabel.replace(/`/g, '');
  if (session.timestamp?.trim()) body.timestamp = session.timestamp.trim();

  return {
    format: SESSION_EXPORT_JSON_FORMAT,
    version: SESSION_EXPORT_JSON_VERSION,
    exportedAt: formatLocalDateTime(nowMs),
    exportedAtMs: nowMs,
    session: body,
  };
}

/** 将会话状态格式化为 JSON 文本（pretty，2 空格） */
export function exportSessionToJson(
  session: SessionState,
  options: ExportSessionOptions = {},
): string {
  return `${JSON.stringify(exportSessionToJsonObject(session, options), null, 2)}\n`;
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

export type DownloadSessionResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

/** 将任意 throw 收敛为用户可读的失败文案（供 toast） */
export function formatExportFailure(err: unknown): string {
  if (err instanceof Error) {
    const m = (err.message || '').trim();
    if (m) return m;
  } else if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  return '导出失败';
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

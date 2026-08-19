/**
 * sessionExport 渲染域：Markdown / JSON 会话构建器。
 * 从 sessionExport.ts 拆出，保持消费方 import 路径不变（hub 仍 re-export）。
 * 脱敏域（文件名 / base64 / 工具调用脱敏）见 ./sessionExportSanitize。
 * 不含下载/IO 包装（downloadTextFile / try* 留在 hub）。
 */

import type { SessionMessage, SessionState } from '../store/types';
import {
  EXPORT_MESSAGE_TEXT_MAX,
  EXPORT_TOOL_OUTPUT_MAX,
  SESSION_EXPORT_JSON_FORMAT,
  SESSION_EXPORT_JSON_VERSION,
  type ExportedAgent,
  type ExportedMessage,
  type ExportedSessionBody,
  type ExportSessionOptions,
  type SessionExportJson,
} from './sessionExportTypes';
import {
  capText,
  formatToolCollapsible,
  redactHeavyPayloads,
  sanitizeToolCallForExport,
} from './sessionExportSanitize';
import {
  normalizeCodeBlockIndent,
  readCodeBlockIndent,
} from './codeBlockIndent';

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

  const toolCalls: ExportedMessage['toolCalls'] = [];
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

/** 将会话状态格式化为 JSON 文本（pretty 缩进读 markdown.codeBlockIndent） */
export function exportSessionToJson(
  session: SessionState,
  options: ExportSessionOptions = {},
): string {
  const indent = normalizeCodeBlockIndent(
    options.jsonIndent ?? readCodeBlockIndent(),
  );
  return `${JSON.stringify(exportSessionToJsonObject(session, options), null, indent)}\n`;
}

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

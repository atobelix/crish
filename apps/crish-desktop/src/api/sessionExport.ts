/**
 * 会话导出为 Markdown（归档 / 分享）。
 * PDF 打印可后续用 window.print 或专用渲染；当前仅 MD。
 */

import type { MessageToolCall, SessionMessage, SessionState } from '../store/types';
import { extractToolCommand, toolHumanLabel } from './toolPresentation';

/** 清理文件名非法字符，拼上日期 → `标题-YYYY-MM-DD.md` */
export function sanitizeExportFilename(title: string, date = new Date()): string {
  const base =
    (title || '会话')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '会话';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${base}-${y}-${m}-${d}.md`;
}

/** Blob + 临时 a[download] 触发浏览器下载 */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

/** 工具：折叠摘要行（details/summary，GitHub 等 MD 渲染器可折叠） */
function formatToolCollapsible(tc: MessageToolCall): string {
  const human = toolHumanLabel(tc);
  const name = (tc.name || 'tool').trim();
  const st = statusLabel(tc.status);
  const summary = escapeHtml(`${name} · ${human} · ${st}`);
  const parts: string[] = [];
  const cmd = extractToolCommand(tc.arguments || '');
  if (cmd && cmd.trim()) {
    parts.push('```');
    parts.push(cmd.trim());
    parts.push('```');
  }
  const out = (tc.output || '').trim();
  if (out && !/^(执行中|运行中)…?$/.test(out)) {
    if (parts.length) parts.push('');
    parts.push('```');
    // 导出截断过长输出，避免巨型 md
    const capped = out.length > 8000 ? `${out.slice(0, 8000)}\n…（已截断）` : out;
    parts.push(capped);
    parts.push('```');
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

  const text = (m.text || '').trim();
  if (text) {
    lines.push(text);
    lines.push('');
  }

  const thinking = (m.thinking || '').trim();
  if (thinking) {
    lines.push('<details>');
    lines.push('<summary>思考过程</summary>');
    lines.push('');
    lines.push(thinking);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  for (const tc of m.toolCalls || []) {
    if (!tc) continue;
    if (!(tc.name || tc.arguments || tc.output)) continue;
    lines.push(formatToolCollapsible(tc));
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * 将会话状态格式化为 Markdown 文本。
 * - 标题、时间
 * - 每条消息 ## User / ## Assistant
 * - 工具为可折叠摘要
 * - 跳过空消息
 */
export function exportSessionToMarkdown(session: SessionState): string {
  const title = (session.title || '会话').trim() || '会话';
  const lines: string[] = [`# ${title}`, ''];

  const exportedAt = formatLocalDateTime(Date.now());
  lines.push(`- 导出时间：${exportedAt}`);
  if (session.folder?.trim()) {
    lines.push(`- 项目：${session.folder.trim()}`);
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
      lines.push(`- 摘要：${ag.summary.trim()}`);
    }
    lines.push('');
    for (const m of agentMsgs) {
      lines.push(formatMessage(m));
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** 一键：生成 MD + 下载；返回文件名 */
export function downloadSessionMarkdown(session: SessionState, date = new Date()): string {
  const content = exportSessionToMarkdown(session);
  const filename = sanitizeExportFilename(session.title || '会话', date);
  downloadTextFile(filename, content);
  return filename;
}

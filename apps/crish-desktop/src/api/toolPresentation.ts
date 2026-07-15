/**
 * 工具展示 + 助手时间线（正文与工具交错）。
 *
 * 原则：
 * - 显示「已结束的工具」为主（带命令/路径摘要），不丢 success
 * - 同 id / 同签名合并时优先终态（success/error）
 * - 中断工具可隐藏；正常完成的绝不能因文案误伤
 */

import type { MessageToolCall, SessionMessage } from '../store/layoutStore';
import { isEditToolName, isShellToolName, sanitizeToolDisplayOutput } from './toolFeedback';

/** 仅真正会话中断才隐藏，勿匹配「工具未完成」等收口文案 */
const HIDE_TOOL_RE = /上次会话中断|会话中断|interrupted|cancelled by user/i;

export function isInterruptedTool(tc: MessageToolCall): boolean {
  if (tc.status !== 'error') return false;
  return HIDE_TOOL_RE.test(tc.output || '');
}

/** 从 arguments 抽出命令/路径 */
export function extractToolCommand(args: string): string {
  if (!args?.trim()) return '';
  const raw = args.trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if ('parameters' in (parsed as object) || 'toolName' in (parsed as object)) {
        const p = parsed as Record<string, unknown>;
        const inner = p.parameters ?? p.input;
        if (inner && typeof inner === 'object') {
          return extractToolCommand(JSON.stringify(inner));
        }
        if (typeof p.command === 'string' && p.command.trim()) return p.command.trim();
        if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim();
      }
      for (const key of ['command', 'cmd', 'path', 'filePath', 'target_file', 'query', 'pattern']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      if (typeof (parsed as { content?: string }).content === 'string') {
        const c = (parsed as { content: string }).content.trim();
        return c.slice(0, 80) + (c.length > 80 ? '…' : '');
      }
    }
  } catch {
    /* plain */
  }
  return raw;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/**
 * 折叠行主文案：优先可读命令/路径，不用含糊 explanation 盖住真实命令。
 */
export function toolSummaryLabel(tc: MessageToolCall): string {
  const name = (tc.name || 'tool').toLowerCase();
  const cmd = extractToolCommand(tc.arguments || '');

  if (isShellToolName(name)) {
    if (cmd) return cmd.length > 64 ? cmd.slice(0, 63) + '…' : cmd;
    return tc.name || '命令';
  }
  if (isEditToolName(name)) {
    return cmd ? `编辑 ${basename(cmd)}` : '编辑文件';
  }
  if (name.includes('read')) {
    return cmd ? `读取 ${basename(cmd)}` : '读取文件';
  }
  if (name.includes('list') || name.includes('glob')) {
    return cmd ? `列出 ${cmd}` : '列出目录';
  }
  if (name.includes('grep') || name.includes('search')) {
    return cmd ? `搜索 ${cmd.slice(0, 40)}` : '搜索';
  }
  // 子 agent 协同：优先展示描述/模式
  if (name === 'run_subagent' || name.includes('subagent')) {
    try {
      const parsed = tc.arguments?.trim().startsWith('{')
        ? (JSON.parse(tc.arguments) as Record<string, unknown>)
        : null;
      const desc =
        (typeof parsed?.description === 'string' && parsed.description.trim()) ||
        (typeof parsed?.prompt === 'string' && parsed.prompt.trim().slice(0, 48)) ||
        '';
      const mode = typeof parsed?.mode === 'string' ? parsed.mode : '';
      if (desc) return mode ? `子代理·${mode} · ${desc}` : `子代理 · ${desc}`;
    } catch {
      /* plain */
    }
    const exp0 = (tc.explanation || '').trim();
    if (exp0 && exp0 !== name) return `子代理 · ${exp0.slice(0, 48)}`;
    return '子代理';
  }

  // 其它：explanation 若像命令则用；否则 name + cmd
  const exp = (tc.explanation || '').trim();
  if (exp && !exp.startsWith('{') && exp !== name && exp !== '需要确认' && exp.length <= 72) {
    // 避免纯中文叙述盖住命令：若有 cmd 且 exp 不含路径特征，拼一下
    if (cmd && !exp.includes(basename(cmd)) && cmd.length < 48) {
      return `${exp} · ${cmd}`;
    }
    return exp;
  }
  if (cmd) return cmd.length > 64 ? cmd.slice(0, 63) + '…' : cmd;
  return tc.name || '工具';
}

/** 右侧次要预览：与主摘要重复则空 */
export function toolCommandPreview(tc: MessageToolCall, max = 48): string {
  const cmd = extractToolCommand(tc.arguments || '');
  if (!cmd) return '';
  const summary = toolSummaryLabel(tc);
  if (summary === cmd || summary.includes(cmd) || cmd.includes(summary.replace(/^(读取|编辑|列出|搜索)\s+/, ''))) {
    return '';
  }
  const one = cmd.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

export function truncateToolOutput(output: string, maxLines = 16, maxChars = 1600): string {
  if (!output) return '';
  // 运行中占位不展示；「完成」允许作为结果预览
  if (/^(执行中|运行中)…?$/.test(output.trim())) return '';
  let text = sanitizeToolDisplayOutput(output);
  if (!text) {
    // 清洗后为空但原串是简短终态词
    if (/^(完成|OK|ok|失败|failed)$/i.test(output.trim())) return output.trim();
    return '';
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n…（共 ${lines.length} 行）`;
  }
  return text;
}

export function isInspectTool(tc: MessageToolCall): boolean {
  if (tc.status === 'pending_approval') return false;
  const n = (tc.name || '').toLowerCase();
  if (isEditToolName(n)) return false;
  if (isShellToolName(n)) {
    const cmd = extractToolCommand(tc.arguments || '').toLowerCase();
    if (/^(pwd|ls|dir|cat|type|head|tail|git\s+status|git\s+diff|git\s+log|echo|whoami|hostname)\b/.test(cmd)) {
      return true;
    }
    if (/\b(rm|del|move|copy|set-content|out-file|write|install|npm\s+i|mkdir)\b/i.test(cmd)) {
      return false;
    }
    return true;
  }
  return (
    n.includes('read') ||
    n.includes('grep') ||
    n.includes('search') ||
    n.includes('list') ||
    n.includes('glob') ||
    n.includes('stat')
  );
}

export type ToolRenderItem =
  | { kind: 'single'; tc: MessageToolCall }
  | { kind: 'group'; id: string; tools: MessageToolCall[]; label: string };

function statusRank(s: MessageToolCall['status']): number {
  if (s === 'success') return 4;
  if (s === 'error') return 3;
  if (s === 'pending_approval') return 2;
  return 1; // running
}

/** 折叠行结果预览（一行） */
export function toolResultPreview(tc: MessageToolCall, max = 72): string {
  if (tc.status === 'running' || tc.status === 'pending_approval') return '';
  const raw = truncateToolOutput(tc.output || '', 2, max + 20);
  if (!raw) {
    if (tc.status === 'success') return '完成';
    if (tc.status === 'error') return '失败';
    return '';
  }
  const line = raw.split('\n').find((l) => l.trim()) || raw;
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

export function toolHasDisplayableResult(tc: MessageToolCall): boolean {
  if (tc.status === 'running' || tc.status === 'pending_approval') return false;
  if (tc.diffs && tc.diffs.length > 0) return true;
  const t = truncateToolOutput(tc.output || '');
  return Boolean(t) || tc.status === 'success' || tc.status === 'error';
}

/**
 * 规范化助手消息时间线：blocks 与 toolCalls 对齐，保证可交错渲染。
 * live / hydrate / 持久化共用，避免各写一套顺序。
 */
export function normalizeAssistantTimeline(msg: SessionMessage): SessionMessage {
  if (msg.sender !== 'assistant') return msg;
  const tools = [...(msg.toolCalls || [])];
  const toolIds = new Set(tools.map((t) => t.id));
  let blocks = [...(msg.blocks || [])].filter(
    (b) => b.type !== 'tool_call' || (b.id != null && toolIds.has(b.id)),
  );

  const inBlocks = new Set(
    blocks.filter((b) => b.type === 'tool_call' && b.id).map((b) => b.id as string),
  );
  const missing = tools.filter((t) => !inBlocks.has(t.id));

  if (missing.length > 0) {
    // 无真实交错数据时：工具在前、正文在后（agent 常见形态）
    const onlyTextOrEmpty =
      blocks.length === 0 || blocks.every((b) => b.type === 'text');
    if (onlyTextOrEmpty) {
      const textContent =
        msg.text?.trim() ||
        blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.content || '')
          .join('\n')
          .trim();
      blocks = [
        ...tools.map((t) => ({ type: 'tool_call' as const, id: t.id })),
        ...(textContent ? [{ type: 'text' as const, content: textContent }] : []),
      ];
    } else {
      // 有交错：缺失的 tool 插在最后一个 text 之前，或末尾
      let insertAt = blocks.length;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text') {
          insertAt = i;
          break;
        }
      }
      const inject = missing.map((t) => ({ type: 'tool_call' as const, id: t.id }));
      blocks = [...blocks.slice(0, insertAt), ...inject, ...blocks.slice(insertAt)];
    }
  }

  // 有正文但无 text 块
  if ((msg.text || '').trim() && !blocks.some((b) => b.type === 'text')) {
    blocks.push({ type: 'text', content: msg.text || '' });
  }

  return {
    ...msg,
    toolCalls: tools,
    blocks,
  };
}

/** 仅按 id 合并状态；同命令多次调用保留多行 */
export function dedupeToolCalls(toolCalls: MessageToolCall[]): MessageToolCall[] {
  const byId = new Map<string, MessageToolCall>();
  const order: string[] = [];
  for (const tc of toolCalls) {
    if (!tc?.id) continue;
    const prev = byId.get(tc.id);
    if (!prev) {
      byId.set(tc.id, { ...tc });
      order.push(tc.id);
      continue;
    }
    if (statusRank(tc.status) > statusRank(prev.status)) {
      byId.set(tc.id, {
        ...prev,
        ...tc,
        arguments: tc.arguments || prev.arguments,
        explanation: tc.explanation || prev.explanation,
        output: tc.output || prev.output,
      });
    } else if (statusRank(tc.status) === statusRank(prev.status)) {
      byId.set(tc.id, {
        ...prev,
        ...tc,
        arguments: tc.arguments || prev.arguments,
        output: tc.output || prev.output,
      });
    } else {
      byId.set(tc.id, {
        ...prev,
        arguments: prev.arguments || tc.arguments,
        explanation: prev.explanation || tc.explanation,
        output: prev.output || tc.output,
      });
    }
  }
  return order.map((id) => byId.get(id)!).filter((tc) => tc && !isInterruptedTool(tc));
}

export function buildToolRenderItems(toolCalls: MessageToolCall[]): ToolRenderItem[] {
  const visible = dedupeToolCalls(toolCalls);
  const out: ToolRenderItem[] = [];
  let buf: MessageToolCall[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push({ kind: 'single', tc: buf[0] });
    } else {
      const last = buf[buf.length - 1];
      const n = buf.length;
      out.push({
        kind: 'group',
        id: `grp-${buf[0].id}`,
        tools: [...buf],
        label: `${toolSummaryLabel(last)} · ${n} 步`,
      });
    }
    buf = [];
  };

  for (const tc of visible) {
    if (tc.status === 'pending_approval') {
      flush();
      out.push({ kind: 'single', tc });
      continue;
    }
    // 有实质输出的查看类单独成行，避免「组折叠藏结果」
    if (isInspectTool(tc) && !toolHasDisplayableResult(tc) && tc.status !== 'running') {
      buf.push(tc);
    } else if (isInspectTool(tc) && tc.status === 'running') {
      buf.push(tc);
    } else if (isInspectTool(tc) && toolHasDisplayableResult(tc)) {
      flush();
      out.push({ kind: 'single', tc });
    } else {
      flush();
      out.push({ kind: 'single', tc });
    }
  }
  flush();
  return out;
}

export type AssistantTimelineItem =
  | { kind: 'text'; content: string; key: string }
  | { kind: 'tools'; items: ToolRenderItem[]; key: string };

/**
 * 构建交错时间线。
 * blocks 可用时按 blocks 顺序；否则工具在前、正文在后。
 */
export function buildAssistantTimeline(msg: SessionMessage): AssistantTimelineItem[] {
  try {
    const tools = msg.toolCalls || [];
    const toolsById = new Map(tools.map((t) => [t.id, t]));
    const blocks = msg.blocks || [];
    const items: AssistantTimelineItem[] = [];
    let toolBuf: MessageToolCall[] = [];
    let ti = 0;
    let xi = 0;

    const flushTools = () => {
      if (!toolBuf.length) return;
      const rendered = buildToolRenderItems(toolBuf);
      if (rendered.length) {
        items.push({ kind: 'tools', items: rendered, key: `tools-${ti++}` });
      }
      toolBuf = [];
    };

    if (blocks.length > 0) {
      const used = new Set<string>();
      for (const b of blocks) {
        if (b.type === 'text') {
          flushTools();
          const c = b.content || '';
          if (c.trim()) items.push({ kind: 'text', content: c, key: `text-${xi++}` });
        } else if (b.type === 'tool_call' && b.id) {
          const tc = toolsById.get(b.id);
          if (tc) {
            toolBuf.push(tc);
            used.add(b.id);
          }
        }
      }
      flushTools();
      const orphan = tools.filter((t) => !used.has(t.id));
      if (orphan.length) {
        const rendered = buildToolRenderItems(orphan);
        if (rendered.length) items.push({ kind: 'tools', items: rendered, key: 'tools-orphan' });
      }
      if (!items.some((i) => i.kind === 'text') && (msg.text || '').trim()) {
        items.push({ kind: 'text', content: msg.text || '', key: 'text-full' });
      }
      return items;
    }

    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length) items.push({ kind: 'tools', items: rendered, key: 'tools-0' });
    }
    if ((msg.text || '').trim()) {
      items.push({ kind: 'text', content: msg.text || '', key: 'text-0' });
    }
    return items;
  } catch {
    // 兜底：至少显示全文
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}

export function assistantCopyText(msg: SessionMessage): string {
  const raw = (msg.text || '').trim();
  if (raw) return raw;
  return (msg.blocks || [])
    .filter((b) => b.type === 'text' && (b.content || '').trim())
    .map((b) => (b.content || '').trim())
    .join('\n\n');
}

export function extractImageRefs(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) if (m[1]) out.push(m[1]);
  for (const m of text.matchAll(
    /(?:^|[\s"'`])((?:[A-Za-z]:)?[\\/][^\s"'`]+\.(?:png|jpe?g|gif|webp|svg)|(?:\.\/|\/)[^\s"'`]+\.(?:png|jpe?g|gif|webp|svg))/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 8);
}

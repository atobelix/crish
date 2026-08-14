/**
 * 工具调用 Timeline 块规范化纯函数。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import {
  isInspectTool,
  isInterruptedTool,
  toolHasDisplayableResult,
  toolHumanLabel,
} from './toolCardPresenter';
import type {
  AssistantTimelineItem,
  ToolRenderItem,
} from './toolPresentationTypes';

function statusRank(s: MessageToolCall['status']): number {
  if (s === 'success') return 4;
  if (s === 'error') return 3;
  if (s === 'pending_approval') return 2;
  return 1; // running
}

/**
 * 规范化助手消息时间线：blocks 与 toolCalls 对齐，保证可交错渲染。
 * live / hydrate / 持久化共用，避免各写一套顺序。
 */
export function normalizeAssistantTimeline(
  msg: SessionMessage
): SessionMessage {
  if (msg.sender !== 'assistant') return msg;
  const tools = [...(msg.toolCalls || [])];
  const toolIds = new Set(tools.map((t) => t.id));
  let blocks = [...(msg.blocks || [])].filter(
    (b) => b.type !== 'tool_call' || (b.id != null && toolIds.has(b.id))
  );

  const inBlocks = new Set(
    blocks
      .filter((b) => b.type === 'tool_call' && b.id)
      .map((b) => b.id as string)
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
        ...(textContent
          ? [{ type: 'text' as const, content: textContent }]
          : []),
      ];
    } else {
      // 有交错：缺失的 tool 插在最后一个 text 之前，或末尾
      let insertAt = blocks.length;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i]?.type === 'text') {
          insertAt = i;
          break;
        }
      }
      const inject = missing.map((t) => ({
        type: 'tool_call' as const,
        id: t.id,
      }));
      blocks = [
        ...blocks.slice(0, insertAt),
        ...inject,
        ...blocks.slice(insertAt),
      ];
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
export function dedupeToolCalls(
  toolCalls: MessageToolCall[]
): MessageToolCall[] {
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
        ...(tc.explanation || prev.explanation
          ? { explanation: tc.explanation || prev.explanation }
          : {}),
        ...(tc.output || prev.output
          ? { output: tc.output || prev.output }
          : {}),
      });
    } else if (statusRank(tc.status) === statusRank(prev.status)) {
      byId.set(tc.id, {
        ...prev,
        ...tc,
        arguments: tc.arguments || prev.arguments,
        ...(tc.output || prev.output
          ? { output: tc.output || prev.output }
          : {}),
      });
    } else {
      byId.set(tc.id, {
        ...prev,
        arguments: prev.arguments || tc.arguments,
        ...(prev.explanation || tc.explanation
          ? { explanation: prev.explanation || tc.explanation }
          : {}),
        ...(prev.output || tc.output
          ? { output: prev.output || tc.output }
          : {}),
      });
    }
  }
  return order
    .map((id) => byId.get(id)!)
    .filter((tc) => tc && !isInterruptedTool(tc));
}

export function buildToolRenderItems(
  toolCalls: MessageToolCall[]
): ToolRenderItem[] {
  const visible = dedupeToolCalls(toolCalls);
  const out: ToolRenderItem[] = [];
  let buf: MessageToolCall[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push({ kind: 'single', tc: buf[0]! });
    } else {
      const last = buf[buf.length - 1];
      const n = buf.length;
      out.push({
        kind: 'group',
        id: `grp-${buf![0]!.id}`,
        tools: [...buf],
        label: `${toolHumanLabel(last!)} · ${n} 步`,
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
    if (
      isInspectTool(tc) &&
      !toolHasDisplayableResult(tc) &&
      tc.status !== 'running'
    ) {
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

/**
 * 构建交错时间线。
 * blocks 可用时按 blocks 顺序；否则工具在前、正文在后。
 */
export function buildAssistantTimeline(
  msg: SessionMessage
): AssistantTimelineItem[] {
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
          if (c.trim())
            items.push({ kind: 'text', content: c, key: `text-${xi++}` });
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
        if (rendered.length)
          items.push({ kind: 'tools', items: rendered, key: 'tools-orphan' });
      }
      if (!items.some((i) => i.kind === 'text') && (msg.text || '').trim()) {
        items.push({ kind: 'text', content: msg.text || '', key: 'text-full' });
      }
      return items;
    }

    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length)
        items.push({ kind: 'tools', items: rendered, key: `tools-0` });
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

/**
 * 助手消息渲染时间线签名（T1.2 / 🔴 红-01 根治修复版）。
 *
 * 核心契约：
 * 1. 流式运行态（msg.status === 'processing'）：最后 text 块只记标记与空态，内容不进签名，
 *    保证流式每帧打字时不触发 timeline 重建，保护 memo 渲染性能；
 * 2. 完成态（msg.status !== 'processing'）：最后 text 块必须将完整 content 纳入签名，
 *    保证持久化提交时签名结构发生绝对改变，强力击穿旧缓存；
 * 3. 兜底特征（A-06）：当 blocks 中无有效 text 块时，将 msg.text 纳入签名投影。
 */
export function timelineSignature(msg: SessionMessage): string {
  const isLiveProcessing = msg.status === 'processing';
  const blocks = msg.blocks || [];
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === 'text') {
      lastTextIdx = i;
      break;
    }
  }

  const blocksProj = blocks.map((b, i) => {
    if (b.type === 'text') {
      if (i === lastTextIdx) {
        return isLiveProcessing
          ? { t: 'text', last: 1, e: (b.content || '') === '' ? 1 : 0 }
          : { t: 'text', last: 1, c: b.content || '' };
      }
      return { t: 'text', c: b.content || '' };
    }
    return { t: b.type, id: b.id };
  });

  const toolsProj = (msg.toolCalls || []).map((tc) => ({
    id: tc.id,
    n: tc.name,
    s: tc.status,
    o: tc.output,
    a: tc.arguments,
    e: tc.explanation,
  }));

  const hasExplicitText = blocks.some(
    (b) => b.type === 'text' && (b.content || '').trim().length > 0
  );

  if (blocks.length === 0 || !hasExplicitText) {
    return JSON.stringify({
      b: blocksProj,
      t: toolsProj,
      st: msg.status || 'unknown',
      hasText: Boolean((msg.text || '').trim()),
      txt: isLiveProcessing ? undefined : msg.text || '',
    });
  }

  return JSON.stringify({
    b: blocksProj,
    t: toolsProj,
    st: msg.status || 'unknown',
  });
}

/**
 * 带签名缓存的 timeline 构建（T1.2）。
 * 签名命中（纯文本流式帧）→ 返回上次 timeline 引用（零重建）；
 * 签名失效（工具事件/块结构变化）→ 全量重建。
 */
export function buildAssistantTimelineCached(
  msg: SessionMessage,
  prevSig: string | null,
  prevTimeline: AssistantTimelineItem[] | null
): { sig: string; timeline: AssistantTimelineItem[] } {
  const sig = timelineSignature(msg);
  if (sig === prevSig && prevTimeline) {
    return { sig, timeline: prevTimeline };
  }
  return { sig, timeline: buildAssistantTimeline(msg) };
}

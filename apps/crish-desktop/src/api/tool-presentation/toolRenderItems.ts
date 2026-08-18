/**
 * 工具调用渲染项构建（V1-γ 折叠单源）。
 *
 * 从 timelineNormalizer 拆分而来；承载 dedupeToolCalls / buildToolRenderItems
 * 及其私有辅助（statusRank / isFoldableInspect / canJoinToolGroup）。
 * timelineNormalizer hub 与 buildAssistantTimeline 经 re-export 共用本模块。
 */

import type { MessageToolCall } from '../../../store/layoutStore';
import {
  isInspectTool,
  isInterruptedTool,
  toolHasDisplayableResult,
  toolHumanLabel,
} from './toolCardPresenter';
import type { ToolRenderItem } from './toolPresentationTypes';

function statusRank(s: MessageToolCall['status']): number {
  if (s === 'success') return 4;
  if (s === 'error') return 3;
  if (s === 'pending_approval') return 2;
  return 1; // running
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

/** 可折叠 inspect：只读工具且无可展示结果（含 running，无结果即折叠候选） */
function isFoldableInspect(tc: MessageToolCall): boolean {
  return isInspectTool(tc) && !toolHasDisplayableResult(tc);
}

/**
 * 投影层折叠/并行唯一裁决（V1-γ 折叠单源）：
 * - 连续可折叠 inspect → 并入同一 group（原「连续 inspect 折叠」语义）；
 * - 否则同轮并行（turnId 相同 + startedAt 相距 ≤200ms）→ 并入同一 group
 *   （原渲染端 parallelGroup 重分组语义下沉投影层）。
 * group.label = `${toolHumanLabel(last)} · ${n} 步`（渲染端复活为折叠头文案）。
 */
function canJoinToolGroup(
  buf: MessageToolCall[],
  tc: MessageToolCall
): boolean {
  const prev = buf[buf.length - 1]!;
  // 连续可折叠 inspect（原投影折叠规则）
  if (isFoldableInspect(prev) && isFoldableInspect(tc)) return true;
  // 同轮并行：turnId 相同且 startedAt 相距 ≤200ms（原渲染端 parallelGroup 规则）
  if (tc.turnId && prev.turnId === tc.turnId) {
    const a = prev.startedAt;
    const b = tc.startedAt;
    if (a != null && b != null && Math.abs(b - a) <= 200) return true;
  }
  return false;
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
    if (buf.length > 0 && canJoinToolGroup(buf, tc)) {
      buf.push(tc);
      continue;
    }
    flush();
    buf = [tc];
  }
  flush();
  return out;
}

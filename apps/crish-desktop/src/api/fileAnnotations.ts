/**
 * 选区批注：添加瞬间即派发对话流可见卡片，并在会话隔离暂存池中等候
 * 下一次发送注入模型（非常驻评论区）。
 *
 * 会话隔离（详案 02 §3.2 / 评审 02 §2.3）：清退模块级全局数组
 * （pendingAnnotations），改为按 sessionId 寻址的暂存池——会话 A 的
 * 批注绝不会被会话 B 的发送消费；添加瞬间经 ContextInjectionDispatcher
 * 派发 file_context 可见卡片（所见即所知），wire 文本仍由
 * assembleChatPayload 在发送时按会话取走注入（单一暂存源，双投影）。
 *
 * 从 workspaceFsApi 拆分而来；hub 经 re-export 保持对外契约不变。
 */

import { useSessionStore } from '../store/sessionStore';
import { contextInjectionDispatcher } from './contextInjectionDispatcher';
import { estimateTextTokens } from '../utils/tokenEstimator';

export type PendingFileAnnotation = {
  id: string;
  path: string;
  selectedText: string;
  text: string;
  createdAt: number;
};

/** 单会话批注上限（防误触刷屏；与旧全局池口径一致） */
const PENDING_ANNOTATIONS_LIMIT = 20;

/** 会话隔离暂存池（sessionId → 待发送批注，最新在前） */
const pendingBySession = new Map<string, PendingFileAnnotation[]>();

/** 批注变更事件（文件面板徽章刷新；UI 本地通知面，非跨会话暗流） */
const ANN_CHANGED_EVENT = 'crish-file-annotations-changed';

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ANN_CHANGED_EVENT));
  } catch {
    /* swallow-ok: 批注变更事件分发失败不影响已入池的批注 */
  }
}

/** 解析目标会话：显式指定优先，缺省回落活跃会话（无会话上下文的调用点） */
function resolveSessionId(explicit?: string | null): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    return useSessionStore.getState().activeSessionId || '';
  } catch {
    return '';
  }
}

/** 路径短名（卡片标题展示用：取末段文件名） */
function shortName(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || path;
}

export function addPendingFileAnnotation(
  input: {
    path: string;
    selectedText: string;
    text: string;
  },
  opts?: { targetSessionId?: string | null }
): PendingFileAnnotation | null {
  const sid = resolveSessionId(opts?.targetSessionId);
  if (!sid) {
    console.warn('[fileAnnotations] 无目标会话，批注已忽略（不落幽灵暂存）');
    return null;
  }
  const a: PendingFileAnnotation = {
    id: `ann-${Date.now().toString(36)}`,
    path: input.path,
    selectedText: input.selectedText.trim().slice(0, 2000),
    text: input.text.trim(),
    createdAt: Date.now(),
  };
  const list = pendingBySession.get(sid) ?? [];
  pendingBySession.set(sid, [a, ...list].slice(0, PENDING_ANNOTATIONS_LIMIT));
  notifyChanged();

  // 添加瞬间即派发 file_context 可见卡片（被动直接注入，零 AI 轮次）；
  // 卡片正文 = wire 注入文本（formatAnnotationsForModel 单一来源）
  const content = formatAnnotationsForModel([a]);
  contextInjectionDispatcher.inject(sid, {
    kind: 'file_context',
    title: `📎 文件批注：${shortName(a.path)}`,
    summary: a.text.length > 80 ? `${a.text.slice(0, 80)}…` : a.text,
    status: 'injected',
    source: 'user_mention',
    content,
    tokenEstimate: estimateTextTokens(content),
    targetPaths: [a.path],
    metadata: { annotationId: a.id },
  });
  return a;
}

export function countPendingFileAnnotations(sessionId?: string | null): number {
  return (pendingBySession.get(resolveSessionId(sessionId)) ?? []).length;
}

/** 取出并清空该会话的待发送批注（发送用户消息时调用；他 session 池不受影响） */
export function takePendingFileAnnotations(
  sessionId?: string | null
): PendingFileAnnotation[] {
  const sid = resolveSessionId(sessionId);
  if (!sid) return [];
  const list = pendingBySession.get(sid) ?? [];
  pendingBySession.delete(sid);
  if (list.length) notifyChanged();
  return list;
}

/** 格式化为注入模型的上下文块（卡片正文与 wire 文本的单一来源） */
export function formatAnnotationsForModel(list: PendingFileAnnotation[]): string {
  if (!list.length) return '';
  const parts = list.map((a, i) => {
    const path = a.path;
    const sel = a.selectedText.length > 800 ? `${a.selectedText.slice(0, 800)}…` : a.selectedText;
    return [
      `### 文件批注 ${i + 1}`,
      `路径: ${path}`,
      `选中内容:`,
      '```',
      sel,
      '```',
      `用户批注: ${a.text}`,
    ].join('\n');
  });
  return (
    `<file_annotations>\n以下批注来自用户在文件面板中对选区的标注，请优先参考。\n\n` +
    parts.join('\n\n') +
    `\n</file_annotations>`
  );
}

/** 测试重置（清空全部会话池） */
export function resetFileAnnotationsForTest(): void {
  pendingBySession.clear();
}
